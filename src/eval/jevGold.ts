/**
 * The Jev gold set: coach replies from fictional eval runs, each labelled yes/no for every
 * reply flag. Opus labels them (npm run jev:label); people can override any label in
 * data/jev-gold/human-labels.csv, and npm run jev:eval checks Jev against the result.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { JevQuestions } from "../adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type ReplyFlag } from "../ports/classifier.js";
import type { TurnUsage } from "../ports/llm.js";
import { coachReplyLines } from "./jevJudge.js";
import { JUDGE_MODEL, exchangeAt, fill, isSampleData, textOf, usageOf } from "./support.js";

export const GOLD_PATH = "data/jev-gold/gold.jsonl";
export const HUMAN_LABELS_PATH = "data/jev-gold/human-labels.csv";

export const FlagLabelsSchema = z.object(
  Object.fromEntries(REPLY_FLAGS.map((f) => [f, z.boolean()])) as Record<(typeof REPLY_FLAGS)[number], z.ZodBoolean>,
);
export type FlagLabels = z.infer<typeof FlagLabelsSchema>;

export const GoldItemSchema = z.object({
  /** Stable id: "<run file>:<persona>:<line>" for eval replies, "seed:<id>" for hand-written ones. */
  id: z.string(),
  /** Where the reply came from: an eval run (with the coach prompt it used) or the seed file. */
  source: z.union([
    z.object({
      run: z.string(),
      persona: z.string(),
      line: z.number().int(),
      coachPrompt: z.string(),
      /**
       * Whether the run used the fictional sample team and tracker, worked out from the run file
       * when the reply was labelled. False for runs let in only by --allow-real-data (including
       * runs too old to say). jev:eval sends a reply to Jev only if this is true, so the check
       * still holds after the run file is gone. Missing from gold files made before it was kept.
       */
      sampleData: z.boolean().optional(),
    }),
    z.object({ seed: z.string() }),
  ]),
  /** Turns before the reply, oldest first, as "COACH: …" / "PERSON: …". */
  context: z.array(z.string()),
  reply: z.string(),
  labels: FlagLabelsSchema,
  /** Model (or "human") that made the labels. */
  labeller: z.string(),
  /** Version of eval/jev-questions.json whose definitions the labels follow. */
  questionsVersion: z.string(),
  labelledAt: z.string(),
  notes: z.string().optional(),
});
export type GoldItem = z.infer<typeof GoldItemSchema>;

/** Reads the gold set. A missing file is an empty set; a bad line is an error naming the line. */
export function readGold(path = GOLD_PATH): GoldItem[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) => line)
    .map(({ line, i }) => {
      try {
        return GoldItemSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`${path} line ${i + 1}: ${(error as Error).message}`);
      }
    });
}

/** Appends items, one JSON object per line, creating the folder if needed. */
export function appendGold(items: GoldItem[], path = GOLD_PATH): void {
  if (items.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, items.map((i) => JSON.stringify(GoldItemSchema.parse(i))).join("\n") + "\n");
}

// ---- Replies waiting for labels ----

/** A coach reply with everything but its labels. */
export type UnlabelledItem = Pick<GoldItem, "id" | "source" | "context" | "reply">;

/** The parts of an eval run file (written by scripts/eval.ts) that the gold set needs. */
const RunFileSchema = z.looseObject({
  /** Missing from runs made before the eval recorded which team, tracker and coach prompt it used. */
  data: z
    .looseObject({
      teamConfigPath: z.string(),
      trackerPath: z.string(),
      coachPromptPath: z.string(),
    })
    .optional(),
  personas: z.array(
    z.looseObject({
      id: z.string(),
      transcript: z.array(z.object({ speaker: z.enum(["coach", "person"]), text: z.string() })),
    }),
  ),
});

/** A run the labeller will not use without --allow-real-data, and why. */
export class RunRefusedError extends Error {
  constructor(
    readonly reason: "too-old" | "not-sample-data",
    message: string,
  ) {
    super(message);
    this.name = "RunRefusedError";
  }
}

