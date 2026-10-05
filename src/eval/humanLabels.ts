/**
 * Hand labels for the Jev gold set, kept in a CSV file that people fill in with Excel.
 * Rows show the conversation and the reply but never Opus's or Jev's answers, so the
 * person labels blind. Where a person gave an answer, it replaces the gold label.
 *
 * The file is only ever appended to, never rewritten, so edits made in Excel survive.
 * Which rows were picked at random (rather than because Jev disagreed with the labels) is
 * kept in a small file next to it, so the sheet itself gives nothing away.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DEFAULT_CONTEXT_TURNS } from "../adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type ReplyFlag } from "../ports/classifier.js";
import { BOM, parseCsv, stripBom, toCsv, type CsvDelimiter } from "./csv.js";
import { spreadPick, type FlagLabels, type GoldItem } from "./jevGold.js";

/** Columns of the hand-labelling sheet, in the order a new file gets them. */
export const HUMAN_LABEL_COLUMNS = ["id", "conversation_so_far", "reply_to_check", ...REPLY_FLAGS, "note"] as const;

/**
 * Earlier turns shown for each reply when nothing else is given: Jev's default. jev:eval
 * passes its own setting, so the person sees what Jev read (0 = the whole conversation).
 */
export const HUMAN_CONTEXT_TURNS = DEFAULT_CONTEXT_TURNS;

/** A person's answers for one reply. A missing flag means "no opinion". */
export type HumanFlagLabels = Partial<Record<ReplyFlag, boolean>>;

export interface ParsedHumanLabels {
  /** Every id in the file, with the answers given so far (an empty object if none yet). */
  labels: Map<string, HumanFlagLabels>;
  notes: Map<string, string>;
  /** Cells or rows that could not be read, in plain words, with the row number Excel shows. */
  problems: string[];
}

/** The first row with anything in it: Excel can leave blank lines above the header. -1 if none. */
function headerRowIndex(rows: string[][]): number {
  return rows.findIndex((r) => r.some((c) => c.trim()));
}

const YES = new Set(["y", "yes", "1", "true"]);
const NO = new Set(["n", "no", "0", "false"]);

/** A Y/N cell: true, false, null for blank (no opinion), or "unreadable". */
export function readYesNo(cell: string): boolean | null | "unreadable" {
  const v = cell.trim().toLowerCase();
  if (v === "") return null;
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return "unreadable";
}

/**
 * Reads the hand-labelling sheet. Columns are found by their names in the first row, so
 * they may be moved or extra ones added. A cell that isn't Y or N is reported and skipped,
 * so one typo doesn't stop the run.
 */
export function parseHumanLabels(text: string): ParsedHumanLabels {
  const labels = new Map<string, HumanFlagLabels>();
  const notes = new Map<string, string>();
  const problems: string[] = [];
  const { rows } = parseCsv(text);
  const start = headerRowIndex(rows);
  const header = rows[start];
  if (!header) return { labels, notes, problems };

  const column = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = column("id");
  if (idCol < 0) {
    problems.push(`The first row has no "id" column, so no answers could be read. It should be: ${HUMAN_LABEL_COLUMNS.join(", ")}.`);
    return { labels, notes, problems };
  }
  const flagCols = REPLY_FLAGS.map((flag) => [flag, column(flag)] as const).filter(([, i]) => i >= 0);
  const noteCol = column("note");

  rows.slice(start + 1).forEach((row, i) => {
    const rowNumber = start + i + 2; // Excel numbers rows from 1
    const id = (row[idCol] ?? "").trim();
    if (!id) {
      if (flagCols.some(([, c]) => (row[c] ?? "").trim())) problems.push(`Row ${rowNumber} has answers but no id, so it was skipped.`);
      return;
    }
    const entry = labels.get(id) ?? {};
    for (const [flag, c] of flagCols) {
      const cell = row[c] ?? "";
      const value = readYesNo(cell);
      if (value === "unreadable") {
        const shown = cell.trim().length > 20 ? `${cell.trim().slice(0, 20)}…` : cell.trim();
        problems.push(`Row ${rowNumber} (${id}), ${flag}: "${shown}" isn't Y or N, so it was ignored. Use Y or N, or leave it blank.`);
      } else if (value !== null) {
        if (entry[flag] !== undefined && entry[flag] !== value) {
          problems.push(`${id} is in the file more than once with different answers for ${flag}; using row ${rowNumber}.`);
        }
        entry[flag] = value;
      }
    }
    labels.set(id, entry);
    const note = noteCol >= 0 ? (row[noteCol] ?? "").trim() : "";
    if (note) notes.set(id, note);
  });
  return { labels, notes, problems };
}

