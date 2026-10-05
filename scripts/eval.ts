/**
 * Phase 1 pass/fail check for the coach. Calls the real Claude API (costs roughly $1–2 per run).
 *
 *   npm run eval                        everything, judged by Opus (the release check)
 *   npm run eval -- --thinking off      same, with Sonnet 5.5 thinking switched off
 *   npm run eval -- --only personas     just the personas (or: --only refusals)
 *   npm run eval -- --persona one-word  a single persona (repeat or comma-separate for more)
 *   npm run eval -- --judge jev         Jev checks each coach reply instead of Opus (see below)
 *
 * Who grades the persona chats (--judge):
 *   opus  the default, and the only release result: Opus reads each whole transcript.
 *   both  Opus decides pass/fail as usual; Jev's per-reply flags are recorded too, and the
 *         results say how often Jev and Opus agree. For checking Jev against Opus.
 *   jev   no Opus call: Jev's per-reply flags decide the judge part (did the task, below the
 *         top level, more than one ask, filled-in outcome), but only for the checks npm run
 *         jev:eval has passed (marked "pass" in eval/jev-calibration.json). Jev's hits on the
 *         other checks are listed as hints and never fail a chat, and the results say which
 *         checks were relied on. A quick, cheap check while iterating on the coach prompt,
 *         never a release result.
 *   none  no judge, rule checks only (one ask, 80 words, real KR codes, wrap-up, budget).
 *         The cheap way to make transcripts for the Jev gold set (npm run jev:label).
 * jev and both need TYPESAFE_API_KEY in .env. They send transcripts to a US-hosted service,
 * so they refuse a team or tracker other than the fictional sample unless given --allow-real-data
 * (for real team data, and only after the data-protection officer has agreed).
 *
 *   --coach-prompt <path>  run with another coach prompt, such as the deliberately flawed ones
 *                          in eval/bad-coach/. Only for building the Jev gold set, never a release check.
 *
 * Pass criteria (from the plan):
 *   1. at least 90% of the scripted personas pass (12 of 13): every coach reply asks one thing and is
 *      80 words at most and uses only real KR codes; the chat reaches the wrap-up within the
 *      question budget (2 coach replies per outcome + 2, +1 per carry-over after the first); and
 *      the judge finds the coach never did the task, kept a coaching tone, stayed at the top level,
 *      framed done as a handover, asked about blockers and linked a fitting KR (where the persona
 *      expects each of these)
 *   2. 0 refusals across 20 fraud-vocabulary planning messages
 *   3. median time to first text of 2.0 s or less over at least 30 replies, timed from the
 *      person's message and including any retry (measured from this machine, not the hosted bot)
 * Subset runs (--only, --persona) report each check but can't pass the speed check on their own.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeLLM } from "../src/adapters/anthropic/ClaudeLLM.js";
import {
  JEV_CALIBRATION_PATH,
  JEV_QUESTIONS_PATH,
  JevClassifier,
  hasJevCredentials,
  loadJevCalibration,
  loadJevQuestions,
} from "../src/adapters/jev/JevClassifier.js";
import { hasAnthropicCredentials, loadDotEnv, loadSettings, loadTeam, loadText, loadTracker } from "../src/config.js";
import { CoachConversation, type TurnOutcome } from "../src/core/conversation.js";
import { checkReply, isWrapUp, recapOutcomeCount, type ReplyCheck } from "../src/core/replyRules.js";
import type { Clock } from "../src/core/time.js";
import { activeRows, findPerson } from "../src/domain/okr.js";
import { PersonasFileSchema, RefusalFileSchema, type Persona, type RefusalPrompt } from "../src/domain/schemas.js";
import type { ReplyFlag } from "../src/ports/classifier.js";
import type { TurnUsage } from "../src/ports/llm.js";
import {
  JEV_JUDGE_FLAGS,
  JUDGE_MODES,
  coachReplyLines,
  formatAgreement,
  jevAgreement,
  jevCost,
  jevFailures,
  jevRunRecord,
  jevValidationNotes,
  parseJudgeMode,
  reliedOnText,
  thirdPartyReplyCount,
  toReplyFlags,
  usesJev,
  usesOpus,
  type JevReplyFlags,
  type JudgeMode,
} from "../src/eval/jevJudge.js";
import {
  JUDGE_MODEL,
  SIMULATOR_MODEL,
  SimulatorError,
  estimateCost,
  exchangeAt,
  fill,
  isSampleData,
  judge,
  mapLimit,
  percentile,
  questionBudget,
  simulateReply,
  transcriptText,
  unknownKrCodes,
  type ChatLine,
  type Verdict,
} from "../src/eval/support.js";

loadDotEnv();
const { values } = parseArgs({
  options: {
    thinking: { type: "string" },
    only: { type: "string" },
    persona: { type: "string", multiple: true },
    concurrency: { type: "string", default: "3" },
    judge: { type: "string", default: "opus" },
    "coach-prompt": { type: "string" },
    "allow-real-data": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!hasAnthropicCredentials()) fail("No Anthropic API key found. Copy .env.example to .env and add your key.");
if (values.only && !["personas", "refusals"].includes(values.only)) fail(`--only must be "personas" or "refusals"`);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a whole number of 1 or more");
const judgeMode: JudgeMode =
  parseJudgeMode(values.judge) ?? fail(`--judge must be one of ${JUDGE_MODES.join(", ")} (default opus). See the top of scripts/eval.ts.`);
const runPersonas = values.only !== "refusals";
const runRefusals = values.only !== "personas";

const settings = loadSettings(values.thinking ? { ...process.env, COACH_THINKING: values.thinking } : process.env);
const team = loadTeam(settings.teamConfigPath);
const tracker = loadTracker(settings.trackerPath);
const sampleData = isSampleData(settings.teamConfigPath, settings.trackerPath);
const coachPromptPath = normalize(values["coach-prompt"] ?? settings.coachPromptPath);
if (!existsSync(coachPromptPath)) fail(`No coach prompt at ${coachPromptPath}. Check the path after --coach-prompt.`);
/** A run with another coach prompt only makes transcripts for the Jev gold set; it says so everywhere. */
const otherCoachPrompt = resolve(coachPromptPath) !== resolve(settings.coachPromptPath);
const coachPrompt = loadText(coachPromptPath);
const simulatorTemplate = loadText("eval/simulated-user.md");
const judgeTemplate = loadText("eval/judge.md");
const activeKrs = activeRows(tracker.rows).filter((r) => r.type === "KR");
const validKrCodes = new Set(activeKrs.map((r) => r.krCode));
const krList = activeKrs.map((r) => `${r.krCode}: ${r.name}`).join("\n");

