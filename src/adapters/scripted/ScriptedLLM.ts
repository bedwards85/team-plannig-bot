import type Anthropic from "@anthropic-ai/sdk";
import type { LLMPort, TurnRequest, TurnResult } from "../../ports/llm.js";

export type ScriptedStep =
  | { reply: string }
  | { refuse: string | null }
  | { error: Error };

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
    if ("error" in step) throw step.error;

    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if ("refuse" in step) {
      onText("I'll start on that");
      const content: Anthropic.ContentBlock[] = [{ type: "text", text: "I'll start on that", citations: null }];
      return {
        text: "I'll start on that",
        content,
        stopReason: "refusal",
        refusalCategory: step.refuse,
        firstTextMs: 1,
        totalMs: 2,
        usage,
      };
    }

    for (const word of step.reply.split(/(?<= )/)) onText(word);
    const content: Anthropic.ContentBlock[] = [{ type: "text", text: step.reply, citations: null }];
    return {
      text: step.reply,
      content,
      stopReason: "end_turn",
      refusalCategory: null,
      firstTextMs: 1,
      totalMs: 2,
      usage,
    };
  }
}
