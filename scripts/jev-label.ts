/**
 * Builds the Jev gold set: Opus labels each coach reply from the eval runs (and the hand-written
 * seed replies) yes/no for the five Jev reply checks, using the same definitions Jev reads.
 * Calls the real Claude API, roughly 1 to 4 cents a reply; the script prints the actual cost.
 *
 *   npm run jev:label                          label every new reply in data/eval/*.json and eval/jev-seed.json
 *   npm run jev:label -- data/eval/<run>.json  only these run files (the seed replies are always included)
 *   npm run jev:label -- --limit 50            label at most 50 new replies: a cheap first look
 *   npm run jev:label -- --repeat-check 100    label 100 labelled replies again and report how often Opus
 *                                              agrees with itself: the best agreement Jev can be expected to reach
 *
 * Options:
 *   --concurrency <n>   replies labelled at once (default 4)
 *   --relabel           start the gold file again from these runs and the seed file, for example after
 *                       changing eval/jev-questions.json. The old file is kept next to it.
 *   --gold <path>       the gold file (default data/jev-gold/gold.jsonl)
 *   --allow-real-data   also use run files that were not made with the fictional sample team and
 *                       tracker, or that are too old to say. Only with the data protection officer's agreement.
 *
 * Labels are added to the gold file as they arrive, so running it again only labels what is new,
 * and stopping it part-way (Ctrl+C) keeps what was done. To finish a --relabel run that stopped
 * part-way, run it again without --relabel. Replies Opus could not label (refused,
 * cut off, unreadable) are listed and left out; running it again retries them.
 * Labels written by people in data/jev-gold/human-labels.csv are never touched, and win over these.
 *
 * Make the transcripts first, with the fictional sample team, for example:
 *   npm run eval -- --judge none --only personas
 *   npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/does-the-work.md
 *   npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/interrogator.md
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { JEV_QUESTIONS_PATH, loadJevQuestions, type JevQuestions } from "../src/adapters/jev/JevClassifier.js";
import { hasAnthropicCredentials, loadDotEnv, loadText } from "../src/config.js";
import { REPLY_FLAGS } from "../src/ports/classifier.js";
import type { TurnUsage } from "../src/ports/llm.js";
import {
  GOLD_PATH,
  LABEL_PROMPT_PATH,
  RunRefusedError,
  SEED_PATH,
  appendGold,
  flagDefinitions,
  formatPositiveRates,
  interleave,
  itemsFromRun,
  labelAgreement,
  labelPrompt,
  labelReply,
  loadSeedItems,
  newItems,
  positiveRates,
  readGold,
  spreadPick,
  toGoldItem,
  type FlagLabels,
  type GoldItem,
  type UnlabelledItem,
} from "../src/eval/jevGold.js";
import { JUDGE_MODEL, estimateCost, mapLimit } from "../src/eval/support.js";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

loadDotEnv();
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      concurrency: { type: "string", default: "4" },
      limit: { type: "string" },
      relabel: { type: "boolean", default: false },
      "repeat-check": { type: "string" },
      gold: { type: "string", default: GOLD_PATH },
      "allow-real-data": { type: "boolean", default: false },
    },
  });
} catch (error) {
  fail(`${(error as Error).message}. See the top of scripts/jev-label.ts for the options.`);
}
const { values, positionals } = parsed;

function wholeNumber(value: string | undefined, option: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${option} must be a whole number of 1 or more, got "${value}".`);
  return n;
}

if (!hasAnthropicCredentials()) fail("No Anthropic API key found. Copy .env.example to .env and add your key.");
const concurrency = wholeNumber(values.concurrency, "--concurrency")!;
const limit = wholeNumber(values.limit, "--limit");
const repeatCheck = wholeNumber(values["repeat-check"], "--repeat-check");
if (repeatCheck !== null && values.relabel) fail("Use --repeat-check or --relabel, not both.");
const goldPath = values.gold;
const allowRealData = values["allow-real-data"];

let questions: JevQuestions;
try {
  questions = loadJevQuestions();
} catch (error) {
  fail(`Could not read the Jev questions in ${JEV_QUESTIONS_PATH}: ${(error as Error).message}`);
}
const definitions = flagDefinitions(questions);
let template: string;
try {
  template = loadText(LABEL_PROMPT_PATH);
  // Fill it once now, so a mistake in the template stops the run here, not as a failure on every reply.
  labelPrompt(template, definitions, { context: [], reply: "" });
} catch (error) {
  fail(`Could not use the labelling prompt in ${LABEL_PROMPT_PATH}: ${(error as Error).message}`);
}
const client = new Anthropic({ maxRetries: 3, timeout: 120_000 });

let gold: GoldItem[];
try {
  gold = readGold(goldPath);
} catch (error) {
  fail(`Could not read the gold file: ${(error as Error).message}\nFix or delete that line, then run this again.`);
}

// ---------- Calling Opus ----------

const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
let calls = 0;
/** Set when a failure means every other call would fail too (bad key, no network): stop starting new ones. */
let stopReason: string | null = null;