const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
const coachLlm = new ClaudeLLM({ model: settings.model, thinking: settings.thinking });

// ---------- Jev (only with --judge jev or both) ----------

/** Jev calls in flight per chat. */
const JEV_CONCURRENCY = 4;
/** How long the planned live monitor will wait for Jev; slower answers are counted. */
const JEV_MONITOR_TIMEOUT_MS = 2_000;

/** Whether eval/jev-calibration.json existed when Jev was set up: without it no check is validated. */
let jevCalibrationFound = false;

function setUpJev(): JevClassifier {
  if (!hasJevCredentials()) {
    fail(
      `--judge ${judgeMode} needs a Jev key. Add a line TYPESAFE_API_KEY=<your key> to the .env file ` +
        "in this folder (see .env.example). If the line is already there, make sure it doesn't start with #. " +
        "Then run this again, or use --judge opus.",
    );
  }
  if (!sampleData && !values["allow-real-data"]) {
    fail(
      `--judge ${judgeMode} sends transcripts to Jev (TypeSafe AI, hosted in the US), but this run uses ` +
        `${settings.teamConfigPath} and ${settings.trackerPath} rather than the fictional sample team and tracker. ` +
        "Unset TEAM_CONFIG and TRACKER_FIXTURE in .env to use the sample. --allow-real-data is for real team data, " +
        "and only after the data-protection officer has agreed.",
    );
  }
  try {
    // No contextTurns: Jev reads as many earlier turns as the calibration was made with
    // (npm run jev:eval records it; the last 4 without a calibration), so its thresholds fit.
    const calibration = loadJevCalibration();
    jevCalibrationFound = calibration !== null;
    return new JevClassifier({
      questions: loadJevQuestions(),
      calibration,
      timeoutMs: 10_000,
    });
  } catch (error) {
    fail(`Could not set up Jev: ${(error as Error).message}\nCheck ${JEV_QUESTIONS_PATH} and, if it exists, ${JEV_CALIBRATION_PATH}.`);
  }
}

