import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/eval/csv.js";
import {
  HUMAN_LABEL_COLUMNS,
  HUMAN_ROUND_ROWS,
  RANDOM_SLICE_PERCENT,
  appendHumanLabelRows,
  appendRandomSliceIds,
  asExcelText,
  conversationSoFar,
  effectiveLabels,
  humanAgreement,
  humanLabelsMetaPath,
  maxDisagreementRows,
  parseHumanLabels,
  readHumanLabels,
  readHumanLabelsMeta,
  readYesNo,
  selectForHumanLabelling,
} from "../src/eval/humanLabels.js";
import type { FlagLabels, GoldItem } from "../src/eval/jevGold.js";
import { REPLY_FLAGS, type ReplyFlag } from "../src/ports/classifier.js";

const HEADER = HUMAN_LABEL_COLUMNS.join(",");

const allNo: FlagLabels = { did_task: false, below_top_level: false, several_asks: false, filled_in_outcome: false, third_party_details: false };

function goldItem(id: string, labels: Partial<FlagLabels> = {}, context?: string[]): GoldItem {
  return {
    id,
    source: { run: "eval-2026-10-05.json", persona: "one-word", line: 4, coachPrompt: "prompts/coach.md" },
    context: context ?? [
      "COACH: Morning Thabo. What do you want to get done this week?",
      "PERSON: Churn summary.",
      "COACH: Who is it for?",
      "PERSON: Lindiwe.",
      "COACH: When does she need it?",
      "PERSON: Thursday.",
    ],
    reply: "So: churn summary to Lindiwe by Thursday. Anything in the way?",
    labels: { ...allNo, ...labels },
    labeller: "claude-opus-5-5",
    questionsVersion: "2026-10-05.1",
    labelledAt: "2026-10-05T09:00:00.000Z",
  };
}

const tempDir = () => mkdtempSync(join(tmpdir(), "human-labels-"));

describe("readYesNo", () => {
  it("reads yes and no in any case, with spaces around", () => {
    for (const v of ["y", "Y", "yes", " YES ", "1", "true", "TRUE", "True"]) expect(readYesNo(v)).toBe(true);
    for (const v of ["n", "N", "no", " No", "0", "false", "FALSE "]) expect(readYesNo(v)).toBe(false);
  });

  it("treats blank as no opinion and anything else as unreadable", () => {
    expect(readYesNo("")).toBeNull();
    expect(readYesNo("   ")).toBeNull();
    for (const v of ["yse", "maybe", "?", "2", "nope"]) expect(readYesNo(v)).toBe("unreadable");
  });
});

