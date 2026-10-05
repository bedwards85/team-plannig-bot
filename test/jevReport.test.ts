import { describe, expect, it } from "vitest";
import { applyIsotonic, auroc, expectedCalibrationError, isCalibrationSplit, precisionRecall, type IsotonicBlock } from "../src/eval/jevMetrics.js";
import {
  JEV_BARS,
  applyLabelTrust,
  buildCalibration,
  deciderFor,
  evaluateFlag,
  findDisagreements,
  flagOutcome,
  flipSummary,
  formatLabelTrust,
  formatResultsTable,
  labelTrust,
  latestById,
  mergeEqualBlocks,
  mostCommon,
  ruleFor,
  runDataKind,
  summariseLatency,
  withOptionalNumber,
  type FlagEvaluation,
  type FlagItem,
  type FlagRule,
  type LabelTrust,
} from "../src/eval/jevReport.js";
import { JevCalibrationSchema } from "../src/adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type FlagProbabilities, type ReplyFlag } from "../src/ports/classifier.js";

/** A small seeded generator, so the "random" data is the same on every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `n` replies, about 35% labelled yes, scored by `score` from the label and a random number. */
function items(n: number, score: (y: boolean, u: number) => number, seed = 7, positiveRate = 0.35): FlagItem[] {
  const rand = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const y = rand() < positiveRate;
    return { id: `run.json:persona:${i}`, p: score(y, rand()), y };
  });
}

/** Yes replies score 0.6–1, no replies 0–0.4: a classifier that never gets it wrong. */
const perfect = (y: boolean, u: number) => (y ? 0.6 + 0.4 * u : 0.4 * u);