function addUsage(u: TurnUsage): void {
  usage.inputTokens += u.inputTokens;
  usage.outputTokens += u.outputTokens;
  usage.cacheReadTokens += u.cacheReadTokens;
  usage.cacheWriteTokens += u.cacheWriteTokens;
}

/** Plain-English reason to stop the whole run, for API errors that will not go away by themselves. */
function stoppingProblem(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in .env.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not allowed to use ${JUDGE_MODEL}.`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `The Anthropic API does not know the model ${JUDGE_MODEL}.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API. Check the internet connection, then run this again.";
  }
  return null;
}

type Labelled = { labels: FlagLabels; notes: string } | { problem: string } | null;

/** One reply's labels from Opus, a problem to list, or null once the run is stopping. */
async function labelOne(item: UnlabelledItem): Promise<Labelled> {
  if (stopReason) return null;
  try {
    calls++;
    const result = await labelReply(client, labelPrompt(template, definitions, item));
    if (result.usage) addUsage(result.usage);
    return result.labels ? { labels: result.labels, notes: result.notes } : { problem: result.problem };
  } catch (error) {
    const stop = stoppingProblem(error);
    if (stop) {
      stopReason ??= stop;
      return null;
    }
    return { problem: `the Anthropic API failed: ${(error as Error).message}` };
  }
}

function costLine(): string {
  return `Opus cost: $${estimateCost(JUDGE_MODEL, usage).toFixed(2)} for ${calls} call${calls === 1 ? "" : "s"}.`;
}

function listProblems(problems: { id: string; problem: string }[]): void {
  if (problems.length === 0) return;
  console.log(
    `\n${problems.length} repl${problems.length === 1 ? "y" : "ies"} could not be labelled and were left out:`,
  );
  for (const p of problems.slice(0, 20)) console.log(`  ${p.id}: ${p.problem}`);
  if (problems.length > 20) console.log(`  …and ${problems.length - 20} more.`);
  console.log("Run npm run jev:label again (without --relabel) to retry them: replies already labelled are skipped.");
}

const yesFlags = (labels: FlagLabels): string => REPLY_FLAGS.filter((f) => labels[f]).join(", ") || "no flags";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---------- Repeat check: Opus against itself ----------