describe("parseHumanLabels", () => {
  it("reads answers by column name, leaving blanks out", () => {
    const text = `${HEADER}\na,ctx,reply,Y,n,,1,FALSE,looks fine\nb,ctx,reply,,,,,,\n`;
    const parsed = parseHumanLabels(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.labels).toEqual(
      new Map([
        ["a", { did_task: true, below_top_level: false, filled_in_outcome: true, third_party_details: false }],
        ["b", {}],
      ]),
    );
    expect(parsed.notes).toEqual(new Map([["a", "looks fine"]]));
  });

  it("reports a typo with its row number and still reads the rest", () => {
    const text = `${HEADER}\na,ctx,reply,Y,yse,N,,,\nb,ctx,reply,maybe,N,,,,\n`;
    const parsed = parseHumanLabels(text);
    expect(parsed.labels.get("a")).toEqual({ did_task: true, several_asks: false });
    expect(parsed.labels.get("b")).toEqual({ below_top_level: false });
    expect(parsed.problems).toEqual([
      'Row 2 (a), below_top_level: "yse" isn\'t Y or N, so it was ignored. Use Y or N, or leave it blank.',
      'Row 3 (b), did_task: "maybe" isn\'t Y or N, so it was ignored. Use Y or N, or leave it blank.',
    ]);
  });

  it("reads what Excel saves: byte-order mark, semicolons, CRLF and quoted line breaks", () => {
    const text =
      "\uFEFF" +
      HUMAN_LABEL_COLUMNS.join(";") +
      '\r\nrun.json:one-word:4;"COACH: Hi\r\nPERSON: Hello; there";"Who is it for?";Y;N;N;N;N;\r\n;;;;;;;;;\r\n';
    const parsed = parseHumanLabels(text);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.labels.keys()]).toEqual(["run.json:one-word:4"]);
    expect(parsed.labels.get("run.json:one-word:4")).toEqual({ ...allNo, did_task: true });
  });

  it("finds columns the person moved, ignores extra ones and copes with missing ones", () => {
    const text = "My notes,several_asks,ID,did_task\nx,y,a,n\n";
    const parsed = parseHumanLabels(text);
    expect(parsed.labels.get("a")).toEqual({ several_asks: true, did_task: false });
    expect(parsed.problems).toEqual([]);
  });

  it("numbers rows as Excel shows them, even with blank lines above the header", () => {
    const parsed = parseHumanLabels(`\n${HEADER}\na,c,r,huh,,,,,\n`);
    expect(parsed.problems[0]).toMatch(/^Row 3 \(a\)/);
  });

  it("says when the id column is missing instead of throwing", () => {
    const parsed = parseHumanLabels("reply,did_task\nhello,Y\n");
    expect(parsed.labels.size).toBe(0);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatch(/no "id" column/);
  });

  it("reports a row with answers but no id", () => {
    const parsed = parseHumanLabels(`${HEADER}\n,ctx,reply,Y,,,,,\n`);
    expect(parsed.labels.size).toBe(0);
    expect(parsed.problems).toEqual(["Row 2 has answers but no id, so it was skipped."]);
  });

  it("merges a repeated id, reporting conflicting answers and using the later row", () => {
    const parsed = parseHumanLabels(`${HEADER}\na,c,r,Y,,,,,\na,c,r,N,Y,,,,\na,c,r,,Y,,,,\n`);
    expect(parsed.labels.get("a")).toEqual({ did_task: false, below_top_level: true });
    expect(parsed.problems).toEqual(["a is in the file more than once with different answers for did_task; using row 3."]);
  });

  it("gives nothing for an empty file", () => {
    expect(parseHumanLabels("")).toEqual({ labels: new Map(), notes: new Map(), problems: [] });
    expect(parseHumanLabels("\uFEFF\r\n").labels.size).toBe(0);
  });
});

describe("readHumanLabels", () => {
  it("treats a missing file as no labels", () => {
    const parsed = readHumanLabels(join(tempDir(), "nope.csv"));
    expect(parsed.exists).toBe(false);
    expect(parsed.labels.size).toBe(0);
  });

  it("notes a file Excel saved in its older, non-UTF-8 format, but still reads the answers", () => {
    const path = join(tempDir(), "labels.csv");
    // "café" in Windows-1252: the é is the single byte 0xE9, which isn't valid UTF-8.
    writeFileSync(path, Buffer.concat([Buffer.from(`${HEADER}\na,caf`), Buffer.from([0xe9]), Buffer.from(",r,Y,,,,,\n")]));
    const parsed = readHumanLabels(path);
    expect(parsed.labels.get("a")).toEqual({ did_task: true });
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatch(/CSV UTF-8/);
  });
});

describe("effectiveLabels", () => {
  const gold = [goldItem("a", { did_task: true }), goldItem("b", { several_asks: true }), goldItem("c")];

  it("lets a person's answer win, flag by flag, and says which flags came from them", () => {
    const human = new Map([
      ["a", { did_task: false, filled_in_outcome: true }],
      ["c", {}],
      ["not-in-gold", { did_task: true }],
    ]);
    expect(effectiveLabels(gold, human)).toEqual([
      { id: "a", labels: { ...allNo, filled_in_outcome: true }, humanFlags: ["did_task", "filled_in_outcome"] },
      { id: "b", labels: { ...allNo, several_asks: true }, humanFlags: [] },
      { id: "c", labels: allNo, humanFlags: [] },
    ]);
  });

  it("does not change the gold items", () => {
    effectiveLabels(gold, new Map([["a", { did_task: false }]]));
    expect(gold[0]!.labels.did_task).toBe(true);
  });
});

describe("humanAgreement", () => {
  it("counts agreement and each kind of difference for the flags a person answered", () => {
    const gold = [goldItem("a", { did_task: true }), goldItem("b"), goldItem("c", { did_task: true })];
    const human = new Map([
      ["a", { did_task: true, several_asks: true }],
      ["b", { did_task: false }],
      ["c", { did_task: false }],
    ]);
    const a = humanAgreement(gold, human);
    expect(a.did_task).toEqual({ n: 3, agree: 2, humanYesGoldNo: 0, humanNoGoldYes: 1 });
    expect(a.several_asks).toEqual({ n: 1, agree: 0, humanYesGoldNo: 1, humanNoGoldYes: 0 });
    expect(a.filled_in_outcome.n).toBe(0);
    expect(Object.keys(a)).toEqual([...REPLY_FLAGS]);
  });
});