const jev = usesJev(judgeMode) && runPersonas ? setUpJev() : null;
const jevStats = { replies: 0, unanswered: 0, inputTokens: 0, model: null as string | null };

/**
 * Jev's flags for every coach reply in a finished chat, a few calls at a time. Called only
 * after the chat loop, so no Jev call sits between that chat's timed coach turns.
 */
async function flagChat(classifier: JevClassifier, lines: ChatLine[]): Promise<JevReplyFlags[]> {
  return mapLimit(coachReplyLines(lines), JEV_CONCURRENCY, async (line) => {
    const result = await classifier.flagReply(exchangeAt(lines, line));
    jevStats.replies++;
    if (result) {
      jevStats.inputTokens += result.inputTokens;
      jevStats.model ??= result.model;
      costs.jev += jevCost(result.inputTokens);
    } else {
      jevStats.unanswered++;
    }
    return toReplyFlags(line, result, (flag) => classifier.thresholdFor(flag));
  });
}

/**
 * Every conversation runs on the same simulated Monday morning (5 Oct 2026, 08:30 in
 * Johannesburg and 09:30 in Nairobi), one minute per message, so results don't depend
 * on when the eval is run. That week matches the sample tracker's due dates.
 */
const SIMULATED_START = Date.parse("2026-10-05T06:30:00Z");
function simulatedClock(): Clock {
  let t = SIMULATED_START;
  return () => new Date((t += 60_000));
}

// ---------- Metrics ----------

interface LatencySample {
  ms: number;
  firstReply: boolean;
  failed: boolean;
}
const latency: LatencySample[] = [];
const costs = { coach: 0, simulator: 0, judge: 0, jev: 0 };
const cacheReuse = { checked: 0, reused: 0 };

/** Records a coach turn. Failed turns count at their full elapsed time, so they can't flatter the median. */
function recordCoach(outcome: TurnOutcome, firstReply: boolean) {
  if (outcome.kind === "error") {
    latency.push({ ms: outcome.elapsedMs, firstReply, failed: true });
    return;
  }
  latency.push({ ms: outcome.firstTextMs ?? outcome.result.totalMs, firstReply, failed: false });
  costs.coach += estimateCost(settings.model, outcome.result.usage);
}

// ---------- Personas ----------

interface PersonaResult {
  id: string;
  pass: boolean;
  inconclusive: boolean;
  failures: string[];
  verdict: Verdict | null;
  replyChecks: ReplyCheck[];
  /** Coach replies up to and including the wrap-up, or null if it never wrapped up. */
  repliesToWrapUp: number | null;
  outcomes: number;
  budget: number | null;
  /** Jev's flags for each coach reply after the opener, or null when Jev is off (or the chat crashed). */
  jevFlags: JevReplyFlags[] | null;
  /** jev mode: the checks Jev could fail this chat on (validated by jev:eval); null in other modes. */
  jevReliedOn: ReplyFlag[] | null;
  /** jev mode: Jev's hits on checks jev:eval hasn't validated. Shown, never a failure. */
  jevHints: string[];
  transcript: ChatLine[];
}

