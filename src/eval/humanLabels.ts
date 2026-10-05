/**
 * Hand labels for the Jev gold set, kept in a CSV file that people fill in with Excel.
 * Rows show the whole conversation and the reply but never Opus's or Jev's answers, so the
 * person labels blind. Where a person gave an answer, it replaces the gold label.
 *
 * The id column shows a short key made from each reply's gold id, not the id itself: gold
 * ids give answers away. The scripts map the keys back. The file is only ever appended to,
 * never rewritten, so edits made in Excel survive. Which rows were picked at random (rather
 * than because Jev disagreed with the labels) is kept in a small file next to it, so the
 * sheet itself gives nothing away.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { REPLY_FLAGS, type ReplyFlag } from "../ports/classifier.js";
import { BOM, parseCsv, stripBom, toCsv, type CsvDelimiter } from "./csv.js";
import type { FlagLabels, GoldItem } from "./jevGold.js";

/** Columns of the hand-labelling sheet, in the order a new file gets them. */
export const HUMAN_LABEL_COLUMNS = ["id", "conversation_so_far", "reply_to_check", ...REPLY_FLAGS, "note"] as const;

/**
 * Earlier turns shown before each reply: 0, the whole conversation. Opus labels with the
 * whole conversation, and the flag definitions are about it (did the person ever give that
 * deadline?), so a person checking Opus's labels needs all of it, whatever Jev is sent.
 */
export const HUMAN_CONTEXT_TURNS = 0;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The id the sheet shows for a gold reply: "r-" and the first 10 characters of a SHA-256 of
 * its gold id. The gold id itself would give answers away: a seed id names what the reply
 * was written to test ("seed:did-writes-sql") and a run id names the run, whose coach prompt
 * may be one of the deliberately flawed ones. The same reply always gets the same key.
 */
export function sheetKey(goldId: string): string {
  return `r-${sha256(goldId).slice(0, 10)}`;
}

/**
 * Turns what is in a sheet's id column back into gold ids: a key as above, or the gold id
 * itself, as sheets made before keys were used show it. Anything else comes back unchanged
 * (a row for a reply no longer in the gold set).
 */
export function sheetIdResolver(goldIds: Iterable<string>): (cell: string) => string {
  const ids = [...new Set(goldIds)];
  // Gold ids first, so a key can never shadow one (they look nothing alike anyway).
  const byCell = new Map<string, string>(ids.map((id) => [id, id]));
  for (const id of ids) {
    const key = sheetKey(id);
    if (!byCell.has(key)) byCell.set(key, id);
  }
  return (cell) => byCell.get(cell) ?? cell;
}

/** A person's answers for one reply. A missing flag means "no opinion". */
export type HumanFlagLabels = Partial<Record<ReplyFlag, boolean>>;

