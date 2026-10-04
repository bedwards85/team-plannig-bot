import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TurnUsage } from "../ports/llm.js";

/** Fill {{placeholders}} in a prompt template. Unknown placeholders are an error. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Template placeholder {{${key}}} has no value`);
    return value;
  });
}

/** Run `fn` over `items` with at most `limit` running at once, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

// $ per million tokens. 1-hour cache writes cost 2x base input.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite1h: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite1h: 4 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 },
};

export function estimateCost(model: string, u: TurnUsage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite1h) /
    1_000_000
  );
}

export function usageOf(message: Anthropic.Message): TurnUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ---- Simulated team member ----

export const SIMULATOR_MODEL = "claude-sonnet-5-5";

export interface ChatLine {
  speaker: "coach" | "person";
  text: string;
}

/**
 * Asks the simulator for the person's next message. The simulator plays the
 * person, so from its point of view the coach's lines are the "user" turns.
 * Retries once on an empty or cut-off reply. Throws SimulatorError if it can't
 * produce one, so the run is reported as inconclusive rather than a coach fault.
 */
export async function simulateReply(
  client: Anthropic,
  systemPrompt: string,
  lines: ChatLine[],
): Promise<{ text: string; usage: TurnUsage }> {
  const messages: Anthropic.MessageParam[] = lines.map((l) => ({
    role: l.speaker === "coach" ? "user" : "assistant",
    content: l.text,
  }));
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await client.messages.create({
      model: SIMULATOR_MODEL,
      max_tokens: 4_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: systemPrompt,
      messages,
    });
    const text = textOf(message).trim();
    if (message.stop_reason === "refusal") problem = "simulated person was refused";
    else if (message.stop_reason === "max_tokens") problem = "simulated person's reply was cut off";
    else if (!text) problem = "simulated person sent an empty reply";
    else return { text, usage: usageOf(message) };
  }
  throw new SimulatorError(problem);
}

/** A failure of the eval's helper models, not of the coach. */
export class SimulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorError";
  }
}

// ---- Judge ----

export const JUDGE_MODEL = "claude-opus-5-5";

export const VerdictSchema = z.object({
  never_does_task: z.boolean(),
  one_question: z.boolean(),
  coach_tone: z.boolean(),
  blocker_question: z.boolean(),
  kr_link: z.boolean(),
  // Two booleans rather than an enum: the SDK's zod helper sends enums only as
  // a description, whereas booleans are enforced by the API's structured output.
  asked_coach_to_do_task: z.boolean(),
  steered_back_every_time: z.boolean(),
  notes: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Grades one transcript. Returns a reason instead of throwing when no verdict is possible. */
export async function judge(
  client: Anthropic,
  prompt: string,
): Promise<{ verdict: Verdict | null; problem: string | null; usage: TurnUsage | null }> {
  try {
    const response = await client.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: 16_000,
      output_config: { effort: "medium", format: zodOutputFormat(VerdictSchema) },
      messages: [{ role: "user", content: prompt }],
    });
    const usage = usageOf(response);
    if (response.stop_reason === "refusal") return { verdict: null, problem: "judge refused", usage };
    if (response.stop_reason === "max_tokens") return { verdict: null, problem: "judge was cut off", usage };
    if (!response.parsed_output) return { verdict: null, problem: "judge gave no verdict", usage };
    return { verdict: response.parsed_output, problem: null, usage };
  } catch (error) {
    if (error instanceof Anthropic.APIError) throw error; // real API failures surface as such
    return { verdict: null, problem: `judge output unreadable: ${(error as Error).message}`, usage: null };
  }
}

export function transcriptText(lines: ChatLine[], personName: string): string {
  return lines.map((l) => `${l.speaker === "coach" ? "COACH" : personName.toUpperCase()}: ${l.text}`).join("\n\n");
}

/**
 * KR codes the coach mentioned that are not in the tracker. Handles lists such
 * as "KR 2.1 or 2.4", "KRs 2.1 and 2.4", "KR 2.1/2.4" and "key result 2.4",
 * but not stray numbers like "an AUC of 0.80".
 */
export function unknownKrCodes(text: string, validCodes: Set<string>): string[] {
  const re =
    /\b(?:KRs?|key results?)\s*(\d+\.\d+(?:(?:\s*[,/&]\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)(?:KR\s*)?[1-9]\d*\.\d+)*)/gi;
  const found = [...text.matchAll(re)].flatMap((m) => [...m[1]!.matchAll(/\d+\.\d+/g)].map((c) => c[0]));
  return [...new Set(found.filter((c) => !validCodes.has(c)))];
}
