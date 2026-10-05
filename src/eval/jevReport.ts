/**
 * The numbers behind npm run jev:eval: per-flag checks of Jev against the gold labels,
 * repeat-run flip rates and call speed, with the pass bars from the plan. Pure functions,
 * so the rules are easy to test; scripts/jev-eval.ts does the calls and the printing.
 */
import { existsSync, readFileSync } from "node:fs";
import { JEV_QUESTIONS_PATH, type FlagVerdict, type JevCalibration } from "../adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type FlagProbabilities, type ReplyFlag } from "../ports/classifier.js";
import { SEED_PATH, type GoldItem } from "./jevGold.js";
import {
  applyIsotonic,
  auroc,
  expectedCalibrationError,
  fitIsotonic,
  flipRate,
  isCalibrationSplit,
  pickThreshold,
  precisionRecall,
  type IsotonicBlock,
  type Scored,
} from "./jevMetrics.js";
import { isSampleData, percentile } from "./support.js";

/** What each flag must reach before Jev's answers for it are trusted. */
export const JEV_BARS = {
  /** Share of real cases caught, on the held-back part, at the chosen threshold. */
  minRecall: 0.9,
  /**
   * Share of real cases the threshold must catch on the tuning part. Higher than minRecall
   * on purpose: a threshold tuned to exactly 90% sits on the edge, so the held-back part
   * would fall below 90% about half the time by chance alone.
   */
  tuningRecall: 0.95,
  /** Share of flags that are real cases, same part and threshold. */
  minPrecision: 0.6,
  /** Chance a real case scores above a clean reply (raw probabilities). */
  minAuroc: 0.85,
  /** Average gap between stated probability and observed rate, after recalibration. */
  maxEce: 0.1,
  /** Labelled replies Jev answered, across both parts. */
  minLabels: 150,
  /** "Yes" and "no" labels needed in each part, or the numbers are too noisy to mean much. */
  minEachClassPerPart: 10,
  /** Share of repeated replies whose yes/no changes between identical requests. */
  maxFlipRate: 0.05,
  /**
   * Replies with two or more answers needed before the flip rate counts. With fewer, one
   * flip moves the rate by more than the 5% bar, so the result is "not measured".
   */
  minFlipReplies: 30,
  /**
   * Hand labels on the randomly picked rows of the hand-labelling sheet needed before a
   * flag's gold labels are judged; fewer are reported but don't count against the flag.
   */
  minLabelChecks: 30,
  /** Share of those hand labels that must match Opus's, or the flag's gold labels can't be trusted. */
  minLabelAgreement: 0.8,
} as const;

/** How long the planned live monitor will wait for Jev. Slower calls are counted. */
export const MONITOR_TIMEOUT_MS = 2_000;

/** Before a flag is calibrated, it counts when Jev's raw probability reaches 0.5 (as in the adapter). */
export const RAW_THRESHOLD = 0.5;

/**
 * "labels untrustworthy": the hand labels and Opus disagree too often on the randomly picked
 * rows, so the gold labels can't say whether Jev is right. Never a pass; never calibrated.
 */
export type FlagStatus = "pass" | "fail" | "not enough data" | "labels untrustworthy";

/** One gold reply for one flag: Jev's raw probability and the label it should match. */
export interface FlagItem {
  id: string;
  p: number;
  y: boolean;
}

export interface PartCounts {
  n: number;
  positives: number;
}

