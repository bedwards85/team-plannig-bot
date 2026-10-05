import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadJevQuestions } from "../src/adapters/jev/JevClassifier.js";
import {
  GoldItemSchema,
  LABEL_PROMPT_PATH,
  RunRefusedError,
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
  seedItems,
  spreadPick,
  toGoldItem,
  type FlagLabels,
  type GoldItem,
  type UnlabelledItem,
} from "../src/eval/jevGold.js";
import { REPLY_FLAGS } from "../src/ports/classifier.js";
import { SAMPLE_TEAM_CONFIG, SAMPLE_TRACKER } from "../src/eval/support.js";

const sampleData = {
  teamConfigPath: SAMPLE_TEAM_CONFIG,
  trackerPath: SAMPLE_TRACKER,
  coachPromptPath: "eval/bad-coach/interrogator.md",
  sampleData: true,
};

const transcript = [
  { speaker: "coach", text: "Hi Thabo, new week. Which of these do you plan to finish off this week?" },
  { speaker: "person", text: "The mapping." },
  { speaker: "coach", text: "That's KR 2.1 work. Who gets it on Friday?" },
  { speaker: "person", text: "Wanjiru." },
  { speaker: "coach", text: "Anything in the way?" },
];

/** A small run file as scripts/eval.ts writes it, with fields the labeller ignores. Null data: an old run without it. */
const run = (data: unknown = sampleData) => ({
  model: "claude-sonnet-5-5",
  judge: "none",
  ...(data === null ? {} : { data }),
  summary: { personasPassed: 1 },
  personas: [{ id: "clear-planner", pass: true, transcript }],
  refusals: [],
});

const noFlags: FlagLabels = {
  did_task: false,
  below_top_level: false,
  several_asks: false,
  filled_in_outcome: false,
  third_party_details: false,
};
const meta = { labeller: "claude-opus-5-5", questionsVersion: "v1", labelledAt: "2026-10-05T09:00:00.000Z" };

describe("itemsFromRun", () => {
  it("takes every coach reply after the fixed opener, with the turns before it", () => {
    const items = itemsFromRun(run(), "eval-x", { allowRealData: false });
    expect(items.map((i) => i.id)).toEqual(["eval-x:clear-planner:2", "eval-x:clear-planner:4"]);
    expect(items[0]).toEqual({
      id: "eval-x:clear-planner:2",
      source: { run: "eval-x", persona: "clear-planner", line: 2, coachPrompt: "eval/bad-coach/interrogator.md" },
      context: [
        "COACH: Hi Thabo, new week. Which of these do you plan to finish off this week?",
        "PERSON: The mapping.",
      ],
      reply: "That's KR 2.1 work. Who gets it on Friday?",
    });
  });

  it("skips blank coach replies", () => {
    const r = run();
    r.personas[0]!.transcript = [...transcript, { speaker: "person", text: "No." }, { speaker: "coach", text: "  " }];
    expect(itemsFromRun(r, "eval-x", { allowRealData: false })).toHaveLength(2);
  });

  it("accepts paths written as ./config/... for the sample data", () => {
    const data = { ...sampleData, teamConfigPath: `./${SAMPLE_TEAM_CONFIG}` };
    expect(itemsFromRun(run(data), "eval-x", { allowRealData: false })).toHaveLength(2);
  });

  it("refuses a run made with another team or tracker unless real data is allowed", () => {
    const data = { ...sampleData, teamConfigPath: "config/team.local.yaml" };
    expect(() => itemsFromRun(run(data), "eval-x", { allowRealData: false })).toThrow(RunRefusedError);
    expect(() => itemsFromRun(run(data), "eval-x", { allowRealData: false })).toThrow(/not the fictional sample team/);
    try {
      itemsFromRun(run(data), "eval-x", { allowRealData: false });
    } catch (error) {
      expect((error as RunRefusedError).reason).toBe("not-sample-data");
    }
    expect(itemsFromRun(run(data), "eval-x", { allowRealData: true })).toHaveLength(2);
    // The sample team with a real tracker is refused too.
    const realTracker = { ...sampleData, trackerPath: "fixtures/q4-tracker.json" };
    expect(() => itemsFromRun(run(realTracker), "eval-x", { allowRealData: false })).toThrow(RunRefusedError);
  });

  it("refuses a run too old to say which data it used, with what to do next", () => {
    const old = run(null);
    expect(() => itemsFromRun(old, "eval-old", { allowRealData: false })).toThrow(
      /too old to know which team and tracker/,
    );
    expect(() => itemsFromRun(old, "eval-old", { allowRealData: false })).toThrow(/--allow-real-data/);
    const items = itemsFromRun(old, "eval-old", { allowRealData: true });
    expect(items[0]!.source).toMatchObject({ coachPrompt: "unknown" });
  });

  it("explains a file that is not an eval run", () => {
    expect(() => itemsFromRun({ hello: 1 }, "notes", { allowRealData: true })).toThrow(
      /does not look like an eval run file/,
    );
    expect(() => itemsFromRun({ hello: 1 }, "notes", { allowRealData: true })).not.toThrow(RunRefusedError);
  });
});

