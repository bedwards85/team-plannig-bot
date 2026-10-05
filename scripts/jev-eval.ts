/**
 * Checks Jev (TypeSafe AI) against the labelled gold set and tunes it: fits a
 * recalibration and a threshold per flag, then reports whether each flag is good enough
 * to use as the coach eval's quick judge. Costs a few cents a run (Jev charges $0.042 per
 * million input tokens; the script prints the actual cost).
 *
 *   npm run jev:eval                         check and write eval/jev-calibration.json; the first run also
 *                                            makes the hand-labelling sheet (see "Hand labels" below)
 *   npm run jev:eval -- --no-write           check only; leave the calibration file as it is
 *   npm run jev:eval -- --more-labels        also add another round of 100 rows to the hand-labelling sheet
 *   npm run jev:eval -- --context-turns 0 --no-write
 *                                            try sending Jev the whole conversation instead of the last four
 *                                            turns, without changing anything. If it scores better, run it again
 *                                            without --no-write: the calibration (and npm run eval -- --judge jev)
 *                                            then switches to it, and later runs keep it.
 *   npm run jev:eval -- --repeats 0          skip the repeat test (faster while rewording questions; the
 *                                            result is then INCOMPLETE, never PASS)
 *
 * Options:
 *   --gold <path>          gold set (default data/jev-gold/gold.jsonl, made by npm run jev:label)
 *   --human <path>         your hand labels (default data/jev-gold/human-labels.csv)
 *   --context-turns N      earlier turns sent with each reply (0 = the whole conversation). Default: the
 *                          setting recorded in eval/jev-calibration.json, or 4 if there is none
 *   --more-labels [N]      add a round of N rows to the hand-labelling sheet (default 100)
 *   --repeats N            times each sampled reply is asked again, to see if Jev changes its mind (default 30;
 *                          0 skips). Its answer from the main pass is compared too, so each reply has N+1 answers.
 *   --sample N             replies in that repeat test (default 50; the flip rate only counts from 30 replies)
 *   --concurrency N        Jev calls at once (default 8)
 *   --no-write             don't write eval/jev-calibration.json
 *   --out-dir <path>       where the full report goes (default data/jev-eval)
 *   --allow-real-data      real team data: only after the data-protection officer has agreed. Also sends
 *                          replies the check below would keep away from Jev.
 *
 * What it does, per flag (did_task, below_top_level, several_asks, filled_in_outcome,
 * third_party_details):
 *   - asks Jev about every gold reply once, without any calibration (raw probabilities);
 *   - splits the replies 70/30 by id: the 70% tunes a recalibration and the threshold that
 *     catches at least 95% of real cases there (a margin over the 90% bar, so the check on the
 *     30% isn't decided by chance), the 30% checks the result;
 *   - pass bars on the 30%: recall 0.90 or more, precision 0.60 or more, AUROC 0.85 or more,
 *     calibration error (ECE) 0.10 or less after recalibration, from at least 150 labels;
 *     and in the repeat test, the yes/no changes for 5% of replies or fewer, over at least 30
 *     replies. If the repeat test is skipped or has fewer replies, the result is INCOMPLETE.
 * The calibration file records how many earlier turns Jev was sent (npm run eval sends the
 * same) and each flag's result. npm run eval -- --judge jev lets Jev fail a chat only on flags
 * that passed every check here, the repeat test included; Jev's hits on the others are shown
 * there as hints. If Jev leaves more than 5% of the replies unanswered (an outage), the
 * calibration file is left exactly as it was.
 *
 * Hand labels: you answer Y or N in data/jev-gold/human-labels.csv in Excel, without seeing Opus's
 * or Jev's answers, and your answers win over Opus's. The sheet shows each reply under a short key
 * (r- and ten letters or digits) rather than its gold id, which could give the answer away, and
 * the whole conversation before it, as Opus saw it. The first run makes the sheet with one round
 * of 100 rows; after that it is only read, and --more-labels adds another round. Each round first
 * picks a random slice of the whole gold set, at least 30 replies, without looking at whether Jev
 * disagreed; a reply already in the sheet can be picked too, and then your answers on it count.
 * Then up to 70 replies where Jev and the labels disagree (the clearest cases of each flag, the
 * five flags taking turns) fill the round. New rows are mixed together in gold-set order. The
 * random slice gives a fair measure of how often you agree with Opus; which rows it holds is kept
 * in human-labels.meta.json next to the sheet, so the sheet gives nothing away. Once you have
 * answered 30 or more slice rows for a flag, if fewer than 80% match Opus the flag is marked
 * "labels untrustworthy": it can't pass and stays out of the calibration until its definition is
 * tightened and the gold set relabelled.
 *
 * Needs TYPESAFE_API_KEY in .env. It sends the gold set's replies to Jev (hosted in the US), so
 * it checks again that they are fictional, failing closed. A reply from an eval run is sent only
 * if the gold set records that the run used the fictional sample team and tracker, or, for gold
 * files made before that was recorded, its run file in data/eval is still there and says so.
 * Replies let into the gold set with --allow-real-data, and replies whose run file says it used
 * other data, are left out too. Every reply left out is counted with its reason (the full list is
 * in the report). Hand-written seed replies are always sent. --allow-real-data here sends
 * everything. Exit code 0 only if every flag passes, the repeat test included.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_CONTEXT_TURNS,
  JEV_CALIBRATION_PATH,
  JEV_QUESTIONS_PATH,
  JevCalibrationSchema,
  JevClassifier,
  calibrationContextTurns,
  hasJevCredentials,
  loadJevCalibration,
  loadJevQuestions,
  type JevCalibration,
  type JevQuestions,
} from "../src/adapters/jev/JevClassifier.js";
import { loadDotEnv } from "../src/config.js";
import {
  HUMAN_ROUND_ROWS,
  appendHumanLabelRows,
  appendRandomSliceIds,
  effectiveLabels,
  humanAgreement,
  humanLabelsMetaPath,
  maxDisagreementRows,
  readHumanLabels,
  readHumanLabelsMeta,
  selectForHumanLabelling,
  type HumanLabelRound,
} from "../src/eval/humanLabels.js";
import { ALLOW_REAL_DATA_TEXT, GOLD_PATH, HUMAN_LABELS_PATH, readGold, spreadPick, type GoldItem } from "../src/eval/jevGold.js";
import { JEV_JUDGE_FLAGS, jevCost, reliedOnText } from "../src/eval/jevJudge.js";
import {
  JEV_BARS,
  MAX_UNANSWERED_SHARE,
  MONITOR_TIMEOUT_MS,
  RAW_THRESHOLD,
  applyLabelTrust,
  buildCalibration,
  calibrationAction,
  calibrationVerdict,
  checkRealData,
  deciderFor,
  evaluateFlag,
  findDisagreements,
  flagOutcome,
  flipState,
  flipSummary,
  formatLabelTrust,
  formatResultsTable,
  isOutage,
  labelTrust,
  latestById,
  mostCommon,
  notEnoughDataAdvice,
  overallResult,
  readRunFileState,
  ruleFor,
  summariseLatency,
  withOptionalNumber,
  type FlagEvaluation,
  type FlagOutcome,
  type FlagRule,
  type FlipSummary,
  type LabelTrust,
  type LeftOutReason,
} from "../src/eval/jevReport.js";
import { isCalibrationSplit } from "../src/eval/jevMetrics.js";
import { mapLimit } from "../src/eval/support.js";
import { REPLY_FLAGS, type FlagResult, type ReplyFlag } from "../src/ports/classifier.js";

/** Where npm run eval writes its run files, and npm run jev:label reads them. */
const EVAL_RUNS_DIR = "data/eval";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