describe("selectForHumanLabelling", () => {
  /** 300 gold replies in file order. */
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `item-${i}` }));
  const index = (id: string) => Number(id.split("-")[1]);
  const dis = (id: string, margins: Partial<Record<ReplyFlag, number>>) => ({ id, margins });
  const sortedByGold = (ids: string[]) => [...ids].sort((a, b) => index(a) - index(b));

  it("takes each flag's clearest disagreements, the five flags taking turns", () => {
    // did_task has 100 disagreements, clearest at item-99; two other flags have a few each.
    const disagreements = [
      ...Array.from({ length: 100 }, (_, i) => dis(`item-${i}`, { did_task: i / 100 })),
      dis("item-200", { below_top_level: 0.1 }),
      dis("item-201", { below_top_level: 0.3 }),
      dis("item-250", { several_asks: 0.05 }),
    ];
    // 10 rows: 7 disagreements at most. Turn 1: item-99, item-201, item-250. Turn 2: item-98, item-200. Then did_task alone.
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 10 });
    expect(round.disagreementIds).toEqual(sortedByGold(["item-99", "item-98", "item-97", "item-96", "item-201", "item-200", "item-250"]));
    expect(round.randomSliceIds).toHaveLength(3);
    expect(round.ids).toHaveLength(10);
  });

  it("gives a quiet flag its turn even when another flag's cases are all clearer", () => {
    const disagreements = [
      dis("item-1", { did_task: 0.9 }),
      dis("item-2", { did_task: 0.8 }),
      dis("item-3", { did_task: 0.7 }),
      dis("item-4", { filled_in_outcome: 0.1 }),
    ];
    // 4 rows leave room for 2 disagreements: the clearest did_task case, then filled_in_outcome's only one.
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 4 });
    expect(round.disagreementIds).toEqual(["item-1", "item-4"]);
    expect(round.randomSliceIds).toHaveLength(2);
  });

  it("takes a reply that disagrees on two flags once, and moves that flag on to its next case", () => {
    const disagreements = [dis("item-10", { did_task: 0.9, below_top_level: 0.8 }), dis("item-20", { did_task: 0.5 }), dis("item-30", { below_top_level: 0.4 })];
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 10 });
    expect(round.disagreementIds).toEqual(["item-10", "item-20", "item-30"]);
    expect(new Set(round.ids).size).toBe(10);
  });

  it("caps a round at 100 rows: up to 70 disagreements, the rest a slice of all the other replies", () => {
    const disagreements = items.slice(0, 150).map((item, i) => dis(item.id, { [REPLY_FLAGS[i % 5]!]: (i % 7) / 10 }));
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set() });
    expect(round.ids).toHaveLength(100);
    expect(round.disagreementIds).toHaveLength(70);
    expect(round.randomSliceIds).toHaveLength(30);
    expect(new Set(round.ids)).toEqual(new Set([...round.disagreementIds, ...round.randomSliceIds]));
    // The slice is drawn from every other reply, disagreements not picked included, not just where Jev and the labels agree.
    const sliceNumbers = round.randomSliceIds.map(index);
    expect(sliceNumbers.some((n) => n < 150)).toBe(true);
    expect(sliceNumbers.some((n) => n >= 150)).toBe(true);
    expect(round.randomSliceIds.some((id) => round.disagreementIds.includes(id))).toBe(false);
    // ...spread across the whole gold set, not just its start.
    expect(Math.min(...sliceNumbers)).toBeLessThan(30);
    expect(Math.max(...sliceNumbers)).toBeGreaterThan(260);
  });

  it("tops up the slice so the round still has 100 rows when there are fewer than 70 disagreements", () => {
    const disagreements = ["item-3", "item-140", "item-290"].map((id) => dis(id, { several_asks: 0.2 }));
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set() });
    expect(round.disagreementIds).toEqual(["item-3", "item-140", "item-290"]);
    expect(round.randomSliceIds).toHaveLength(97);
    expect(round.ids).toHaveLength(100);
  });

  it("lists the round in gold-file order, so the two kinds of row are mixed together", () => {
    const disagreements = [dis("item-200", { did_task: 0.9 }), dis("item-100", { did_task: 0.1 }), dis("item-150", { third_party_details: 0.5 })];
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 20 });
    expect(round.ids).toEqual(sortedByGold(round.ids));
    expect(round.disagreementIds).toEqual(["item-100", "item-150", "item-200"]);
    expect(round.randomSliceIds).toEqual(sortedByGold(round.randomSliceIds));
    // Neither kind comes first: the slice has rows before and after the disagreements.
    expect(round.ids.indexOf("item-100")).toBeGreaterThan(0);
    expect(round.ids.indexOf("item-200")).toBeLessThan(round.ids.length - 1);
  });

  it("for --more-labels, skips replies already in the sheet and takes the next clearest instead", () => {
    const disagreements = Array.from({ length: 100 }, (_, i) => dis(`item-${i}`, { did_task: i / 100 }));
    const first = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set() });
    const inSheet = new Set(first.ids);
    const second = selectForHumanLabelling({ items, disagreements, alreadyInFile: inSheet });
    expect(second.ids).toHaveLength(100);
    expect(second.ids.some((id) => inSheet.has(id))).toBe(false);
    // The first round took did_task's 70 clearest (item-99 down to item-30); the second takes the next ones.
    expect(first.disagreementIds).toEqual(sortedByGold(Array.from({ length: 70 }, (_, k) => `item-${99 - k}`)));
    expect(second.disagreementIds.map(index).every((n) => n < 30)).toBe(true);
    expect(second.disagreementIds.length + first.randomSliceIds.filter((id) => index(id) < 30).length).toBe(30);
  });

  it("keeps the same split for a round of another size", () => {
    const disagreements = items.slice(0, 100).map((item) => dis(item.id, { did_task: 0.5 }));
    const twenty = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 20 });
    expect([twenty.disagreementIds.length, twenty.randomSliceIds.length]).toEqual([14, 6]);
    const fifteen = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 15 });
    expect([fifteen.disagreementIds.length, fifteen.randomSliceIds.length]).toEqual([10, 5]); // the slice rounds up
    const one = selectForHumanLabelling({ items, disagreements, alreadyInFile: new Set(), rows: 1 });
    expect([one.disagreementIds.length, one.randomSliceIds.length]).toEqual([0, 1]);
    expect([maxDisagreementRows(100), maxDisagreementRows(20), maxDisagreementRows(1)]).toEqual([70, 14, 0]);
    expect(HUMAN_ROUND_ROWS).toBe(100);
    expect(RANDOM_SLICE_PERCENT).toBe(30);
  });

  it("gives fewer rows once the gold set runs out", () => {
    const small = items.slice(0, 50);
    const alreadyInFile = new Set(small.slice(0, 45).map((i) => i.id));
    const round = selectForHumanLabelling({ items: small, disagreements: [dis("item-1", { did_task: 1 }), dis("item-47", { did_task: 0.2 })], alreadyInFile });
    expect(round.ids).toEqual(["item-45", "item-46", "item-47", "item-48", "item-49"]);
    expect(round.disagreementIds).toEqual(["item-47"]);
    expect(selectForHumanLabelling({ items: small, disagreements: [], alreadyInFile: new Set(small.map((i) => i.id)) }).ids).toEqual([]);
  });

  it("ignores disagreements for replies it doesn't know", () => {
    const round = selectForHumanLabelling({ items: [{ id: "a" }], disagreements: [dis("zzz", { did_task: 1 })], alreadyInFile: new Set(), rows: 1 });
    expect(round).toEqual({ ids: ["a"], disagreementIds: [], randomSliceIds: ["a"] });
  });

  it("gives the same round every time, whatever order the disagreements come in", () => {
    const disagreements = items.slice(0, 120).map((item, i) => dis(item.id, { [REPLY_FLAGS[i % 5]!]: ((i * 37) % 11) / 10 }));
    const run = (list: typeof disagreements) => selectForHumanLabelling({ items, disagreements: list, alreadyInFile: new Set() });
    expect(run(disagreements)).toEqual(run([...disagreements].reverse()));
    expect(run(disagreements)).toEqual(run(disagreements));
  });

  it("makes a sheet that stays blind: rows in gold order, no labels and no hint of which rows are which", () => {
    const gold = items.slice(0, 40).map((i) => goldItem(i.id, { did_task: index(i.id) % 3 === 0 }));
    const round = selectForHumanLabelling({ items: gold, disagreements: [dis("item-33", { did_task: 0.9 })], alreadyInFile: new Set(), rows: 10 });
    const path = join(tempDir(), "human-labels.csv");
    const byId = new Map(gold.map((g) => [g.id, g]));
    appendHumanLabelRows(path, round.ids.map((id) => byId.get(id)!));
    const text = readFileSync(path, "utf8");
    expect([...parseHumanLabels(text).labels.keys()]).toEqual(round.ids);
    expect(parseCsv(text).rows[0]).toEqual([...HUMAN_LABEL_COLUMNS]);
    expect(text).not.toMatch(/true|false|opus|random|disagree|slice/i);
  });
});