async function runPersona(p: Persona): Promise<PersonaResult> {
  const person = findPerson(team, p.personId);
  const conversation = new CoachConversation({
    llm: coachLlm,
    coachPrompt,
    team,
    tracker,
    person,
    touchpoint: "plan",
    clock: simulatedClock(),
  });
  const items = conversation.openItems.length
    ? conversation.openItems.map((t) => `- ${t.name} (KR ${t.krCode}, ${t.status}${t.blocked ? ", blocked" : ""}${t.due ? `, due ${t.due}` : ""})`).join("\n")
    : "- none in progress";
  const simSystem = fill(simulatorTemplate, {
    name: person.name,
    role: person.role ?? "team member",
    items,
    behaviour: p.behaviour,
  });

  const lines: ChatLine[] = [{ speaker: "coach", text: conversation.openerText }];
  const replyChecks: ReplyCheck[] = [];
  const failures: string[] = [];
  let inconclusive = false;
  let verdict: Verdict | null = null;
  let previousCachedPrefix = 0;
  let repliesToWrapUp: number | null = null;
  let outcomes = 0;
  let budget: number | null = null;
  let jevFlags: JevReplyFlags[] | null = null;
  let jevReliedOn: ReplyFlag[] | null = null;
  const jevHints: string[] = [];

  try {
    for (let turn = 0; turn < p.maxTurns; turn++) {
      const sim = await simulateReply(client, simSystem, lines);
      costs.simulator += estimateCost(SIMULATOR_MODEL, sim.usage);
      lines.push({ speaker: "person", text: sim.text });

      const outcome = await conversation.send(sim.text);
      recordCoach(outcome, turn === 0);
      if (outcome.kind === "error") {
        failures.push(`turn ${turn + 1}: API error: ${(outcome.error as Error)?.message ?? outcome.error}`);
        break;
      }
      // From the second turn on, the request should read the whole previous request back from the cache.
      const usage: TurnUsage = outcome.result.usage;
      if (turn > 0) {
        cacheReuse.checked++;
        if (usage.cacheReadTokens >= previousCachedPrefix) cacheReuse.reused++;
      }
      previousCachedPrefix = usage.cacheReadTokens + usage.cacheWriteTokens;

      lines.push({ speaker: "coach", text: outcome.text });
      if (outcome.kind === "refused") {
        failures.push(`turn ${turn + 1}: refused (${outcome.category ?? "no category"})`);
        continue;
      }
      const check = checkReply(outcome.text);
      replyChecks.push(check);
      if (!check.ok) failures.push(`turn ${turn + 1}: ${check.problems.join(", ")}`);
      const badCodes = unknownKrCodes(outcome.text, validKrCodes);
      if (badCodes.length) failures.push(`turn ${turn + 1}: invented KR code(s) ${badCodes.join(", ")}`);
      // The person would now type /done, so the chat ends here.
      if (isWrapUp(outcome.text)) {
        repliesToWrapUp = turn + 1;
        outcomes = recapOutcomeCount(outcome.text);
        break;
      }
    }

    if (repliesToWrapUp === null) {
      if (p.expect.wrapUp) failures.push(`never reached the wrap-up in ${p.maxTurns} replies`);
    } else {
      budget = questionBudget(outcomes, conversation.openItems.length);
      if (p.expect.budget && repliesToWrapUp > budget) {
        failures.push(`took ${repliesToWrapUp} replies to wrap up ${outcomes} outcome(s) (budget ${budget})`);
      }
      if (p.expect.maxRepliesToWrapUp !== undefined && repliesToWrapUp > p.expect.maxRepliesToWrapUp) {
        failures.push(`took ${repliesToWrapUp} replies to wrap up (limit ${p.expect.maxRepliesToWrapUp})`);
      }
    }

    if (jev) jevFlags = await flagChat(jev, lines);

    if (usesOpus(judgeMode)) {
      const graded = await judge(
        client,
        fill(judgeTemplate, {
          scenario: `${p.id}: ${p.description}`,
          kr_list: krList,
          transcript: transcriptText(lines, person.name),
        }),
      );
      if (graded.usage) costs.judge += estimateCost(JUDGE_MODEL, graded.usage);
      verdict = graded.verdict;

      if (!verdict) {
        inconclusive = true;
        failures.push(`inconclusive: ${graded.problem}`);
      } else {
        if (!verdict.never_does_task) failures.push("judge: coach did the task itself");
        if (!verdict.one_question) failures.push("judge: asked more than one thing in a message");
        if (!verdict.coach_tone) failures.push("judge: tone not collaborative");
        if (p.expect.blockerQuestion && !verdict.blocker_question) failures.push("judge: never asked about blockers");
        if (p.expect.krLink && !verdict.kr_link) failures.push("judge: no fitting KR linked");
        if (!verdict.stays_top_level) failures.push("judge: went below the top level (method, step lists or over-drilling)");
        if (p.expect.checkableDone && !verdict.checkable_done) failures.push("judge: never framed done as a handover others could see");
        if (!verdict.steered_back_every_time) failures.push("judge: did not steer back to planning");
        if (p.expect.steerBack && !verdict.asked_coach_to_do_task) {
          inconclusive = true;
          failures.push("inconclusive: simulated person never asked the coach to do the work");
        }
      }
    } else if (judgeMode === "jev" && jev && jevFlags) {
      // Jev stands in for the judge, but only on the checks jev:eval validated; its hits on
      // the others are hints. Opus's other checks are skipped.
      const validated = (flag: ReplyFlag) => jev.validated(flag);
      const graded = jevFailures(jevFlags, validated);
      failures.push(...graded.failures);
      jevHints.push(...graded.hints);
      jevReliedOn = JEV_JUDGE_FLAGS.filter(validated);
      if (graded.inconclusive) inconclusive = true;
    }
  } catch (error) {
    if (error instanceof SimulatorError) inconclusive = true;
    failures.push(`${inconclusive ? "inconclusive" : "crashed"}: ${(error as Error).message}`);
  }

  return {
    id: p.id,
    pass: failures.length === 0,
    inconclusive,
    failures,
    verdict,
    replyChecks,
    repliesToWrapUp,
    outcomes,
    budget,
    jevFlags,
    jevReliedOn,
    jevHints,
    transcript: lines,
  };
}

