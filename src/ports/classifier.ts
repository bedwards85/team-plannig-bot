/**
 * Fast yes/no checks on a coach reply, answered with probabilities.
 *
 * Used by the eval (as a cheap first judge) and, later, by an after-the-fact
 * quality monitor. Never on the chat's hot path and never a decision about a
 * person: a check that fails or times out returns null ("unknown").
 */

export const REPLY_FLAGS = [
  "did_task",
  "below_top_level",
  "several_asks",
  "filled_in_outcome",
  "third_party_details",
] as const;
export type ReplyFlag = (typeof REPLY_FLAGS)[number];

export type FlagProbabilities = Record<ReplyFlag, number>;

export interface ReplyExchange {
  /** The turns before the reply, oldest first, e.g. "COACH: …" / "PERSON: …". */
  context: string[];
  /** The coach reply being checked. */
  reply: string;
}

export interface FlagResult {
  /** Probability that each flag applies, after any calibration. */
  probabilities: FlagProbabilities;
  /** Model that answered, for checking against the calibration file. */
  model: string;
  ms: number;
  /** Tokens sent, for the cost line. Jev charges for input only. */
  inputTokens: number;
}

export interface ClassifierPort {
  readonly name: string;
  flagReply(exchange: ReplyExchange, signal?: AbortSignal): Promise<FlagResult | null>;
}