describe("evaluateFlag", () => {
  it("passes a classifier that separates the labels cleanly", () => {
    const e = evaluateFlag("did_task", items(300, perfect));
    expect(e.status).toBe("pass");
    expect(e.reasons).toEqual([]);
    expect(e.labels).toBe(300);
    expect(e.metrics.recall!).toBeGreaterThanOrEqual(0.9);
    expect(e.metrics.precision).toBe(1);
    expect(e.metrics.auroc).toBe(1);
    expect(e.metrics.eceCalibrated!).toBeLessThan(0.01);
    expect(e.metrics.eceRaw!).toBeGreaterThan(0.1);
    expect(e.threshold).not.toBeNull();
    // Every no maps to 0 and every yes to 1, so the map needs only two steps.
    expect(e.isotonic.map((b) => b[2])).toEqual([0, 1]);
  });

  it("tunes on the 70% part and reports on the 30% part, split by id", () => {
    const all = items(400, perfect);
    const e = evaluateFlag("several_asks", all);
    const tuning = all.filter((i) => isCalibrationSplit(i.id));
    const checking = all.filter((i) => !isCalibrationSplit(i.id));
    expect(e.tuning).toEqual({ n: tuning.length, positives: tuning.filter((i) => i.y).length });
    expect(e.checking).toEqual({ n: checking.length, positives: checking.filter((i) => i.y).length });
    expect(e.tuning.n + e.checking.n).toBe(400);
    expect(e.tuning.n / 400).toBeGreaterThan(0.6);
    expect(e.tuning.n / 400).toBeLessThan(0.8);
    // The threshold keeps at least 90% recall on the recalibrated tuning part.
    const recal = tuning.map((i) => ({ p: applyIsotonic(e.isotonic, i.p), y: i.y }));
    expect(precisionRecall(recal, e.threshold!).recall!).toBeGreaterThanOrEqual(0.9);
    // Every reported number comes from the 30% part: raw for AUROC and ECE before, recalibrated otherwise.
    const checkRaw = checking.map((i) => ({ p: i.p, y: i.y }));
    const checkRecal = checking.map((i) => ({ p: applyIsotonic(e.isotonic, i.p), y: i.y }));
    expect(e.metrics).toEqual({
      auroc: auroc(checkRaw),
      eceRaw: expectedCalibrationError(checkRaw),
      eceCalibrated: expectedCalibrationError(checkRecal),
      ...precisionRecall(checkRecal, e.threshold!),
    });
  });

  it("measures only the held-back part: a classifier right on the 70% but backwards on the 30% fails", () => {
    const all = items(400, (y, u) => (y ? 0.6 + 0.4 * u : 0.4 * u)).map((i) =>
      isCalibrationSplit(i.id) ? i : { ...i, p: 1 - i.p },
    );
    const e = evaluateFlag("below_top_level", all);
    expect(e.status).toBe("fail");
    expect(e.metrics.auroc).toBe(auroc(all.filter((i) => !isCalibrationSplit(i.id))));
    expect(e.metrics.auroc!).toBeLessThan(0.1);
    expect(e.reasons.join(" ")).toMatch(/AUROC 0\.0\d: too often scores a clean reply above a real case \(needs 0\.85 or more\)/);
  });

  it("fails a classifier that guesses, giving each failed bar in plain words", () => {
    const e = evaluateFlag("filled_in_outcome", items(400, (_y, u) => u, 11));
    expect(e.status).toBe("fail");
    expect(e.metrics.recall!).toBeLessThan(JEV_BARS.minRecall);
    expect(e.reasons).toEqual([
      expect.stringMatching(/^catches \d+% of real cases \(needs 90% or more\)$/),
      expect.stringMatching(/^only \d+% of its flags are real cases \(needs 60% or more\)$/),
      expect.stringMatching(/^AUROC 0\.\d\d: too often scores a clean reply above a real case \(needs 0\.85 or more\)$/),
    ]);
  });

  it("fails on calibration error even when the ranking is good", () => {
    // Perfect ranking, but the 70% part says yes replies are rare at high scores, so the
    // recalibration it learns is wrong for the 30% part.
    const all = items(400, perfect).map((i) => (isCalibrationSplit(i.id) && i.y && i.p > 0.8 ? { ...i, y: false } : i));
    const e = evaluateFlag("did_task", all);
    expect(e.metrics.eceCalibrated!).toBeGreaterThan(JEV_BARS.maxEce);
    expect(e.reasons.join(" ")).toMatch(/probabilities are off by 0\.\d\d on average even after recalibration \(needs 0\.10 or less\)/);
  });

  it("says there isn't enough data below 150 labels", () => {
    const e = evaluateFlag("did_task", items(120, perfect));
    expect(e.status).toBe("not enough data");
    expect(e.reasons).toContain("only 120 labelled replies (needs 150)");
  });

  it("says there isn't enough data with fewer than 10 yes labels in a part", () => {
    const e = evaluateFlag("third_party_details", items(300, perfect, 5, 0.03));
    expect(e.status).toBe("not enough data");
    expect(e.reasons.join(" ")).toMatch(/"yes" labels in the (tuning|checking)/);
  });

  it("says there isn't enough data with fewer than 10 no labels in a part", () => {
    const e = evaluateFlag("several_asks", items(300, perfect, 5, 0.97));
    expect(e.status).toBe("not enough data");
    expect(e.reasons.join(" ")).toMatch(/"no" labels in the (tuning|checking)/);
  });

  it("copes with no items at all", () => {
    const e = evaluateFlag("did_task", []);
    expect(e.status).toBe("not enough data");
    expect(e.threshold).toBeNull();
    expect(e.metrics).toEqual({ auroc: null, eceRaw: null, eceCalibrated: null, precision: null, recall: null });
  });
});

function evaluation(overrides: Partial<FlagEvaluation> = {}): FlagEvaluation {
  return {
    flag: "did_task",
    status: "pass",
    reasons: [],
    labels: 300,
    tuning: { n: 210, positives: 70 },
    checking: { n: 90, positives: 30 },
    threshold: 0.5,
    isotonic: [
      [0, 0.5, 0.1],
      [0.6, 1, 0.8],
    ],
    metrics: { auroc: 0.93, eceRaw: 0.21, eceCalibrated: 0.04, precision: 0.72, recall: 0.94 },
    ...overrides,
  };
}