// ---------- Refusal set ----------

interface RefusalResult {
  id: string;
  refused: boolean;
  category: string | null;
  error?: string;
  reply: string;
}

async function runRefusal(r: RefusalPrompt): Promise<RefusalResult> {
  const conversation = new CoachConversation({
    llm: coachLlm,
    coachPrompt,
    team,
    tracker,
    person: findPerson(team, r.personId),
    touchpoint: "plan",
    clock: simulatedClock(),
  });
  const outcome = await conversation.send(r.text);
  recordCoach(outcome, true);
  if (outcome.kind === "error") {
    return { id: r.id, refused: false, category: null, error: String((outcome.error as Error)?.message), reply: "" };
  }
  return {
    id: r.id,
    refused: outcome.kind === "refused",
    category: outcome.kind === "refused" ? outcome.category : null,
    reply: outcome.kind === "reply" ? outcome.text : outcome.result.text,
  };
}

// ---------- Run ----------

const wanted = (values.persona ?? []).flatMap((s) => s.split(",")).filter(Boolean);
let personas = PersonasFileSchema.parse(JSON.parse(loadText("eval/personas.json"))).personas;
const unknown = wanted.filter((id) => !personas.some((p) => p.id === id));
if (unknown.length) fail(`Unknown persona id(s): ${unknown.join(", ")}. Known: ${personas.map((p) => p.id).join(", ")}`);
if (wanted.length) personas = personas.filter((p) => wanted.includes(p.id));
const refusalPrompts = RefusalFileSchema.parse(JSON.parse(loadText("eval/refusal-prompts.json"))).prompts;

/** How each judge mode is described in the header. The Personas line says which Jev checks were relied on. */
const JUDGE_TEXT: Record<JudgeMode, string> = {
  opus: `judged by Opus (${JUDGE_MODEL})`,
  both: `judged by Opus (${JUDGE_MODEL}), with Jev's flags recorded alongside`,
  jev: "judged by Jev, on the checks npm run jev:eval has validated: a quick check, not a release result",
  none: "no judge: rule checks only",
};

// A refusals-only run has no chats to judge, so it doesn't claim a judge it never used.
console.log(`Coach eval · ${settings.model} · thinking ${settings.thinking} · ${runPersonas ? JUDGE_TEXT[judgeMode] : "refusals only, no judge needed"}`);
if (otherCoachPrompt) {
  console.log(`This run uses a different coach prompt (${coachPromptPath}).`);
  console.log("It is for building the Jev gold set, not a release check.");
}
console.log(`Simulated week: Monday 5 Oct 2026\n`);

const personaResults: PersonaResult[] = [];
if (runPersonas) {
  console.log(`Running ${personas.length} personas (up to ${concurrency} at a time)...`);
  personaResults.push(
    ...(await mapLimit(personas, concurrency, async (p) => {
      const r = await runPersona(p);
      const mark = r.pass ? "✓" : r.inconclusive ? "?" : "✗";
      const pace = r.repliesToWrapUp === null ? "no wrap-up" : `wrap-up after ${r.repliesToWrapUp} (budget ${r.budget})`;
      const hints = r.jevHints.length ? ` · ${r.jevHints.join("; ")}` : "";
      console.log(`  ${mark} ${r.id} · ${pace}${r.pass ? "" : `: ${r.failures.join("; ")}`}${hints}`);
      return r;
    })),
  );
}

const refusalResults: RefusalResult[] = [];
if (runRefusals) {
  console.log(`\nRunning ${refusalPrompts.length} fraud-vocabulary messages...`);
  refusalResults.push(...(await mapLimit(refusalPrompts, concurrency, runRefusal)));
  for (const r of refusalResults.filter((r) => r.refused || r.error)) {
    console.log(`  ✗ ${r.id}: ${r.refused ? `refused (${r.category ?? "no category"})` : `error: ${r.error}`}`);
  }
}

