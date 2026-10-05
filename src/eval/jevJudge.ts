/**
 * Jev as the coach eval's judge: turning per-reply flag probabilities into pass/fail lines
 * and comparing them with the Opus judge. Pure functions, so the rules are easy to test;
 * scripts/eval.ts does the calls.
 *
 * Jev is a quick check for prompt iteration. Opus stays the release judge.
 */
import type { JevClassifier } from "../adapters/jev/JevClassifier.js";
import { REPLY_FLAGS, type FlagProbabilities, type FlagResult, type ReplyFlag } from "../ports/classifier.js";
import type { ChatLine, Verdict } from "./support.js";

/**
 * Who grades the persona chats:
 * - opus: the Opus judge reads each transcript (the release check)
 * - both: Opus decides pass/fail; Jev's flags are recorded too and agreement is reported
 * - jev: Jev's per-reply flags stand in for the judge (a quick check, not a release result)
 * - none: rule checks only (the cheap way to make transcripts for the Jev gold set)
 */
export const JUDGE_MODES = ["opus", "both", "jev", "none"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export function parseJudgeMode(value: string): JudgeMode | null {
  const v = value.trim().toLowerCase();
  return (JUDGE_MODES as readonly string[]).includes(v) ? (v as JudgeMode) : null;
}

export const usesOpus = (mode: JudgeMode): boolean => mode === "opus" || mode === "both";
export const usesJev = (mode: JudgeMode): boolean => mode === "jev" || mode === "both";

/** Jev's answer for one coach reply in an eval chat. */
export interface JevReplyFlags {
  /** Index of the reply in the transcript. Line 0 is the fixed opener and is never checked. */
  line: number;
  /** Null when Jev could not answer (timeout, error or an incomplete answer). */
  probabilities: FlagProbabilities | null;
  /** Flags at or above their threshold. */
  flagged: ReplyFlag[];
  /** Whole milliseconds Jev took, retries included; null when it did not answer. */
  ms: number | null;
}

/** Transcript lines Jev should check: every coach reply after the fixed opener that has any text. */
export function coachReplyLines(lines: ChatLine[]): number[] {
  return lines.flatMap((l, i) => (i > 0 && l.speaker === "coach" && l.text.trim() ? [i] : []));
}

/** The flags whose probability reaches that flag's threshold, in the standard order. */
export function flaggedFlags(probabilities: FlagProbabilities, thresholdFor: (flag: ReplyFlag) => number): ReplyFlag[] {
  return REPLY_FLAGS.filter((f) => probabilities[f] >= thresholdFor(f));
}

/** Turns one classifier answer (or no answer) into the record kept for the reply. */
export function toReplyFlags(
  line: number,
  result: FlagResult | null,
  thresholdFor: (flag: ReplyFlag) => number,
): JevReplyFlags {
  if (!result) return { line, probabilities: null, flagged: [], ms: null };
  const flagged = flaggedFlags(result.probabilities, thresholdFor);
  return { line, probabilities: result.probabilities, flagged, ms: Math.round(result.ms) };
}

/**
 * Reply number as the rule checks count it ("turn 3" is the coach's third answer): the
 * opener is line 0 and the chat alternates, so the coach's n-th answer is line 2n.
 */
export const replyNumber = (line: number): number => Math.ceil(line / 2);

/** What each failing flag means in a results line. The third-party flag is reported, never a failure. */
const FAILURE_TEXT: Record<Exclude<ReplyFlag, "third_party_details">, string> = {
  did_task: "did the task",
  below_top_level: "went below the top level",
  several_asks: "asked more than one thing",
  filled_in_outcome: "filled in an outcome, recipient or deadline the person never gave",
};

/** The flags that can fail a chat in jev mode, in the standard order. */
export const JEV_JUDGE_FLAGS = Object.keys(FAILURE_TEXT) as Array<keyof typeof FAILURE_TEXT>;

/** Start of a hint line: Jev flagged something on a check jev:eval hasn't validated. */
export const JEV_HINT_PREFIX = "jev hint, not validated by jev:eval";

export interface JevChatResult {
  /** Plain-English failures, one per failing validated flag, plus an "inconclusive" line if Jev missed replies. */
  failures: string[];
  /** The same lines for flags jev:eval hasn't validated: shown, but they never fail a chat. */
  hints: string[];
  /** Replies Jev could not answer. */
  unanswered: number;
  /** True when Jev missed a reply and some flag relied on: a missed reply could hide a failure. */
  inconclusive: boolean;
  /** Replies flagged for customer or suspect details: reported only. */
  thirdPartyReplies: number;
}

/** Replies Jev flagged for customer or suspect details. Reported in every mode, never a failure. */
export function thirdPartyReplyCount(records: readonly JevReplyFlags[]): number {
  return records.filter((r) => r.flagged.includes("third_party_details")).length;
}

/**
 * Pass/fail lines for one chat when Jev is the judge. Only flags npm run jev:eval has
 * validated can fail the chat; hits on the others become hints, so an unproven check can
 * neither fail a chat nor be mistaken for a clean one. A reply Jev couldn't answer makes the
 * chat inconclusive only when some flag is relied on, as otherwise Jev decides nothing.
 */
export function jevFailures(records: JevReplyFlags[], validated: (flag: ReplyFlag) => boolean): JevChatResult {
  const failures: string[] = [];
  const hints: string[] = [];
  for (const flag of JEV_JUDGE_FLAGS) {
    const hits = records
      .filter((r) => r.flagged.includes(flag))
      .map((r) => `reply ${replyNumber(r.line)}, p=${r.probabilities![flag].toFixed(2)}`);
    if (!hits.length) continue;
    const text = `${FAILURE_TEXT[flag]} (${hits.join("; ")})`;
    if (validated(flag)) failures.push(`jev: ${text}`);
    else hints.push(`${JEV_HINT_PREFIX}: ${text}`);
  }
  const unanswered = records.filter((r) => r.probabilities === null).length;
  const inconclusive = unanswered > 0 && JEV_JUDGE_FLAGS.some(validated);
  if (inconclusive) failures.push(`inconclusive: Jev could not answer ${unanswered} of ${records.length} replies`);
  return { failures, hints, unanswered, inconclusive, thirdPartyReplies: thirdPartyReplyCount(records) };
}

/** The flags jev mode relies on, as a phrase: "did_task and several_asks", or "no checks". */
export function reliedOnText(flags: readonly ReplyFlag[]): string {
  if (flags.length === 0) return "no checks";
  return flags.length === 1 ? flags[0]! : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
}

/**
 * Notes for a jev-mode run on which checks Jev may fail a chat on. Only flags whose result in
 * the calibration file is "pass" count; the rest are named, so nobody reads a pass as clean.
 */
export function jevValidationNotes(args: {
  /** False when eval/jev-calibration.json doesn't exist. */
  calibrationFound: boolean;
  validated: (flag: ReplyFlag) => boolean;
  calibrationPath: string;
}): string[] {
  if (!args.calibrationFound) {
    return [
      `There is no ${args.calibrationPath} yet, so none of Jev's checks has been validated by npm run jev:eval. ` +
        "Jev's flags are shown as hints and no chat fails on them; only the rule checks decide. Run npm run jev:eval first.",
    ];
  }
  const unvalidated = JEV_JUDGE_FLAGS.filter((f) => !args.validated(f));
  if (unvalidated.length === 0) return [];
  return [
    `Not validated by npm run jev:eval, so shown as hints that never fail a chat: ${reliedOnText(unvalidated)}. ` +
      `${args.calibrationPath} doesn't mark ${unvalidated.length === 1 ? "it" : "them"} as passed ` +
      "(it failed a bar or the repeat test there, the file was made before jev:eval recorded each check's result, or it is for other questions or another Jev model).",
  ];
}

/** Jev flags that match a judge criterion. The judge's field is true when the coach did well. */
export const AGREEMENT_PAIRS = [
  { flag: "did_task", criterion: "never_does_task", label: "did the task" },
  { flag: "several_asks", criterion: "one_question", label: "one ask" },
  { flag: "below_top_level", criterion: "stays_top_level", label: "top level" },
] as const satisfies ReadonlyArray<{ flag: ReplyFlag; criterion: keyof Verdict; label: string }>;
export type AgreementFlag = (typeof AGREEMENT_PAIRS)[number]["flag"];
export type JevAgreement = Record<AgreementFlag, { agree: number; n: number }>;

/**
 * Per chat, does Jev ("some reply was flagged") agree with Opus ("this check failed")?
 * A chat counts only if Opus gave a verdict and Jev answered every reply it was asked about
 * (and there was at least one), so a missing answer can't pass for a clean one.
 */
export function jevAgreement(chats: Array<{ verdict: Verdict | null; jevFlags: JevReplyFlags[] | null }>): JevAgreement {
  const out = Object.fromEntries(AGREEMENT_PAIRS.map((p) => [p.flag, { agree: 0, n: 0 }])) as JevAgreement;
  for (const { verdict, jevFlags } of chats) {
    if (!verdict || !jevFlags?.length || jevFlags.some((r) => r.probabilities === null)) continue;
    for (const { flag, criterion } of AGREEMENT_PAIRS) {
      const jevSaysFailed = jevFlags.some((r) => r.flagged.includes(flag));
      const opusSaysFailed = !verdict[criterion];
      out[flag].n++;
      if (jevSaysFailed === opusSaysFailed) out[flag].agree++;
    }
  }
  return out;
}

/** "Jev vs Opus, per chat: did the task 12/13 agree · one ask 11/13 · top level 10/13" */
export function formatAgreement(agreement: JevAgreement): string {
  // Every pair counts the same chats, so one zero means there was nothing to compare.
  if (AGREEMENT_PAIRS.every((p) => agreement[p.flag].n === 0)) {
    return "Jev vs Opus, per chat: no chats to compare (each needs an Opus verdict and a Jev answer for every reply)";
  }
  const parts = AGREEMENT_PAIRS.map((p, i) => `${p.label} ${agreement[p.flag].agree}/${agreement[p.flag].n}${i === 0 ? " agree" : ""}`);
  return `Jev vs Opus, per chat: ${parts.join(" · ")}`;
}

/**
 * The "jev" section of an eval run file. Settings are read from the classifier at the end
 * of the run, so the file records what Jev was actually given: the context setting it took
 * from the calibration file, and thresholds after any calibration made for another model
 * was dropped.
 */
export function jevRunRecord(
  jev: Pick<JevClassifier, "questionsVersion" | "contextTurns" | "thresholdFor" | "validated" | "notes">,
  stats: { model: string | null; inputTokens: number; replies: number; unanswered: number },
) {
  return {
    questionsVersion: jev.questionsVersion,
    model: stats.model,
    /** Earlier turns sent with each reply; 0 = the whole conversation. */
    contextTurns: jev.contextTurns,
    thresholds: Object.fromEntries(REPLY_FLAGS.map((f) => [f, jev.thresholdFor(f)])) as Record<ReplyFlag, number>,
    /** Flags jev:eval passed, which jev mode lets fail a chat; hits on the others were hints only. */
    validatedFlags: REPLY_FLAGS.filter((f) => jev.validated(f)),
    notes: [...jev.notes],
    inputTokens: stats.inputTokens,
    replies: stats.replies,
    unanswered: stats.unanswered,
  };
}

/** Jev charges $0.042 per million input tokens; output is free. */
export const JEV_DOLLARS_PER_MILLION_INPUT = 0.042;
export const jevCost = (inputTokens: number): number => (inputTokens * JEV_DOLLARS_PER_MILLION_INPUT) / 1_000_000;