describe("seed items", () => {
  it("loads the real seed file, which passes its schema", () => {
    const items = loadSeedItems();
    expect(items.length).toBeGreaterThanOrEqual(35);
    expect(items.every((i) => i.id.startsWith("seed:") && "seed" in i.source && i.reply.trim())).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("keeps real-looking identifiers out of the seed file", () => {
    const raw = readFileSync("eval/jev-seed.json", "utf8");
    // After any country code, every long number starts with 00. No real phone, ID or device
    // number does, whereas one that merely contains 000 could still be someone's real mobile.
    const numbers = [...raw.matchAll(/\+?\d[\d -]{7,}\d/g)].map((m) => m[0]);
    expect(numbers.length).toBeGreaterThan(5);
    for (const n of numbers) expect(n.replace(/^\+\d{1,3} /, ""), n).toMatch(/^00/);
  });

  it("gives seed ids and sources", () => {
    const items = seedItems({ about: "x", items: [{ id: "tp-one", context: ["PERSON: hi"], reply: "Who gets it?" }] });
    expect(items).toEqual([
      { id: "seed:tp-one", source: { seed: "tp-one" }, context: ["PERSON: hi"], reply: "Who gets it?" },
    ]);
  });

  it("rejects duplicate ids and context lines without a speaker", () => {
    const item = { id: "a", context: ["PERSON: hi"], reply: "ok" };
    expect(() => seedItems({ about: "x", items: [item, item] })).toThrow(/unique/);
    expect(() => seedItems({ about: "x", items: [{ ...item, context: ["hi"] }] })).toThrow(/COACH/);
  });
});

describe("flagDefinitions and labelPrompt", () => {
  const questions = loadJevQuestions();
  const definitions = flagDefinitions(questions);

  it("covers every flag with its question and both criteria, from the Jev questions file", () => {
    for (const flag of REPLY_FLAGS) {
      expect(definitions).toContain(`## ${flag}`);
      expect(definitions).toContain(questions.flags[flag].instructions);
      expect(definitions).toContain(`Yes when: ${questions.flags[flag].criteria.true}`);
      expect(definitions).toContain(`No when: ${questions.flags[flag].criteria.false}`);
    }
  });

  it("fills the real template with the definitions, the conversation and the reply", () => {
    const template = readFileSync(LABEL_PROMPT_PATH, "utf8");
    const prompt = labelPrompt(template, definitions, {
      context: ["COACH: Hi.", "PERSON: The {{mapping}}."],
      reply: "Who gets it?",
    });
    expect(prompt).toContain(definitions);
    expect(prompt).toContain("COACH: Hi.\n\nPERSON: The {{mapping}}.");
    expect(prompt).toContain("<reply_to_check>\nWho gets it?\n</reply_to_check>");
    expect(labelPrompt(template, definitions, { context: [], reply: "Hi" })).toContain("this is the first message");
  });
});

describe("choosing what to label", () => {
  const item = (id: string): UnlabelledItem => ({ id, source: { seed: id }, context: [], reply: "r" });

  it("newItems skips ids already labelled and repeats", () => {
    expect(newItems([item("a"), item("b"), item("a"), item("c")], ["b"]).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("interleave takes one from each group in turn", () => {
    expect(interleave([[1, 2, 3], [10], [20, 21]])).toEqual([1, 10, 20, 2, 21, 3]);
    expect(interleave([])).toEqual([]);
  });

});

describe("spreadPick", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i);

  it("spreads the picks evenly, in list order", () => {
    expect(spreadPick(ten, 2)).toEqual([2, 7]);
    expect(spreadPick(ten, 5)).toEqual([1, 3, 5, 7, 9]);
  });

  it("never picks the same item twice", () => {
    const picks = spreadPick(Array.from({ length: 101 }, (_, i) => i), 100);
    expect(new Set(picks).size).toBe(100);
  });

  it("takes everything when asked for more than there is, and nothing for zero", () => {
    expect(spreadPick(ten, 50)).toEqual(ten);
    expect(spreadPick(ten, 0)).toEqual([]);
  });

  it("with a sort key, picks the same whatever order the items came in, in sorted order", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}` }));
    const pick = spreadPick(items, 3, (i) => i.id).map((i) => i.id);
    expect(pick).toEqual(["id-1", "id-5", "id-8"]);
    expect(spreadPick([...items].reverse(), 3, (i) => i.id).map((i) => i.id)).toEqual(pick);
    expect(spreadPick([...items].reverse(), 50, (i) => i.id)).toEqual(items);
  });

  it("leaves its input alone", () => {
    const items = [3, 1, 2];
    spreadPick(items, 2, String);
    expect(items).toEqual([3, 1, 2]);
  });
});

describe("gold items", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("toGoldItem records labeller, version and time, and drops a 'none' note", () => {
    const base: UnlabelledItem = { id: "seed:a", source: { seed: "a" }, context: ["PERSON: hi"], reply: "ok" };
    const gold = toGoldItem(base, { ...noFlags, did_task: true }, "none", meta);
    expect(gold).toEqual({ ...base, labels: { ...noFlags, did_task: true }, ...meta });
    expect(toGoldItem(base, noFlags, "None.", meta)).not.toHaveProperty("notes");
    expect(toGoldItem(base, noFlags, "", meta)).not.toHaveProperty("notes");
    expect(toGoldItem(base, noFlags, "Close call on asks.", meta).notes).toBe("Close call on asks.");
  });

  it("round-trips through the gold file", () => {
    dir = mkdtempSync(join(tmpdir(), "gold-"));
    const path = join(dir, "sub", "gold.jsonl");
    const items = itemsFromRun(run(), "eval-x", { allowRealData: false }).map((i) => toGoldItem(i, noFlags, "", meta));
    appendGold(items, path);
    appendGold(
      [toGoldItem(seedItems({ about: "", items: [{ id: "s", context: [], reply: "r" }] })[0]!, noFlags, "", meta)],
      path,
    );
    const back = readGold(path);
    expect(back.map((g) => g.id)).toEqual(["eval-x:clear-planner:2", "eval-x:clear-planner:4", "seed:s"]);
    expect(back.every((g) => GoldItemSchema.safeParse(g).success)).toBe(true);
  });
});

describe("positiveRates", () => {
  const gold = (coachPrompt: string | null, labels: Partial<FlagLabels>): Pick<GoldItem, "source" | "labels"> => ({
    source: coachPrompt ? { run: "r", persona: "p", line: 2, coachPrompt } : { seed: "s" },
    labels: { ...noFlags, ...labels },
  });

  it("gives the share of yes labels per coach prompt, the seed file and overall", () => {
    const rows = positiveRates([
      gold("prompts/coach.md", {}),
      gold("prompts/coach.md", { several_asks: true }),
      gold("eval/bad-coach/does-the-work.md", { did_task: true }),
      gold(null, { third_party_details: true }),
    ]);
    expect(rows.map((r) => [r.group, r.n])).toEqual([
      ["eval/bad-coach/does-the-work.md", 1],
      ["prompts/coach.md", 2],
      ["seed file (eval/jev-seed.json)", 1],
      ["all", 4],
    ]);
    expect(rows[1]!.rates.several_asks).toBe(0.5);
    expect(rows[3]!.rates.did_task).toBe(0.25);
    const table = formatPositiveRates(rows);
    expect(table[0]).toContain("third_party_details");
    expect(table[2]).toMatch(/prompts\/coach\.md\s+2\s+0%\s+0%\s+50%/);
  });

  it("is empty for an empty set", () => {
    expect(positiveRates([])).toEqual([]);
  });
});

describe("labelAgreement", () => {
  it("counts agreement, changes and kappa per flag", () => {
    const yes = { ...noFlags, did_task: true };
    const a = labelAgreement([
      [yes, yes],
      [noFlags, noFlags],
      [yes, noFlags],
      [noFlags, noFlags],
    ]);
    expect(a.did_task).toMatchObject({ n: 4, agree: 3, rate: 0.75, yesToNo: 1, noToYes: 0 });
    // Observed 0.75; by chance 0.5*0.25 + 0.5*0.75 = 0.5; kappa = 0.25 / 0.5.
    expect(a.did_task.kappa).toBeCloseTo(0.5);
    // Never flagged by either pass: perfect agreement, but kappa can't be worked out.
    expect(a.several_asks).toMatchObject({ agree: 4, rate: 1, kappa: null });
  });

  it("handles no pairs", () => {
    expect(labelAgreement([]).did_task).toMatchObject({ n: 0, rate: null, kappa: null });
  });
});

describe("labelReply", () => {
  const usage = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  /** A stand-in client that answers every call with one message, recording the request. */
  function fakeClient(text: string, stop_reason = "end_turn") {
    const requests: unknown[] = [];
    const client = {
      messages: {
        create: async (body: unknown) => {
          requests.push(body);
          return { content: text ? [{ type: "text", text }] : [], stop_reason, usage, model: "claude-opus-5-5" };
        },
      },
    } as unknown as Anthropic;
    return { client, requests };
  }

  it("returns labels and notes, asking Opus at medium effort with structured output", async () => {
    const { client, requests } = fakeClient(JSON.stringify({ ...noFlags, several_asks: true, notes: " none " }));
    const result = await labelReply(client, "prompt");
    expect(result).toMatchObject({ labels: { ...noFlags, several_asks: true }, notes: "none", problem: null });
    expect(result.usage?.inputTokens).toBe(900);
    expect(requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "medium", format: { type: "json_schema" } },
      messages: [{ role: "user", content: "prompt" }],
    });
  });

  it("reports refusals, cut-offs, empty and unreadable answers as problems, never labels", async () => {
    expect((await labelReply(fakeClient("", "refusal").client, "p")).problem).toBe("the labeller refused");
    expect((await labelReply(fakeClient('{"did_task": tr', "max_tokens").client, "p")).problem).toMatch(/cut off/);
    expect((await labelReply(fakeClient("").client, "p")).problem).toMatch(/no answer/);
    const unreadable = await labelReply(fakeClient('{"did_task": "maybe"}').client, "p");
    expect(unreadable.labels).toBeNull();
    expect(unreadable.problem).toMatch(/unreadable/);
  });
});
