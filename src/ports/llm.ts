import type Anthropic from "@anthropic-ai/sdk";

/** What the coach needs from a language model: one streamed chat turn. */
export interface LLMPort {
  streamTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult>;
}

export interface TurnRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnResult {
  /** Visible reply text (text blocks only). */
  text: string;
  /** The assistant content exactly as returned, to be appended to history unchanged. */
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
  /** Set when stopReason is "refusal". */
  refusalCategory: string | null;
  /** Milliseconds from sending the request to the first visible text. */
  firstTextMs: number | null;
  totalMs: number;
  usage: TurnUsage;
}

/** Thrown when no text arrives within the first-text deadline. Safe to retry once. */
export class FirstTextTimeoutError extends Error {
  constructor(public readonly afterMs: number) {
    super(`No reply text after ${afterMs} ms`);
    this.name = "FirstTextTimeoutError";
  }
}