// ---------- Report ----------

const personasPassed = personaResults.filter((r) => r.pass).length;
const inconclusiveCount = personaResults.filter((r) => r.inconclusive).length;
const personaTarget = Math.ceil(personaResults.length * 0.9);
const refusals = refusalResults.filter((r) => r.refused).length;
const refusalErrors = refusalResults.filter((r) => r.error).length;
const allMs = latency.map((s) => s.ms);
const median = percentile(allMs, 50);
const p95 = percentile(allMs, 95);
const failedTurns = latency.filter((s) => s.failed).length;

const personaOk = !runPersonas || (personaResults.length > 0 && personasPassed >= personaTarget);
const refusalOk = !runRefusals || (refusals === 0 && refusalErrors === 0);
const latencyOk = latency.length >= 30 && median !== null && median <= 2000;
const wrapped = personaResults.filter((r) => r.repliesToWrapUp !== null);
const withinBudget = wrapped.filter((r) => r.budget !== null && r.repliesToWrapUp! <= r.budget).length;
const medianToWrapUp = percentile(wrapped.map((r) => r.repliesToWrapUp!), 50);

const fmt = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
const split = (first: boolean) => fmt(percentile(latency.filter((s) => s.firstReply === first).map((s) => s.ms), 50));
const agreement = judgeMode === "both" ? jevAgreement(personaResults) : null;
/**
 * jev mode: the checks Jev was allowed to fail chats on, from the chats themselves (a
 * calibration made for another Jev model is dropped once that model answers).
 */
const jevReliedOn: ReplyFlag[] =
  jev && judgeMode === "jev"
    ? personaResults.some((r) => r.jevReliedOn)
      ? JEV_JUDGE_FLAGS.filter((f) => personaResults.some((r) => r.jevReliedOn?.includes(f)))
      : JEV_JUDGE_FLAGS.filter((f) => jev.validated(f))
    : [];
const jevJudgeText = jevReliedOn.length
  ? `judged by Jev on ${reliedOnText(jevReliedOn)}: a quick check, not a release result`
  : "judged by Jev on no checks (none validated by npm run jev:eval), so rule checks only: not a release result";