describe("deciderFor", () => {
  it("uses the recalibrated probability and threshold once a flag has enough data", () => {
    const decide = deciderFor(evaluation());
    expect(decide(0.55)).toBe(false); // recalibrated to 0.45
    expect(decide(0.6)).toBe(true); // recalibrated to 0.8
    expect(decide(0.2)).toBe(false);
  });

  it("falls back to raw 0.5 when the flag hasn't enough data, as the adapter does", () => {
    const decide = deciderFor(evaluation({ status: "not enough data", threshold: 0.9 }));
    expect(decide(0.5)).toBe(true);
    expect(decide(0.49)).toBe(false);
  });

  it("falls back to raw 0.5 when there is no threshold", () => {
    expect(deciderFor(evaluation({ threshold: null }))(0.55)).toBe(true);
  });
});

describe("flipSummary", () => {
  const atHalf = (p: number) => p >= 0.5;

  it("counts replies whose yes/no changed across repeats", () => {
    const s = flipSummary(
      [
        [0.4, 0.6, 0.4],
        [0.9, 0.95],
        [0.1, 0.2, 0.3],
        [0.7, 0.7, 0.2],
      ],
      atHalf,
    );
    expect(s).toEqual({ replies: 4, flipped: 2, rate: 0.5, pass: false });
  });

  it("ignores replies with fewer than two answers", () => {
    expect(flipSummary([[0.9], [], [0.1, 0.2]], atHalf)).toEqual({ replies: 1, flipped: 0, rate: 0, pass: true });
  });

  it("passes at exactly 5%", () => {
    const steady = Array.from({ length: 19 }, () => [0.9, 0.9]);
    expect(flipSummary([...steady, [0.4, 0.6]], atHalf).pass).toBe(true);
    expect(flipSummary([...steady.slice(1), [0.4, 0.6], [0.6, 0.4]], atHalf).pass).toBe(false);
  });

  it("gives null with nothing to compare", () => {
    expect(flipSummary([], atHalf)).toEqual({ replies: 0, flipped: 0, rate: null, pass: null });
  });
});

describe("flagOutcome", () => {
  const flipped = { replies: 50, flipped: 5, rate: 0.1, pass: false };

  it("fails an otherwise passing flag whose answers flip too often, saying so", () => {
    const o = flagOutcome(evaluation(), flipped);
    expect(o.status).toBe("fail");
    expect(o.reasons).toEqual(["gave a different yes/no on a repeat for 5 of 50 replies, 10% (needs 5% or less)"]);
  });

  it("keeps the label checks' result when the flip rate is fine or wasn't measured", () => {
    expect(flagOutcome(evaluation(), { replies: 50, flipped: 1, rate: 0.02, pass: true }).status).toBe("pass");
    expect(flagOutcome(evaluation(), null).status).toBe("pass");
    expect(flagOutcome(evaluation({ status: "fail", reasons: ["x"] }), null)).toEqual({ status: "fail", reasons: ["x"] });
  });

  it("leaves 'labels untrustworthy' alone, never turning it into a pass or a fail", () => {
    const untrustworthy = evaluation({ status: "labels untrustworthy", reasons: ["the hand labels and Opus disagree"] });
    expect(flagOutcome(untrustworthy, flipped)).toEqual({ status: "labels untrustworthy", reasons: ["the hand labels and Opus disagree"] });
    expect(flagOutcome(untrustworthy, { replies: 50, flipped: 0, rate: 0, pass: true }).status).toBe("labels untrustworthy");
    expect(flagOutcome(untrustworthy, null).status).toBe("labels untrustworthy");
  });

  it("leaves 'not enough data' alone", () => {
    const o = flagOutcome(evaluation({ status: "not enough data", reasons: ["only 90 labelled replies (needs 150)"] }), flipped);
    expect(o).toEqual({ status: "not enough data", reasons: ["only 90 labelled replies (needs 150)"] });
  });
});