/** How to make fresh transcripts with the fictional sample team: cheap, as no judge is called. */
export const FRESH_RUN_COMMAND = "npm run eval -- --judge none --only personas";

/** What --allow-real-data is for, said the same way everywhere. */
export const ALLOW_REAL_DATA_TEXT = "--allow-real-data is for real team data, and only after the data-protection officer has agreed";

/**
 * Every coach reply in an eval run, ready to label: each coach line except the fixed opener
 * (line 0), with the turns before it. Labels go to Opus and, later, the replies go to Jev
 * (hosted in the US), so a run made with anything but the fictional sample team and tracker
 * is refused unless allowRealData is set. A file that is not an eval run is an Error.
 *
 * Each reply records whether its run used the sample data, whatever allowRealData says, so
 * replies let in with --allow-real-data are marked false and jev:eval can keep them out.
 */
export function itemsFromRun(run: unknown, runName: string, opts: { allowRealData: boolean }): UnlabelledItem[] {
  const parsed = RunFileSchema.safeParse(run);
  if (!parsed.success) {
    throw new Error(
      `${runName} does not look like an eval run file (from npm run eval): ${z.prettifyError(parsed.error)}`,
    );
  }
  const { data, personas } = parsed.data;
  const sampleData = data ? isSampleData(data.teamConfigPath, data.trackerPath) : false;
  if (!opts.allowRealData) {
    if (!data) {
      throw new RunRefusedError(
        "too-old",
        `${runName} is too old to know which team and tracker it used, so it may hold real people's work. ` +
          `Make a fresh run instead (${FRESH_RUN_COMMAND}; it is cheap).`,
      );
    }
    if (!sampleData) {
      throw new RunRefusedError(
        "not-sample-data",
        `${runName} used ${data.teamConfigPath} and ${data.trackerPath}, not the fictional sample team and tracker, ` +
          `so it may hold real people's work. ${ALLOW_REAL_DATA_TEXT}.`,
      );
    }
  }
  const coachPrompt = data?.coachPromptPath ?? "unknown";
  return personas.flatMap((persona) =>
    coachReplyLines(persona.transcript).map((line) => ({
      id: `${runName}:${persona.id}:${line}`,
      source: { run: runName, persona: persona.id, line, coachPrompt, sampleData },
      ...exchangeAt(persona.transcript, line),
    })),
  );
}

/** Hand-written fictional exchanges for cases the eval personas rarely produce. */
export const SEED_PATH = "eval/jev-seed.json";

export const SeedFileSchema = z
  .object({
    about: z.string(),
    items: z.array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/, "seed ids use lower-case letters, digits and hyphens"),
        /** Turns before the reply, written as exchangeAt writes them. */
        context: z.array(
          z.string().regex(/^(COACH|PERSON): \S/, 'each context line starts with "COACH: " or "PERSON: "'),
        ),
        reply: z.string().min(1),
        /** What the item is meant to test, for people reading the file. Never shown to the labeller. */
        note: z.string().optional(),
      }),
    ),
  })
  .refine((seed) => new Set(seed.items.map((i) => i.id)).size === seed.items.length, {
    message: "seed ids must be unique",
  });

export function seedItems(seed: unknown): UnlabelledItem[] {
  return SeedFileSchema.parse(seed).items.map((s) => ({
    id: `seed:${s.id}`,
    source: { seed: s.id },
    context: s.context,
    reply: s.reply,
  }));
}

export function loadSeedItems(path = SEED_PATH): UnlabelledItem[] {
  return seedItems(JSON.parse(readFileSync(path, "utf8")));
}

/** Items whose id is not in the gold set yet, each id once, in the order given. */
export function newItems(items: UnlabelledItem[], labelledIds: Iterable<string>): UnlabelledItem[] {
  const seen = new Set(labelledIds);
  return items.filter((item) => !seen.has(item.id) && (seen.add(item.id), true));
}