export interface FlagEvaluation {
  flag: ReplyFlag;
  status: FlagStatus;
  /** Plain-English reasons for "fail" or "not enough data"; empty on a pass. */
  reasons: string[];
  /** Labelled replies Jev answered, both parts together. */
  labels: number;
  /** The 70% used to fit the recalibration and choose the threshold. */
  tuning: PartCounts;
  /** The 30% held back to check the result. */
  checking: PartCounts;
  /** On recalibrated probabilities; null when the tuning part has no "yes" labels. */
  threshold: number | null;
  isotonic: IsotonicBlock[];
  /** Measured on the checking part only. */
  metrics: {
    auroc: number | null;
    eceRaw: number | null;
    eceCalibrated: number | null;
    precision: number | null;
    recall: number | null;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const two = (x: number) => x.toFixed(2);
const counts = (items: FlagItem[]): PartCounts => ({ n: items.length, positives: items.filter((i) => i.y).length });
const scored = (items: FlagItem[], map: (p: number) => number = (p) => p): Scored[] => items.map((i) => ({ p: map(i.p), y: i.y }));

/**
 * Checks one flag. The stable 70/30 split by id keeps tuning and checking apart: the
 * recalibration and threshold come from the 70%, every reported number from the 30%. The
 * threshold is set to catch 95% of real cases on the 70%, so that the 90% bar on the 30%
 * isn't a coin toss.
 */
export function evaluateFlag(flag: ReplyFlag, items: FlagItem[]): FlagEvaluation {
  const tuningItems = items.filter((i) => isCalibrationSplit(i.id));
  const checkingItems = items.filter((i) => !isCalibrationSplit(i.id));
  const isotonic = mergeEqualBlocks(fitIsotonic(scored(tuningItems)));
  const recalibrate = (p: number) => applyIsotonic(isotonic, p);
  const threshold = pickThreshold(scored(tuningItems, recalibrate), JEV_BARS.tuningRecall);

  const raw = scored(checkingItems);
  const calibrated = scored(checkingItems, recalibrate);
  const { precision, recall } = threshold === null ? { precision: null, recall: null } : precisionRecall(calibrated, threshold);
  const metrics = {
    auroc: auroc(raw),
    eceRaw: expectedCalibrationError(raw),
    eceCalibrated: expectedCalibrationError(calibrated),
    precision,
    recall,
  };
  const tuning = counts(tuningItems);
  const checking = counts(checkingItems);
  const base = { flag, labels: items.length, tuning, checking, threshold, isotonic, metrics };

  const short: string[] = [];
  if (items.length < JEV_BARS.minLabels) short.push(`only ${items.length} labelled replies (needs ${JEV_BARS.minLabels})`);
  const min = JEV_BARS.minEachClassPerPart;
  for (const [name, part] of [["tuning (70%)", tuning], ["checking (30%)", checking]] as const) {
    if (part.positives < min) short.push(`only ${part.positives} "yes" labels in the ${name} part (needs ${min})`);
    if (part.n - part.positives < min) short.push(`only ${part.n - part.positives} "no" labels in the ${name} part (needs ${min})`);
  }
  if (short.length) return { ...base, status: "not enough data", reasons: short };

  const failed: string[] = [];
  if (recall === null || recall < JEV_BARS.minRecall) {
    failed.push(`catches ${recall === null ? "none" : pct(recall)} of real cases (needs ${pct(JEV_BARS.minRecall)} or more)`);
  }
  if (precision === null) failed.push("flagged none of the held-back replies, so it can't be trusted when it does");
  else if (precision < JEV_BARS.minPrecision) {
    failed.push(`only ${pct(precision)} of its flags are real cases (needs ${pct(JEV_BARS.minPrecision)} or more)`);
  }
  if (metrics.auroc === null || metrics.auroc < JEV_BARS.minAuroc) {
    failed.push(
      `AUROC ${metrics.auroc === null ? "n/a" : two(metrics.auroc)}: too often scores a clean reply above a real case (needs ${two(JEV_BARS.minAuroc)} or more)`,
    );
  }
  if (metrics.eceCalibrated === null || metrics.eceCalibrated > JEV_BARS.maxEce) {
    failed.push(
      `probabilities are off by ${metrics.eceCalibrated === null ? "n/a" : two(metrics.eceCalibrated)} on average even after recalibration (needs ${two(JEV_BARS.maxEce)} or less)`,
    );
  }
  return { ...base, status: failed.length ? "fail" : "pass", reasons: failed };
}

/**
 * Joins neighbouring steps of an isotonic map that give the same value. The map is
 * unchanged (the gap between two equal steps interpolates to that value anyway), but the
 * calibration file stays short: continuous scores otherwise give a step per reply.
 */
export function mergeEqualBlocks(blocks: readonly IsotonicBlock[]): IsotonicBlock[] {
  const out: IsotonicBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && last[2] === block[2]) last[1] = block[1];
    else out.push([...block]);
  }
  return out;
}

/** How a flag turns a raw probability into yes/no: recalibrate it, then compare with the threshold. */
export interface FlagRule {
  threshold: number;
  recalibrate: (rawP: number) => number;
}

/** Statuses whose recalibration and threshold stay out of the calibration file. */
const UNCALIBRATED: ReadonlySet<FlagStatus> = new Set(["not enough data", "labels untrustworthy"]);