/**
 * Reads the sheet from disk; a missing file has no labels. Excel's plain "CSV" format is
 * not UTF-8, which only matters for display, so it is noted rather than refused.
 */
export function readHumanLabels(path: string): ParsedHumanLabels & { exists: boolean } {
  if (!existsSync(path)) return { labels: new Map(), notes: new Map(), problems: [], exists: false };
  const bytes = readFileSync(path);
  const parsed = parseHumanLabels(bytes.toString("utf8"));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    parsed.problems.push(
      "The file isn't saved as UTF-8, so accented letters and dashes may look garbled in Excel. " +
        "Next time use File > Save As > CSV UTF-8. Your Y/N answers still read fine.",
    );
  }
  return { ...parsed, exists: true };
}

export interface EffectiveLabels {
  id: string;
  labels: FlagLabels;
  /** Flags whose label came from a person rather than the gold file. */
  humanFlags: ReplyFlag[];
}

/** The labels to check Jev against: a person's answer wins over the gold label, flag by flag. */
export function effectiveLabels(gold: readonly GoldItem[], human: ReadonlyMap<string, HumanFlagLabels>): EffectiveLabels[] {
  return gold.map((item) => {
    const mine = human.get(item.id) ?? {};
    const humanFlags = REPLY_FLAGS.filter((f) => mine[f] !== undefined);
    const labels = { ...item.labels };
    for (const f of humanFlags) labels[f] = mine[f]!;
    return { id: item.id, labels, humanFlags };
  });
}

export interface LabelAgreement {
  /** Replies where the person answered this flag. */
  n: number;
  agree: number;
  humanYesGoldNo: number;
  humanNoGoldYes: number;
}

/** How often the gold labeller (normally Opus) matches the person, flag by flag. */
export function humanAgreement(
  gold: readonly GoldItem[],
  human: ReadonlyMap<string, HumanFlagLabels>,
): Record<ReplyFlag, LabelAgreement> {
  const out = Object.fromEntries(
    REPLY_FLAGS.map((f) => [f, { n: 0, agree: 0, humanYesGoldNo: 0, humanNoGoldYes: 0 }]),
  ) as Record<ReplyFlag, LabelAgreement>;
  for (const item of gold) {
    const mine = human.get(item.id);
    if (!mine) continue;
    for (const f of REPLY_FLAGS) {
      const h = mine[f];
      if (h === undefined) continue;
      const a = out[f];
      a.n++;
      if (h === item.labels[f]) a.agree++;
      else if (h) a.humanYesGoldNo++;
      else a.humanNoGoldYes++;
    }
  }
  return out;
}

/** Rows in one round of hand labelling, unless asked for another number (--more-labels N). */
export const HUMAN_ROUND_ROWS = 100;

/**
 * Share of every round, in per cent and rounded up, kept for the random slice: replies
 * picked evenly from the whole gold set. That slice is what gives a fair measure of how
 * often the person agrees with Opus; the disagreement rows can't, as they were picked
 * because a label looked wrong. 30% of 100 rows leaves room for up to 70 disagreements.
 */
export const RANDOM_SLICE_PERCENT = 30;

/** The most disagreement rows a round of `rows` may hold: 70 of 100, leaving at least 30% for the random slice. */
export function maxDisagreementRows(rows: number): number {
  return Math.max(0, rows - Math.ceil((rows * RANDOM_SLICE_PERCENT) / 100));
}

