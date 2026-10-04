/**
 * Talk to the coach in your terminal.
 *
 *   npm run chat -- --as amara
 *   npm run chat -- --as thabo --thinking off
 *   npm run chat -- --as wanjiru --touchpoint review
 *
 * Type your replies. Type "done" (or press Ctrl+C) to finish.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { stdin, stdout } from "node:process";
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

if (!hasAnthropicCredentials()) {
  console.error(
    "No Anthropic API key found.\n" +
      "Copy .env.example to .env and put your key after ANTHROPIC_API_KEY=, then run this again.",
  );
  process.exit(1);
}

const settings = loadSettings();
const thinking = (values.thinking ?? settings.thinking) as ThinkingMode;
const touchpoint = values.touchpoint as Touchpoint;
if (!["plan", "checkin", "review"].includes(touchpoint)) {
  console.error(`--touchpoint must be plan, checkin or review (got "${touchpoint}")`);
  process.exit(1);
}

const team = loadTeam(settings.teamConfigPath);
const tracker = loadTracker(settings.trackerPath);
const person = findPerson(team, values.as!);
const llm = new ClaudeLLM({ model: settings.model, thinking });
const conversation = new CoachConversation({
  llm,
  coachPrompt: loadText(settings.coachPromptPath),
  team,
  tracker,
  person,
  touchpoint,
});

console.log(grey(`Coach chat as ${person.name} · ${touchpoint} · ${settings.model} · thinking ${thinking}`));
console.log(grey(`Type your reply and press Enter. Type "done" to finish.\n`));
console.log(`${bold("Coach:")} ${conversation.openerText}\n`);

const rl = createInterface({ input: stdin, output: stdout });
const firstTextTimes: number[] = [];
rl.on("SIGINT", () => finish());

function finish(): never {
  rl.close();
  if (firstTextTimes.length) {
    const sorted = [...firstTextTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    console.log(grey(`\n${firstTextTimes.length} replies · median time to first text ${(median / 1000).toFixed(2)} s`));
  }
  console.log(grey("(Phase 1 doesn't save anything yet. Saving to Notion comes in Phases 2–3.)"));
  process.exit(0);
}

while (true) {
  const input = (await rl.question(`${bold(`${person.name}:`)} `)).trim();
  if (!input) continue;
  if (["done", "/done", "/quit", "quit", "exit"].includes(input.toLowerCase())) finish();

  stdout.write(`\n${bold("Coach:")} `);
  const outcome = await conversation.send(input, (delta) => stdout.write(delta));

  if (outcome.kind === "reply") {
    const r = outcome.result;
    if (r.firstTextMs !== null) firstTextTimes.push(r.firstTextMs);
    const check = checkReply(outcome.text);
    const first = r.firstTextMs === null ? "no text" : `first text ${(r.firstTextMs / 1000).toFixed(2)} s`;
    const cache = r.usage.cacheReadTokens > 0 ? `cache hit ${r.usage.cacheReadTokens} tokens` : "cache miss";
    const rules = check.ok ? "" : ` · ⚠ ${check.problems.join(", ")}`;
    console.log(`\n${grey(`${first} · ${cache}${rules}`)}\n`);
  } else if (outcome.kind === "refused") {
    // The streamed partial text is replaced by a gentle redirect.
    console.log(`\n${grey(`[reply withdrawn: refusal${outcome.category ? ` (${outcome.category})` : ""}]`)}`);
    console.log(`${bold("Coach:")} ${outcome.text}\n`);
  } else {
    console.log(`${outcome.text}\n${grey(String((outcome.error as Error)?.message ?? outcome.error))}\n`);
  }
}
