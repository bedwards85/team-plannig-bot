import { describe, expect, it } from "vitest";
import { checkReply } from "../src/core/replyRules.js";
import { localStamp, weekStart } from "../src/core/time.js";
import { fill, mapLimit, percentile, unknownKrCodes } from "../src/eval/support.js";

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
  });
  it("keeps result order under limited concurrency", async () => {
    const out = await mapLimit([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });
});