export interface ParsedHumanLabels {
  /**
   * Every reply in the file, with the answers given so far (an empty object if none yet).
   * Keyed by gold id when the gold ids were given to the reader, by the sheet's own id otherwise.
   */
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
 * so one typo doesn't stop the run. With `goldIds`, the sheet's keys (or, in older sheets,
 * gold ids) are mapped back to gold ids; problems still quote the id as the sheet shows it.
 */
export function parseHumanLabels(text: string, goldIds?: Iterable<string>): ParsedHumanLabels {
  const resolve = goldIds ? sheetIdResolver(goldIds) : (cell: string) => cell;
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
    const shownId = (row[idCol] ?? "").trim();
    if (!shownId) {
      if (flagCols.some(([, c]) => (row[c] ?? "").trim())) problems.push(`Row ${rowNumber} has answers but no id, so it was skipped.`);
      return;
    }
    const id = resolve(shownId);
    const entry = labels.get(id) ?? {};
    for (const [flag, c] of flagCols) {
      const cell = row[c] ?? "";
      const value = readYesNo(cell);
      if (value === "unreadable") {
        const shown = cell.trim().length > 20 ? `${cell.trim().slice(0, 20)}…` : cell.trim();
        problems.push(`Row ${rowNumber} (${shownId}), ${flag}: "${shown}" isn't Y or N, so it was ignored. Use Y or N, or leave it blank.`);
      } else if (value !== null) {
        if (entry[flag] !== undefined && entry[flag] !== value) {
          problems.push(`${shownId} is in the file more than once with different answers for ${flag}; using row ${rowNumber}.`);
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
 * not UTF-8, which only matters for display, so it is noted rather than refused. With
 * `goldIds`, rows are keyed by gold id (see parseHumanLabels).
 */
export function readHumanLabels(path: string, goldIds?: Iterable<string>): ParsedHumanLabels & { exists: boolean } {
  if (!existsSync(path)) return { labels: new Map(), notes: new Map(), problems: [], exists: false };
  const bytes = readFileSync(path);
  const parsed = parseHumanLabels(bytes.toString("utf8"), goldIds);
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
 * picked at random from the whole gold set. That slice is what gives a fair measure of how
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
  /** New rows for the sheet, in gold-file order, so the labeller can't tell the two kinds apart. */
  ids: string[];
  /** Picked because Jev disagreed with the labels: each flag's clearest cases, the flags taking turns. */
  disagreementIds: string[];
  /**
   * Picked at random from the whole gold set, in gold-file order: every reply picked this
   * round, including any already in the sheet (they get no new row, but their answers now count).
   */
  randomSliceIds: string[];
  /** The part of randomSliceIds already in the sheet. */
  sliceAlreadyInSheet: string[];
}

/** Each id's place in the gold file (its first appearance). */
function goldOrder(items: ReadonlyArray<{ id: string }>): Map<string, number> {
  const order = new Map<string, number>();
  items.forEach((item, i) => {
    if (!order.has(item.id)) order.set(item.id, i);
  });
  return order;
}

/**
 * The order the random slice is drawn in: the ids shuffled by a SHA-256 of each one. Fixed,
 * so the same inputs always give the same round, but unrelated to the labels, to Jev's
 * answers, to the gold-file order and to the keys the sheet shows (a different hash), so the
 * first n of it are a fair random sample and give nothing away.
 */
export function randomSliceOrder(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
    .map((id) => ({ id, rank: sha256(`random slice\u0000${id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((r) => r.id);
}

/**
 * Up to `max` of the replies where Jev disagreed with the labels, from those `eligible`.
 * Each flag's list is sorted by how confidently Jev disagreed on that flag, then the five
 * flags take turns adding their next reply not yet chosen, so a flag with few disagreements
 * still gets its clearest cases checked. Ties go to the earlier reply in the gold file, so the
 * input's own order doesn't matter. Returned in gold-file order.
 */
export function pickDisagreements(options: {
  /** The gold set, in file order. Disagreements for other ids are ignored. */
  items: ReadonlyArray<{ id: string }>;
  disagreements: ReadonlyArray<{ id: string; margins: Partial<Record<ReplyFlag, number>> }>;
  eligible: (id: string) => boolean;
  max: number;
}): string[] {
  const order = goldOrder(options.items);
  const queues = REPLY_FLAGS.map((flag) =>
    options.disagreements
      .filter((d) => d.margins[flag] !== undefined && order.has(d.id) && options.eligible(d.id))
      .sort((a, b) => b.margins[flag]! - a.margins[flag]! || order.get(a.id)! - order.get(b.id)!)
      .map((d) => d.id),
  );
  const picked = new Set<string>();
  while (picked.size < options.max && queues.some((q) => q.length)) {
    for (const queue of queues) {
      if (picked.size >= options.max) break;
      let id = queue.shift();
      while (id !== undefined && picked.has(id)) id = queue.shift();
      if (id !== undefined) picked.add(id);
    }
  }
  return [...picked].sort((a, b) => order.get(a)! - order.get(b)!);
}

/**
 * Chooses a round of `rows` new rows for the sheet: a random slice of the whole gold set
 * (at least 30% of the round), and up to 70% where Jev disagreed with the labels.
 *
 * The slice is picked first and on its own: it is the start of a fixed random order of every
 * gold reply not already recorded as slice, whether or not Jev disagreed with it and whether
 * or not it is already in the sheet (an earlier round may have added it as a disagreement).
 * A reply already in the sheet gets no new row, but it joins the slice, so the answers given
 * on it count. That keeps the slice a fair sample of the gold set, which it would not be if
 * the replies picked for disagreeing were kept out of it. The disagreement rows then come
 * from the replies left (see pickDisagreements). While the round is short of `rows`, because
 * there are few disagreements or slice picks were already in the sheet, the slice takes the
 * next replies in its order. The same inputs always give the same round.
 */
export function selectForHumanLabelling(options: {
  /** The gold set, in file order. */
  items: ReadonlyArray<{ id: string }>;
  disagreements: ReadonlyArray<{ id: string; margins: Partial<Record<ReplyFlag, number>> }>;
  /** Gold ids already in the sheet. */
  alreadyInFile: ReadonlySet<string>;
  /** Gold ids already recorded as random-slice rows (in the file next to the sheet). */
  alreadyInSlice?: ReadonlySet<string>;
  rows?: number;
}): HumanLabelRound {
  const { items, alreadyInFile, alreadyInSlice = new Set<string>(), rows = HUMAN_ROUND_ROWS } = options;
  const order = goldOrder(items);
  const byGoldOrder = (ids: Iterable<string>) => [...ids].sort((a, b) => order.get(a)! - order.get(b)!);
  const isNew = (id: string) => !alreadyInFile.has(id);
  const maxDisagreements = maxDisagreementRows(rows);
  const minSlice = rows - maxDisagreements;

  // Replies that could become disagreement rows: not in the sheet yet, and Jev disagreed on a flag.
  const disagreeing = new Set(
    options.disagreements
      .filter((d) => order.has(d.id) && isNew(d.id) && REPLY_FLAGS.some((f) => d.margins[f] !== undefined))
      .map((d) => d.id),
  );

  const slice: string[] = [];
  let sliceNewRows = 0;
  let disagreeingLeft = disagreeing.size;
  const disagreementRoom = () => Math.max(0, Math.min(maxDisagreements, rows - sliceNewRows, disagreeingLeft));
  for (const id of randomSliceOrder([...order.keys()].filter((id) => !alreadyInSlice.has(id)))) {
    if (slice.length >= minSlice && sliceNewRows + disagreementRoom() >= rows) break;
    slice.push(id);
    if (isNew(id)) sliceNewRows++;
    if (disagreeing.has(id)) disagreeingLeft--;
  }

  const inSlice = new Set(slice);
  const disagreementIds = pickDisagreements({
    items,
    disagreements: options.disagreements,
    eligible: (id) => disagreeing.has(id) && !inSlice.has(id),
    max: disagreementRoom(),
  });
  return {
    ids: byGoldOrder([...slice.filter(isNew), ...disagreementIds]),
    disagreementIds,
    randomSliceIds: byGoldOrder(slice),
    sliceAlreadyInSheet: byGoldOrder(slice.filter((id) => !isNew(id))),
  };
}

// ---- The file next to the sheet ----

/**
 * What the sheet must not show: which of its rows are the random slice, as gold ids (the
 * sheet shows keys instead, so this file doesn't point at its rows either). Only ever added
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

/**
 * A new sheet row, keyed by column name: the reply's key (not its gold id), the whole
 * conversation before it and the reply. Flag and note columns start blank: the person labels blind.
 */
export function humanLabelRow(item: Pick<GoldItem, "id" | "context" | "reply">): Record<string, string> {
  return {
    id: sheetKey(item.id),
    conversation_so_far: conversationSoFar(item.context),
    reply_to_check: asExcelText(item.reply),
  };
}

/**
 * Adds rows to the sheet for these replies, creating it (with a header, and a byte-order
 * mark so Excel reads it as UTF-8) if it doesn't exist. An existing file is never rewritten
 * or reordered: rows are appended in its own column order, with its own delimiter and
 * line ends, and replies already in it (under their key, or their gold id in older sheets)
 * are skipped. Returns how many rows were added.
 */
export function appendHumanLabelRows(path: string, items: ReadonlyArray<Pick<GoldItem, "id" | "context" | "reply">>): number {
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
    const key = sheetKey(item.id);
    if (present.has(key) || present.has(item.id)) continue;
    present.add(key);
    const cells = humanLabelRow(item);
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