/** True when the coach eval will use raw probability against 0.5 for this flag, not a fitted rule. */
export function isUncalibrated(evaluation: Pick<FlagEvaluation, "status" | "threshold">): boolean {
  return UNCALIBRATED.has(evaluation.status) || evaluation.threshold === null;
}

/**
 * The rule for a flag as the coach eval will apply it: recalibrated probability against
 * the chosen threshold once the flag goes in the calibration file (enough data, labels not
 * found untrustworthy), raw probability against 0.5 until then.
 */
export function ruleFor(evaluation: Pick<FlagEvaluation, "status" | "threshold" | "isotonic">): FlagRule {
  const { threshold, isotonic } = evaluation;
  if (isUncalibrated(evaluation) || threshold === null) return { threshold: RAW_THRESHOLD, recalibrate: (p) => p };
  return { threshold, recalibrate: (p) => applyIsotonic(isotonic, p) };
}

/** The same rule as a yes/no function of the raw probability. */
export function deciderFor(evaluation: Pick<FlagEvaluation, "status" | "threshold" | "isotonic">): (rawP: number) => boolean {
  const rule = ruleFor(evaluation);
  return (p) => rule.recalibrate(p) >= rule.threshold;
}

export interface FlipSummary {
  /** Replies with at least two answers to compare. */
  replies: number;
  /** Replies whose yes/no changed at least once. */
  flipped: number;
  /** Null when there was nothing to compare. */
  rate: number | null;
  /** Null when not measured: fewer than 30 replies had two or more answers to compare. */
  pass: boolean | null;
}

/**
 * How often the same request got a different yes/no, given each reply's raw probabilities:
 * its answer in the main pass first, then its repeats. Under 30 replies to compare, the rate
 * is still worked out but not judged.
 */
export function flipSummary(rawAnswersPerItem: number[][], decide: (rawP: number) => boolean): FlipSummary {
  const decisions = rawAnswersPerItem.map((ps) => ps.map(decide));
  const usable = decisions.filter((d) => d.length > 1);
  const rate = flipRate(decisions);
  return {
    replies: usable.length,
    flipped: usable.filter((d) => d.some((x) => x !== d[0])).length,
    rate,
    pass: rate === null || usable.length < JEV_BARS.minFlipReplies ? null : rate <= JEV_BARS.maxFlipRate,
  };
}

/** "measured", or why not: the repeat test wasn't run (null), or had too few replies to compare. */
export function flipState(flip: FlipSummary | null): "measured" | "not run" | "too small" {
  if (flip === null) return "not run";
  return flip.pass === null ? "too small" : "measured";
}

/**
 * A flag's final result: the label checks, then the flip rate if it was measured. "Not
 * enough data" and "labels untrustworthy" stand whatever the flip rate: both have to be
 * fixed before a flip rate means anything.
 */
export function flagOutcome(evaluation: FlagEvaluation, flip: FlipSummary | null): { status: FlagStatus; reasons: string[] } {
  if (UNCALIBRATED.has(evaluation.status) || flip?.pass !== false) return { status: evaluation.status, reasons: evaluation.reasons };
  return {
    status: "fail",
    reasons: [
      ...evaluation.reasons,
      `gave a different yes/no on a repeat for ${flip.flipped} of ${flip.replies} replies, ${pct(flip.rate!)} (needs ${pct(JEV_BARS.maxFlipRate)} or less)`,
    ],
  };
}

export interface LatencySummary {
  calls: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Calls slower than the live monitor's limit, counting failures at the time they took. */
  overLimit: number;
  shareOverLimit: number | null;
  limitMs: number;
}

/** Speed over every call. Failed calls count at their full elapsed time, so they can't flatter the numbers. */
export function summariseLatency(samples: ReadonlyArray<{ ms: number; ok: boolean }>, limitMs = MONITOR_TIMEOUT_MS): LatencySummary {
  const ms = samples.map((s) => s.ms);
  const overLimit = ms.filter((m) => m > limitMs).length;
  return {
    calls: samples.length,
    failures: samples.filter((s) => !s.ok).length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    overLimit,
    shareOverLimit: samples.length ? overLimit / samples.length : null,
    limitMs,
  };
}

export interface Disagreement {
  id: string;
  /** Flags where Jev's yes/no differs from the label. */
  flags: ReplyFlag[];
  /** How far past its threshold Jev was on each of those flags (recalibrated scale). */
  margins: Partial<Record<ReplyFlag, number>>;
  /** The largest of those margins: how clear-cut the reply's strongest disagreement is. */
  margin: number;
}

