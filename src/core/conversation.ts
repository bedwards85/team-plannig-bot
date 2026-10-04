import Anthropic from "@anthropic-ai/sdk";
import type { OkrRow, Person, TeamConfig, TrackerFixture } from "../domain/schemas.js";
import { openItemsFor, renderOkrSnapshot } from "../domain/okr.js";
import { FirstTextTimeoutError, type LLMPort, type TurnResult } from "../ports/llm.js";
import { opener, type Touchpoint } from "./openers.js";
import { buildContextMessage, buildSystem, buildUserTurn } from "./promptAssembly.js";
import { systemClock, weekStart, type Clock } from "./time.js";

/** Shown instead of a refused reply. Gentle, and keeps to the item in hand. */
export const REFUSAL_REDIRECT: Record<Touchpoint, string> = {
  plan: "Let's keep this to the plan itself. What would done look like for that piece by Friday?",
  checkin: "Let's keep this to the plan itself. How is that piece going?",
  review: "Let's keep this to the plan itself. How did that piece land this week?",
};

export const REPEATED_REFUSAL_NOTE = "Let's keep this one short: give it a one-line title and we'll move on.";

/** Stands in for a refused message, so the triggering text is never re-sent. */
export const WITHHELD_USER_TEXT = "(The person described a work item; details left out.)";

export const CONNECTION_TROUBLE =
  "Sorry, I'm having trouble connecting right now. Your message wasn't lost: try sending it again in a minute.";

interface Timing {
  /** From the person pressing Enter to the first visible text, across retries. */
  firstTextMs: number | null;
  attempts: number;
}

export type TurnOutcome =
  | ({ kind: "reply"; text: string; result: TurnResult } & Timing)
  | ({ kind: "refused"; text: string; result: TurnResult; category: string | null } & Timing)
  | { kind: "error"; text: string; error: unknown; elapsedMs: number; attempts: number };

export interface ConversationSetup {
  llm: LLMPort;
  coachPrompt: string;
  team: TeamConfig;
  tracker: TrackerFixture;
  person: Person;
  touchpoint: Touchpoint;
  clock?: Clock;
  /** Wait before the single retry. Defaults to a short random pause (250–750 ms). */
  retryDelayMs?: () => number;
}

/**
 * One coaching conversation (one touchpoint for one person).
 *
 * History is append-only: once a turn is committed, it is never edited or
 * removed. Claude Sonnet 5.5 checks that earlier turns are unchanged, and the
 * prompt cache depends on it too. A user turn is committed only together with
 * the reply it produced. If the call fails, nothing is committed and the
 * person can simply resend.
 */
export class CoachConversation {
  readonly system: Anthropic.TextBlockParam[];
  readonly openerText: string;
  readonly openItems: OkrRow[];
  readonly touchpoint: Touchpoint;
  private readonly history: Anthropic.MessageParam[];
  private readonly llm: LLMPort;
  private readonly clock: Clock;
  private readonly person: Person;
  private readonly retryDelayMs: () => number;
  private busy = false;
  refusals = 0;

  constructor(setup: ConversationSetup) {
    this.llm = setup.llm;
    this.clock = setup.clock ?? systemClock;
    this.person = setup.person;
    this.touchpoint = setup.touchpoint;
    this.retryDelayMs = setup.retryDelayMs ?? (() => 250 + Math.random() * 500);
    // Frozen for the life of this conversation, so the cached prefix stays identical.
    this.system = buildSystem(setup.coachPrompt, renderOkrSnapshot(setup.tracker, setup.team));
    this.openItems = setup.touchpoint === "plan" ? openItemsFor(setup.person.id, setup.tracker) : [];
    this.openerText = opener(setup.touchpoint, setup.person, this.openItems);
    this.history = [
      buildContextMessage({
        team: setup.team,
        person: setup.person,
        touchpoint: setup.touchpoint,
        weekOf: weekStart(this.clock(), setup.person.timezone),
        openItems: this.openItems,
      }),
      { role: "assistant", content: this.openerText },
    ];
  }

  /** A read-only copy of the committed history. */
  get messages(): Anthropic.MessageParam[] {
    return structuredClone(this.history);
  }

  /** Sends one user message. Streams reply text to `onText`. Only one turn may run at a time. */
  async send(userText: string, onText: (delta: string) => void = () => {}): Promise<TurnOutcome> {
    if (this.busy) throw new Error("A turn is already in progress for this conversation");
    this.busy = true;
    const started = performance.now();
    try {
      const at = this.clock();
      const userTurn = buildUserTurn(userText, at, this.person.timezone);
      const request = { system: this.system, messages: [...this.history, userTurn] };

      let result: TurnResult | undefined;
      let firstTextMs: number | null = null;
      let attempts = 0;
      let lastError: unknown;
      // One retry, only for failures that happened before any text was shown.
      while (attempts < 2 && !result) {
        if (attempts > 0) await sleep(this.retryDelayMs());
        attempts++;
        let shown = false;
        try {
          const attempt = await this.llm.streamTurn(request, (d) => {
            if (!shown) {
              shown = true;
              firstTextMs ??= performance.now() - started;
            }
            onText(d);
          });
          if (attempt.stopReason !== "refusal" && attempt.text.trim() === "") {
            // An empty reply can't be committed (and shows nothing). Treat it as a failed attempt.
            lastError = new Error("Empty reply from the model");
            continue;
          }
          result = attempt;
        } catch (error) {
          lastError = error;
          if (shown || !isRetryable(error)) break;
        }
      }
      if (!result) {
        return { kind: "error", text: CONNECTION_TROUBLE, error: lastError, elapsedMs: performance.now() - started, attempts };
      }

      if (result.stopReason === "refusal") {
        // Discard the partial reply. Commit a neutral stand-in for the person's
        // message and the redirect they actually saw, so the text that
        // triggered the refusal is never re-sent on later turns.
        this.refusals++;
        const text = this.refusals >= 2 ? REPEATED_REFUSAL_NOTE : REFUSAL_REDIRECT[this.touchpoint];
        this.history.push(buildUserTurn(WITHHELD_USER_TEXT, at, this.person.timezone), {
          role: "assistant",
          content: text,
        });
        return { kind: "refused", text, result, category: result.refusalCategory, firstTextMs, attempts };
      }

      this.history.push(userTurn, { role: "assistant", content: result.content });
      return { kind: "reply", text: result.text, result, firstTextMs, attempts };
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Worth one retry: timeouts, network failures, rate limits and server errors,
 * whether they arrive as an HTTP status or as an error event inside an
 * already-open stream (those carry no status, only a type).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof FirstTextTimeoutError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true; // includes request timeouts
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true; // HTTP 5xx, including 529
  if (error instanceof Anthropic.APIError) {
    // Stream error events have no status. A user abort has neither status nor type.
    return (
      error.status === undefined &&
      (error.type === "overloaded_error" || error.type === "api_error" || error.type === "rate_limit_error")
    );
  }
  // Transport failures inside the stream body are wrapped as a plain AnthropicError.
  return error instanceof Anthropic.AnthropicError;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