/**
 * The command that finishes a --relabel run that stopped part-way: the same arguments without
 * --relabel and without --limit. Running --relabel again would set the new gold file aside and
 * pay for every reply again; without it, only the replies still missing are labelled.
 */
export function finishRelabelCommand(args: readonly string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--relabel" || arg.startsWith("--limit=")) continue;
    if (arg === "--limit") {
      i++; // and its number
      continue;
    }
    kept.push(/^[\w./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);
  }
  return kept.length ? `npm run jev:label -- ${kept.join(" ")}` : "npm run jev:label";
}

/** Takes one from each group in turn, so a capped run (--limit) still covers every source. */
export function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]!);
  }
  return out;
}

// ---- Labelling ----

export const LABEL_PROMPT_PATH = "eval/jev-label.md";

/**
 * The flag definitions for the labelling prompt, taken from eval/jev-questions.json so that
 * Opus and Jev read exactly the same wording.
 */
export function flagDefinitions(questions: JevQuestions): string {
  return REPLY_FLAGS.map((flag) => {
    const q = questions.flags[flag];
    return [`## ${flag}`, q.instructions, `Yes when: ${q.criteria.true}`, `No when: ${q.criteria.false}`].join("\n");
  }).join("\n\n");
}

/** The labelling prompt for one reply. The labeller sees the whole conversation before it. */
export function labelPrompt(
  template: string,
  definitions: string,
  item: Pick<UnlabelledItem, "context" | "reply">,
): string {
  return fill(template, {
    definitions,
    conversation: item.context.length ? item.context.join("\n\n") : "(nothing yet: this is the first message)",
    reply: item.reply,
  });
}

export const LabellerOutputSchema = FlagLabelsSchema.extend({ notes: z.string() });

export type LabelResult =
  | { labels: FlagLabels; notes: string; problem: null; usage: TurnUsage }
  | { labels: null; notes: null; problem: string; usage: TurnUsage | null };

/**
 * Asks Opus for one reply's labels. A refusal, a cut-off or an unreadable answer comes back
 * as a problem, never as labels. API failures (key, network, rate limits) are thrown.
 * No fallback model: every label in the set should come from the same labeller.
 */
export async function labelReply(client: Anthropic, prompt: string, model = JUDGE_MODEL): Promise<LabelResult> {
  const format = zodOutputFormat(LabellerOutputSchema);
  // create() rather than parse(), so a cut-off answer is reported as such, not as unreadable.
  const response = await client.messages.create({
    model,
    max_tokens: 16_000,
    output_config: { effort: "medium", format },
    messages: [{ role: "user", content: prompt }],
  });
  const usage = usageOf(response);
  const failed = (problem: string): LabelResult => ({ labels: null, notes: null, problem, usage });
  if (response.stop_reason === "refusal") return failed("the labeller refused");
  if (response.stop_reason === "max_tokens") return failed("the labeller's answer was cut off");
  const text = textOf(response).trim();
  if (!text) return failed("the labeller gave no answer");
  try {
    const { notes, ...labels } = format.parse(text);
    return { labels, notes: notes.trim(), problem: null, usage };
  } catch (error) {
    return failed(`the labeller's answer was unreadable (${(error as Error).message.slice(0, 200)})`);
  }
}

export function toGoldItem(
  item: UnlabelledItem,
  labels: FlagLabels,
  notes: string,
  meta: { labeller: string; questionsVersion: string; labelledAt: string },
): GoldItem {
  return GoldItemSchema.parse({
    ...item,
    labels,
    ...meta,
    // The prompt asks for "none" when nothing was a close call; that is not worth keeping.
    ...(notes.trim() && !/^none\.?$/i.test(notes.trim()) ? { notes: notes.trim() } : {}),
  });
}

// ---- Summaries ----

/** Where a gold item came from, for grouping: its coach prompt, or the seed file. */
export function sourceGroup(item: Pick<GoldItem, "source">): string {
  return "seed" in item.source ? `seed file (${SEED_PATH})` : item.source.coachPrompt;
}