describe("summariseLatency", () => {
  it("gives percentiles over all calls, counting failures at their full time", () => {
    const s = summariseLatency([
      { ms: 100, ok: true },
      { ms: 300, ok: true },
      { ms: 200, ok: true },
      { ms: 2_500, ok: false },
    ]);
    expect(s).toEqual({ calls: 4, failures: 1, p50Ms: 200, p95Ms: 2_500, overLimit: 1, shareOverLimit: 0.25, limitMs: 2_000 });
  });

  it("does not count a call of exactly 2 s as over", () => {
    expect(summariseLatency([{ ms: 2_000, ok: true }]).overLimit).toBe(0);
  });

  it("copes with no calls", () => {
    expect(summariseLatency([])).toEqual({ calls: 0, failures: 0, p50Ms: null, p95Ms: null, overLimit: 0, shareOverLimit: null, limitMs: 2_000 });
  });
});

describe("ruleFor", () => {
  it("recalibrates and uses the chosen threshold once a flag has enough data", () => {
    const rule = ruleFor(evaluation());
    expect(rule.threshold).toBe(0.5);
    expect(rule.recalibrate(0.6)).toBe(0.8);
  });

  it("uses raw probabilities and 0.5 otherwise", () => {
    const rule = ruleFor(evaluation({ status: "not enough data" }));
    expect(rule.threshold).toBe(0.5);
    expect(rule.recalibrate(0.6)).toBe(0.6);
  });

  it("uses raw probabilities and 0.5 for a flag whose labels are untrustworthy, as the coach eval will (it isn't calibrated)", () => {
    const rule = ruleFor(evaluation({ status: "labels untrustworthy", threshold: 0.3 }));
    expect(rule.threshold).toBe(0.5);
    expect(rule.recalibrate(0.6)).toBe(0.6);
  });
});

describe("findDisagreements", () => {
  const probs = (over: Partial<FlagProbabilities>): FlagProbabilities => ({
    did_task: 0.1,
    below_top_level: 0.1,
    several_asks: 0.1,
    filled_in_outcome: 0.1,
    third_party_details: 0.1,
    ...over,
  });
  const labels = (over: Partial<Record<ReplyFlag, boolean>> = {}) =>
    ({ ...Object.fromEntries(REPLY_FLAGS.map((f) => [f, false])), ...over }) as Record<ReplyFlag, boolean>;
  const raw: FlagRule = { threshold: 0.5, recalibrate: (p) => p };
  const atHalf = Object.fromEntries(REPLY_FLAGS.map((f) => [f, raw])) as Record<ReplyFlag, FlagRule>;

  it("lists replies where Jev's yes/no differs from the label, with the flags, most confident first", () => {
    const rows = [
      { id: "a", probabilities: probs({}), labels: labels() },
      { id: "b", probabilities: probs({ did_task: 0.6 }), labels: labels() },
      { id: "c", probabilities: probs({ several_asks: 0.9 }), labels: labels({ several_asks: true, filled_in_outcome: true }) },
      { id: "d", probabilities: null, labels: labels({ did_task: true }) },
      { id: "e", probabilities: probs({ below_top_level: 0.7 }), labels: labels() },
    ];
    const found = findDisagreements(rows, atHalf);
    expect(found.map(({ id, flags }) => ({ id, flags }))).toEqual([
      { id: "c", flags: ["filled_in_outcome"] },
      { id: "e", flags: ["below_top_level"] },
      { id: "b", flags: ["did_task"] },
    ]);
    expect(found.map((d) => d.margin)).toEqual([expect.closeTo(0.4), expect.closeTo(0.2), expect.closeTo(0.1)]);
  });

  it("keeps the margin for each flag, so each flag's clearest cases can be found", () => {
    const rows = [
      { id: "a", probabilities: probs({ did_task: 0.95, several_asks: 0.6 }), labels: labels() },
      { id: "b", probabilities: probs({ several_asks: 0.1 }), labels: labels({ several_asks: true }) },
    ];
    const found = findDisagreements(rows, atHalf);
    expect(found).toEqual([
      { id: "a", flags: ["did_task", "several_asks"], margins: { did_task: expect.closeTo(0.45), several_asks: expect.closeTo(0.1) }, margin: expect.closeTo(0.45) },
      { id: "b", flags: ["several_asks"], margins: { several_asks: expect.closeTo(0.4) }, margin: expect.closeTo(0.4) },
    ]);
  });

  it("uses each flag's own rule", () => {
    const strict = { ...atHalf, did_task: { threshold: 0.95, recalibrate: (p: number) => p } };
    expect(findDisagreements([{ id: "a", probabilities: probs({ did_task: 0.9 }), labels: labels({ did_task: true }) }], strict)).toEqual([
      { id: "a", flags: ["did_task"], margins: { did_task: expect.closeTo(0.05) }, margin: expect.closeTo(0.05) },
    ]);
  });
});