/**
 * Replies where Jev's yes/no differs from the label on at least one flag, most confident
 * first: where Jev was sure and still disagreed, the label is the likelier one to be wrong,
 * so those rows are the most useful to check by hand. The margin is kept per flag too, so
 * the hand-labelling sheet can take the clearest cases of every flag, not just of the noisiest.
 */
export function findDisagreements(
  rows: ReadonlyArray<{ id: string; probabilities: FlagProbabilities | null; labels: Record<ReplyFlag, boolean> }>,
  rules: Record<ReplyFlag, FlagRule>,
): Disagreement[] {
  const found = rows.flatMap(({ id, probabilities, labels }) => {
    if (!probabilities) return [];
    const flags: ReplyFlag[] = [];
    const margins: Partial<Record<ReplyFlag, number>> = {};
    let margin = 0;
    for (const flag of REPLY_FLAGS) {
      const { threshold, recalibrate } = rules[flag];
      const p = recalibrate(probabilities[flag]);
      if (p >= threshold === labels[flag]) continue;
      flags.push(flag);
      margins[flag] = Math.abs(p - threshold);
      margin = Math.max(margin, margins[flag]);
    }
    return flags.length ? [{ id, flags, margins, margin }] : [];
  });
  return found.sort((a, b) => b.margin - a.margin); // stable, so ties keep gold order
}

/** The value seen most often (the first one seen on a tie), with every value's count. */
export function mostCommon(values: readonly string[]): { value: string | null; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  let value: string | null = null;
  for (const [v, n] of Object.entries(counts)) if (value === null || n > counts[value]!) value = v;
  return { value, counts };
}

/**
 * What an eval run file (from npm run eval) says about its data: the fictional sample team
 * and tracker, something else, or "unknown" when it is too old to say. jev:eval checks the
 * run files behind the gold set again before sending their replies to Jev.
 */
export function runDataKind(run: unknown): "sample" | "other" | "unknown" {
  const data = typeof run === "object" && run !== null ? (run as { data?: unknown }).data : undefined;
  if (typeof data !== "object" || data === null) return "unknown";
  const { teamConfigPath, trackerPath } = data as { teamConfigPath?: unknown; trackerPath?: unknown };
  if (typeof teamConfigPath !== "string" || typeof trackerPath !== "string") return "unknown";
  return isSampleData(teamConfigPath, trackerPath) ? "sample" : "other";
}

/** Keeps the last copy of each id (a relabelled item replaces the older one), in first-seen order. */
export function latestById<T extends { id: string }>(items: readonly T[]): { items: T[]; duplicates: number } {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return { items: [...byId.values()], duplicates: items.length - byId.size };
}

/** A flag's final result in a jev:eval run: the label checks, then the repeat test. */
export interface FlagOutcome {
  evaluation: FlagEvaluation;
  status: FlagStatus;
  flip: FlipSummary | null;
}

/**
 * What the calibration file records about a flag, and so whether the coach eval lets Jev
 * fail a chat on it: "pass" only when the flag passed every check, the repeat test included.
 * A repeat test that wasn't run or was too small leaves it at "fail" (not validated).
 */
export function calibrationVerdict(outcome: Pick<FlagOutcome, "status" | "flip">): FlagVerdict {
  return outcome.status === "pass" && outcome.flip?.pass === true ? "pass" : "fail";
}

/**
 * The calibration file's content: recalibration, threshold and result for each flag that had
 * enough data (pass or fail) and whose labels weren't found untrustworthy, or null if none
 * did, so nothing useful would be written. It records the context setting the run used,
 * because the probabilities and thresholds only fit that setting.
 */
export function buildCalibration(args: {
  model: string;
  questionsVersion: string;
  createdAt: string;
  /** Earlier turns Jev read before each reply in this run; 0 = the whole conversation. */
  contextTurns: number;
  outcomes: readonly FlagOutcome[];
}): JevCalibration | null {
  const flags: JevCalibration["flags"] = {};
  for (const o of args.outcomes) {
    const e = o.evaluation;
    if (isUncalibrated(e) || e.threshold === null) continue;
    flags[e.flag] = { threshold: e.threshold, isotonic: e.isotonic, status: calibrationVerdict(o) };
  }
  if (Object.keys(flags).length === 0) return null;
  const { model, questionsVersion, createdAt, contextTurns } = args;
  return { model, questionsVersion, createdAt, contextTurns, flags };
}