async function runRepeatCheck(n: number): Promise<void> {
  // The latest label for each reply, and only labels this labeller made with the current wording,
  // so the comparison really is the same model against itself.
  const latest = [...new Map(gold.map((g) => [g.id, g])).values()];
  const candidates = latest.filter((g) => g.labeller === JUDGE_MODEL && g.questionsVersion === questions.version);
  if (candidates.length === 0) {
    fail(
      gold.length
        ? `None of the ${latest.length} labelled replies in ${goldPath} were labelled by ${JUDGE_MODEL} with the current questions (${questions.version}). Run npm run jev:label -- --relabel first.`
        : `No labelled replies in ${goldPath} yet. Run npm run jev:label first.`,
    );
  }
  const picked = spreadPick(candidates, n, (g) => g.id);
  if (picked.length < n) {
    console.log(
      `Only ${picked.length} labelled replies were labelled by ${JUDGE_MODEL} with the current questions, so checking all of them.`,
    );
  }
  console.log(
    `Labelling ${picked.length} replies again with ${JUDGE_MODEL}, ${concurrency} at a time. The gold file is not changed.`,
  );

  const problems: { id: string; problem: string }[] = [];
  const pairs: { item: GoldItem; second: FlagLabels; notes: string }[] = [];
  await mapLimit(picked, concurrency, async (item) => {
    const result = await labelOne(item);
    if (!result) return;
    if ("problem" in result) {
      problems.push({ id: item.id, problem: result.problem });
      console.log(
        `  [${pairs.length + problems.length}/${picked.length}] ${item.id}: not labelled (${result.problem})`,
      );
      return;
    }
    pairs.push({ item, second: result.labels, notes: result.notes });
    const changed = REPLY_FLAGS.filter((f) => item.labels[f] !== result.labels[f]);
    console.log(
      `  [${pairs.length + problems.length}/${picked.length}] ${item.id}: ${changed.length ? `changed ${changed.join(", ")}` : "same"}`,
    );
  });
  if (stopReason) console.log(`\nStopped early: ${stopReason}`);
  listProblems(problems);
  if (pairs.length === 0) {
    console.log(`\nNo replies were labelled again, so there is nothing to compare. ${costLine()}`);
    process.exit(1);
  }

  const agreement = labelAgreement(pairs.map((p) => [p.item.labels, p.second]));
  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  console.log(`\nHow often the second Opus pass agreed with the first, over ${pairs.length} replies:`);
  for (const f of REPLY_FLAGS) {
    const a = agreement[f];
    const kappa = a.kappa === null ? "n/a" : a.kappa.toFixed(2);
    console.log(
      `  ${f.padEnd(20)} ${pct(a.rate).padStart(4)}  (kappa ${kappa}; ${a.noToYes} no→yes, ${a.yesToNo} yes→no)`,
    );
  }
  const allSame = pairs.filter((p) => REPLY_FLAGS.every((f) => p.item.labels[f] === p.second[f])).length;
  console.log(`  All five flags the same on ${allSame} of ${pairs.length} replies.`);
  console.log(
    "Opus's agreement with itself is about the best Jev can be expected to reach on each flag. Kappa is agreement " +
      "beyond chance (1 is perfect, 0 is no better than guessing): a flag well below 0.8 has a definition worth tightening.",
  );

  const file = join(dirname(goldPath), `repeat-check-${stamp()}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        labeller: JUDGE_MODEL,
        questionsVersion: questions.version,
        goldPath,
        replies: pairs.length,
        agreement,
        items: pairs.map((p) => ({
          id: p.item.id,
          first: p.item.labels,
          second: p.second,
          notes: p.notes || undefined,
        })),
        problems,
      },
      null,
      2,
    ),
  );
  console.log(`\nDetails: ${file}\n${costLine()}`);
}

// ---------- Labelling new replies ----------

/** The run files to read: those named on the command line, or every run in data/eval. */
function runFiles(): string[] {
  if (positionals.length) return positionals;
  if (!existsSync("data/eval")) return [];
  return readdirSync("data/eval")
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join("data/eval", f));
}

const REFUSAL_SHORT: Record<RunRefusedError["reason"], string> = {
  "too-old": "too old to show which team and tracker it used",
  "not-sample-data": "not made with the fictional sample team and tracker",
};

/** Reads the run files and the seed file, listing every run it skips and why. */
function collectItems(): UnlabelledItem[][] {
  const files = runFiles();
  console.log(
    `Reading ${files.length} eval run file${files.length === 1 ? "" : "s"} and the seed replies (${SEED_PATH}).`,
  );
  const groups: UnlabelledItem[][] = [];
  const refused: { file: string; reason: RunRefusedError["reason"] }[] = [];
  const unreadable: { file: string; problem: string }[] = [];
  for (const file of files) {
    let run: unknown;
    try {
      run = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      unreadable.push({
        file,
        problem: existsSync(file) ? `not valid JSON (${(error as Error).message})` : "no such file",
      });
      continue;
    }
    try {
      const items = itemsFromRun(run, basename(file, ".json"), { allowRealData });
      groups.push(items);
      const prompt = items[0] && "run" in items[0].source ? ` (coach prompt ${items[0].source.coachPrompt})` : "";
      console.log(`  ${file}: ${items.length} coach repl${items.length === 1 ? "y" : "ies"}${prompt}`);
      if (allowRealData) {
        // Say so whenever --allow-real-data let in a run the guard would have kept out.
        try {
          itemsFromRun(run, basename(file, ".json"), { allowRealData: false });
        } catch (error) {
          if (error instanceof RunRefusedError) {
            console.log(`    included only because of --allow-real-data: ${REFUSAL_SHORT[error.reason]}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof RunRefusedError) refused.push({ file, reason: error.reason });
      else unreadable.push({ file, problem: (error as Error).message.split("\n")[0]! });
    }
  }
  try {
    const seed = loadSeedItems();
    groups.push(seed);
    console.log(`  ${SEED_PATH}: ${seed.length} hand-written replies`);
  } catch (error) {
    fail(`Could not read ${SEED_PATH}: ${(error as Error).message}`);
  }

  if (unreadable.length) {
    console.log(`\nSkipped ${unreadable.length} file${unreadable.length === 1 ? "" : "s"} that could not be read:`);
    for (const u of unreadable) console.log(`  ${u.file}: ${u.problem}`);
  }
  if (refused.length) {
    console.log(
      `\nSkipped ${refused.length} run file${refused.length === 1 ? "" : "s"} to keep real data out of the gold set:`,
    );
    for (const r of refused) console.log(`  ${r.file}: ${REFUSAL_SHORT[r.reason]}`);
    const tooOld = refused.filter((r) => r.reason === "too-old").length;
    const real = refused.length - tooOld;
    if (tooOld) {
      console.log(
        `${tooOld} ${tooOld === 1 ? "is" : "are"} from before the eval recorded which team and tracker it used. ` +
          "Make fresh runs instead (see the top of scripts/jev-label.ts), or add --allow-real-data if you are sure they used the fictional sample team.",
      );
    }
    if (real) {
      console.log(
        `${real} used a team or tracker other than the fictional sample. Leave ${real === 1 ? "it" : "them"} out unless ` +
          "the data protection officer has agreed, then add --allow-real-data.",
      );
    }
  }
  return groups;
}

