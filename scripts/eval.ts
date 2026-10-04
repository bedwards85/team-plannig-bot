/**
 * Phase 1 pass/fail check for the coach. Calls the real Claude API (costs roughly $1–2 per run).
 *
 *   npm run eval                        everything
 *   npm run eval -- --thinking off      same, with Sonnet 5.5 thinking switched off
 *   npm run eval -- --only personas     just the personas (or: --only refusals)
 *   npm run eval -- --persona one-word  a single persona (repeat or comma-separate for more)
 *
 * Pass criteria (from the plan):
 *   1. at least 9 of 10 scripted personas pass: every coach reply is one question at most and
 *      80 words at most, uses only real KR codes, and the judge finds the coach never did the task,
 *      kept a coaching tone, asked about blockers and linked a KR (where the persona expects it)
 *   2. 0 refusals across 20 fraud-vocabulary planning messages
 *   3. median time to first text of 2.0 s or less over at least 30 replies
 *      (measured from this machine, not from the hosted bot)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeLLM } from "../src/adapters/anthropic/ClaudeLLM.js";
import {
  hasAnthropicCredentials,
  loadDotEnv,
  loadSettings,
  loadTeam,
  loadText,
  loadTracker,
  type ThinkingMode,
} from "../src/config.js";
import { CoachConversation } from "../src/core/conversation.js";
import { checkReply, type ReplyCheck } from "../src/core/replyRules.js";
import { activeRows, findPerson } from "../src/domain/okr.js";
import { PersonasFileSchema, RefusalFileSchema, type Persona, type RefusalPrompt } from "../src/domain/schemas.js";
import type { TurnUsage } from "../src/ports/llm.js";
import {
  JUDGE_MODEL,
  SIMULATOR_MODEL,
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

if (!hasAnthropicCredentials()) {
  console.error("No Anthropic API key found. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const settings = loadSettings();
const thinking = (values.thinking ?? settings.thinking) as ThinkingMode;
const concurrency = Math.max(1, Number(values.concurrency));
const team = loadTeam(settings.teamConfigPath);
const tracker = loadTracker(settings.trackerPath);
const coachPrompt = loadText(settings.coachPromptPath);
const simulatorTemplate = loadText("eval/simulated-user.md");
const judgeTemplate = loadText("eval/judge.md");
const validKrCodes = new Set(activeRows(tracker.rows).filter((r) => r.type === "KR").map((r) => r.krCode));

const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });
const coachLlm = new ClaudeLLM({ model: settings.model, thinking });

const costs = { coach: 0, simulator: 0, judge: 0 };
const firstTextMs: number[] = [];
let cacheHits = 0;
let coachReplies = 0;

function recordCoach(firstText: number | null, usage: TurnUsage) {
  coachReplies++;
  if (firstText !== null) firstTextMs.push(firstText);
  if (usage.cacheReadTokens > 0) cacheHits++;
  costs.coach += estimateCost(settings.model, usage);
}

// ---------- Personas ----------

interface PersonaResult {
  id: string;
  pass: boolean;
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
  });
  const items = conversation.openItems.length
    ? conversation.openItems.map((t) => `- ${t.name} (KR ${t.krCode}, ${t.status}${t.due ? `, due ${t.due}` : ""})`).join("\n")
    : "- none";
  const simSystem = fill(simulatorTemplate, {
    name: person.name,
    role: person.role ?? "team member",
    items,
    behaviour: p.behaviour,
  });

  const lines: ChatLine[] = [{ speaker: "coach", text: conversation.openerText }];
  const replyChecks: ReplyCheck[] = [];
  const failures: string[] = [];

  for (let turn = 0; turn < p.turns; turn++) {
    const sim = await simulateReply(client, simSystem, lines);
    costs.simulator += estimateCost(SIMULATOR_MODEL, sim.usage);
    lines.push({ speaker: "person", text: sim.text });

    const outcome = await conversation.send(sim.text);
    if (outcome.kind === "error") {
      failures.push(`turn ${turn + 1}: API error: ${(outcome.error as Error)?.message ?? outcome.error}`);
      break;
    }
    recordCoach(outcome.result.firstTextMs, outcome.result.usage);
    if (outcome.kind === "refused") {
      failures.push(`turn ${turn + 1}: refused (${outcome.category ?? "no category"})`);
      lines.push({ speaker: "coach", text: outcome.text });
      continue;
    }
    lines.push({ speaker: "coach", text: outcome.text });
    const check = checkReply(outcome.text);
    replyChecks.push(check);
    if (!check.ok) failures.push(`turn ${turn + 1}: ${check.problems.join(", ")}`);
    const badCodes = unknownKrCodes(outcome.text, validKrCodes);
    if (badCodes.length) failures.push(`turn ${turn + 1}: invented KR code(s) ${badCodes.join(", ")}`);
  }

  const { verdict, usage } = await judge(
    client,
    fill(judgeTemplate, {
      scenario: `${p.id}: ${p.description}`,
      kr_codes: [...validKrCodes].join(", "),
      transcript: transcriptText(lines, person.name),
    }),
  );
  costs.judge += estimateCost(JUDGE_MODEL, usage);

  if (!verdict) failures.push("judge returned no verdict");
  else {
    if (!verdict.never_does_task) failures.push("judge: coach did the task itself");
    if (!verdict.coach_tone) failures.push("judge: tone not collaborative");
    if (p.expect.blockerQuestion && !verdict.blocker_question) failures.push("judge: never asked about blockers");
    if (p.expect.krLink && !verdict.kr_link) failures.push("judge: never linked a KR");
    if (p.expect.steerBack && verdict.steer_back === "no") failures.push("judge: did not steer back to planning");
  }

  return { id: p.id, pass: failures.length === 0, failures, verdict, replyChecks, transcript: lines };
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
  });
  const outcome = await conversation.send(r.text);
  if (outcome.kind === "error") {
    return { id: r.id, refused: false, category: null, error: String((outcome.error as Error)?.message), reply: "" };
  }
  recordCoach(outcome.result.firstTextMs, outcome.result.usage);
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
if (wanted.length) personas = personas.filter((p) => wanted.includes(p.id));
const refusalPrompts = RefusalFileSchema.parse(JSON.parse(loadText("eval/refusal-prompts.json"))).prompts;

console.log(`Coach eval · ${settings.model} · thinking ${thinking} · judge ${JUDGE_MODEL}\n`);

const personaResults: PersonaResult[] = [];
if (runPersonas) {
  console.log(`Running ${personas.length} personas (up to ${concurrency} at a time)...`);
  personaResults.push(
    ...(await mapLimit(personas, concurrency, async (p) => {
      const r = await runPersona(p).catch(
        (e): PersonaResult => ({
          id: p.id,
          pass: false,
          failures: [`crashed: ${(e as Error).message}`],
          verdict: null,
          replyChecks: [],
          transcript: [],
        }),
      );
      console.log(`  ${r.pass ? "✓" : "✗"} ${r.id}${r.pass ? "" : `: ${r.failures.join("; ")}`}`);
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
const personaTarget = Math.ceil(personaResults.length * 0.9);
const refusals = refusalResults.filter((r) => r.refused).length;
const refusalErrors = refusalResults.filter((r) => r.error).length;
const median = percentile(firstTextMs, 50);
const p95 = percentile(firstTextMs, 95);

const personaOk = !runPersonas || personasPassed >= personaTarget;
const refusalOk = !runRefusals || (refusals === 0 && refusalErrors === 0);
const latencyOk = firstTextMs.length >= 30 && median !== null && median <= 2000;

const fmt = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
console.log("\n──────── Results ────────");
if (runPersonas) {
  console.log(`${personaOk ? "PASS" : "FAIL"}  Personas: ${personasPassed}/${personaResults.length} passed (need ${personaTarget})`);
}
if (runRefusals) {
  console.log(`${refusalOk ? "PASS" : "FAIL"}  Refusals: ${refusals}/${refusalResults.length} refused${refusalErrors ? `, ${refusalErrors} errors` : ""} (need 0)`);
}
console.log(
  `${latencyOk ? "PASS" : "FAIL"}  Speed: median first text ${fmt(median)}, p95 ${fmt(p95)} over ${firstTextMs.length} replies ` +
    `(need ≤ 2.00 s over ≥ 30) · cache hits ${cacheHits}/${coachReplies} · measured from this machine, not hosted`,
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
      thinking,
      judge: JUDGE_MODEL,
      summary: { personasPassed, personaCount: personaResults.length, refusals, firstTextMs: { median, p95, n: firstTextMs.length }, cacheHits, coachReplies, costs },
      personas: personaResults,
      refusals: refusalResults,
    },
    null,
    2,
  ),
);
console.log(`Full transcripts: ${file}`);
process.exit(allOk ? 0 : 1);