describe("the record of randomly picked rows", () => {
  it("sits next to the sheet", () => {
    expect(humanLabelsMetaPath("data/jev-gold/human-labels.csv")).toBe("data/jev-gold/human-labels.meta.json");
    expect(humanLabelsMetaPath("x/Labels.CSV")).toBe("x/Labels.meta.json");
    expect(humanLabelsMetaPath("x/sheet")).toBe("x/sheet.meta.json");
  });

  it("reads as empty when there is no file yet", () => {
    expect(readHumanLabelsMeta(join(tempDir(), "none.meta.json"))).toEqual({ randomSliceIds: [], exists: false });
  });

  it("is only ever added to: earlier ids stay, in their order, and repeats are skipped", () => {
    const path = join(tempDir(), "sub", "human-labels.meta.json");
    expect(appendRandomSliceIds(path, ["c", "a"])).toBe(2);
    expect(appendRandomSliceIds(path, ["a", "d", "b", "d"])).toBe(2);
    expect(readHumanLabelsMeta(path)).toEqual({ randomSliceIds: ["c", "a", "d", "b"], exists: true });
    // A later round that picks none of the old ids never shrinks the record.
    expect(appendRandomSliceIds(path, ["e"])).toBe(1);
    expect(readHumanLabelsMeta(path).randomSliceIds).toEqual(["c", "a", "d", "b", "e"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ randomSliceIds: ["c", "a", "d", "b", "e"] });
  });

  it("keeps anything else someone put in the file", () => {
    const path = join(tempDir(), "labels.meta.json");
    writeFileSync(path, JSON.stringify({ randomSliceIds: ["a"], note: "round 1 by the team lead" }));
    appendRandomSliceIds(path, ["b"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ randomSliceIds: ["a", "b"], note: "round 1 by the team lead" });
  });

  it("writes nothing when there is nothing new", () => {
    const path = join(tempDir(), "labels.meta.json");
    expect(appendRandomSliceIds(path, [])).toBe(0);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '{"randomSliceIds":["a"]}');
    expect(appendRandomSliceIds(path, ["a"])).toBe(0);
    expect(readFileSync(path, "utf8")).toBe('{"randomSliceIds":["a"]}');
  });

  it("says in plain words when the file can't be read, and never overwrites it", () => {
    const path = join(tempDir(), "labels.meta.json");
    writeFileSync(path, "{ not json");
    expect(() => readHumanLabelsMeta(path)).toThrow(/labels\.meta\.json can't be read .*picked at random.*move it aside/);
    expect(() => appendRandomSliceIds(path, ["a"])).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    writeFileSync(path, '{"randomSliceIds":"a"}');
    expect(() => readHumanLabelsMeta(path)).toThrow(/can't be read/);
  });
});

describe("conversationSoFar and asExcelText", () => {
  const context = ["COACH: one", "PERSON: two", "COACH: three", "PERSON: four", "COACH: five", "PERSON: six"];

  it("shows the last four turns, one per line, or the whole conversation for 0", () => {
    expect(conversationSoFar(context)).toBe("COACH: three\nPERSON: four\nCOACH: five\nPERSON: six");
    expect(conversationSoFar(context, 2)).toBe("COACH: five\nPERSON: six");
    expect(conversationSoFar(context, 0)).toBe(context.join("\n"));
    expect(conversationSoFar([])).toBe("(start of the conversation)");
  });

  it("stops Excel reading a cell as a formula", () => {
    expect(asExcelText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(asExcelText("- first step")).toBe("'- first step");
    expect(asExcelText("+27 number")).toBe("'+27 number");
    expect(asExcelText("@here")).toBe("'@here");
    expect(asExcelText("So, by Thursday?")).toBe("So, by Thursday?");
  });
});

describe("appendHumanLabelRows", () => {
  it("creates the file with a byte-order mark, the header and blank answer columns (labelling is blind)", () => {
    const path = join(tempDir(), "sub", "human-labels.csv");
    const item = goldItem("run.json:one-word:4", { did_task: true, several_asks: true });
    expect(appendHumanLabelRows(path, [item])).toBe(1);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    const { rows } = parseCsv(text);
    expect(rows[0]).toEqual([...HUMAN_LABEL_COLUMNS]);
    expect(rows[1]).toEqual([
      "run.json:one-word:4",
      "COACH: Who is it for?\nPERSON: Lindiwe.\nCOACH: When does she need it?\nPERSON: Thursday.",
      item.reply,
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(text).not.toMatch(/true|false|opus/i);
  });

  it("appends without touching what is there, using the file's delimiter and line ends", () => {
    const path = join(tempDir(), "labels.csv");
    const before = "\uFEFF" + HUMAN_LABEL_COLUMNS.join(";") + "\r\nold;\"c\";\"r\";Y;;;;;mine\r\n";
    writeFileSync(path, before);
    expect(appendHumanLabelRows(path, [goldItem("new-1"), goldItem("new-2")])).toBe(2);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length);
    // Rows end with CRLF like the file's own; line breaks inside a cell stay LF, as Excel writes them.
    expect(added.split("\r\n").filter(Boolean).map((row) => row.split(";")[0])).toEqual(["new-1", "new-2"]);
    const parsed = parseHumanLabels(after);
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1", "new-2"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: true });
    expect(parseCsv(after).delimiter).toBe(";");
  });

  it("adds a line end first when the file doesn't end with one", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, `${HEADER}\nold,c,r,N,,,,,`);
    appendHumanLabelRows(path, [goldItem("new-1")]);
    const parsed = parseHumanLabels(readFileSync(path, "utf8"));
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: false });
    expect(readFileSync(path, "utf8")).toMatch(/^[^\r]*\nold,c,r,N,,,,,\nnew-1,/);
  });

  it("skips replies already in the file and repeats in the list", () => {
    const path = join(tempDir(), "labels.csv");
    appendHumanLabelRows(path, [goldItem("a")]);
    expect(appendHumanLabelRows(path, [goldItem("a"), goldItem("b"), goldItem("b")])).toBe(1);
    expect(appendHumanLabelRows(path, [goldItem("a")])).toBe(0);
    expect([...parseHumanLabels(readFileSync(path, "utf8")).labels.keys()]).toEqual(["a", "b"]);
  });

  it("follows the column order of an existing file", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "did_task,ID,reply_to_check,extra\n");
    appendHumanLabelRows(path, [goldItem("x")]);
    const { rows } = parseCsv(readFileSync(path, "utf8"));
    expect(rows[1]).toEqual(["", "x", goldItem("x").reply, ""]);
  });

  it("appends to a semicolon file with a blank line above its header", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "\r\n" + HUMAN_LABEL_COLUMNS.join(";") + "\r\nold;c;r;Y;;;;;\r\n");
    expect(appendHumanLabelRows(path, [goldItem("new-1")])).toBe(1);
    const parsed = parseHumanLabels(readFileSync(path, "utf8"));
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: true });
  });

  it("puts a header into an existing empty file", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "");
    appendHumanLabelRows(path, [goldItem("x")]);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("\uFEFF" + HEADER)).toBe(true);
    expect([...parseHumanLabels(text).labels.keys()]).toEqual(["x"]);
  });

  it("refuses to append to a file with no id column, leaving it as it was", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "reply,did_task\nhello,Y\n");
    expect(() => appendHumanLabelRows(path, [goldItem("x")])).toThrow(/no "id" column/);
    expect(readFileSync(path, "utf8")).toBe("reply,did_task\nhello,Y\n");
  });

  it("writes nothing, and creates no file, when there is nothing to add", () => {
    const path = join(tempDir(), "labels.csv");
    expect(appendHumanLabelRows(path, [])).toBe(0);
    expect(() => readFileSync(path)).toThrow();
  });

  it("shows the whole conversation when asked for 0 turns, and guards formula-like replies", () => {
    const path = join(tempDir(), "labels.csv");
    const item = { ...goldItem("x"), reply: "- one\n- two" };
    appendHumanLabelRows(path, [item], 0);
    const { rows } = parseCsv(readFileSync(path, "utf8"));
    expect(rows[1]![1]!.split("\n")).toHaveLength(6);
    expect(rows[1]![2]).toBe("'- one\n- two");
  });
});