/**
 * Share of gold replies Jev may leave unanswered before a run is treated as an outage. Past
 * it, the run's thresholds rest on a part of the gold set Jev happened to answer, so the
 * calibration file is left exactly as it was.
 */
export const MAX_UNANSWERED_SHARE = 0.05;

/** What a jev:eval run does with eval/jev-calibration.json. */
export type CalibrationAction =
  /** --no-write: left alone. */
  | "not asked"
  /** Jev left more than 5% unanswered: left alone, whatever this run found. */
  | "kept: outage"
  /** No flag can be calibrated: an older file would switch on checks this run can't support, so it goes. */
  | "remove"
  | "write";

/** True when Jev left more than 5% of the gold replies sent to it unanswered (or none were sent): an outage. */
export function isOutage(answers: { sent: number; unanswered: number }): boolean {
  return answers.sent === 0 || answers.unanswered / answers.sent > MAX_UNANSWERED_SHARE;
}

export function calibrationAction(args: { noWrite: boolean; sent: number; unanswered: number; hasCalibration: boolean }): CalibrationAction {
  if (args.noWrite) return "not asked";
  if (isOutage(args)) return "kept: outage";
  return args.hasCalibration ? "write" : "remove";
}

/** The Overall line of a jev:eval run, and its exit code. */
export interface OverallResult {
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  /** 0 only for a full pass. */
  exitCode: 0 | 1;
  text: string;
}

/**
 * PASS only when every flag passed every check and the repeat test measured them. When all
 * flags pass but the repeat test was skipped or too small, the result is INCOMPLETE, never
 * PASS: whether Jev gives the same answer twice is part of being good enough. A run where
 * Jev left more than 5% of the replies unanswered is INCOMPLETE too, whatever the flags
 * show: its figures rest on the part Jev happened to answer, and the calibration file was
 * left as it was, so a PASS would claim something npm run eval -- --judge jev doesn't use.
 */
export function overallResult(
  outcomes: ReadonlyArray<Pick<FlagOutcome, "status" | "flip">>,
  answers?: { sent: number; unanswered: number },
): OverallResult {
  const passed = outcomes.filter((o) => o.status === "pass").length;
  const of = `${passed} of ${outcomes.length} flags pass`;
  if (answers && isOutage(answers)) {
    return {
      verdict: "INCOMPLETE",
      exitCode: 1,
      text:
        `INCOMPLETE: Jev left ${answers.unanswered} of ${answers.sent} replies unanswered (more than ${pct(MAX_UNANSWERED_SHARE)}), ` +
        `so this run doesn't count (${of} on the replies it answered). Run this again when Jev is reachable.`,
    };
  }
  if (passed < outcomes.length) return { verdict: "FAIL", exitCode: 1, text: `FAIL (${of})` };
  const notRun = outcomes.some((o) => flipState(o.flip) === "not run");
  const small = outcomes.find((o) => flipState(o.flip) === "too small");
  if (notRun || small) {
    const what = notRun
      ? "INCOMPLETE: flip test not run"
      : `INCOMPLETE: flip test too small (it compared ${small!.flip!.replies} replies; needs ${JEV_BARS.minFlipReplies})`;
    return {
      verdict: "INCOMPLETE",
      exitCode: 1,
      text: `${what}. All ${outcomes.length} flags pass the other checks, but Jev isn't validated until the repeat test shows it gives the same answer twice.`,
    };
  }
  return {
    verdict: "PASS",
    exitCode: 0,
    text: `PASS (${of}): Jev is good enough to use as the quick judge while working on the coach prompt (Opus stays the release judge).`,
  };
}

/**
 * What to do about flags without enough data. third_party_details is different from the
 * others: its "yes" cases (customer or suspect details in a reply) come only from the
 * hand-written seed replies, as no persona or bad-coach prompt produces them, so more
 * transcripts won't help.
 */
