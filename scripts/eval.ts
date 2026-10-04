/**
 * Phase 1 pass/fail check for the coach. Calls the real Claude API (costs roughly $1–2 per run).
 *
 *   npm run eval                        everything
 *   npm run eval -- --thinking off      same, with Sonnet 5.5 thinking switched off
 *   npm run eval -- --only personas     just the personas (or: --only refusals)
 *   npm run eval -- --persona one-word  a single persona (repeat or comma-separate for more)
 *
 * Pass criteria (from the plan):
 *   1. at least 9 of 10 scripted personas pass: every coach reply asks one thing and is 80 words
 *      at most, uses only real KR codes, and the judge finds the coach never did the task, kept a
 *      coaching tone, asked about blockers and linked a fitting KR (where the persona expects it)
 *   2. 0 refusals across 20 fraud-vocabulary planning messages
 *   3. median time to first text of 2.0 s or less over at least 30 replies, timed from the
 *      person's message and including any retry (measured from this machine, not the hosted bot)
 * Subset runs (--only, --persona) report each check but can't pass the speed check on their own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeLLM } from "../src/adapters/anthropic/ClaudeLLM.js";
import { hasAnthropicCredentials, loadDotEnv, loadSettings, loadTeam, loadText, loadTracker } from "../src/config.js";
import { CoachConversation, type TurnOutcome } from "../src/core/conversation.js";
import { checkReply, type ReplyCheck } from "../src/core/replyRules.js";
import type { Clock } from "../src/core/time.js";
import { activeRows, findPerson } from "../src/domain/okr.js";
import { PersonasFileSchema, RefusalFileSchema, type Persona, type RefusalPrompt } from "../src/domain/schemas.js";
import type { TurnUsage } from "../src/ports/llm.js";
import {
  JUDGE_MODEL,
  SIMULATOR_MODEL,
  SimulatorError,
  estimateCost,
  fill,
  judge,
  mapLimit,
  percentile,
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

const settings = loadSettings(values.thinking ? { ...process.env, COACH_THINKING: values.thinking } : process.env);
const team = loadTeam(settings.teamConfigPath);
const tracker = loadTracker(settings.trackerPath);
const coachPrompt = loadText(settings.coachPromptPath);
const simulatorTemplate = loadText("eval/simulated-user.md");
const judgeTemplate = loadText("eval/judge.md");
const activeKrs = activeRows(tracker.rows).filter((r) => r.type === "KR");
const validKrCodes = new Set(activeKrs.map((r) => r.krCode));
const krList = activeKrs.map((r) => `${r.krCode}: ${r.name}`).join("\n");

const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
const coachLlm = new ClaudeLLM({ model: settings.model, thinking: settings.thinking });

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
const costs = { coach: 0, simulator: 0, judge: 0 };
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
    ? conversation.openItems.map((t) => `- ${t.name} (KR ${t.krCode}, ${t.status}${t.due ? `, due ${t.due}` : ""})`).join("\n")
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

  try {
    for (let turn = 0; turn < p.turns; turn++) {
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
    }

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
      if (!verdict.steered_back_every_time) failures.push("judge: did not steer back to planning");
      if (p.expect.steerBack && !verdict.asked_coach_to_do_task) {
        inconclusive = true;
        failures.push("inconclusive: simulated person never asked the coach to do the work");
      }
    }
  } catch (error) {
    if (error instanceof SimulatorError) inconclusive = true;
    failures.push(`${inconclusive ? "inconclusive" : "crashed"}: ${(error as Error).message}`);
  }

  return { id: p.id, pass: failures.length === 0, inconclusive, failures, verdict, replyChecks, transcript: lines };
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

const runPersonas = values.only !== "refusals";
const runRefusals = values.only !== "personas";
const wanted = (values.persona ?? []).flatMap((s) => s.split(",")).filter(Boolean);
let personas = PersonasFileSchema.parse(JSON.parse(loadText("eval/personas.json"))).personas;
const unknown = wanted.filter((id) => !personas.some((p) => p.id === id));
if (unknown.length) fail(`Unknown persona id(s): ${unknown.join(", ")}. Known: ${personas.map((p) => p.id).join(", ")}`);
if (wanted.length) personas = personas.filter((p) => wanted.includes(p.id));
const refusalPrompts = RefusalFileSchema.parse(JSON.parse(loadText("eval/refusal-prompts.json"))).prompts;

console.log(`Coach eval · ${settings.model} · thinking ${settings.thinking} · judge ${JUDGE_MODEL}`);
console.log(`Simulated week: Monday 5 Oct 2026\n`);

const personaResults: PersonaResult[] = [];
if (runPersonas) {
  console.log(`Running ${personas.length} personas (up to ${concurrency} at a time)...`);
  personaResults.push(
    ...(await mapLimit(personas, concurrency, async (p) => {
      const r = await runPersona(p);
      const mark = r.pass ? "✓" : r.inconclusive ? "?" : "✗";
      console.log(`  ${mark} ${r.id}${r.pass ? "" : `: ${r.failures.join("; ")}`}`);
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

const fmt = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
const split = (first: boolean) => fmt(percentile(latency.filter((s) => s.firstReply === first).map((s) => s.ms), 50));
console.log("\n──────── Results ────────");
if (runPersonas) {
  const inc = inconclusiveCount ? ` · ${inconclusiveCount} inconclusive (helper model trouble; rerun with --persona)` : "";
  console.log(`${personaOk ? "PASS" : "FAIL"}  Personas: ${personasPassed}/${personaResults.length} passed (need ${personaTarget})${inc}`);
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
const total = costs.coach + costs.simulator + costs.judge;
console.log(
  `      Cost: ~$${total.toFixed(2)} (coach $${costs.coach.toFixed(2)}, simulated people $${costs.simulator.toFixed(2)}, judge $${costs.judge.toFixed(2)})`,
);

const allOk = personaOk && refusalOk && latencyOk;
console.log(`\nOverall: ${allOk ? "PASS" : "FAIL"}`);

mkdirSync("data/eval", { recursive: true });
const file = `data/eval/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      model: settings.model,
      thinking: settings.thinking,
      judge: JUDGE_MODEL,
      summary: {
        personasPassed,
        personaCount: personaResults.length,
        inconclusive: inconclusiveCount,
        refusals,
        firstTextMs: { median, p95, n: latency.length, failedTurns },
        cacheReuse,
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
