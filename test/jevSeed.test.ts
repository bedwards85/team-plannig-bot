/**
 * Checks on the hand-written seed file (eval/jev-seed.json). Its tp- items are almost the only
 * source of "yes" labels for third_party_details: the eval personas and the flawed coach prompts
 * never bring up customers or suspects. Jev's report needs enough "yes" labels in both the tuning
 * part and the held-back part of the gold set, so these tests make sure the ids put enough of
 * them on each side, and that nothing in the file could be a real person's number.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEED_PATH, SeedFileSchema, loadSeedItems, seedItems } from "../src/eval/jevGold.js";
import { isCalibrationSplit } from "../src/eval/jevMetrics.js";
import { JEV_BARS } from "../src/eval/jevReport.js";

const raw = readFileSync(SEED_PATH, "utf8");

/** The seed items as the loader reads them, each with the id it gets in the gold set. */
function seeds() {
  const parsed = SeedFileSchema.parse(JSON.parse(raw));
  const goldIds = seedItems(parsed).map((i) => i.id);
  return parsed.items.map((item, i) => ({ ...item, goldId: goldIds[i]! }));
}

/** How many items with this id prefix fall in each part of the split, from their gold ids. */
function perPart(prefix: string) {
  const matching = seeds().filter((s) => s.id.startsWith(prefix));
  const tuning = matching.filter((s) => isCalibrationSplit(s.goldId)).length;
  return { tuning, checking: matching.length - tuning };
}

/**
 * Opus may label a few of the intended positives "no", so ask for a margin over the report's
 * bar (at least 12) rather than exactly the bar.
 */
const MIN_POSITIVES_PER_PART = Math.max(12, JEV_BARS.minEachClassPerPart + 2);

describe("the seed file", () => {
  it("parses with the loader's schema", () => {
    expect(() => SeedFileSchema.parse(JSON.parse(raw))).not.toThrow();
    expect(loadSeedItems().length).toBe(seeds().length);
  });

  it("has unique ids", () => {
    const ids = seeds().map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("uses tp- only for customer or suspect details and tpn- only for look-alikes without them", () => {
    // The prefix is what the split checks below count, so it must match what each item is for.
    for (const s of seeds()) {
      if (s.id.startsWith("tp-")) expect(s.note, s.id).toMatch(/^third_party_details yes/);
      if (s.id.startsWith("tpn-")) expect(s.note, s.id).toMatch(/^third_party_details no/);
    }
  });

  it(`puts at least ${MIN_POSITIVES_PER_PART} tp- items in each part of the split`, () => {
    const { tuning, checking } = perPart("tp-");
    expect(tuning, "tp- items in the tuning part").toBeGreaterThanOrEqual(MIN_POSITIVES_PER_PART);
    expect(checking, "tp- items in the held-back part").toBeGreaterThanOrEqual(MIN_POSITIVES_PER_PART);
  });

  it("puts some tpn- look-alikes in each part, so false alarms are counted in both", () => {
    const { tuning, checking } = perPart("tpn-");
    expect(tuning).toBeGreaterThanOrEqual(3);
    expect(checking).toBeGreaterThanOrEqual(3);
  });

  it("keeps real-looking identifiers out", () => {
    // The rule from test/jevGold.test.ts: after any country code, every long number starts
    // with 00. No real phone, ID or device number does.
    const numbers = [...raw.matchAll(/\+?\d[\d -]{7,}\d/g)].map((m) => m[0]);
    expect(numbers.length).toBeGreaterThan(5);
    for (const n of numbers) expect(n.replace(/^\+\d{1,3} /, ""), n).toMatch(/^00/);
    // The same for numbers given only by their last digits, however that is worded ("the account
    // ending 0042", "ends in", "last four digits are"): too short for the rule above to catch.
    const lastDigits = /\b(?:ending(?: in)?|ends (?:in|with)|last (?:\w+ )?digits(?: are)?:?) (\d+)/gi;
    const endings = [...raw.matchAll(lastDigits)].map((m) => m[1]!);
    expect(endings.length).toBeGreaterThan(0);
    for (const n of endings) expect(n, `a number ending ${n}`).toMatch(/^00/);
    // Email addresses only at example.com, a domain reserved for examples.
    for (const [address] of raw.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) {
      expect(address, address).toMatch(/@example\.com$/);
    }
  });
});