async function runLabelling(): Promise<void> {
  const groups = collectItems();
  const fresh = newItems(
    interleave(groups),
    values.relabel ? [] : gold.map((g) => g.id),
  );
  const todo = limit === null ? fresh : fresh.slice(0, limit);
  const deferred = fresh.length - todo.length;

  /**
   * With --relabel the old gold file is moved aside just before the first new label is written,
   * so a run that labels nothing (a bad key, no network, nothing to read) leaves it where it was.
   */
  let moveOldGold = values.relabel && existsSync(goldPath);
  const startAgainIfRelabelling = (): void => {
    if (!moveOldGold) return;
    moveOldGold = false;
    const kept = join(dirname(goldPath), `gold-before-relabel-${stamp()}.jsonl`);
    renameSync(goldPath, kept);
    console.log(`  --relabel: starting ${goldPath} again. The old one is kept as ${kept}.`);
  };

  if (todo.length === 0) {
    console.log(
      values.relabel
        ? `\nNothing to label, so ${goldPath} is left as it was.`
        : `\nNothing new to label: every reply is already in ${goldPath}. Use --relabel to label them all again.`,
    );
  } else {
    console.log(
      `\nLabelling ${todo.length}${values.relabel ? "" : " new"} repl${todo.length === 1 ? "y" : "ies"} with ${JUDGE_MODEL}, ${concurrency} at a time` +
        `${deferred ? ` (${deferred} more left for a later run because of --limit)` : ""}. ` +
        `Expect roughly 1 to 4 cents a reply, so $${(todo.length * 0.01).toFixed(2)} to $${(todo.length * 0.04).toFixed(2)}. ` +
        "Ctrl+C stops it and keeps what is done.",
    );
  }

  const meta = { labeller: JUDGE_MODEL, questionsVersion: questions.version };
  const problems: { id: string; problem: string }[] = [];
  let labelled = 0;
  await mapLimit(todo, concurrency, async (item) => {
    const result = await labelOne(item);
    if (!result) return;
    if ("problem" in result) {
      problems.push({ id: item.id, problem: result.problem });
      console.log(`  [${labelled + problems.length}/${todo.length}] ${item.id}: not labelled (${result.problem})`);
      return;
    }
    // Written one at a time, so a stopped run keeps every label it paid for.
    startAgainIfRelabelling();
    appendGold(
      [toGoldItem(item, result.labels, result.notes, { ...meta, labelledAt: new Date().toISOString() })],
      goldPath,
    );
    labelled++;
    console.log(`  [${labelled + problems.length}/${todo.length}] ${item.id}: ${yesFlags(result.labels)}`);
  });
  if (stopReason) console.log(`\nStopped early: ${stopReason}`);
  listProblems(problems);
  if (moveOldGold && todo.length) console.log(`\nNothing was labelled, so ${goldPath} is left as it was.`);

  const all = readGold(goldPath);
  console.log(`\nLabelled ${labelled} new repl${labelled === 1 ? "y" : "ies"}. ${goldPath} now holds ${all.length}.`);
  const older = all.filter((g) => g.questionsVersion !== questions.version).length;
  if (older) {
    console.log(
      `${older} of them follow older question wording than ${questions.version}. Run with --relabel to bring them up to date.`,
    );
  }
  if (all.length) {
    console.log("\nShare of replies labelled yes, by coach prompt:");
    const rates = positiveRates(all);
    for (const line of formatPositiveRates(rates)) console.log(`  ${line}`);
    const overall = rates.at(-1)!;
    const low = REPLY_FLAGS.filter((f) => overall.rates[f] < 0.3);
    console.log(
      "Each check needs roughly 30-40% yes answers overall to be measured fairly." +
        (low.length
          ? ` Below 30% now: ${low.join(", ")}. Runs with the bad coach prompts in eval/bad-coach/ add did_task, ` +
            "below_top_level, several_asks and filled_in_outcome; third_party_details comes mostly from the seed replies."
          : " Every check is there or above."),
    );
  }
  console.log(`\n${costLine()}`);
  if (all.length) {
    console.log(
      "Next: npm run jev:label -- --repeat-check 100 to see how consistent Opus is, then npm run jev:eval to check Jev against these labels.",
    );
  }
  if (stopReason) process.exit(1);
}

if (repeatCheck !== null) {
  if (positionals.length)
    console.log("--repeat-check uses replies already in the gold file; the run files named are ignored.");
  if (limit !== null) console.log("--repeat-check sets how many replies to check; --limit is ignored.");
  await runRepeatCheck(repeatCheck);
} else {
  await runLabelling();
}