describe("mergeEqualBlocks", () => {
  it("joins neighbouring steps with the same value without changing the map", () => {
    const blocks: IsotonicBlock[] = [
      [0, 0.1, 0],
      [0.2, 0.2, 0],
      [0.3, 0.4, 0.5],
      [0.6, 0.7, 1],
      [0.8, 0.9, 1],
    ];
    const merged = mergeEqualBlocks(blocks);
    expect(merged).toEqual([
      [0, 0.2, 0],
      [0.3, 0.4, 0.5],
      [0.6, 0.9, 1],
    ]);
    for (let p = 0; p <= 1; p += 0.01) expect(applyIsotonic(merged, p)).toBeCloseTo(applyIsotonic(blocks, p), 12);
  });

  it("leaves its input alone and copes with nothing", () => {
    const blocks: IsotonicBlock[] = [
      [0, 0.1, 0],
      [0.2, 0.3, 0],
    ];
    mergeEqualBlocks(blocks);
    expect(blocks[0]).toEqual([0, 0.1, 0]);
    expect(mergeEqualBlocks([])).toEqual([]);
  });
});

describe("mostCommon and latestById", () => {
  it("finds the most common value, the first on a tie", () => {
    expect(mostCommon(["b", "a", "a", "b", "c"])).toEqual({ value: "b", counts: { b: 2, a: 2, c: 1 } });
    expect(mostCommon(["c", "a", "a"]).value).toBe("a");
    expect(mostCommon(["x", "y", "y"]).value).toBe("y");
    expect(mostCommon([])).toEqual({ value: null, counts: {} });
  });

  it("keeps the last copy of each id, in first-seen order", () => {
    const { items: kept, duplicates } = latestById([
      { id: "a", v: 1 },
      { id: "b", v: 1 },
      { id: "a", v: 2 },
    ]);
    expect(kept).toEqual([
      { id: "a", v: 2 },
      { id: "b", v: 1 },
    ]);
    expect(duplicates).toBe(1);
  });
});

describe("runDataKind", () => {
  it("knows a run made with the fictional sample team and tracker", () => {
    const data = { teamConfigPath: "config/team.sample.yaml", trackerPath: "./fixtures/q4-tracker.sample.json", coachPromptPath: "prompts/coach.md" };
    expect(runDataKind({ data, personas: [] })).toBe("sample");
  });

  it("flags a run made with anything else", () => {
    expect(runDataKind({ data: { teamConfigPath: "config/team.local.yaml", trackerPath: "fixtures/q4-tracker.sample.json" } })).toBe("other");
    expect(runDataKind({ data: { teamConfigPath: "config/team.sample.yaml", trackerPath: "fixtures/real.local.json" } })).toBe("other");
  });

  it("can't say for a run too old to record its data, or something that isn't a run", () => {
    expect(runDataKind({ personas: [] })).toBe("unknown");
    expect(runDataKind({ data: { teamConfigPath: "config/team.sample.yaml" } })).toBe("unknown");
    expect(runDataKind(null)).toBe("unknown");
    expect(runDataKind("not a run")).toBe("unknown");
  });
});