export interface PositiveRates {
  group: string;
  n: number;
  /** Share of replies labelled yes, per flag. */
  rates: Record<ReplyFlag, number>;
}

/** Share of yes labels per flag, for each coach prompt (and the seed file), then for everything. */
export function positiveRates(items: Pick<GoldItem, "source" | "labels">[]): PositiveRates[] {
  const rates = (group: string, members: typeof items): PositiveRates => ({
    group,
    n: members.length,
    rates: Object.fromEntries(
      REPLY_FLAGS.map((f) => [f, members.length ? members.filter((m) => m.labels[f]).length / members.length : 0]),
    ) as Record<ReplyFlag, number>,
  });
  const groups = [...new Set(items.map(sourceGroup))].sort((a, b) => a.localeCompare(b));
  const rows = groups.map((g) =>
    rates(
      g,
      items.filter((i) => sourceGroup(i) === g),
    ),
  );
  return items.length ? [...rows, rates("all", items)] : [];
}

/** A plain-text table of positive rates, one row per group. */
export function formatPositiveRates(rows: PositiveRates[]): string[] {
  const width = Math.max(12, ...rows.map((r) => r.group.length));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const header = `${"".padEnd(width)}  replies  ${REPLY_FLAGS.map((f) => f.padStart(f.length)).join("  ")}`;
  const lines = rows.map(
    (r) =>
      `${r.group.padEnd(width)}  ${String(r.n).padStart(7)}  ${REPLY_FLAGS.map((f) => pct(r.rates[f]).padStart(f.length)).join("  ")}`,
  );
  return [header, ...lines];
}

/**
 * `n` items spread evenly through the list (all of them if there are fewer), never the same
 * one twice. Even spacing gives a deterministic sample that covers the whole list, not just
 * its start, so the same inputs always give the same pick. With `sortKey` the list is sorted
 * first, so the pick doesn't depend on the order the items came in (the result is then in
 * that sorted order); without it the result keeps the list's own order.
 *
 * Used for the repeat checks in jev:label and jev:eval. The random slice of the
 * hand-labelling sheet uses a shuffled order instead (see humanLabels.ts), so it can grow
 * a round at a time and still be a fair sample.
 */
export function spreadPick<T>(items: readonly T[], n: number, sortKey?: (item: T) => string): T[] {
  const list = sortKey
    ? items
        .map((item) => ({ item, key: sortKey(item) }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((k) => k.item)
    : [...items];
  if (n >= list.length) return list;
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / n)]!);
}

export interface FlagAgreement {
  n: number;
  agree: number;
  /** agree / n, or null with no pairs. */
  rate: number | null;
  /** Agreement beyond chance (1 perfect, 0 no better than chance); null when it can't be worked out. */
  kappa: number | null;
  /** Labelled no the first time and yes the second, and the other way round. */
  noToYes: number;
  yesToNo: number;
}

/** How often two labelling passes over the same replies agree, per flag. */
export function labelAgreement(pairs: [FlagLabels, FlagLabels][]): Record<ReplyFlag, FlagAgreement> {
  return Object.fromEntries(
    REPLY_FLAGS.map((f) => {
      const n = pairs.length;
      const agree = pairs.filter(([a, b]) => a[f] === b[f]).length;
      const noToYes = pairs.filter(([a, b]) => !a[f] && b[f]).length;
      const yesToNo = pairs.filter(([a, b]) => a[f] && !b[f]).length;
      let kappa: number | null = null;
      if (n > 0) {
        const p1 = pairs.filter(([a]) => a[f]).length / n;
        const p2 = pairs.filter(([, b]) => b[f]).length / n;
        const chance = p1 * p2 + (1 - p1) * (1 - p2);
        kappa = chance < 1 ? (agree / n - chance) / (1 - chance) : null;
      }
      return [f, { n, agree, rate: n ? agree / n : null, kappa, noToYes, yesToNo }];
    }),
  ) as Record<ReplyFlag, FlagAgreement>;
}
