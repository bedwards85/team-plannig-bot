/**
 * Talk to the coach in your terminal.
 *
 *   npm run chat -- --as amara
 *   npm run chat -- --as thabo --thinking off
 *   npm run chat -- --as wanjiru --touchpoint review
 *
 * Type your replies and press Enter. Type /done (or press Ctrl+C or Ctrl+D) to finish.
 * Lines typed while the coach is replying are kept and sent next, in order.
 */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { stdin, stdout } from "node:process";
import { ClaudeLLM } from "../src/adapters/anthropic/ClaudeLLM.js";
import { hasAnthropicCredentials, loadDotEnv, loadSettings, loadTeam, loadText, loadTracker } from "../src/config.js";
import { CoachConversation } from "../src/core/conversation.js";
import type { Touchpoint } from "../src/core/openers.js";
import { checkReply } from "../src/core/replyRules.js";
import { findPerson } from "../src/domain/okr.js";

const grey = (s: string) => (stdout.isTTY ? `\x1b[90m${s}\x1b[0m` : s);
const bold = (s: string) => (stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

loadDotEnv();
const { values } = parseArgs({
  options: {
    as: { type: "string", default: "amara" },
    touchpoint: { type: "string", default: "plan" },
    thinking: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!hasAnthropicCredentials()) {
  fail(
    "No Anthropic API key found.\n" +
      "Copy .env.example to .env and put your key after ANTHROPIC_API_KEY=, then run this again.",
  );
}

let settings: ReturnType<typeof loadSettings>;
try {
  settings = loadSettings(values.thinking ? { ...process.env, COACH_THINKING: values.thinking } : process.env);
} catch (error) {
  fail((error as Error).message.replace("COACH_THINKING", "--thinking"));
}
const touchpoint = values.touchpoint as Touchpoint;
if (!["plan", "checkin", "review"].includes(touchpoint)) {
  fail(`--touchpoint must be plan, checkin or review (got "${touchpoint}")`);
}

const team = loadTeam(settings.teamConfigPath);
const tracker = loadTracker(settings.trackerPath);
const person = findPerson(team, values.as!);
const conversation = new CoachConversation({
  llm: new ClaudeLLM({ model: settings.model, thinking: settings.thinking }),
  coachPrompt: loadText(settings.coachPromptPath),
  team,
  tracker,
  person,
  touchpoint,
});

console.log(grey(`Coach chat as ${person.name} · ${touchpoint} · ${settings.model} · thinking ${settings.thinking}`));
console.log(grey(`Type your reply and press Enter. Type /done to finish.\n`));
console.log(`${bold("Coach:")} ${conversation.openerText}\n`);

const DONE = Symbol("done");
const firstTextTimes: number[] = [];
const queue: Array<string | typeof DONE> = [];
let busy = false;
let closed = false;

const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
rl.setPrompt(bold(`${person.name}: `));
const prompt = () => {
  if (stdin.isTTY) rl.prompt();
};
rl.on("line", (line) => {
  const input = line.trim();
  if (!input) return prompt();
  // Commands queue behind messages already typed, so nothing typed is lost.
  queue.push(["/done", "/quit", "/exit"].includes(input.toLowerCase()) ? DONE : input);
  void drain();
});
// Ctrl+D or the end of piped input: finish once any queued messages are answered.
rl.on("close", () => {
  closed = true;
  if (!busy && queue.length === 0) finish();
});
rl.on("SIGINT", () => finish());
prompt();

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const next = queue.shift()!;
    if (next === DONE) finish();
    await turn(next);
  }
  busy = false;
  if (closed) finish();
  else prompt();
}

async function turn(input: string): Promise<void> {
  if (!stdin.isTTY) console.log(`${bold(`${person.name}:`)} ${input}`);
  stdout.write(`\n${bold("Coach:")} `);
  const outcome = await conversation.send(input, (delta) => stdout.write(delta));

  if (outcome.kind === "reply") {
    if (outcome.firstTextMs !== null) firstTextTimes.push(outcome.firstTextMs);
    const r = outcome.result;
    const check = checkReply(outcome.text);
    const first = outcome.firstTextMs === null ? "no text" : `first text ${(outcome.firstTextMs / 1000).toFixed(2)} s`;
    const retry = outcome.attempts > 1 ? " (after a retry)" : "";
    const cache = r.usage.cacheReadTokens > 0 ? `cache hit ${r.usage.cacheReadTokens} tokens` : "cache miss";
    const rules = check.ok ? "" : ` · ⚠ ${check.problems.join(", ")}`;
    console.log(`\n${grey(`${first}${retry} · ${cache}${rules}`)}\n`);
  } else if (outcome.kind === "refused") {
    // The streamed partial text is replaced by a gentle redirect.
    console.log(`\n${grey(`[reply withdrawn: refusal${outcome.category ? ` (${outcome.category})` : ""}]`)}`);
    console.log(`${bold("Coach:")} ${outcome.text}\n`);
  } else {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    console.log(`${outcome.text}\n${grey(detail)}\n`);
  }
}

function finish(): never {
  rl.removeAllListeners("close");
  rl.close();
  if (firstTextTimes.length) {
    const sorted = [...firstTextTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    console.log(grey(`\n${firstTextTimes.length} replies · median time to first text ${(median / 1000).toFixed(2)} s`));
  }
  console.log(grey("(Phase 1 doesn't save anything yet. Saving to Notion comes in Phases 2–3.)"));
  process.exit(0);
}