describe("buildCalibration", () => {
  const args = { model: "jev-test-1", questionsVersion: "2026-10-05.1", createdAt: "2026-10-05T09:00:00.000Z", contextTurns: 4 };

  it("includes passing and failing flags, but not those without enough data or with untrustworthy labels", () => {
    const cal = buildCalibration({
      ...args,
      evaluations: [
        evaluation({ flag: "did_task" }),
        evaluation({ flag: "several_asks", status: "fail", threshold: 0.3, isotonic: [[0, 1, 0.4]] }),
        evaluation({ flag: "third_party_details", status: "not enough data" }),
        evaluation({ flag: "filled_in_outcome", status: "labels untrustworthy" }),
      ],
    });
    expect(cal).toEqual({
      ...args,
      flags: {
        did_task: { threshold: 0.5, isotonic: evaluation().isotonic },
        several_asks: { threshold: 0.3, isotonic: [[0, 1, 0.4]] },
      },
    });
  });

  it("gives null when no flag can be calibrated", () => {
    expect(buildCalibration({ ...args, evaluations: [evaluation({ status: "not enough data" }), evaluation({ threshold: null })] })).toBeNull();
    expect(buildCalibration({ ...args, evaluations: [evaluation({ status: "labels untrustworthy" })] })).toBeNull();
  });

  it("records the context setting the run used, whatever it was, so the coach eval sends the same", () => {
    for (const contextTurns of [0, 2, 4, 12]) {
      const cal = buildCalibration({ ...args, contextTurns, evaluations: [evaluation()] });
      expect(cal!.contextTurns).toBe(contextTurns);
      expect(JevCalibrationSchema.parse(cal)).toEqual(cal);
    }
  });
});

describe("labelTrust", () => {
  it("doesn't judge with 29 answers, however poor the match, but reports it", () => {
    expect(labelTrust({ n: 29, agree: 0 })).toEqual({ n: 29, agree: 0, rate: 0, verdict: "too few" });
    expect(labelTrust({ n: 29, agree: 29 }).verdict).toBe("too few");
    expect(labelTrust({ n: 0, agree: 0 })).toEqual({ n: 0, agree: 0, rate: null, verdict: "too few" });
  });

  it("judges from 30 answers: under 80% matching is untrustworthy, 80% is fine", () => {
    expect(labelTrust({ n: 30, agree: 23 }).verdict).toBe("untrustworthy"); // 77%
    expect(labelTrust({ n: 30, agree: 24 }).verdict).toBe("trusted"); // exactly 80%
    expect(labelTrust({ n: 100, agree: 79 }).verdict).toBe("untrustworthy");
    expect(labelTrust({ n: 100, agree: 80 }).verdict).toBe("trusted");
    expect(labelTrust({ n: 100, agree: 79 }).rate).toBe(0.79);
    expect([JEV_BARS.minLabelChecks, JEV_BARS.minLabelAgreement]).toEqual([30, 0.8]);
  });
});

describe("applyLabelTrust", () => {
  const untrustworthy: LabelTrust = { n: 40, agree: 28, rate: 0.7, verdict: "untrustworthy" };

  it("marks a flag whose labels are untrustworthy, even if its numbers pass, saying what to do", () => {
    const e = applyLabelTrust(evaluation({ flag: "below_top_level" }), untrustworthy);
    expect(e.status).toBe("labels untrustworthy");
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0]).toBe(
      "the hand labels and Opus disagree too often on this flag (they match on 28 of 40 randomly picked rows, 70%; needs 80% or more), " +
        "so tighten its definition in eval/jev-questions.json, relabel with npm run jev:label -- --relabel, and run this again",
    );
    // Its numbers are kept for the table.
    expect(e.metrics).toEqual(evaluation().metrics);
  });

  it("puts that reason first and keeps the others", () => {
    const e = applyLabelTrust(evaluation({ status: "not enough data", reasons: ["only 90 labelled replies (needs 150)"] }), untrustworthy);
    expect(e.status).toBe("labels untrustworthy");
    expect(e.reasons[1]).toBe("only 90 labelled replies (needs 150)");
    expect(e.reasons[0]).toMatch(/^the hand labels and Opus disagree too often/);
  });

  it("changes nothing with too few answers or a good match", () => {
    const e = evaluation({ status: "fail", reasons: ["x"] });
    expect(applyLabelTrust(e, { n: 29, agree: 0, rate: 0, verdict: "too few" })).toBe(e);
    expect(applyLabelTrust(e, { n: 30, agree: 24, rate: 0.8, verdict: "trusted" })).toBe(e);
  });
});