/** One round of rows for the sheet. */
export interface HumanLabelRound {
  /** Every reply in the round, in gold-file order, so the labeller can't tell the two kinds apart. */
  ids: string[];
  /** Picked because Jev disagreed with the labels: each flag's clearest cases, the flags taking turns. */
  disagreementIds: string[];
  /** Picked evenly from all the other gold replies (agreements and disagreements alike), in gold-file order. */
  randomSliceIds: string[];
}

/**
 * Chooses a round of `rows` replies not yet in the sheet: up to 70% of them where Jev
 * disagreed with the labels, the rest (at least 30%) a random slice of all the others.
 *
 * Disagreements are taken per flag: each flag's list is sorted by how confidently Jev
 * disagreed on that flag, then the five flags take turns adding their next reply not yet
 * chosen, so a flag with few disagreements still gets its clearest cases checked. With
 * fewer disagreements than that, the slice grows to keep the round at `rows` while the
 * gold set has replies left. The slice is spread evenly over the gold set sorted by id,
 * so it is deterministic and covers every run and persona. The same inputs always give
 * the same round.
 */
export function selectForHumanLabelling(options: {
  /** The gold set, in file order. */
  items: ReadonlyArray<{ id: string }>;
  disagreements: ReadonlyArray<{ id: string; margins: Partial<Record<ReplyFlag, number>> }>;
  alreadyInFile: ReadonlySet<string>;
  rows?: number;
}): HumanLabelRound {
  const { items, alreadyInFile, rows = HUMAN_ROUND_ROWS } = options;
  const order = new Map<string, number>();
  items.forEach((item, i) => {
    if (!order.has(item.id)) order.set(item.id, i);
  });
  const open = (id: string) => order.has(id) && !alreadyInFile.has(id);
  const byGoldOrder = (ids: Iterable<string>) => [...ids].sort((a, b) => order.get(a)! - order.get(b)!);
  const maxDisagreements = maxDisagreementRows(rows);

  // Ties go to the earlier reply in the gold file, so the input's own order doesn't matter.
  const queues = REPLY_FLAGS.map((flag) =>
    options.disagreements
      .filter((d) => d.margins[flag] !== undefined && open(d.id))
      .sort((a, b) => b.margins[flag]! - a.margins[flag]! || order.get(a.id)! - order.get(b.id)!)
      .map((d) => d.id),
  );
  const picked = new Set<string>();
  while (picked.size < maxDisagreements && queues.some((q) => q.length)) {
    for (const queue of queues) {
      if (picked.size >= maxDisagreements) break;
      let id = queue.shift();
      while (id !== undefined && picked.has(id)) id = queue.shift();
      if (id !== undefined) picked.add(id);
    }
  }

  const others = [...order.keys()].filter((id) => open(id) && !picked.has(id));
  const slice = spreadPick(others, rows - picked.size, (id) => id);
  return {
    ids: byGoldOrder([...picked, ...slice]),
    disagreementIds: byGoldOrder(picked),
    randomSliceIds: byGoldOrder(slice),
  };
}

// ---- The file next to the sheet ----

/**
 * What the sheet must not show: which of its rows are the random slice. Only ever added
 * to, so a row once counted as random stays counted. Other keys are kept as found.
 */
export const HumanLabelsMetaSchema = z.looseObject({ randomSliceIds: z.array(z.string()) });

/** data/jev-gold/human-labels.csv → data/jev-gold/human-labels.meta.json */
export function humanLabelsMetaPath(sheetPath: string): string {
  return `${sheetPath.replace(/\.csv$/i, "")}.meta.json`;
}

/** The random-slice ids recorded so far; none if the file doesn't exist. Throws, in plain words, if it can't be read. */
export function readHumanLabelsMeta(path: string): { randomSliceIds: string[]; exists: boolean } {
  if (!existsSync(path)) return { randomSliceIds: [], exists: false };
  try {
    return { randomSliceIds: HumanLabelsMetaSchema.parse(JSON.parse(readFileSync(path, "utf8"))).randomSliceIds, exists: true };
  } catch (error) {
    throw new Error(
      `${path} can't be read (${(error as Error).message.split("\n")[0]}). It records which rows of the hand-labelling sheet ` +
        "were picked at random. Put back a copy that works, or move it aside to start the record again.",
    );
  }
}