export function notEnoughDataAdvice(evaluations: ReadonlyArray<Pick<FlagEvaluation, "flag" | "status" | "labels" | "tuning" | "checking">>): string[] {
  const min = JEV_BARS.minEachClassPerPart;
  const transcripts: ReplyFlag[] = [];
  let seed = false;
  for (const e of evaluations) {
    if (e.status !== "not enough data") continue;
    const fewYes = e.tuning.positives < min || e.checking.positives < min;
    const fewNo = e.tuning.n - e.tuning.positives < min || e.checking.n - e.checking.positives < min;
    const fewLabels = e.labels < JEV_BARS.minLabels;
    if (e.flag === "third_party_details" && fewYes) seed = true;
    if (fewLabels || fewNo || (fewYes && e.flag !== "third_party_details")) transcripts.push(e.flag);
  }
  const advice: string[] = [];
  if (seed) {
    advice.push(
      `For third_party_details: its "yes" cases (customer or suspect details in a reply) come only from the hand-written replies in ${SEED_PATH}; ` +
        "the personas and the bad-coach prompts never produce them, so more transcripts won't help. Add more fictional ones there, " +
        "label them with npm run jev:label, then run this again.",
    );
  }
  if (transcripts.length) {
    advice.push(
      `For ${transcripts.join(", ")}: make more transcripts (npm run eval -- --judge none --only personas, also with --coach-prompt ` +
        "and a file in eval/bad-coach/), label them with npm run jev:label, then run this again.",
    );
  }
  return advice;
}

// ---- Keeping real data away from Jev ----

/** What jev:eval finds when it looks for the run file behind some gold replies. */
export type RunFileState = "missing" | "unreadable" | "sample" | "other" | "unknown";

/** Looks at a run file from npm run eval: is it there, can it be read, and which data did it use? */
export function readRunFileState(path: string): RunFileState {
  if (!existsSync(path)) return "missing";
  try {
    return runDataKind(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return "unreadable";
  }
}

/** Why a gold reply was kept away from Jev. */
export type LeftOutReason =
  | "admitted with --allow-real-data"
  | "not sample data"
  | "run file missing"
  | "run file unreadable"
  | "run file too old to say which data it used";

/**
 * The real-data guard in jev:eval, failing closed. A reply from an eval run goes to Jev only
 * if the gold set records that its run used the fictional sample team and tracker, or, for
 * gold files made before that was recorded, its run file is still there, can be read and
 * says so. A readable run file that says otherwise keeps the reply out either way. Seed
 * replies are hand-written and fictional, so they always go.
 */
export function checkRealData<T extends Pick<GoldItem, "id" | "source">>(
  items: readonly T[],
  runFile: (run: string) => RunFileState,
): { send: T[]; leftOut: Array<{ id: string; run: string; reason: LeftOutReason }> } {
  const states = new Map<string, RunFileState>();
  const stateOf = (run: string) => {
    if (!states.has(run)) states.set(run, runFile(run));
    return states.get(run)!;
  };
  const send: T[] = [];
  const leftOut: Array<{ id: string; run: string; reason: LeftOutReason }> = [];
  for (const item of items) {
    if ("seed" in item.source) {
      send.push(item);
      continue;
    }
    const { run, sampleData } = item.source;
    const state = stateOf(run);
    let reason: LeftOutReason | null = null;
    if (sampleData === false) reason = "admitted with --allow-real-data";
    else if (state === "other") reason = "not sample data";
    else if (sampleData === undefined) {
      if (state === "missing") reason = "run file missing";
      else if (state === "unreadable") reason = "run file unreadable";
      else if (state === "unknown") reason = "run file too old to say which data it used";
    }
    if (reason) leftOut.push({ id: item.id, run, reason });
    else send.push(item);
  }
  return { send, leftOut };
}

// ---- How far the gold labels can be trusted ----

/** How a person's hand labels compare with Opus's on one flag, over the randomly picked rows only. */
export interface LabelTrust {
  /** Randomly picked rows where the person answered this flag. */
  n: number;
  agree: number;
  /** agree / n, or null with no answers yet. */
  rate: number | null;
  /**
   * "too few": under 30 answers, reported but not judged. "untrustworthy": 30 or more, and
   * under 80% match Opus. "trusted": 30 or more, 80% or more match.
   */
  verdict: "too few" | "untrustworthy" | "trusted";
}

/**
 * Judges a flag's gold labels from the randomly picked rows of the hand-labelling sheet.
 * Only those rows count: the other rows were picked because Jev disagreed with the labels,
 * so they hold more label mistakes than the gold set as a whole and would understate it.
 */
export function labelTrust(agreement: { n: number; agree: number }): LabelTrust {
  const { n, agree } = agreement;
  const rate = n ? agree / n : null;
  if (n < JEV_BARS.minLabelChecks) return { n, agree, rate, verdict: "too few" };
  return { n, agree, rate, verdict: agree / n < JEV_BARS.minLabelAgreement ? "untrustworthy" : "trusted" };
}

/**
 * Marks a flag "labels untrustworthy" when the hand labels show its gold labels can't be
 * trusted, whatever its numbers: they were measured against those labels. Its other
 * reasons are kept after the main one.
 */
export function applyLabelTrust(evaluation: FlagEvaluation, trust: LabelTrust): FlagEvaluation {
  if (trust.verdict !== "untrustworthy") return evaluation;
  const reason =
    `the hand labels and Opus disagree too often on this flag (they match on ${trust.agree} of ${trust.n} randomly picked rows, ` +
    `${pct(trust.rate!)}; needs ${pct(JEV_BARS.minLabelAgreement)} or more), so tighten its definition in ${JEV_QUESTIONS_PATH}, ` +
    "relabel with npm run jev:label -- --relabel, and run this again";
  return { ...evaluation, status: "labels untrustworthy", reasons: [reason, ...evaluation.reasons] };
}

/** One line per flag on how the randomly picked hand labels compare with Opus's. */
export function formatLabelTrust(trust: Record<ReplyFlag, LabelTrust>): string[] {
  const width = Math.max(...REPLY_FLAGS.map((f) => f.length));
  return REPLY_FLAGS.map((flag) => {
    const t = trust[flag];
    const head = `${flag.padEnd(width)}  `;
    if (t.n === 0) return `${head}no answers yet`;
    const counts = `${t.agree} of ${t.n} match (${pct(t.rate!)})`;
    if (t.verdict === "too few") return `${head}${counts}: too few to judge yet (needs ${JEV_BARS.minLabelChecks})`;
    if (t.verdict === "untrustworthy") return `${head}${counts}: labels untrustworthy (needs ${pct(JEV_BARS.minLabelAgreement)} or more)`;
    return `${head}${counts}: fine`;
  });
}

// ---- Command line ----

/**
 * Lets an option take an optional number, which node's parseArgs can't express: a bare
 * `--more-labels` becomes `--more-labels=100`, and `--more-labels 20` becomes
 * `--more-labels=20`. Anything else after a bare option is left for parseArgs to judge.
 */
export function withOptionalNumber(args: readonly string[], option: string, defaultValue: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== option) {
      out.push(arg);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) {
      out.push(`${option}=${next}`);
      i++;
    } else {
      out.push(`${option}=${defaultValue}`);
    }
  }
  return out;
}