describe("formatLabelTrust", () => {
  it("gives one line per flag in plain words", () => {
    const trust = {
      did_task: labelTrust({ n: 30, agree: 24 }),
      below_top_level: labelTrust({ n: 40, agree: 28 }),
      several_asks: labelTrust({ n: 12, agree: 11 }),
      filled_in_outcome: labelTrust({ n: 0, agree: 0 }),
      third_party_details: labelTrust({ n: 35, agree: 35 }),
    };
    const lines = formatLabelTrust(trust);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^did_task\s+24 of 30 match \(80%\): fine$/);
    expect(lines[1]).toMatch(/^below_top_level\s+28 of 40 match \(70%\): labels untrustworthy \(needs 80% or more\)$/);
    expect(lines[2]).toMatch(/^several_asks\s+11 of 12 match \(92%\): too few to judge yet \(needs 30\)$/);
    expect(lines[3]).toMatch(/^filled_in_outcome\s+no answers yet$/);
    expect(lines[4]).toMatch(/^third_party_details\s+35 of 35 match \(100%\): fine$/);
  });
});

describe("withOptionalNumber", () => {
  it("gives a bare --more-labels the default, and joins a number that follows it", () => {
    expect(withOptionalNumber(["--more-labels"], "--more-labels", 100)).toEqual(["--more-labels=100"]);
    expect(withOptionalNumber(["--more-labels", "20", "--no-write"], "--more-labels", 100)).toEqual(["--more-labels=20", "--no-write"]);
    expect(withOptionalNumber(["--more-labels", "--repeats", "0"], "--more-labels", 100)).toEqual(["--more-labels=100", "--repeats", "0"]);
  });

  it("leaves everything else, including --more-labels=N, for parseArgs", () => {
    expect(withOptionalNumber(["--more-labels=5", "--gold", "x"], "--more-labels", 100)).toEqual(["--more-labels=5", "--gold", "x"]);
    expect(withOptionalNumber(["--more-labels", "lots"], "--more-labels", 100)).toEqual(["--more-labels=100", "lots"]);
    expect(withOptionalNumber([], "--more-labels", 100)).toEqual([]);
  });
});

describe("formatResultsTable", () => {
  it("prints one aligned line per flag with the numbers and flip rate", () => {
    const lines = formatResultsTable([
      { evaluation: evaluation(), status: "pass", flip: { replies: 50, flipped: 1, rate: 0.02, pass: true } },
      {
        evaluation: evaluation({ flag: "third_party_details", status: "not enough data", threshold: null, metrics: { auroc: null, eceRaw: null, eceCalibrated: null, precision: null, recall: null } }),
        status: "not enough data",
        flip: null,
      },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Flag\s+Result\s+Recall\s+Precision\s+AUROC\s+ECE before → after\s+Threshold\s+Checked \(yes\)\s+Flip rate$/);
    expect(lines[1]).toMatch(/^did_task\s+PASS\s+0\.94\s+0\.72\s+0\.93\s+0\.21 → 0\.04\s+0\.50\s+90 \(30\)\s+2% \(1\/50\)$/);
    expect(lines[2]).toMatch(/^third_party_details\s+NOT ENOUGH DATA\s+n\/a\s+n\/a\s+n\/a\s+n\/a → n\/a\s+n\/a\s+90 \(30\)\s+not run$/);
    // Columns line up: "Result" starts at the same place on every line.
    const at = lines.map((l) => l.search(/PASS|NOT ENOUGH|Result/));
    expect(new Set(at).size).toBe(1);
  });

  it("says plainly when a flag's labels are untrustworthy", () => {
    const [, line] = formatResultsTable([{ evaluation: evaluation({ flag: "several_asks" }), status: "labels untrustworthy", flip: null }]);
    expect(line).toMatch(/^several_asks\s+LABELS UNTRUSTWORTHY\s+0\.94/);
  });
});
