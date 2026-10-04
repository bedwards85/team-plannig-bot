import Anthropic from "@anthropic-ai/sdk";
import type { OkrRow, Person, TeamConfig, TrackerFixture } from "../domain/schemas.js";
import { openItemsFor, renderOkrSnapshot } from "../domain/okr.js";
import { FirstTextTimeoutError, type LLMPort, type TurnResult } from "../ports/llm.js";
import { opener, type Touchpoint } from "./openers.js";
import { buildContextMessage, buildSystem, buildUserTurn } from "./promptAssembly.js";
import { systemClock, weekStart, type Clock } from "./time.js";

/** Shown instead of a refused reply. Gentle, and steers back to the plan. */
export const REFUSAL_REDIRECT =
  "I can't go into that one, but let's keep going with your week. What's the next thing on your plan?";

export const REPEATED_REFUSAL_NOTE =
  "That's twice I've hit a wall on this one, sorry. Let's keep this item short: give it a title and I'll log it as-is.";

export const CONNECTION_TROUBLE =
  "Sorry, I'm having trouble connecting right now. Your message wasn't lost: try sending it again in a minute.";

export type TurnOutcome =
  | { kind: "reply"; text: string; result: TurnResult; attempts: number }
  | { kind: "refused"; text: string; result: TurnResult; category: string | null }
  | { kind: "error"; text: string; error: unknown };

export interface ConversationSetup {
  llm: LLMPort;
  coachPrompt: string;
  team: TeamConfig;
  tracker: TrackerFixture;
  person: Person;
  touchpoint: Touchpoint;
  clock?: Clock;
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
  private readonly history: Anthropic.MessageParam[];
  private readonly llm: LLMPort;
  private readonly clock: Clock;
  private readonly person: Person;
  private busy = false;
  refusals = 0;

  constructor(setup: ConversationSetup) {
    this.llm = setup.llm;
    this.clock = setup.clock ?? systemClock;
    this.person = setup.person;
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
    try {
      const userTurn = buildUserTurn(userText, this.clock(), this.person.timezone);
      const request = { system: this.system, messages: [...this.history, userTurn] };

      let result: TurnResult | undefined;
      let attempts = 0;
      let lastError: unknown;
      // One retry, only for failures that happened before any text was shown.
      while (attempts < 2 && !result) {
        attempts++;
        let shown = false;
        try {
          result = await this.llm.streamTurn(request, (d) => {
            shown = true;
            onText(d);
          });
        } catch (error) {
          lastError = error;
          if (shown || !isRetryable(error)) break;
        }
      }
      if (!result) return { kind: "error", text: CONNECTION_TROUBLE, error: lastError };

      if (result.stopReason === "refusal") {
        // The partial reply is discarded. The person sees a redirect, and the
        // history records the redirect as the assistant turn, which is what
        // they actually saw.
        this.refusals++;
        const text = this.refusals >= 2 ? REPEATED_REFUSAL_NOTE : REFUSAL_REDIRECT;
        this.history.push(userTurn, { role: "assistant", content: text });
        return { kind: "refused", text, result, category: result.refusalCategory };
      }

      this.history.push(userTurn, { role: "assistant", content: result.content });
      return { kind: "reply", text: result.text, result, attempts };
    } finally {
      this.busy = false;
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof FirstTextTimeoutError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIError) return error.status === 529;
  return false;
}
