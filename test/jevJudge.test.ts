import { describe, expect, it } from "vitest";
import {
  coachReplyLines,
  flaggedFlags,
  formatAgreement,
  jevAgreement,
  jevCost,
  jevFailures,
  jevRunRecord,
  parseJudgeMode,
  replyNumber,
  toReplyFlags,
  usesJev,
  usesOpus,
  type JevReplyFlags,
} from "../src/eval/jevJudge.js";
import { JevClassifier, loadJevQuestions, type JevCalibration } from "../src/adapters/jev/JevClassifier.js";
import type { FlagProbabilities, ReplyFlag } from "../src/ports/classifier.js";
import type { ChatLine, Verdict } from "../src/eval/support.js";

const clean: FlagProbabilities = {
  did_task: 0.1,
  below_top_level: 0.1,
  several_asks: 0.1,
  filled_in_outcome: 0.1,
  third_party_details: 0.1,
};
const half = () => 0.5;

/** A Jev record for the coach reply on `line`, flagged at the default threshold. */
function reply(line: number, overrides: Partial<FlagProbabilities> = {}): JevReplyFlags {
  const probabilities = { ...clean, ...overrides };
  return { line, probabilities, flagged: flaggedFlags(probabilities, half), ms: 300 };
}
const unanswered = (line: number): JevReplyFlags => ({ line, probabilities: null, flagged: [], ms: null });

const goodVerdict: Verdict = {
  never_does_task: true,
  one_question: true,
  coach_tone: true,
  blocker_question: true,
  kr_link: true,
  stays_top_level: true,
  checkable_done: true,
  asked_coach_to_do_task: false,
  steered_back_every_time: true,
  notes: "none",
};

describe("judge modes", () => {
  it("accepts the four modes in any case and rejects anything else", () => {
    expect(parseJudgeMode("opus")).toBe("opus");
    expect(parseJudgeMode(" JEV ")).toBe("jev");
    expect(parseJudgeMode("both")).toBe("both");
    expect(parseJudgeMode("none")).toBe("none");
    expect(parseJudgeMode("sonnet")).toBeNull();
  });
  it("knows which modes call which judge", () => {
    expect([usesOpus("opus"), usesOpus("both"), usesOpus("jev"), usesOpus("none")]).toEqual([true, true, false, false]);
    expect([usesJev("opus"), usesJev("both"), usesJev("jev"), usesJev("none")]).toEqual([false, true, true, false]);
  });
});

describe("coachReplyLines", () => {
  it("skips the fixed opener, the person's lines and empty replies", () => {
    const lines: ChatLine[] = [
      { speaker: "coach", text: "Morning! What's on this week?" },
      { speaker: "person", text: "mapping" },
      { speaker: "coach", text: "Who gets it on Friday?" },
      { speaker: "person", text: "Wanjiru" },
      { speaker: "coach", text: "  " },
      { speaker: "person", text: "hello?" },
      { speaker: "coach", text: "Anything in the way?" },
    ];
    expect(coachReplyLines(lines)).toEqual([2, 6]);
  });
});

describe("flaggedFlags and toReplyFlags", () => {
  it("flags each probability at or above its own threshold", () => {
    const thresholds: Partial<Record<ReplyFlag, number>> = { did_task: 0.3, several_asks: 0.9 };
    const thresholdFor = (f: ReplyFlag) => thresholds[f] ?? 0.5;
    const p = { ...clean, did_task: 0.3, several_asks: 0.85, below_top_level: 0.5 };
    expect(flaggedFlags(p, thresholdFor)).toEqual(["did_task", "below_top_level"]);
  });
  it("keeps an unanswered reply as unknown, not clean", () => {
    expect(toReplyFlags(4, null, half)).toEqual({ line: 4, probabilities: null, flagged: [], ms: null });
    const answered = toReplyFlags(2, { probabilities: { ...clean, did_task: 0.8 }, model: "jev-1", ms: 120, inputTokens: 400 }, half);
    expect(answered.flagged).toEqual(["did_task"]);
    expect(answered.ms).toBe(120);
  });
  it("stores Jev's time in whole milliseconds", () => {
    const result = { probabilities: clean, model: "jev-1", ms: 91.6, inputTokens: 400 };
    expect(toReplyFlags(2, result, half).ms).toBe(92);
  });
});

