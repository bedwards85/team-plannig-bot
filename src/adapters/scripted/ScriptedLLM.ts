import type Anthropic from "@anthropic-ai/sdk";
import type { LLMPort, TurnRequest, TurnResult } from "../../ports/llm.js";

export type ScriptedStep = (
  | { reply: string }
  | { refuse: string | null }
  | { error: Error }
  /** Streams some text, then fails (e.g. a dropped connection mid-reply). */
  | { textThenError: string; error: Error }
) & { delayMs?: number };

/**
 * A fake model for tests: plays back scripted replies, refusals or errors in
 * order, and records every request it was sent.
 */
export class ScriptedLLM implements LLMPort {
  readonly requests: TurnRequest[] = [];
  private index = 0;

  constructor(private readonly steps: ScriptedStep[]) {}

  async streamTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    // Deep-copy so later mutations by the caller can't rewrite what was "sent".
    this.requests.push(structuredClone(request));
    const step = this.steps[this.index++];
    if (!step) throw new Error("ScriptedLLM ran out of steps");
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if ("textThenError" in step) {
      onText(step.textThenError);
      throw step.error;
    }
    if ("error" in step) throw step.error;

    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const text = "refuse" in step ? "I'll start on that" : step.reply;
    if (text) onText(text);
    const content: Anthropic.ContentBlock[] = text ? [{ type: "text", text, citations: null }] : [];
    return {
      text,
      content,
      stopReason: "refuse" in step ? "refusal" : "end_turn",
      refusalCategory: "refuse" in step ? step.refuse : null,
      firstTextMs: 1,
      totalMs: 2,
      usage,
    };
  }
}
