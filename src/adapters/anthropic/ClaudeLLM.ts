import Anthropic from "@anthropic-ai/sdk";
import type { ThinkingMode } from "../../config.js";
import { FirstTextTimeoutError, type LLMPort, type TurnRequest, type TurnResult } from "../../ports/llm.js";

export interface ClaudeLLMOptions {
  client?: Anthropic;
  model?: string;
  /** "adaptive" = adaptive thinking at low effort (default); "off" = Sonnet 5.5's `between_tools`. */
  thinking?: ThinkingMode;
  /** Abort and let the caller retry if no visible text arrives in this many ms. */
  firstTextTimeoutMs?: number;
}

/**
 * Chat turns on Claude, tuned for low latency:
 * - streaming, so the first words show while the rest is generated;
 * - low effort, so the model skips thinking on most simple turns;
 * - prompt caching: explicit 1h breakpoints are set by promptAssembly, and the
 *   top-level marker here caches the growing conversation tail;
 * - no tools on the hot path (structured extraction happens at Save, Phase 2).
 *
 * The thinking and effort settings must stay fixed for a whole conversation:
 * changing either invalidates the prompt cache.
 */
export class ClaudeLLM implements LLMPort {
  private readonly client: Anthropic;
  readonly model: string;
  readonly thinking: ThinkingMode;
  private readonly firstTextTimeoutMs: number;

  constructor(opts: ClaudeLLMOptions = {}) {
    this.client = opts.client ?? new Anthropic({ maxRetries: 2, timeout: 60_000 });
    this.model = opts.model ?? "claude-sonnet-5-5";
    this.thinking = opts.thinking ?? "adaptive";
    this.firstTextTimeoutMs = opts.firstTextTimeoutMs ?? 12_000;
  }

  buildParams(request: TurnRequest): Anthropic.MessageStreamParams {
    return {
      model: this.model,
      // A backstop only. Reply length is set by the coach prompt (under 80 words).
      max_tokens: 16_000,
      thinking: this.thinking === "off" ? { type: "between_tools" } : { type: "adaptive" },
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: request.system,
      messages: request.messages,
    };
  }

  async streamTurn(request: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const started = performance.now();
    let firstTextMs: number | null = null;
    let text = "";

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.firstTextTimeoutMs);

    try {
      const stream = this.client.messages.stream(this.buildParams(request), { signal: abort.signal });
      stream.on("text", (delta) => {
        if (firstTextMs === null) {
          firstTextMs = performance.now() - started;
          clearTimeout(timer);
        }
        text += delta;
        onText(delta);
      });
      const message = await stream.finalMessage();
      return {
        text,
        content: message.content,
        stopReason: message.stop_reason,
        refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? null) : null,
        firstTextMs,
        totalMs: performance.now() - started,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      if (timedOut) throw new FirstTextTimeoutError(this.firstTextTimeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