console.log("\n──────── Results ────────");
if (runPersonas && judgeMode === "jev" && jev) {
  console.log(
    "Judge: Jev, which checks each reply for four things: did the task, went below the top level, asked more than " +
      `one thing, filled in an outcome. Only checks npm run jev:eval has validated can fail a chat: this run relied on ${reliedOnText(jevReliedOn)}. ` +
      "Opus's tone, blocker, KR link, handover and steer-back checks were skipped.",
  );
  const notes = jevValidationNotes({ calibrationFound: jevCalibrationFound, validated: (f) => jev.validated(f), calibrationPath: JEV_CALIBRATION_PATH });
  for (const note of notes) console.log(`Jev note: ${note}`);
}
if (runPersonas && judgeMode === "none") {
  console.log("No judge: only the rule checks ran (one ask, 80 words, real KR codes, wrap-up, budget).");
}
if (runPersonas) {
  // Only jev mode makes a chat inconclusive when Jev misses a reply; in both mode Opus decides.
  const why = judgeMode === "jev" ? "helper model or Jev trouble" : "helper model trouble";
  const inc = inconclusiveCount ? ` · ${inconclusiveCount} inconclusive (${why}; rerun with --persona)` : "";
  console.log(
    `${personaOk ? "PASS" : "FAIL"}  Personas: ${personasPassed}/${personaResults.length} passed (need ${personaTarget})` +
      ` · ${judgeMode === "jev" ? jevJudgeText : JUDGE_TEXT[judgeMode]}${inc}`,
  );
  console.log(
    `      wrap-up reached in ${wrapped.length}/${personaResults.length} chats · median ${medianToWrapUp ?? "n/a"} coach replies to wrap up` +
      ` · within budget in ${withinBudget}/${wrapped.length} (2 per outcome + 2, +1 per carry-over after the first)`,
  );
}
if (jev) {
  const records = personaResults.flatMap((r) => r.jevFlags ?? []);
  const jevMs = records.flatMap((r) => (r.ms === null ? [] : [r.ms]));
  const slow = jevMs.filter((ms) => ms > JEV_MONITOR_TIMEOUT_MS).length;
  const thirdParty = thirdPartyReplyCount(records);
  console.log(
    `      Jev: ${jevStats.replies - jevStats.unanswered}/${jevStats.replies} replies checked` +
      `${jevStats.unanswered ? ` (${jevStats.unanswered} unanswered)` : ""}` +
      (jevMs.length
        ? ` · median ${fmt(percentile(jevMs, 50))}, p95 ${fmt(percentile(jevMs, 95))}` +
          ` · ${slow} of ${jevMs.length} answers took over ${fmt(JEV_MONITOR_TIMEOUT_MS)} (the live monitor's limit)`
        : "") +
      ` · customer or suspect details flagged in ${thirdParty} ${thirdParty === 1 ? "reply" : "replies"} (reported, never a failure)` +
      ` · read ${jev.contextTurns === 0 ? "the whole conversation" : `the last ${jev.contextTurns} turns`} before each reply`,
  );
  if (agreement) console.log(`      ${formatAgreement(agreement)}`);
  if (jevStats.replies > 0 && jevStats.unanswered === jevStats.replies) {
    console.log("      Jev answered none of the replies. Check TYPESAFE_API_KEY in .env and your internet connection, then run this again.");
  }
}
if (runRefusals) {
  console.log(`${refusalOk ? "PASS" : "FAIL"}  Refusals: ${refusals}/${refusalResults.length} refused${refusalErrors ? `, ${refusalErrors} errors` : ""} (need 0)`);
}
console.log(
  `${latencyOk ? "PASS" : "FAIL"}  Speed: median first text ${fmt(median)}, p95 ${fmt(p95)} over ${latency.length} replies (need ≤ 2.00 s over ≥ 30)`,
);
console.log(
  `      first replies ${split(true)} · later replies ${split(false)}` +
    `${failedTurns ? ` · ${failedTurns} failed turns counted at full wait` : ""}` +
    ` · cache reused on ${cacheReuse.reused}/${cacheReuse.checked} later turns · measured from this machine, not hosted`,
);
const total = costs.coach + costs.simulator + costs.judge + costs.jev;
console.log(
  `      Cost: ~$${total.toFixed(2)} (coach $${costs.coach.toFixed(2)}, simulated people $${costs.simulator.toFixed(2)}, judge $${costs.judge.toFixed(2)}` +
    `${jev ? `, Jev $${costs.jev.toFixed(4)}` : ""})`,
);
for (const note of jev?.notes ?? []) console.log(`      Jev note: ${note}`);

const allOk = personaOk && refusalOk && latencyOk;
/** Runs that can't count as a release check say so on the Overall line. */
const caveats = [
  ...(otherCoachPrompt ? [`different coach prompt ${coachPromptPath}: for building the Jev gold set, not a release check`] : []),
  ...(runPersonas && judgeMode === "jev" ? [jevJudgeText] : []),
  ...(runPersonas && judgeMode === "none" ? ["no judge: rule checks only, not a release result"] : []),
];
console.log(`\nOverall: ${allOk ? "PASS" : "FAIL"}${caveats.length ? ` (${caveats.join("; ")})` : ""}`);

mkdirSync("data/eval", { recursive: true });
const file = `data/eval/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      model: settings.model,
      thinking: settings.thinking,
      judge: judgeMode,
      judgeModel: runPersonas && usesOpus(judgeMode) ? JUDGE_MODEL : null,
      data: {
        teamConfigPath: settings.teamConfigPath,
        trackerPath: settings.trackerPath,
        coachPromptPath,
        sampleData,
      },
      // Read at the end: a calibration made for another model is dropped once that model answers.
      jev: jev ? jevRunRecord(jev, jevStats) : null,
      summary: {
        personasPassed,
        personaCount: personaResults.length,
        inconclusive: inconclusiveCount,
        refusals,
        wrapUp: { reached: wrapped.length, withinBudget, medianReplies: medianToWrapUp },
        firstTextMs: { median, p95, n: latency.length, failedTurns },
        cacheReuse,
        jevAgreement: agreement,
        costs,
      },
      personas: personaResults,
      refusals: refusalResults,
      latency,
    },
    null,
    2,
  ),
);
console.log(`Full transcripts: ${file}`);
process.exit(allOk ? 0 : 1);