const STATUS_TEXT: Record<FlagStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  "not enough data": "NOT ENOUGH DATA",
  "labels untrustworthy": "LABELS UNTRUSTWORTHY",
};

/**
 * The Threshold cell: the fitted threshold, or for a flag the coach eval won't calibrate
 * ("not enough data", "labels untrustworthy") the rule it applies instead, raw 0.50, with
 * any fitted threshold marked as not used.
 */
function thresholdCell(e: FlagEvaluation, status: FlagStatus): string {
  if (!isUncalibrated(e) && !UNCALIBRATED.has(status)) return e.threshold === null ? "n/a" : two(e.threshold);
  return `raw ${two(RAW_THRESHOLD)}${e.threshold === null ? "" : ` (${two(e.threshold)} not used)`}`;
}

/** The Flip rate cell: "not run" when skipped, "not measured" when under 30 replies were compared. */
function flipCell(flip: FlipSummary | null): string {
  if (flip === null) return "not run";
  if (flip.pass === null) return `not measured (${flip.replies} compared)`;
  return `${pct(flip.rate!)} (${flip.flipped}/${flip.replies})`;
}

/** The results table, one line per flag, with a header line. */
export function formatResultsTable(rows: ReadonlyArray<FlagOutcome>): string[] {
  const num = (x: number | null) => (x === null ? "n/a" : two(x));
  const header = ["Flag", "Result", "Recall", "Precision", "AUROC", "ECE before → after", "Threshold", "Checked (yes)", "Flip rate"];
  const body = rows.map(({ evaluation: e, status, flip }) => [
    e.flag,
    STATUS_TEXT[status],
    num(e.metrics.recall),
    num(e.metrics.precision),
    num(e.metrics.auroc),
    `${num(e.metrics.eceRaw)} → ${num(e.metrics.eceCalibrated)}`,
    thresholdCell(e, status),
    `${e.checking.n} (${e.checking.positives})`,
    flipCell(flip),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  return [header, ...body].map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}
