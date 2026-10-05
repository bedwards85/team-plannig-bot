import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WRAP_UP_LINE, checkReply, isWrapUp, recapOutcomeCount } from "../src/core/replyRules.js";
import { localStamp, weekStart } from "../src/core/time.js";
import { resolve } from "node:path";
import { exchangeAt, fill, isSampleData, mapLimit, percentile, unknownKrCodes } from "../src/eval/support.js";

describe("checkReply", () => {
  it("accepts a short single question", () => {
    expect(checkReply("Sounds good. What does done look like by Friday?").ok).toBe(true);
  });
  it("flags more than one question and more than 80 words", () => {
    expect(checkReply("Who? When?").problems).toEqual(["2 questions (max 1)"]);
    expect(checkReply(Array(81).fill("word").join(" ")).problems).toEqual(["81 words (max 80)"]);
  });
  it("flags an empty reply", () => {
    expect(checkReply("   ").ok).toBe(false);
  });
  it("reads an either/or and a quoted example as one question", () => {
    expect(checkReply("Is it more the model or the data? Or something else?").ok).toBe(true);
    expect(checkReply('You could ask "who signs this off?" first. What feels most likely?').ok).toBe(true);
    expect(checkReply("That fits KR 2.1, right? What's the first step today?").ok).toBe(false);
  });
});

describe("wrap-up", () => {
  const wrapUp = [
    "Here's your week:",
    "- Mapping to Wanjiru for review by Thursday (KR 2.1)",
    "- Taxonomy draft to the team for comments by Friday (KR 5.1?)",
    "- Catch-up emails sorted (no KR)",
    WRAP_UP_LINE,
  ].join("\n");

  it("is quoted word for word in the coach prompt", () => {
    expect(readFileSync("prompts/coach.md", "utf8")).toContain(WRAP_UP_LINE);
  });

  it("is recognised, counts one line per outcome and passes the reply rules", () => {
    expect(isWrapUp(wrapUp)).toBe(true);
    expect(isWrapUp("Who gets the mapping on Friday?")).toBe(false);
    expect(recapOutcomeCount(wrapUp)).toBe(3);
    expect(checkReply(wrapUp).problems).toEqual([]);
  });

  it("treats a tentative KR label as a label, not a question", () => {
    expect(checkReply("- Draft to the team (KR 5.1?)\n- Tests (KR 2.3?)\nWho gets it?").questions).toBe(1);
  });
});

describe("time helpers", () => {
  it("formats in the person's time zone", () => {
    const at = new Date("2026-10-12T06:30:00Z");
    expect(localStamp(at, "Africa/Nairobi")).toBe("Mon 12 Oct 2026, 09:30");
    expect(localStamp(at, "Africa/Johannesburg")).toBe("Mon 12 Oct 2026, 08:30");
  });
  it("finds the Monday of the local week, including across midnight", () => {
    expect(weekStart(new Date("2026-10-15T10:00:00Z"), "Africa/Nairobi")).toBe("2026-10-12");
    // Sunday 23:30 UTC is already Monday 02:30 in Nairobi.
    expect(weekStart(new Date("2026-10-18T23:30:00Z"), "Africa/Nairobi")).toBe("2026-10-19");
    expect(weekStart(new Date("2026-10-18T21:30:00Z"), "Africa/Johannesburg")).toBe("2026-10-12");
  });
});

describe("eval support", () => {
  it("fills placeholders and rejects unknown ones", () => {
    expect(fill("Hi {{name}}", { name: "Ann" })).toBe("Hi Ann");
    expect(() => fill("Hi {{who}}", {})).toThrow(/who/);
  });
  it("computes percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
  it("spots KR codes that are not in the tracker", () => {
    const valid = new Set(["1.2", "2.1"]);
    expect(unknownKrCodes("Sounds like KR 1.2, or maybe KR 7.4?", valid)).toEqual(["7.4"]);
    expect(unknownKrCodes("No KRs here", valid)).toEqual([]);
    expect(unknownKrCodes("Sounds like KR 2.1 or 7.4. Right?", valid)).toEqual(["7.4"]);
    expect(unknownKrCodes("KRs 2.1 and 8.8, or KR 2.1/9.1", valid)).toEqual(["8.8", "9.1"]);
    expect(unknownKrCodes("key result 6.6", valid)).toEqual(["6.6"]);
    expect(unknownKrCodes("KR 2.1 and an AUC of 0.80", valid)).toEqual([]);
  });
  it("keeps result order under limited concurrency", async () => {
    const out = await mapLimit([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });
});

describe("isSampleData", () => {
  it("accepts the sample files however the path is written", () => {
    expect(isSampleData("config/team.sample.yaml", "fixtures/q4-tracker.sample.json")).toBe(true);
    expect(isSampleData("./config/team.sample.yaml", resolve("fixtures/q4-tracker.sample.json"))).toBe(true);
  });
  it("refuses any other team or tracker", () => {
    expect(isSampleData("config/team.local.yaml", "fixtures/q4-tracker.sample.json")).toBe(false);
    expect(isSampleData("config/team.sample.yaml", "fixtures/tracker.local.json")).toBe(false);
  });
});

describe("exchangeAt", () => {
  const lines = [
    { speaker: "coach" as const, text: "Hi, new week." },
    { speaker: "person" as const, text: "Finishing the mapping." },
    { speaker: "coach" as const, text: "Who gets it on Friday?" },
  ];
  it("gives the reply and the turns before it, without names", () => {
    expect(exchangeAt(lines, 2)).toEqual({
      context: ["COACH: Hi, new week.", "PERSON: Finishing the mapping."],
      reply: "Who gets it on Friday?",
    });
  });
  it("refuses a line that isn't a coach reply", () => {
    expect(() => exchangeAt(lines, 1)).toThrow(/not a coach reply/);
    expect(() => exchangeAt(lines, 9)).toThrow(/not a coach reply/);
  });
});