/**
 * Records more random-slice ids, keeping every id already there (and its order) and
 * adding new ones at the end. Written to a temporary file first, so a crash part-way
 * can't leave it half-written. Returns how many ids were new.
 */
export function appendRandomSliceIds(path: string, ids: readonly string[]): number {
  const existing = existsSync(path) ? HumanLabelsMetaSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : { randomSliceIds: [] };
  const known = new Set(existing.randomSliceIds);
  const added = ids.filter((id) => !known.has(id) && (known.add(id), true));
  if (added.length === 0) return 0;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.writing`;
  writeFileSync(temporary, JSON.stringify({ ...existing, randomSliceIds: [...existing.randomSliceIds, ...added] }, null, 2) + "\n");
  renameSync(temporary, path);
  return added.length;
}

/**
 * Excel runs a cell that starts with =, +, - or @ as a formula. A leading apostrophe keeps
 * it as text. Only used on the display columns, which are never read back.
 */
export function asExcelText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** The last `turns` turns (0 means the whole conversation), one per line. */
export function conversationSoFar(context: readonly string[], turns = HUMAN_CONTEXT_TURNS): string {
  const shown = turns > 0 ? context.slice(-turns) : context;
  return shown.length ? shown.map(asExcelText).join("\n") : "(start of the conversation)";
}

/** A new sheet row, keyed by column name. Flag and note columns start blank: the person labels blind. */
export function humanLabelRow(item: Pick<GoldItem, "id" | "context" | "reply">, contextTurns = HUMAN_CONTEXT_TURNS): Record<string, string> {
  return {
    id: item.id,
    conversation_so_far: conversationSoFar(item.context, contextTurns),
    reply_to_check: asExcelText(item.reply),
  };
}

/**
 * Adds rows to the sheet for these replies, creating it (with a header, and a byte-order
 * mark so Excel reads it as UTF-8) if it doesn't exist. An existing file is never rewritten
 * or reordered: rows are appended in its own column order, with its own delimiter and
 * line ends, and replies already in it are skipped. Returns how many rows were added.
 */
export function appendHumanLabelRows(
  path: string,
  items: ReadonlyArray<Pick<GoldItem, "id" | "context" | "reply">>,
  contextTurns = HUMAN_CONTEXT_TURNS,
): number {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  let header: string[] = [...HUMAN_LABEL_COLUMNS];
  let delimiter: CsvDelimiter = ",";
  let newline = "\r\n";
  let writeHeader = true;
  const present = new Set<string>();

  if (existing !== null) {
    const parsed = parseCsv(existing);
    delimiter = parsed.delimiter;
    if (existing.includes("\n") && !existing.includes("\r\n")) newline = "\n";
    const start = headerRowIndex(parsed.rows);
    const first = parsed.rows[start];
    if (first) {
      writeHeader = false;
      header = first.map((h) => h.trim().toLowerCase());
      const idCol = header.indexOf("id");
      if (idCol < 0) {
        throw new Error(
          `${path} has no "id" column in its first row, so new rows can't be added safely. ` +
            `Put back the header (${HUMAN_LABEL_COLUMNS.join(", ")}) or move the file aside, then run this again.`,
        );
      }
      for (const row of parsed.rows.slice(start + 1)) {
        const id = (row[idCol] ?? "").trim();
        if (id) present.add(id);
      }
    }
  }

  const rows: string[][] = [];
  for (const item of items) {
    if (present.has(item.id)) continue;
    present.add(item.id);
    const cells = humanLabelRow(item, contextTurns);
    rows.push(header.map((name) => cells[name] ?? ""));
  }
  if (rows.length === 0) return 0;

  const text = toCsv(writeHeader ? [header, ...rows] : rows, { delimiter, newline });
  if (existing === null) {
    mkdirSync(dirname(path), { recursive: true });
    // "wx": never overwrite a file that appeared in the meantime.
    writeFileSync(path, BOM + text, { flag: "wx" });
  } else {
    const needsNewline = stripBom(existing) !== "" && !/[\r\n]$/.test(existing);
    const bom = existing === "" ? BOM : "";
    appendFileSync(path, bom + (needsNewline ? newline : "") + text);
  }
  return rows.length;
}
