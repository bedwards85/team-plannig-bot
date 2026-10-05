/**
 * The Jev gold set: coach replies from fictional eval runs, each labelled yes/no for every
 * reply flag. Opus labels them (npm run jev:label); people can override any label in
 * data/jev-gold/human-labels.csv, and npm run jev:eval checks Jev against the result.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { REPLY_FLAGS } from "../ports/classifier.js";

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
    z.object({ run: z.string(), persona: z.string(), line: z.number().int(), coachPrompt: z.string() }),
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