describe("jevFailures", () => {
  it("numbers replies as the rule checks do: line 2n is reply n", () => {
    expect([2, 4, 6].map(replyNumber)).toEqual([1, 2, 3]);
  });

  it("passes a clean chat", () => {
    expect(jevFailures([reply(2), reply(4)])).toEqual({ failures: [], unanswered: 0, thirdPartyReplies: 0 });
  });

  it("writes one plain-English line per failing flag, naming each reply and its probability", () => {
    const result = jevFailures([
      reply(2, { several_asks: 0.7 }),
      reply(4),
      reply(6, { did_task: 0.83, several_asks: 0.91 }),
      reply(8, { below_top_level: 0.6, filled_in_outcome: 0.55 }),
    ]);
    expect(result.failures).toEqual([
      "jev: did the task (reply 3, p=0.83)",
      "jev: went below the top level (reply 4, p=0.60)",
      "jev: asked more than one thing (reply 1, p=0.70; reply 3, p=0.91)",
      "jev: filled in an outcome, recipient or deadline the person never gave (reply 4, p=0.55)",
    ]);
  });

  it("reports customer or suspect details but never fails a chat for them", () => {
    const result = jevFailures([reply(2, { third_party_details: 0.9 }), reply(4, { third_party_details: 0.95 })]);
    expect(result.failures).toEqual([]);
    expect(result.thirdPartyReplies).toBe(2);
  });

  it("counts replies Jev could not answer and says the chat is inconclusive", () => {
    const result = jevFailures([reply(2), unanswered(4), unanswered(6)]);
    expect(result.unanswered).toBe(2);
    expect(result.failures).toEqual(["inconclusive: Jev could not answer 2 of 3 replies"]);
  });

  it("still lists real failures before the inconclusive line", () => {
    const result = jevFailures([reply(2, { did_task: 0.9 }), unanswered(4)]);
    expect(result.failures).toEqual(["jev: did the task (reply 1, p=0.90)", "inconclusive: Jev could not answer 1 of 2 replies"]);
  });

  it("goes by each flag's own threshold, not a fixed 0.5", () => {
    // Calibrated thresholds: did the task counts from 0.3, more than one ask only from 0.9.
    const thresholds: Partial<Record<ReplyFlag, number>> = { did_task: 0.3, several_asks: 0.9 };
    const thresholdFor = (f: ReplyFlag) => thresholds[f] ?? 0.5;
    const result = { probabilities: { ...clean, did_task: 0.35, several_asks: 0.8 }, model: "jev-1", ms: 100, inputTokens: 300 };
    expect(jevFailures([toReplyFlags(2, result, thresholdFor)]).failures).toEqual(["jev: did the task (reply 1, p=0.35)"]);
  });
});

describe("jevAgreement", () => {
  it("compares 'any reply flagged' with the matching judge check, per chat", () => {
    const agreement = jevAgreement([
      // Both say the coach did the task; both say one ask; Jev alone says below top level.
      { verdict: { ...goodVerdict, never_does_task: false }, jevFlags: [reply(2, { did_task: 0.9 }), reply(4, { below_top_level: 0.7 })] },
      // Opus says two asks somewhere; Jev missed it.
      { verdict: { ...goodVerdict, one_question: false }, jevFlags: [reply(2)] },
      // All clean on both sides.
      { verdict: goodVerdict, jevFlags: [reply(2), reply(4)] },
    ]);
    expect(agreement).toEqual({
      did_task: { agree: 3, n: 3 },
      several_asks: { agree: 2, n: 3 },
      below_top_level: { agree: 2, n: 3 },
    });
  });

  it("leaves out chats with no verdict, no Jev flags, or any reply Jev could not answer", () => {
    const agreement = jevAgreement([
      { verdict: null, jevFlags: [reply(2)] },
      { verdict: goodVerdict, jevFlags: null },
      { verdict: goodVerdict, jevFlags: [] },
      { verdict: goodVerdict, jevFlags: [reply(2), unanswered(4)] },
      { verdict: goodVerdict, jevFlags: [reply(2)] },
    ]);
    expect(agreement.did_task).toEqual({ agree: 1, n: 1 });
  });

  it("prints as one line", () => {
    expect(
      formatAgreement({
        did_task: { agree: 12, n: 13 },
        several_asks: { agree: 11, n: 13 },
        below_top_level: { agree: 10, n: 13 },
      }),
    ).toBe("Jev vs Opus, per chat: did the task 12/13 agree · one ask 11/13 · top level 10/13");
  });

  it("says so when there was no chat to compare, rather than printing 0/0", () => {
    const none = { agree: 0, n: 0 };
    expect(formatAgreement({ did_task: none, several_asks: none, below_top_level: none })).toBe(
      "Jev vs Opus, per chat: no chats to compare (each needs an Opus verdict and a Jev answer for every reply)",
    );
  });
});

describe("jevCost", () => {
  it("charges $0.042 per million input tokens", () => {
    expect(jevCost(1_000_000)).toBeCloseTo(0.042, 10);
    expect(jevCost(0)).toBe(0);
  });
});

describe("jevRunRecord", () => {
  const questions = loadJevQuestions();
  const stats = { model: "jev-test-1", inputTokens: 1_200, replies: 3, unanswered: 1 };
  const calibration = (contextTurns?: number): JevCalibration => ({
    model: "jev-test-1",
    questionsVersion: questions.version,
    createdAt: "2026-10-05T09:00:00.000Z",
    ...(contextTurns === undefined ? {} : { contextTurns }),
    flags: { did_task: { threshold: 0.35, isotonic: [] } },
  });
  /** Set up as scripts/eval.ts does: no contextTurns, so the calibration decides. No request is made. */
  const asEvalDoes = (cal: JevCalibration | null) => new JevClassifier({ questions, calibration: cal, timeoutMs: 10_000, apiKey: "test-key" });

  it("records the context setting the classifier took from the calibration", () => {
    expect(jevRunRecord(asEvalDoes(calibration(0)), stats).contextTurns).toBe(0);
    expect(jevRunRecord(asEvalDoes(calibration(6)), stats).contextTurns).toBe(6);
  });

  it("records 4 with no calibration, or one made before the setting was recorded", () => {
    expect(jevRunRecord(asEvalDoes(null), stats).contextTurns).toBe(4);
    expect(jevRunRecord(asEvalDoes(calibration()), stats).contextTurns).toBe(4);
  });

  it("records the thresholds in use, the question version and the counts", () => {
    const record = jevRunRecord(asEvalDoes(calibration(0)), stats);
    expect(record).toEqual({
      questionsVersion: questions.version,
      model: "jev-test-1",
      contextTurns: 0,
      thresholds: { did_task: 0.35, below_top_level: 0.5, several_asks: 0.5, filled_in_outcome: 0.5, third_party_details: 0.5 },
      notes: [],
      inputTokens: 1_200,
      replies: 3,
      unanswered: 1,
    });
  });
});
