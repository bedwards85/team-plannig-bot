import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ScriptedLLM } from "../src/adapters/scripted/ScriptedLLM.js";
import {
  CONNECTION_TROUBLE,
  CoachConversation,
  REFUSAL_REDIRECT,
  REPEATED_REFUSAL_NOTE,
  WITHHELD_USER_TEXT,
  isRetryable,
} from "../src/core/conversation.js";
import { findPerson } from "../src/domain/okr.js";
import { FirstTextTimeoutError } from "../src/ports/llm.js";
import { MONDAY, team, tracker } from "./helpers.js";

function make(llm: ScriptedLLM, personId = "ann") {
  return new CoachConversation({
    llm,
    coachPrompt: "COACH PROMPT",
    team,
    tracker,
    person: findPerson(team, personId),
    touchpoint: "plan",
    clock: () => MONDAY,
    retryDelayMs: () => 0,
  });
}

const overloadedMidStream = () =>
  new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, "Overloaded", new Headers(), "overloaded_error");

describe("CoachConversation", () => {
  it("starts with the context note and the template opener, which lists open items", () => {
    const c = make(new ScriptedLLM([]));
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]!.role).toBe("user");
    expect(c.messages[1]).toEqual({ role: "assistant", content: c.openerText });
    expect(c.openerText).toContain("Sooner task (KR 1.2, due 9 Oct)");
    expect(c.openerText).toMatch(/Which of these do you plan to finish off this week\?/);
  });

  it("keeps history append-only: every request starts with the previous request plus its reply", async () => {
    const llm = new ScriptedLLM([{ reply: "First?" }, { reply: "Second?" }, { reply: "Third?" }]);
    const c = make(llm);
    await c.send("one");
    await c.send("two");
    await c.send("three");
    const [r1, r2, r3] = llm.requests;
    expect(r2!.messages.slice(0, r1!.messages.length)).toEqual(r1!.messages);
    expect(r3!.messages.slice(0, r2!.messages.length)).toEqual(r2!.messages);
    // The system prompt is identical on every request (cache-safe).
    expect(r2!.system).toEqual(r1!.system);
    expect(r3!.system).toEqual(r1!.system);
  });

  it("prefixes each user turn with a timestamp in the person's own time zone", async () => {
    const llm = new ScriptedLLM([{ reply: "ok?" }]);
    await make(llm).send("hello");
    const last = llm.requests[0]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "text", text: "[Mon 12 Oct 2026, 09:30]" }, // Nairobi
      { type: "text", text: "hello" },
    ]);
  });

  it("streams text to the caller", async () => {
    const llm = new ScriptedLLM([{ reply: "What does done look like?" }]);
    let streamed = "";
    const outcome = await make(llm).send("hi", (d) => (streamed += d));
    expect(outcome.kind).toBe("reply");
    expect(streamed).toBe("What does done look like?");
  });

  it("replaces a refused reply with a gentle redirect, and a note on the second refusal", async () => {
    const llm = new ScriptedLLM([{ refuse: "cyber" }, { refuse: null }, { reply: "Back on track?" }]);
    const c = make(llm);
    const first = await c.send("something odd");
    expect(first).toMatchObject({ kind: "refused", text: REFUSAL_REDIRECT.plan, category: "cyber" });
    expect(c.messages.at(-1)).toEqual({ role: "assistant", content: REFUSAL_REDIRECT.plan });
    const second = await c.send("again");
    expect(second).toMatchObject({ kind: "refused", text: REPEATED_REFUSAL_NOTE });
    const third = await c.send("fine");
    expect(third.kind).toBe("reply");
    const history = JSON.stringify(c.messages);
    // Neither the refused output nor the messages that triggered it are kept or re-sent.
    expect(history).not.toContain("I'll start on that");
    expect(history).not.toContain("something odd");
    expect(history).not.toContain("again");
    expect(history).toContain(WITHHELD_USER_TEXT);
    expect(JSON.stringify(llm.requests[2]!.messages)).not.toContain("something odd");
  });

  it("retries once on a first-text timeout and then succeeds", async () => {
    const llm = new ScriptedLLM([{ error: new FirstTextTimeoutError(12_000) }, { reply: "Sorry for the wait?" }]);
    const outcome = await make(llm).send("hi");
    expect(outcome).toMatchObject({ kind: "reply", attempts: 2 });
  });

  it("commits nothing when the call fails twice, so the person can just resend", async () => {
    const err = new Anthropic.APIConnectionError({ message: "network down" });
    const llm = new ScriptedLLM([{ error: err }, { error: err }, { reply: "Back?" }]);
    const c = make(llm);
    const before = c.messages;
    const outcome = await c.send("hi");
    expect(outcome).toMatchObject({ kind: "error", text: CONNECTION_TROUBLE });
    expect(c.messages).toEqual(before);
    expect((await c.send("hi again")).kind).toBe("reply");
  });

  it("retries an overload that arrives inside the stream before any text", async () => {
    const llm = new ScriptedLLM([{ error: overloadedMidStream() }, { reply: "Here we go?" }]);
    expect(await make(llm).send("hi")).toMatchObject({ kind: "reply", attempts: 2 });
  });

  it("does not retry once text has been shown, so nothing is shown twice", async () => {
    const llm = new ScriptedLLM([{ textThenError: "What does ", error: overloadedMidStream() }, { reply: "never" }]);
    const c = make(llm);
    const before = c.messages;
    expect((await c.send("hi")).kind).toBe("error");
    expect(llm.requests).toHaveLength(1);
    expect(c.messages).toEqual(before);
  });

  it("treats an empty reply as a failed attempt and retries", async () => {
    const llm = new ScriptedLLM([{ reply: "" }, { reply: "Sorry, what was that?" }]);
    const c = make(llm);
    expect(await c.send("hi")).toMatchObject({ kind: "reply", attempts: 2 });
    expect(JSON.stringify(c.messages)).not.toContain('"content":[]');
  });

  it("times first text from the person's message, across a retry", async () => {
    const llm = new ScriptedLLM([{ error: new FirstTextTimeoutError(12_000), delayMs: 40 }, { reply: "There?" }]);
    const outcome = await make(llm).send("hi");
    expect(outcome.kind).toBe("reply");
    // Node's timers can fire up to a millisecond early against performance.now(), so allow 2 ms.
    if (outcome.kind === "reply") expect(outcome.firstTextMs).toBeGreaterThanOrEqual(38);
  });

  it("classifies errors: transient ones retry, permanent ones and user aborts don't", () => {
    expect(isRetryable(overloadedMidStream())).toBe(true);
    expect(isRetryable(new Anthropic.APIConnectionError({ message: "reset" }))).toBe(true);
    expect(isRetryable(new Anthropic.AnthropicError("terminated"))).toBe(true);
    expect(isRetryable(new Anthropic.APIUserAbortError())).toBe(false);
    expect(isRetryable(new Anthropic.AuthenticationError(401, {}, "no", new Headers()))).toBe(false);
    expect(isRetryable(new Error("bug"))).toBe(false);
  });

  it("does not retry errors that will not go away (bad request)", async () => {
    const bad = new Anthropic.BadRequestError(400, { type: "error" }, "bad", new Headers());
    const llm = new ScriptedLLM([{ error: bad }, { reply: "never reached" }]);
    const outcome = await make(llm).send("hi");
    expect(outcome.kind).toBe("error");
    expect(llm.requests).toHaveLength(1);
  });

  it("refuses to run two turns at once", async () => {
    const llm = new ScriptedLLM([{ reply: "a?" }, { reply: "b?" }]);
    const c = make(llm);
    const first = c.send("one");
    await expect(c.send("two")).rejects.toThrow(/already in progress/);
    await first;
  });

  it("builds the same cached prefix (system) for different people on the team", () => {
    const a = make(new ScriptedLLM([]), "ann");
    const b = make(new ScriptedLLM([]), "bob");
    expect(a.system).toEqual(b.system);
  });
});