loadDotEnv();
let parsed;
try {
  parsed = parseArgs({
    // --more-labels takes an optional number, which parseArgs can't say on its own.
    args: withOptionalNumber(process.argv.slice(2), "--more-labels", HUMAN_ROUND_ROWS),
    options: {
      gold: { type: "string", default: GOLD_PATH },
      human: { type: "string", default: HUMAN_LABELS_PATH },
      // No default: it comes from the calibration file, so a plain run keeps the setting chosen.
      "context-turns": { type: "string" },
      "more-labels": { type: "string" },
      repeats: { type: "string", default: "30" },
      sample: { type: "string", default: "50" },
      concurrency: { type: "string", default: "8" },
      "no-write": { type: "boolean", default: false },
      "out-dir": { type: "string", default: "data/jev-eval" },
      "allow-real-data": { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(`${(error as Error).message}. See the top of scripts/jev-eval.ts for the options.`);
}
const { values } = parsed;

function wholeNumber(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number of ${min} or more (got "${value}").`);
  return n;
}
const repeats = wholeNumber("repeats", values.repeats, 0);
const sampleSize = wholeNumber("sample", values.sample, 1);
const concurrency = wholeNumber("concurrency", values.concurrency, 1);
/** Rows to add to the hand-labelling sheet this run, or null to only read it (once it exists). */
const moreLabels = values["more-labels"] === undefined ? null : wholeNumber("more-labels", values["more-labels"], 1);
const goldPath = values.gold;
const humanPath = values.human;
const metaPath = humanLabelsMetaPath(humanPath);

/**
 * The calibration npm run eval uses now. Its context setting is this run's default, so a
 * plain run keeps whatever was chosen (an earlier --context-turns run that wrote it).
 */
let calibrationInUse: JevCalibration | null = null;
let calibrationProblem: string | null = null;
try {
  calibrationInUse = loadJevCalibration();
} catch (error) {
  calibrationProblem = (error as Error).message.split("\n")[0] ?? "";
}
const turnsInUse = calibrationContextTurns(calibrationInUse);
const contextTurns = values["context-turns"] === undefined ? turnsInUse : wholeNumber("context-turns", values["context-turns"], 0);
const turnsText = (turns: number) => (turns === 0 ? "the whole conversation" : `the last ${turns} turns`);
const contextText = turnsText(contextTurns);
const contextSource =
  values["context-turns"] !== undefined
    ? "--context-turns"
    : calibrationInUse
      ? `the setting in ${JEV_CALIBRATION_PATH}`
      : "the default";

if (!hasJevCredentials()) {
  fail(
    "No Jev key found. Add a line TYPESAFE_API_KEY=<your key> to the .env file in this folder (see .env.example). " +
      "If the line is already there, make sure it doesn't start with #. Then run this again.",
  );
}

let questions: JevQuestions;
try {
  questions = loadJevQuestions();
} catch (error) {
  fail(`Could not read ${JEV_QUESTIONS_PATH}: ${(error as Error).message}`);
}

let gold: GoldItem[];
/** Every reply in the gold file, including any the real-data check below leaves out. */
let allGoldIds: string[];
try {
  const read = latestById(readGold(goldPath));
  gold = read.items;
  allGoldIds = gold.map((g) => g.id);
  if (read.duplicates) console.log(`Note: ${plural(read.duplicates, "reply", "replies")} repeated in ${goldPath}; using the latest label for each.`);
} catch (error) {
  fail(`Could not read the gold set: ${(error as Error).message}`);
}
if (gold.length === 0) {
  fail(`The gold set ${goldPath} is empty or missing. Make it first with npm run jev:label (see the top of scripts/jev-label.ts), then run this again.`);
}

/**
 * The real-data guard, checked again here because this run sends the replies to Jev, and
 * failing closed: see checkRealData. Without --allow-real-data, every reply it can't show
 * to be from the fictional sample data is left out, and each reason is counted.
 */
const realData = checkRealData(gold, (run) => readRunFileState(join(EVAL_RUNS_DIR, `${run}.json`)));
const REASON_TEXT: Record<LeftOutReason, string> = {
  "admitted with --allow-real-data": "let into the gold set with --allow-real-data",
  "not sample data": "its run file says it used a team or tracker other than the fictional sample",
  "run file missing": "its run file is missing, and the gold set doesn't record which data it used",
  "run file unreadable": "its run file can't be read, and the gold set doesn't record which data it used",
  "run file too old to say which data it used": "its run file is too old to say which team and tracker it used",
};
/** "  data/eval/eval-x.json: 12 replies, its run file is missing, ...": one line per run and reason. */
function leftOutLines(list: typeof realData.leftOut): string[] {
  const groups = new Map<string, { file: string; reason: LeftOutReason; n: number }>();
  for (const l of list) {
    const key = `${l.run}\u0000${l.reason}`;
    const g = groups.get(key) ?? { file: join(EVAL_RUNS_DIR, `${l.run}.json`), reason: l.reason, n: 0 };
    g.n++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => `  ${g.file}: ${plural(g.n, "reply", "replies")}, ${REASON_TEXT[g.reason]}`);
}
let leftOutForRealData = 0;
if (realData.leftOut.length && !values["allow-real-data"]) {
  gold = realData.send;
  leftOutForRealData = realData.leftOut.length;
  console.log(`Left out ${plural(leftOutForRealData, "reply", "replies")} to keep real data away from Jev (hosted in the US):`);
  for (const line of leftOutLines(realData.leftOut)) console.log(line);
  console.log(
    "To use runs like these, make fresh ones with the fictional sample team (cheap; see the top of scripts/jev-label.ts) " +
      `and label them with npm run jev:label. ${ALLOW_REAL_DATA_TEXT}. The report lists every reply left out.\n`,
  );
  if (gold.length === 0) fail("That leaves no replies to check, so nothing was sent to Jev.");
} else if (realData.leftOut.length) {
  console.log(`Sending ${plural(realData.leftOut.length, "reply", "replies")} the real-data check would have left out, because of --allow-real-data:`);
  for (const line of leftOutLines(realData.leftOut)) console.log(line);
  console.log("");
}

// Sheet keys (or, in older sheets, gold ids) are mapped back to gold ids here.
const human = readHumanLabels(humanPath, allGoldIds);
const effective = effectiveLabels(gold, human.labels);
const goldIds = new Set(gold.map((g) => g.id));
const humanAnswered = [...human.labels].filter(([id, l]) => goldIds.has(id) && Object.keys(l).length > 0).length;

/** Which sheet rows were picked at random. Unreadable means no rows can be added safely this run. */
let meta: { randomSliceIds: string[]; exists: boolean } = { randomSliceIds: [], exists: false };
let metaProblem: string | null = null;
try {
  meta = readHumanLabelsMeta(metaPath);
} catch (error) {
  metaProblem = (error as Error).message;
}
const randomSliceIds = new Set(meta.randomSliceIds);
// Only the randomly picked rows give a fair comparison with Opus: the others were picked because a label looked wrong.
const sliceAgreement = humanAgreement(
  gold.filter((g) => randomSliceIds.has(g.id)),
  human.labels,
);
const trust = Object.fromEntries(REPLY_FLAGS.map((f) => [f, labelTrust(sliceAgreement[f])])) as Record<ReplyFlag, LabelTrust>;

console.log(`Jev check · questions ${questions.version} · Jev reads ${contextText} before each reply (${contextSource})`);
if (calibrationProblem) {
  console.log(
    `Note: ${JEV_CALIBRATION_PATH} could not be read (${calibrationProblem}), so this run uses the default of ${DEFAULT_CONTEXT_TURNS} turns. ` +
      "A run without --no-write replaces the file.",
  );
}
console.log(`Gold set: ${gold.length} replies (${goldPath})`);
console.log(
  human.exists
    ? `Your labels: ${plural(human.labels.size, "row")}, ${humanAnswered} with at least one Y/N (${humanPath})`
    : `Your labels: none yet (${humanPath} will be created)`,
);
if (metaProblem) console.log(`\nWarning: ${metaProblem}`);

const otherVersion = gold.filter((g) => g.questionsVersion !== questions.version);
if (otherVersion.length) {
  const versions = [...new Set(otherVersion.map((g) => g.questionsVersion))].join(", ");
  console.log(
    `\nWarning: ${otherVersion.length} of ${gold.length} replies were labelled under questions version ${versions}, but ` +
      `${JEV_QUESTIONS_PATH} is now ${questions.version}. If you only reworded the questions for Jev, that is fine. ` +
      "If you changed what a flag means, Opus's labels follow the old meaning: relabel with npm run jev:label before trusting these results.",
  );
}
if (human.problems.length) {
  console.log(`\nSome of your labels in ${humanPath} could not be read (everything else was used):`);
  for (const p of human.problems.slice(0, 10)) console.log(`  - ${p}`);
  if (human.problems.length > 10) console.log(`  - and ${human.problems.length - 10} more like these.`);
}
// Rows for replies the real-data check left out aren't stray: they are just not used this run.
const allGoldIdSet = new Set(allGoldIds);
const strayIds = [...human.labels.keys()].filter((id) => !allGoldIdSet.has(id));
if (strayIds.length) {
  console.log(`Note: ${plural(strayIds.length, "row")} in ${humanPath} ${strayIds.length === 1 ? "doesn't" : "don't"} match any reply in the gold set and ${strayIds.length === 1 ? "is" : "are"} ignored.`);
}

// ---------- Ask Jev ----------

const jev = new JevClassifier({
  questions,
  calibration: null, // raw probabilities: this run is what makes the calibration
  timeoutMs: 10_000,
  maxRetries: 1,
  contextTurns, // 0 = the whole conversation, as in the calibration file
});

interface CallRecord {
  ms: number;
  ok: boolean;
  model: string | null;
  inputTokens: number;
}
const calls: CallRecord[] = [];

async function ask(item: GoldItem): Promise<FlagResult | null> {
  const started = performance.now();
  const result = await jev.flagReply({ context: item.context, reply: item.reply });
  calls.push({ ms: performance.now() - started, ok: result !== null, model: result?.model ?? null, inputTokens: result?.inputTokens ?? 0 });
  return result;
}

/** Runs the calls a few at a time, printing about five progress lines (at most one per 100 calls). */
async function askAll<T>(items: T[], toGold: (t: T) => GoldItem): Promise<Array<FlagResult | null>> {
  const step = Math.max(100, Math.ceil(items.length / 5 / 100) * 100);
  let done = 0;
  return mapLimit(items, concurrency, async (t) => {
    const result = await ask(toGold(t));
    done++;
    if (done % step === 0 && done < items.length) console.log(`  ${done} of ${items.length}`);
    return result;
  });
}

console.log(`\nAsking Jev about ${gold.length} replies (${concurrency} at a time)...`);
const results = await askAll(gold, (g) => g);
const rows = gold.map((item, i) => ({ item, effective: effective[i]!, result: results[i] ?? null }));
const answered = rows.filter((r) => r.result !== null);
const unanswered = rows.length - answered.length;
if (answered.length === 0) {
  fail(
    `Jev answered none of the ${rows.length} replies. Check TYPESAFE_API_KEY in .env and your internet connection, then run this again.` +
      (process.env.TYPESAFE_BASE_URL ? ` (TYPESAFE_BASE_URL is set to ${process.env.TYPESAFE_BASE_URL}; remove it unless you meant it.)` : ""),
  );
}
if (unanswered) console.log(`Jev could not answer ${unanswered} of ${rows.length} replies (timeouts or errors); they are left out of the results.`);

// ---------- Per-flag checks ----------

// A flag whose gold labels the hand labels show can't be trusted is marked so before
// anything else uses it: it can't pass, and its threshold stays out of the calibration.
const evaluations: FlagEvaluation[] = REPLY_FLAGS.map((flag) =>
  applyLabelTrust(
    evaluateFlag(
      flag,
      answered.map((r) => ({ id: r.item.id, p: r.result!.probabilities[flag], y: r.effective.labels[flag] })),
    ),
    trust[flag],
  ),
);
const evaluationOf = (flag: ReplyFlag) => evaluations.find((e) => e.flag === flag)!;
const rules = Object.fromEntries(REPLY_FLAGS.map((f) => [f, ruleFor(evaluationOf(f))])) as Record<ReplyFlag, FlagRule>;

// ---------- Repeat test ----------

const repeatSample = repeats > 0 ? spreadPick(answered, sampleSize) : [];
/** Why the repeat test has fewer replies than the flip rate needs: a small --sample, a small gold set, or Jev missing replies. */
function smallSampleReason(): string {
  if (sampleSize < JEV_BARS.minFlipReplies) return `it sampled only ${repeatSample.length}; raise --sample to ${JEV_BARS.minFlipReplies} or more`;
  if (rows.length < JEV_BARS.minFlipReplies) return `only ${rows.length} gold replies could be sent to Jev, so the gold set needs to be bigger`;
  return `Jev answered only ${answered.length} of the ${rows.length} gold replies (timeouts or errors); run this again when Jev is reachable`;
}
/** Per sampled reply: its answer from the main pass first, then each repeat (null if Jev didn't answer). */
let repeatResults: Array<Array<FlagResult | null>> = [];
let repeatCalls = 0;
let repeatsUnanswered = 0;
if (repeatSample.length) {
  console.log(
    `\nAsking Jev about ${repeatSample.length} of those replies ${repeats} more times each, to see if it changes its mind ` +
      `(each reply's first answer counts too, so ${repeats + 1} answers per reply)...`,
  );
  if (repeatSample.length < JEV_BARS.minFlipReplies) {
    console.log(`Note: that is fewer than the ${JEV_BARS.minFlipReplies} replies the flip rate needs, so it will be reported as not measured: ${smallSampleReason()}.`);
  }
  // Round by round (every reply once, then again), so repeats of one reply are spread over the
  // run rather than sent as a burst of identical requests at the same moment.
  const jobs = Array.from({ length: repeats }, () => repeatSample.map((r, i) => ({ r, i }))).flat();
  const flat = await askAll(jobs, (j) => j.r.item);
  repeatResults = repeatSample.map((r) => [r.result]);
  jobs.forEach((job, k) => repeatResults[job.i]!.push(flat[k] ?? null));
  repeatCalls = jobs.length;
  repeatsUnanswered = flat.filter((f) => f === null).length;
}
const flips: Record<ReplyFlag, FlipSummary | null> = Object.fromEntries(
  REPLY_FLAGS.map((flag) => [
    flag,
    repeatSample.length
      ? flipSummary(
          repeatResults.map((list) => list.flatMap((res) => (res ? [res.probabilities[flag]] : []))),
          deciderFor(evaluationOf(flag)),
        )
      : null,
  ]),
) as Record<ReplyFlag, FlipSummary | null>;
const outcomes: Array<FlagOutcome & { flag: ReplyFlag; reasons: string[] }> = REPLY_FLAGS.map((flag) => ({
  flag,
  evaluation: evaluationOf(flag),
  flip: flips[flag],
  ...flagOutcome(evaluationOf(flag), flips[flag]),
}));

// ---------- Results ----------

const latency = summariseLatency(calls);
const models = mostCommon(calls.flatMap((c) => (c.model ? [c.model] : [])));
const inputTokens = Math.round(calls.reduce((sum, c) => sum + c.inputTokens, 0));
const sec = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%`);

console.log("\n──────── Results ────────");
console.log(`Checked on the 30% of replies held back from tuning (the other 70% set the recalibration and threshold).\n`);
for (const line of formatResultsTable(outcomes)) console.log(`  ${line}`);
console.log(
  "\n  Recall: share of real cases Jev catches (needs 0.90+). Precision: share of Jev's flags that are real (needs 0.60+).\n" +
    "  AUROC: how well Jev ranks real cases above clean replies (needs 0.85+). ECE: how far Jev's probabilities are\n" +
    "  from how often it is right, before and after recalibration (needs 0.10 or less after). Threshold: the\n" +
    "  recalibrated probability at which a flag counts, chosen on the tuning 70% to catch 95% of real cases there.\n" +
    `  "raw ${RAW_THRESHOLD.toFixed(2)}": the flag isn't calibrated (not enough data, or labels untrustworthy), so npm run eval -- --judge jev\n` +
    `  counts it when Jev's own probability reaches ${RAW_THRESHOLD.toFixed(2)}; a threshold fitted anyway is shown as "not used", and that\n` +
    "  row's recall, precision and ECE after describe the fitted values, which are not used. Checked (yes): replies in the\n" +
    "  held-back 30% (how many of them are real cases). Flip rate: replies whose yes/no changed when asked again, counting\n" +
    `  each reply's first answer (needs 5% or less, over at least ${JEV_BARS.minFlipReplies} replies; "not measured" when fewer).`,
);
const notPassing = outcomes.filter((o) => o.status !== "pass");
if (notPassing.length) {
  console.log("\nWhy:");
  for (const o of notPassing) console.log(`  ${o.flag} (${o.status}): ${o.reasons.join("; ")}.`);
}

console.log(
  `\nSpeed: median ${sec(latency.p50Ms)}, 95th percentile ${sec(latency.p95Ms)} over ${latency.calls} calls (${concurrency} at a time, ` +
    `from this machine). ${latency.overLimit} took over ${sec(MONITOR_TIMEOUT_MS)}, the planned live monitor's limit (${pct(latency.shareOverLimit)})` +
    `${latency.failures ? `; ${latency.failures} failed` : ""}. Reported only, not a pass bar.`,
);
console.log(`Cost: ~$${jevCost(inputTokens).toFixed(4)} (${inputTokens.toLocaleString("en-GB")} input tokens).`);
const modelNames = Object.keys(models.counts);
if (modelNames.length > 1) {
  console.log(
    `Note: Jev answered with more than one model (${Object.entries(models.counts).map(([m, n]) => `${m}: ${n}`).join(", ")}). ` +
      `The calibration is for the most common one, ${models.value}.`,
  );
}
for (const note of jev.notes) console.log(`Jev note: ${note}`);

// ---------- How far the gold labels can be trusted ----------

const answeredSlice = REPLY_FLAGS.some((f) => trust[f].n > 0);
if (answeredSlice) {
  console.log(
    `\nYour Y/N against Opus's labels, on the rows of your sheet picked at random from the whole gold set ` +
      `(a flag is judged once it has ${JEV_BARS.minLabelChecks} answers, and needs ${Math.round(JEV_BARS.minLabelAgreement * 100)}% to match):`,
  );
  for (const line of formatLabelTrust(trust)) console.log(`  ${line}`);
} else if (human.exists) {
  console.log(
    meta.randomSliceIds.length
      ? `\nOpus's labels can't be checked yet: none of the rows in ${humanPath} picked at random has a Y/N answer. ` +
          `Each flag needs ${JEV_BARS.minLabelChecks} answers on those rows.`
      : `\nOpus's labels can't be checked yet: no rows in ${humanPath} are recorded as picked at random from the gold set ` +
          `(that record is ${metaPath}). Add a round with npm run jev:eval -- --more-labels and label it.`,
  );
}
// Every row you answered, as before. Kept for reference, but most rows were picked because
// Jev disagreed with the label, so they hold more of Opus's mistakes than the gold set does.
const agreement = humanAgreement(gold, human.labels);
const compared = REPLY_FLAGS.filter((f) => agreement[f].n > 0);
if (compared.length) {
  const labeller = mostCommon(gold.filter((g) => human.labels.has(g.id)).map((g) => g.labeller)).value ?? "the gold labels";
  console.log(
    `All the rows you answered, including those picked because Jev disagreed with the labels (so this figure is biased low), ` +
      `against the gold labels (${labeller}): ` +
      compared.map((f) => `${f} ${agreement[f].agree}/${agreement[f].n}`).join(" · ") +
      " agree. Where you differ, your answer is the one used above.",
  );
}

// ---------- Rows for you to label ----------

const disagreements = findDisagreements(
  answered.map((r) => ({ id: r.item.id, probabilities: r.result!.probabilities, labels: r.effective.labels })),
  rules,
);
const perFlag = REPLY_FLAGS.map((f) => [f, disagreements.filter((d) => d.flags.includes(f)).length] as const).filter(([, n]) => n > 0);
console.log(
  `\nJev and the labels disagree on ${disagreements.length} of ${answered.length} replies` +
    (perFlag.length ? ` (${perFlag.map(([f, n]) => `${f} ${n}`).join(", ")}).` : "."),
);

/** The sheet is made once, then only read: rows are added on request, so Excel edits are never at risk. */
const addRound = !human.exists || moreLabels !== null;
const roundRows = moreLabels ?? HUMAN_ROUND_ROWS;
let round: HumanLabelRound | null = null;
let added = 0;
let sliceIdsRecorded = meta.randomSliceIds.length;
if (addRound && metaProblem) {
  console.log(`No rows were added to ${humanPath}, because the record of which rows are picked at random can't be read (see the warning above).`);
} else if (addRound) {
  // A record left from a sheet that has since been removed is set aside below, so it doesn't count here.
  const alreadyInSlice = new Set(human.exists ? meta.randomSliceIds : []);
  round = selectForHumanLabelling({ items: gold, disagreements, alreadyInFile: new Set(human.labels.keys()), alreadyInSlice, rows: roundRows });
  let appended = false;
  try {
    // A record left from a sheet that has since been removed would count the new sheet's
    // disagreement rows as random ones, so it is set aside rather than added to.
    if (!human.exists && meta.randomSliceIds.length) {
      const aside = `${metaPath.replace(/\.json$/, "")}.before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      renameSync(metaPath, aside);
      sliceIdsRecorded = 0;
      console.log(`${metaPath} belonged to a sheet that is no longer there, so it was moved to ${aside} and a new record started.`);
    }
    const byId = new Map(gold.map((g) => [g.id, g]));
    // Every row shows the whole conversation before the reply, as Opus saw it when labelling.
    added = appendHumanLabelRows(humanPath, round.ids.map((id) => byId.get(id)!));
    appended = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(
      code === "EBUSY" || code === "EPERM" || code === "EACCES"
        ? `Could not add rows to ${humanPath}: it is probably open in Excel. Close it there (save your answers first) and run this again.`
        : `Could not add rows to ${humanPath}: ${(error as Error).message}`,
    );
  }
  // Every reply in the slice is recorded, those already in the sheet included, so their answers count.
  if (appended && round.randomSliceIds.length) {
    try {
      sliceIdsRecorded += appendRandomSliceIds(metaPath, round.randomSliceIds);
    } catch (error) {
      console.log(
        `Which rows were picked at random could not be recorded in ${metaPath} ` +
          `(${(error as Error).message}), so they won't count towards the check of Opus's labels.`,
      );
    }
  }
  const fromDisagreements = round.disagreementIds.length;
  const fromSlice = round.randomSliceIds.length - round.sliceAlreadyInSheet.length;
  const sliceInSheet = round.sliceAlreadyInSheet.length;
  if (added) {
    const parts = [
      ...(fromDisagreements ? [`${fromDisagreements} where Jev and the labels disagree (the clearest cases of each flag, the flags taking turns)`] : []),
      ...(fromSlice ? [`${fromSlice} picked at random from the whole gold set, which show fairly how often you and Opus agree`] : []),
    ];
    console.log(
      `Added ${plural(added, "reply", "replies")} to ${humanPath} for you to label: ${parts.join(", and ")}. ` +
        "The two kinds are mixed together in gold-set order and look the same, so treat every row alike.",
    );
    if (added < roundRows) console.log(`That is fewer than the ${roundRows} asked for because every other reply is already in the sheet.`);
  }
  if (appended && sliceInSheet) {
    console.log(
      `${plural(sliceInSheet, "row")} already in the sheet ${sliceInSheet === 1 ? "was" : "were"} picked at random this round too, ` +
        `so your answers on ${sliceInSheet === 1 ? "it" : "them"} now count towards the check of Opus's labels.`,
    );
  }
  if (added) {
    console.log(
      `Open it in Excel and put Y or N in each flag column, judging the reply yourself by the "true" and "false" wording ` +
        `for that flag in ${JEV_QUESTIONS_PATH} (leave a cell blank if unsure; the note column is for anything you want ` +
        "to remember). Save it with File > Save As > CSV UTF-8, then run npm run jev:eval again. Your answers replace Opus's labels. " +
        `Leave the id column and ${metaPath} as they are: they are how your answers are matched to the replies, and which rows were picked at random.`,
    );
    console.log("If Excel puts everything in one column, open the file from Excel with Data > From Text/CSV instead.");
  } else if (appended && round.ids.length === 0) {
    console.log(`Nothing new to add to ${humanPath}: every reply in the gold set is already in it.`);
  }
} else {
  console.log(
    `${humanPath} already exists, so it was only read, not changed. To add another round of up to ${HUMAN_ROUND_ROWS} rows ` +
      `(a random slice of the whole gold set, then up to ${maxDisagreementRows(HUMAN_ROUND_ROWS)} disagreements), ` +
      "run npm run jev:eval -- --more-labels (or --more-labels 50 for a smaller round).",
  );
}
const unlabelled = [...human.labels].filter(([id, l]) => goldIds.has(id) && Object.keys(l).length === 0).length;
if (unlabelled) console.log(`${plural(unlabelled, "row")} already in ${humanPath} still ${unlabelled === 1 ? "has" : "have"} no Y/N answers.`);

// ---------- Calibration file ----------

const createdAt = new Date().toISOString();
const calibration = models.value
  ? buildCalibration({ model: models.value, questionsVersion: questions.version, createdAt, contextTurns, outcomes })
  : null;
const action = calibrationAction({ noWrite: values["no-write"], sent: rows.length, unanswered, hasCalibration: calibration !== null });
let calibrationWritten: string | null = null;
if (action === "not asked") {
  console.log(
    `\nCalibration: not written (--no-write).` +
      (contextTurns !== turnsInUse
        ? ` npm run eval -- --judge jev still sends Jev ${turnsText(turnsInUse)}. If this run scored better, run it again ` +
          "without --no-write to switch to this setting."
        : ""),
  );
} else if (action === "kept: outage") {
  // Thresholds fitted on whichever replies Jev happened to answer would replace good ones, so nothing changes.
  const kept = existsSync(JEV_CALIBRATION_PATH);
  console.log(
    `\nCalibration: ${kept ? `kept ${JEV_CALIBRATION_PATH} exactly as it was` : "nothing written"}, because Jev did not answer ` +
      `${unanswered} of ${rows.length} replies (${pct(unanswered / rows.length)}; more than ${pct(MAX_UNANSWERED_SHARE)} looks like an outage). ` +
      "Run this again when Jev is reachable.",
  );
} else if (action === "remove") {
  // An older file would still switch on checks this run could not support, so it goes.
  const removed = existsSync(JEV_CALIBRATION_PATH);
  if (removed) rmSync(JEV_CALIBRATION_PATH);
  console.log(
    `\nCalibration: not written, because no flag yet has both enough labelled replies and labels that can be trusted.` +
      (removed ? ` Removed the old ${JEV_CALIBRATION_PATH}, so npm run eval -- --judge jev uses Jev's raw answers until a run writes a new one.` : ""),
  );
} else if (calibration) {
  writeFileSync(JEV_CALIBRATION_PATH, JSON.stringify(JevCalibrationSchema.parse(calibration), null, 2) + "\n");
  calibrationWritten = JEV_CALIBRATION_PATH;
  const flags = Object.keys(calibration.flags).join(", ");
  const switched = calibrationInUse && contextTurns !== turnsInUse ? ` (it sent ${turnsText(turnsInUse)} before)` : "";
  const reliedOn = JEV_JUDGE_FLAGS.filter((f) => calibration.flags[f]?.status === "pass");
  const hintsOnly = JEV_JUDGE_FLAGS.filter((f) => !reliedOn.includes(f));
  const relies = reliedOn.length
    ? `It lets Jev fail a chat only on ${reliedOnText(reliedOn)}, which passed every check here, the repeat test included` +
      (hintsOnly.length ? `; Jev's hits on ${reliedOnText(hintsOnly)} are shown there as hints only.` : ".")
    : "No check passed everything here (the repeat test included), so it won't let Jev fail any chat yet: Jev's hits are shown there as hints only.";
  console.log(
    `\nCalibration: wrote ${JEV_CALIBRATION_PATH} for ${flags} (model ${calibration.model}). npm run eval -- --judge jev uses it ` +
      `from now on, sending Jev ${contextText} before each reply${switched}. ${relies}`,
  );
}

// ---------- Full report ----------

const outDir = values["out-dir"];
mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, `report-${createdAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      createdAt,
      settings: {
        goldPath,
        humanPath,
        contextTurns: contextTurns === 0 ? "whole conversation" : contextTurns,
        contextTurnsFrom: contextSource,
        moreLabels,
        repeats,
        sample: repeatSample.length,
        concurrency,
        questionsVersion: questions.version,
        bars: JEV_BARS,
        monitorTimeoutMs: MONITOR_TIMEOUT_MS,
        allowRealData: values["allow-real-data"],
      },
      models: models.counts,
      counts: {
        gold: gold.length,
        leftOutForRealData,
        repeatCalls,
        repeatsUnanswered,
        answered: answered.length,
        unanswered,
        otherQuestionsVersion: otherVersion.length,
        humanRows: human.labels.size,
        humanAnswered,
        humanProblems: human.problems,
      },
      flags: outcomes.map((o) => ({
        flag: o.flag,
        status: o.status,
        // What the calibration file says, which decides whether npm run eval -- --judge jev relies on the flag.
        calibrationStatus: calibrationVerdict(o),
        reasons: o.reasons,
        evaluation: o.evaluation,
        flip: o.flip,
      })),
      latency,
      cost: { inputTokens, dollars: jevCost(inputTokens) },
      // Only the random slice is a fair measure of Opus's labels; allRows is biased low by the disagreement rows.
      humanAgreement: { randomSlice: sliceAgreement, allRows: agreement },
      labelTrust: trust,
      randomSliceRows: { recordedIn: metaPath, ids: sliceIdsRecorded },
      disagreements,
      humanRound: round
        ? {
            requested: roundRows,
            added,
            disagreementIds: round.disagreementIds,
            randomSliceIds: round.randomSliceIds,
            sliceAlreadyInSheet: round.sliceAlreadyInSheet,
          }
        : null,
      humanRowsAdded: added,
      // Every reply the real-data check would keep away from Jev, with why; "sent" only with --allow-real-data.
      realDataCheck: { sent: values["allow-real-data"], replies: realData.leftOut },
      calibrationFile: action,
      calibration: calibrationWritten ? { path: calibrationWritten, ...calibration } : null,
      items: rows.map((r) => ({
        id: r.item.id,
        labels: r.effective.labels,
        humanFlags: r.effective.humanFlags,
        labeller: r.item.labeller,
        part: isCalibrationSplit(r.item.id) ? "tuning" : "checking",
        raw: r.result?.probabilities ?? null,
        model: r.result?.model ?? null,
        ms: r.result?.ms ?? null,
      })),
      // The main-pass answer first, then each repeat.
      repeats: repeatSample.map((r, i) => ({
        id: r.item.id,
        raw: repeatResults[i]!.map((res) => res?.probabilities ?? null),
      })),
    },
    null,
    2,
  ),
);

const next: string[] = [];
// An outage comes first: the other advice rests on the replies Jev happened to answer.
if (isOutage({ sent: rows.length, unanswered })) {
  next.push(`Jev did not answer ${unanswered} of ${rows.length} replies: run this again when Jev is reachable, before acting on anything below.`);
}
next.push(...notEnoughDataAdvice(outcomes.map((o) => ({ ...o.evaluation, status: o.status }))));
if (outcomes.some((o) => o.status === "labels untrustworthy")) {
  next.push(
    `For flags whose labels are untrustworthy: tighten that flag's definition in ${JEV_QUESTIONS_PATH} (and bump its version), ` +
      "relabel with npm run jev:label -- --relabel, then run this again.",
  );
}
if (outcomes.some((o) => o.status === "fail")) {
  next.push(
    `For failing flags: label the rows in ${humanPath} first (Opus may be the one that's wrong), then try rewording that question in ${JEV_QUESTIONS_PATH} ` +
      "(and bump its version) and run this again.",
  );
}
const flipStateNow = flipState(flips[REPLY_FLAGS[0]] ?? null); // every flag compares the same replies
if (flipStateNow === "not run") {
  next.push("The repeat test was skipped (--repeats 0), so no flag counts as validated: run without --repeats 0 before relying on this result.");
} else if (flipStateNow === "too small") {
  const compared = flips[REPLY_FLAGS[0]]!.replies;
  const why =
    repeatSample.length < JEV_BARS.minFlipReplies
      ? smallSampleReason()
      : `Jev did not answer ${repeatsUnanswered} of the ${repeatCalls} repeat requests (timeouts or errors): run this again when Jev is reachable`;
  next.push(`The repeat test compared only ${compared} replies (needs ${JEV_BARS.minFlipReplies}) because ${why}.`);
}
const overall = overallResult(outcomes, { sent: rows.length, unanswered });
console.log(`\nFull report: ${reportPath}`);
console.log(`\nOverall: ${overall.text}`);
for (const line of next) console.log(`  ${line}`);
process.exit(overall.exitCode);
