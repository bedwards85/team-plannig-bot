import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/eval/csv.js";
import {
  HUMAN_CONTEXT_TURNS,
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
  pickDisagreements,
  randomSliceOrder,
  readHumanLabels,
  readHumanLabelsMeta,
  readYesNo,
  selectForHumanLabelling,
  sheetIdResolver,
  sheetKey,
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

describe("sheetKey and sheetIdResolver", () => {
  it("shows a short key that gives nothing away, the same every time", () => {
    for (const id of ["seed:did-writes-sql", "eval-2026-10-05T06-39-40-533Z:one-word:4"]) {
      const key = sheetKey(id);
      expect(key).toMatch(/^r-[0-9a-f]{10}$/);
      expect(sheetKey(id)).toBe(key);
      expect(key).not.toMatch(/seed|did|sql|eval|word/);
    }
    expect(sheetKey("seed:a")).not.toBe(sheetKey("seed:b"));
  });

  it("maps a key, or a gold id as older sheets show it, back to the gold id", () => {
    const resolve = sheetIdResolver(["seed:a", "run.json:p:2"]);
    expect(resolve(sheetKey("seed:a"))).toBe("seed:a");
    expect(resolve(sheetKey("run.json:p:2"))).toBe("run.json:p:2");
    expect(resolve("seed:a")).toBe("seed:a");
    expect(resolve("r-0000000000")).toBe("r-0000000000"); // not in the gold set: left as it is
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

  it("given the gold ids, keys answers by gold id, from keys and from older sheets' gold ids alike", () => {
    const gold = ["seed:did-writes-sql", "run.json:one-word:4", "run.json:one-word:6"];
    const text = `${HEADER}\n${sheetKey(gold[0]!)},c,r,Y,,,,,mine\nrun.json:one-word:4,c,r,N,,,,,\n${sheetKey("gone")},c,r,Y,,,,,\n`;
    const parsed = parseHumanLabels(text, gold);
    expect(parsed.labels).toEqual(
      new Map([
        ["seed:did-writes-sql", { did_task: true }],
        ["run.json:one-word:4", { did_task: false }],
        [sheetKey("gone"), { did_task: true }], // no longer in the gold set: kept under what the sheet shows
      ]),
    );
    expect(parsed.notes.get("seed:did-writes-sql")).toBe("mine");
  });

  it("quotes the id as the sheet shows it when a cell can't be read", () => {
    const key = sheetKey("seed:a");
    const parsed = parseHumanLabels(`${HEADER}\n${key},c,r,maybe,,,,,\n`, ["seed:a"]);
    expect(parsed.problems).toEqual([`Row 2 (${key}), did_task: "maybe" isn't Y or N, so it was ignored. Use Y or N, or leave it blank.`]);
    expect(parsed.problems[0]).not.toContain("seed:a");
  });
});

describe("readHumanLabels", () => {
  it("treats a missing file as no labels", () => {
    const parsed = readHumanLabels(join(tempDir(), "nope.csv"));
    expect(parsed.exists).toBe(false);
    expect(parsed.labels.size).toBe(0);
  });

  it("maps keys back to gold ids when given them", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, `${HEADER}\n${sheetKey("seed:a")},c,r,,Y,,,,\n`);
    expect(readHumanLabels(path, ["seed:a"]).labels).toEqual(new Map([["seed:a", { below_top_level: true }]]));
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

describe("pickDisagreements", () => {
  /** 300 gold replies in file order. */
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `item-${i}` }));
  const index = (id: string) => Number(id.split("-")[1]);
  const dis = (id: string, margins: Partial<Record<ReplyFlag, number>>) => ({ id, margins });
  const sortedByGold = (ids: string[]) => [...ids].sort((a, b) => index(a) - index(b));
  const any = () => true;

  it("takes each flag's clearest disagreements, the five flags taking turns", () => {
    // did_task has 100 disagreements, clearest at item-99; two other flags have a few each.
    const disagreements = [
      ...Array.from({ length: 100 }, (_, i) => dis(`item-${i}`, { did_task: i / 100 })),
      dis("item-200", { below_top_level: 0.1 }),
      dis("item-201", { below_top_level: 0.3 }),
      dis("item-250", { several_asks: 0.05 }),
    ];
    // Turn 1: item-99, item-201, item-250. Turn 2: item-98, item-200. Then did_task alone.
    const picked = pickDisagreements({ items, disagreements, eligible: any, max: 7 });
    expect(picked).toEqual(sortedByGold(["item-99", "item-98", "item-97", "item-96", "item-201", "item-200", "item-250"]));
  });

  it("gives a quiet flag its turn even when another flag's cases are all clearer", () => {
    const disagreements = [
      dis("item-1", { did_task: 0.9 }),
      dis("item-2", { did_task: 0.8 }),
      dis("item-3", { did_task: 0.7 }),
      dis("item-4", { filled_in_outcome: 0.1 }),
    ];
    expect(pickDisagreements({ items, disagreements, eligible: any, max: 2 })).toEqual(["item-1", "item-4"]);
  });

  it("takes a reply that disagrees on two flags once, and moves that flag on to its next case", () => {
    const disagreements = [dis("item-10", { did_task: 0.9, below_top_level: 0.8 }), dis("item-20", { did_task: 0.5 }), dis("item-30", { below_top_level: 0.4 })];
    expect(pickDisagreements({ items, disagreements, eligible: any, max: 10 })).toEqual(["item-10", "item-20", "item-30"]);
  });

  it("skips replies that aren't eligible and ones it doesn't know, taking the next clearest instead", () => {
    const disagreements = [dis("item-5", { did_task: 0.9 }), dis("item-6", { did_task: 0.8 }), dis("item-7", { did_task: 0.7 }), dis("zzz", { did_task: 1 })];
    expect(pickDisagreements({ items, disagreements, eligible: (id) => id !== "item-5", max: 2 })).toEqual(["item-6", "item-7"]);
  });

  it("is the same whatever order the disagreements come in, ties going to the earlier reply", () => {
    const disagreements = [dis("item-9", { did_task: 0.5 }), dis("item-3", { did_task: 0.5 }), dis("item-6", { did_task: 0.5 })];
    expect(pickDisagreements({ items, disagreements, eligible: any, max: 2 })).toEqual(["item-3", "item-6"]);
    expect(pickDisagreements({ items, disagreements: [...disagreements].reverse(), eligible: any, max: 2 })).toEqual(["item-3", "item-6"]);
  });
});

describe("randomSliceOrder", () => {
  it("is a fixed shuffle: the same for any input order, unrelated to the ids' own order or the sheet keys", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const order = randomSliceOrder(ids);
    expect(randomSliceOrder([...ids].reverse())).toEqual(order);
    expect(new Set(order)).toEqual(new Set(ids));
    expect(order).not.toEqual(ids);
    expect(order).not.toEqual([...ids].sort());
    // A different hash from the sheet keys, so the slice rows don't sort together in the sheet.
    const byKey = [...ids].sort((a, b) => (sheetKey(a) < sheetKey(b) ? -1 : 1));
    expect(order.slice(0, 30)).not.toEqual(byKey.slice(0, 30));
    const firstByKey = new Set(byKey.slice(0, 30));
    expect(order.slice(0, 30).filter((id) => firstByKey.has(id)).length).toBeLessThan(15);
  });

  it("spreads its first picks over the whole list", () => {
    const first = randomSliceOrder(Array.from({ length: 300 }, (_, i) => `item-${i}`)).slice(0, 30).map((id) => Number(id.split("-")[1]));
    expect(first.filter((n) => n < 150).length).toBeGreaterThan(5);
    expect(first.filter((n) => n >= 150).length).toBeGreaterThan(5);
  });
});

describe("selectForHumanLabelling", () => {
  /** 300 gold replies in file order. */
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `item-${i}` }));
  const index = (id: string) => Number(id.split("-")[1]);
  const dis = (id: string, margins: Partial<Record<ReplyFlag, number>>) => ({ id, margins });
  const sortedByGold = (ids: string[]) => [...ids].sort((a, b) => index(a) - index(b));
  const none = new Set<string>();

  it("picks the slice first, from the whole gold set, the same whichever replies Jev disagreed with", () => {
    const some = items.slice(0, 150).map((item, i) => dis(item.id, { [REPLY_FLAGS[i % 5]!]: (i % 7) / 10 }));
    const others = items.slice(100, 300).map((item, i) => dis(item.id, { did_task: (i % 9) / 10 }));
    const a = selectForHumanLabelling({ items, disagreements: some, alreadyInFile: none });
    const b = selectForHumanLabelling({ items, disagreements: others, alreadyInFile: none });
    expect(a.randomSliceIds).toHaveLength(30);
    expect(a.randomSliceIds).toEqual(b.randomSliceIds);
    // It is the start of the fixed random order of every gold reply.
    expect(new Set(a.randomSliceIds)).toEqual(new Set(randomSliceOrder(items.map((i) => i.id)).slice(0, 30)));
  });

  it("can put a reply Jev disagreed with in the slice, and then doesn't count it as a disagreement row", () => {
    const disagreements = items.map((item) => dis(item.id, { did_task: 0.5 })); // Jev disagreed on every reply
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: none });
    expect(round.randomSliceIds).toHaveLength(30);
    expect(round.disagreementIds).toHaveLength(70);
    expect(round.randomSliceIds.some((id) => round.disagreementIds.includes(id))).toBe(false);
    expect(new Set(round.ids)).toEqual(new Set([...round.disagreementIds, ...round.randomSliceIds]));
  });

  it("caps a round at 100 rows: up to 70 disagreements and at least 30 from the slice", () => {
    const disagreements = items.slice(0, 150).map((item, i) => dis(item.id, { [REPLY_FLAGS[i % 5]!]: (i % 7) / 10 }));
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: none });
    expect(round.ids).toHaveLength(100);
    expect(round.disagreementIds).toHaveLength(70);
    expect(round.randomSliceIds).toHaveLength(30);
    expect(round.sliceAlreadyInSheet).toEqual([]);
    // The disagreement rows are each flag's clearest, leaving out what the slice took.
    const inSlice = new Set(round.randomSliceIds);
    expect(round.disagreementIds).toEqual(pickDisagreements({ items, disagreements, eligible: (id) => !inSlice.has(id), max: 70 }));
  });

  it("tops up the slice so the round still has 100 rows when there are fewer than 70 disagreements", () => {
    const disagreements = ["item-3", "item-140", "item-290"].map((id) => dis(id, { several_asks: 0.2 }));
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: none });
    expect(round.ids).toHaveLength(100);
    expect(round.disagreementIds).toEqual(["item-3", "item-140", "item-290"].filter((id) => !round.randomSliceIds.includes(id)));
    expect(round.randomSliceIds).toHaveLength(100 - round.disagreementIds.length);
    // Topping up takes the next replies in the same random order, so it stays a fair sample.
    expect(new Set(round.randomSliceIds)).toEqual(new Set(randomSliceOrder(items.map((i) => i.id)).slice(0, round.randomSliceIds.length)));
  });

  it("lists new rows in gold-file order, so the two kinds of row are mixed together", () => {
    const disagreements = [dis("item-200", { did_task: 0.9 }), dis("item-100", { did_task: 0.1 }), dis("item-150", { third_party_details: 0.5 })];
    const round = selectForHumanLabelling({ items, disagreements, alreadyInFile: none, rows: 20 });
    expect(round.ids).toEqual(sortedByGold(round.ids));
    expect(round.randomSliceIds).toEqual(sortedByGold(round.randomSliceIds));
    expect(round.disagreementIds).toEqual(["item-100", "item-150", "item-200"].filter((id) => !round.randomSliceIds.includes(id)));
    // Neither kind comes first: the slice has rows before and after the disagreements.
    expect(Math.min(...round.randomSliceIds.map(index))).toBeLessThan(100);
    expect(Math.max(...round.randomSliceIds.map(index))).toBeGreaterThan(200);
  });

  it("for --more-labels, can pick slice rows already in the sheet: they get no new row, but are recorded so their answers count", () => {
    const disagreements = Array.from({ length: 100 }, (_, i) => dis(`item-${i}`, { did_task: i / 100 }));
    const first = selectForHumanLabelling({ items, disagreements, alreadyInFile: none });
    const inSheet = new Set(first.ids);
    const second = selectForHumanLabelling({ items, disagreements, alreadyInFile: inSheet, alreadyInSlice: new Set(first.randomSliceIds) });
    // The first round's disagreement rows can join the slice now: it is drawn from the whole gold set.
    expect(second.sliceAlreadyInSheet.length).toBeGreaterThan(0);
    expect(second.sliceAlreadyInSheet.every((id) => first.disagreementIds.includes(id))).toBe(true);
    expect(second.randomSliceIds).toEqual(expect.arrayContaining(second.sliceAlreadyInSheet));
    // ...but get no second row, and no reply is picked for the slice twice.
    expect(second.ids.some((id) => inSheet.has(id))).toBe(false);
    expect(second.randomSliceIds.some((id) => first.randomSliceIds.includes(id))).toBe(false);
    // The round still adds 100 new rows, at least 30 of them from the slice.
    expect(second.ids).toHaveLength(100);
    expect(second.randomSliceIds.length - second.sliceAlreadyInSheet.length).toBeGreaterThanOrEqual(30);
    // The first round took did_task's 70 clearest outside its slice; the second takes the next ones.
    const firstSlice = new Set(first.randomSliceIds);
    expect(first.disagreementIds).toEqual(
      sortedByGold(Array.from({ length: 100 }, (_, k) => `item-${99 - k}`).filter((id) => !firstSlice.has(id)).slice(0, 70)),
    );
    expect(second.disagreementIds.every((id) => !inSheet.has(id) && !second.randomSliceIds.includes(id))).toBe(true);
  });

  it("keeps the same split for a round of another size", () => {
    const disagreements = items.slice(0, 100).map((item) => dis(item.id, { did_task: 0.5 }));
    const twenty = selectForHumanLabelling({ items, disagreements, alreadyInFile: none, rows: 20 });
    expect([twenty.disagreementIds.length, twenty.randomSliceIds.length]).toEqual([14, 6]);
    const fifteen = selectForHumanLabelling({ items, disagreements, alreadyInFile: none, rows: 15 });
    expect([fifteen.disagreementIds.length, fifteen.randomSliceIds.length]).toEqual([10, 5]); // the slice rounds up
    const one = selectForHumanLabelling({ items, disagreements, alreadyInFile: none, rows: 1 });
    expect([one.disagreementIds.length, one.randomSliceIds.length]).toEqual([0, 1]);
    expect([maxDisagreementRows(100), maxDisagreementRows(20), maxDisagreementRows(1)]).toEqual([70, 14, 0]);
    expect(HUMAN_ROUND_ROWS).toBe(100);
    expect(RANDOM_SLICE_PERCENT).toBe(30);
  });

  it("once the gold set runs out, gives fewer rows and takes every remaining reply into the slice", () => {
    const small = items.slice(0, 50);
    const alreadyInFile = new Set(small.slice(0, 45).map((i) => i.id));
    const round = selectForHumanLabelling({ items: small, disagreements: [dis("item-1", { did_task: 1 }), dis("item-47", { did_task: 0.2 })], alreadyInFile });
    expect(round.ids).toEqual(["item-45", "item-46", "item-47", "item-48", "item-49"]);
    expect(round.randomSliceIds).toEqual(small.map((i) => i.id));
    expect(round.sliceAlreadyInSheet).toHaveLength(45);
    expect(round.disagreementIds).toEqual([]);
    const everything = new Set(small.map((i) => i.id));
    expect(selectForHumanLabelling({ items: small, disagreements: [], alreadyInFile: everything, alreadyInSlice: everything })).toEqual({
      ids: [],
      disagreementIds: [],
      randomSliceIds: [],
      sliceAlreadyInSheet: [],
    });
  });

  it("ignores disagreements for replies it doesn't know", () => {
    const round = selectForHumanLabelling({ items: [{ id: "a" }], disagreements: [dis("zzz", { did_task: 1 })], alreadyInFile: none, rows: 1 });
    expect(round).toEqual({ ids: ["a"], disagreementIds: [], randomSliceIds: ["a"], sliceAlreadyInSheet: [] });
  });

  it("gives the same round every time, whatever order the disagreements and the gold set come in", () => {
    const disagreements = items.slice(0, 120).map((item, i) => dis(item.id, { [REPLY_FLAGS[i % 5]!]: ((i * 37) % 11) / 10 }));
    const run = (list: typeof disagreements) => selectForHumanLabelling({ items, disagreements: list, alreadyInFile: none });
    expect(run(disagreements)).toEqual(run([...disagreements].reverse()));
    expect(run(disagreements)).toEqual(run(disagreements));
    const reversed = selectForHumanLabelling({ items: [...items].reverse(), disagreements, alreadyInFile: none });
    expect(new Set(reversed.randomSliceIds)).toEqual(new Set(run(disagreements).randomSliceIds));
  });

  it("makes a sheet that stays blind: rows in gold order under opaque keys, no labels and no hint of which rows are which", () => {
    const gold = items.slice(0, 40).map((i) => goldItem(`seed:${i.id}-writes-sql`, { did_task: index(i.id) % 3 === 0 }));
    const round = selectForHumanLabelling({ items: gold, disagreements: [dis(gold[33]!.id, { did_task: 0.9 })], alreadyInFile: none, rows: 10 });
    const path = join(tempDir(), "human-labels.csv");
    const byId = new Map(gold.map((g) => [g.id, g]));
    appendHumanLabelRows(path, round.ids.map((id) => byId.get(id)!));
    const text = readFileSync(path, "utf8");
    expect(parseCsv(text).rows[0]).toEqual([...HUMAN_LABEL_COLUMNS]);
    expect([...parseHumanLabels(text).labels.keys()]).toEqual(round.ids.map(sheetKey));
    expect([...parseHumanLabels(text, gold.map((g) => g.id)).labels.keys()]).toEqual(round.ids);
    expect(text).not.toMatch(/true|false|opus|random|disagree|slice|seed|writes-sql|item-|eval-|\.json/i);
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

  it("shows the whole conversation by default, as Opus saw it, one turn per line", () => {
    expect(HUMAN_CONTEXT_TURNS).toBe(0);
    expect(conversationSoFar(context)).toBe(context.join("\n"));
    expect(conversationSoFar(context, 2)).toBe("COACH: five\nPERSON: six");
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
  it("creates the file with a byte-order mark, the header, the reply's key, the whole conversation and blank answer columns", () => {
    const path = join(tempDir(), "sub", "human-labels.csv");
    const item = goldItem("run.json:one-word:4", { did_task: true, several_asks: true });
    expect(appendHumanLabelRows(path, [item])).toBe(1);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    const { rows } = parseCsv(text);
    expect(rows[0]).toEqual([...HUMAN_LABEL_COLUMNS]);
    expect(rows[1]).toEqual([
      sheetKey("run.json:one-word:4"),
      item.context.join("\n"),
      item.reply,
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(text).not.toMatch(/true|false|opus|run\.json|one-word/i);
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
    expect(added.split("\r\n").filter(Boolean).map((row) => row.split(";")[0])).toEqual([sheetKey("new-1"), sheetKey("new-2")]);
    const parsed = parseHumanLabels(after, ["old", "new-1", "new-2"]);
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1", "new-2"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: true });
    expect(parseCsv(after).delimiter).toBe(";");
  });

  it("adds a line end first when the file doesn't end with one", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, `${HEADER}\nold,c,r,N,,,,,`);
    appendHumanLabelRows(path, [goldItem("new-1")]);
    const parsed = parseHumanLabels(readFileSync(path, "utf8"), ["old", "new-1"]);
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: false });
    expect(readFileSync(path, "utf8")).toMatch(new RegExp(`^[^\\r]*\\nold,c,r,N,,,,,\\n${sheetKey("new-1")},`));
  });

  it("skips replies already in the file and repeats in the list", () => {
    const path = join(tempDir(), "labels.csv");
    appendHumanLabelRows(path, [goldItem("a")]);
    expect(appendHumanLabelRows(path, [goldItem("a"), goldItem("b"), goldItem("b")])).toBe(1);
    expect(appendHumanLabelRows(path, [goldItem("a")])).toBe(0);
    expect([...parseHumanLabels(readFileSync(path, "utf8"), ["a", "b"]).labels.keys()]).toEqual(["a", "b"]);
  });

  it("knows a reply an older sheet shows under its gold id, and doesn't add it again", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, `${HEADER}\nseed:a,c,r,Y,,,,,\n`);
    expect(appendHumanLabelRows(path, [goldItem("seed:a"), goldItem("seed:b")])).toBe(1);
    const parsed = parseHumanLabels(readFileSync(path, "utf8"), ["seed:a", "seed:b"]);
    expect([...parsed.labels.keys()]).toEqual(["seed:a", "seed:b"]);
    expect(parsed.labels.get("seed:a")).toEqual({ did_task: true });
  });

  it("follows the column order of an existing file", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "did_task,ID,reply_to_check,extra\n");
    appendHumanLabelRows(path, [goldItem("x")]);
    const { rows } = parseCsv(readFileSync(path, "utf8"));
    expect(rows[1]).toEqual(["", sheetKey("x"), goldItem("x").reply, ""]);
  });

  it("appends to a semicolon file with a blank line above its header", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "\r\n" + HUMAN_LABEL_COLUMNS.join(";") + "\r\nold;c;r;Y;;;;;\r\n");
    expect(appendHumanLabelRows(path, [goldItem("new-1")])).toBe(1);
    const parsed = parseHumanLabels(readFileSync(path, "utf8"), ["old", "new-1"]);
    expect([...parsed.labels.keys()]).toEqual(["old", "new-1"]);
    expect(parsed.labels.get("old")).toEqual({ did_task: true });
  });

  it("puts a header into an existing empty file", () => {
    const path = join(tempDir(), "labels.csv");
    writeFileSync(path, "");
    appendHumanLabelRows(path, [goldItem("x")]);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("\uFEFF" + HEADER)).toBe(true);
    expect([...parseHumanLabels(text, ["x"]).labels.keys()]).toEqual(["x"]);
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

  it("always shows the whole conversation, however long, and guards formula-like replies", () => {
    const path = join(tempDir(), "labels.csv");
    const context = Array.from({ length: 14 }, (_, i) => (i % 2 ? `PERSON: answer ${i}` : `COACH: question ${i}`));
    const item = { ...goldItem("x", {}, context), reply: "- one\n- two" };
    appendHumanLabelRows(path, [item]);
    const { rows } = parseCsv(readFileSync(path, "utf8"));
    expect(rows[1]![1]!.split("\n")).toEqual(context);
    expect(rows[1]![2]).toBe("'- one\n- two");
  });
});
