import { describe, expect, it } from "vitest";
import {
  applyIsotonic,
  auroc,
  expectedCalibrationError,
  fitIsotonic,
  flipRate,
  isCalibrationSplit,
  pickThreshold,
  precisionRecall,
  type IsotonicBlock,
  type Scored,
} from "../src/eval/jevMetrics.js";

const yes = (p: number): Scored => ({ p, y: true });
const no = (p: number): Scored => ({ p, y: false });

/** A small seeded generator, so the "random" data is the same on every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Scores loosely related to the labels, rounded to two places so some scores tie. */
function noisyItems(n: number, seed: number): Scored[] {
  const rand = seeded(seed);
  return Array.from({ length: n }, () => {
    const y = rand() < 0.4;
    const p = Math.round(Math.min(1, Math.max(0, (y ? 0.65 : 0.35) + (rand() - 0.5) * 0.8)) * 100) / 100;
    return { p, y };
  });
}

describe("precisionRecall", () => {
  const items = [yes(0.9), no(0.8), yes(0.6), yes(0.4), no(0.2)];

  it("counts hits, false alarms and misses at the threshold", () => {
    const { precision, recall } = precisionRecall(items, 0.5);
    expect(precision).toBeCloseTo(2 / 3);
    expect(recall).toBeCloseTo(2 / 3);
  });

  it("flags a score equal to the threshold", () => {
    expect(precisionRecall(items, 0.6)).toEqual(precisionRecall(items, 0.55));
    expect(precisionRecall(items, 0.4).recall).toBe(1);
  });

  it("gives null precision when nothing is flagged", () => {
    expect(precisionRecall(items, 0.95)).toEqual({ precision: null, recall: 0 });
  });

  it("gives null recall when there are no positives", () => {
    expect(precisionRecall([no(0.9), no(0.1)], 0.5)).toEqual({ precision: 0, recall: null });
  });

  it("gives null for both on an empty list", () => {
    expect(precisionRecall([], 0.5)).toEqual({ precision: null, recall: null });
  });
});

describe("auroc", () => {
  it("is 1 when every positive scores above every negative", () => {
    expect(auroc([yes(0.9), yes(0.7), no(0.4), no(0.1)])).toBe(1);
  });

  it("is 0 when the scores are exactly backwards", () => {
    expect(auroc([yes(0.1), yes(0.3), no(0.6), no(0.9)])).toBe(0);
  });

  it("counts a tie as half a win", () => {
    expect(auroc([yes(0.5), no(0.5)])).toBe(0.5);
    // Pairs: 0.8>0.5, 0.8>0.2, 0.5=0.5 (half), 0.5>0.2 -> 3.5 of 4.
    expect(auroc([yes(0.8), yes(0.5), no(0.5), no(0.2)])).toBe(0.875);
  });

  it("is null when one class is missing", () => {
    expect(auroc([yes(0.9), yes(0.2)])).toBeNull();
    expect(auroc([no(0.9), no(0.2)])).toBeNull();
    expect(auroc([])).toBeNull();
  });
});

describe("expectedCalibrationError", () => {
  it("is 0 when stated probabilities match observed rates", () => {
    const items = [yes(0.25), no(0.25), no(0.25), no(0.25), yes(0.75), yes(0.75), yes(0.75), no(0.75)];
    expect(expectedCalibrationError(items)).toBeCloseTo(0, 10);
  });

  it("is the gap when every item is wrong in the same way", () => {
    expect(expectedCalibrationError([no(0.9), no(0.9), no(0.9)])).toBeCloseTo(0.9);
  });

  it("puts p = 1 in the last bin rather than a bin of its own", () => {
    expect(expectedCalibrationError([yes(1)])).toBe(0);
    // Same bin: mean p 0.96, rate 0.5 -> 0.46. A separate bin for p = 1 would give 0.54.
    expect(expectedCalibrationError([no(1), yes(0.92)])).toBeCloseTo(0.46);
  });

  it("weights each bin by its share of the items", () => {
    // Three items at p = 0 that are all no (gap 0) and one at 0.9 that is no (gap 0.9): a quarter of 0.9.
    const items = [no(0), no(0), no(0), no(0.9)];
    expect(expectedCalibrationError(items)).toBeCloseTo(0.25 * 0.9);
  });

  it("puts a stray score below 0 in the first bin instead of failing", () => {
    // Bin 0 holds both: mean p (-0.1 + 0.05) / 2 = -0.025, rate 0 -> 0.025.
    expect(expectedCalibrationError([no(-0.1), no(0.05)])).toBeCloseTo(0.025);
  });

  it("is null for an empty list", () => {
    expect(expectedCalibrationError([])).toBeNull();
  });
});

describe("fitIsotonic", () => {
  it("pools a pair that breaks the order", () => {
    expect(fitIsotonic([no(0.1), yes(0.2), no(0.3), yes(0.4)])).toEqual([
      [0.1, 0.1, 0],
      [0.2, 0.3, 0.5],
      [0.4, 0.4, 1],
    ]);
  });

  it("pools back through several earlier blocks when needed", () => {
    expect(fitIsotonic([yes(0.1), yes(0.2), no(0.3), no(0.4)])).toEqual([[0.1, 0.4, 0.5]]);
  });

  it("does not care what order the items come in", () => {
    const items = noisyItems(200, 7);
    expect(fitIsotonic([...items].reverse())).toEqual(fitIsotonic(items));
  });

  it("puts equal scores in one block whatever the order", () => {
    expect(fitIsotonic([no(0.5), yes(0.5)])).toEqual([[0.5, 0.5, 0.5]]);
    expect(fitIsotonic([yes(0.5), no(0.5)])).toEqual([[0.5, 0.5, 0.5]]);
    // Ties next to a lower block stay separate when their pooled rate is higher.
    expect(fitIsotonic([yes(0.1), no(0.1), no(0.2), yes(0.2), yes(0.2), yes(0.2)])).toEqual([
      [0.1, 0.1, 0.5],
      [0.2, 0.2, 0.75],
    ]);
  });

  it("returns ordered, non-overlapping blocks with non-decreasing values", () => {
    const blocks = fitIsotonic(noisyItems(300, 42));
    expect(blocks.length).toBeGreaterThan(1);
    for (const [lo, hi] of blocks) expect(lo).toBeLessThanOrEqual(hi);
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1]!;
      const cur = blocks[i]!;
      expect(cur[0]).toBeGreaterThan(prev[1]);
      expect(cur[2]).toBeGreaterThanOrEqual(prev[2]);
    }
  });

  it("gives each block the observed rate of the items inside it", () => {
    const items = noisyItems(300, 3);
    const blocks = fitIsotonic(items);
    let covered = 0;
    for (const [lo, hi, value] of blocks) {
      const inside = items.filter((i) => i.p >= lo && i.p <= hi);
      covered += inside.length;
      expect(value).toBeCloseTo(inside.filter((i) => i.y).length / inside.length, 12);
    }
    expect(covered).toBe(items.length);
  });

  it("returns no blocks for no items", () => {
    expect(fitIsotonic([])).toEqual([]);
  });
});

describe("applyIsotonic", () => {
  const blocks: IsotonicBlock[] = [
    [0.1, 0.3, 0.2],
    [0.5, 0.6, 0.4],
    [0.8, 0.9, 0.9],
  ];

  it("returns the block value inside a block, edges included", () => {
    expect(applyIsotonic(blocks, 0.2)).toBe(0.2);
    expect(applyIsotonic(blocks, 0.55)).toBe(0.4);
    expect(applyIsotonic(blocks, 0.5)).toBe(0.4);
    expect(applyIsotonic(blocks, 0.6)).toBe(0.4);
    expect(applyIsotonic(blocks, 0.85)).toBe(0.9);
  });

  it("interpolates in the gap between blocks", () => {
    expect(applyIsotonic(blocks, 0.4)).toBeCloseTo(0.3);
    expect(applyIsotonic(blocks, 0.7)).toBeCloseTo(0.65);
    expect(applyIsotonic(blocks, 0.35)).toBeCloseTo(0.25);
  });

  it("clamps below the first block and above the last", () => {
    expect(applyIsotonic(blocks, 0)).toBe(0.2);
    expect(applyIsotonic(blocks, 0.05)).toBe(0.2);
    expect(applyIsotonic(blocks, 0.95)).toBe(0.9);
    expect(applyIsotonic(blocks, 1)).toBe(0.9);
  });

  it("maps everything to the one value of a single-block map", () => {
    expect(applyIsotonic([[0.4, 0.6, 0.3]], 0)).toBe(0.3);
    expect(applyIsotonic([[0.4, 0.6, 0.3]], 0.5)).toBe(0.3);
    expect(applyIsotonic([[0.4, 0.6, 0.3]], 1)).toBe(0.3);
  });

  it("leaves the score alone with an empty map", () => {
    expect(applyIsotonic([], 0.37)).toBe(0.37);
  });

  it("stays non-decreasing over a fitted map", () => {
    const fitted = fitIsotonic(noisyItems(300, 11));
    let previous = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const v = applyIsotonic(fitted, p);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = v;
    }
  });
});

describe("pickThreshold", () => {
  const items = [yes(0.9), yes(0.8), no(0.7), yes(0.6), no(0.5), yes(0.3), no(0.2)];

  it("picks the highest threshold that still reaches the recall", () => {
    expect(pickThreshold(items, 0.75)).toBe(0.6);
    expect(pickThreshold(items, 0.5)).toBe(0.8);
    expect(pickThreshold(items, 1)).toBe(0.3);
  });

  it("returns a threshold whose recall is enough, while the next one up falls short", () => {
    const t = pickThreshold(items, 0.75)!;
    expect(precisionRecall(items, t).recall).toBeGreaterThanOrEqual(0.75);
    expect(precisionRecall(items, 0.7).recall).toBeLessThan(0.75);
  });

  it("is null with no positives", () => {
    expect(pickThreshold([no(0.9), no(0.1)], 0.9)).toBeNull();
    expect(pickThreshold([], 0.9)).toBeNull();
  });
});

describe("flipRate", () => {
  it("is 0 when every item gets the same answer each time", () => {
    expect(flipRate([[true, true, true], [false, false], [true, true]])).toBe(0);
  });

  it("counts an item once however often it flips", () => {
    expect(flipRate([[true, false, true, false], [true, true, true], [false, false, false], [false, true]])).toBe(0.5);
  });

  it("ignores items with only one run", () => {
    expect(flipRate([[true, false], [true], [false]])).toBe(1);
  });

  it("is null when no item has two or more runs", () => {
    expect(flipRate([[true], [false], []])).toBeNull();
    expect(flipRate([])).toBeNull();
  });
});

describe("isCalibrationSplit", () => {
  it("always puts the same id on the same side", () => {
    for (const id of ["run-1:amara:3", "seed-17", "", "x"]) {
      expect(isCalibrationSplit(id)).toBe(isCalibrationSplit(id));
    }
    const first = Array.from({ length: 200 }, (_, i) => isCalibrationSplit(`item-${i}`));
    const second = Array.from({ length: 200 }, (_, i) => isCalibrationSplit(`item-${i}`));
    expect(second).toEqual(first);
  });

  it("keeps the sides it has always had", () => {
    // Changing the split would move replies between tuning and checking under an existing calibration.
    const sides = Object.fromEntries(
      ["seed:tp-coach-repeats-account", "eval-2026-10-05.json:amara:2", "eval-2026-10-05.json:amara:4", "item-0", "item-2"].map(
        (id) => [id, isCalibrationSplit(id)],
      ),
    );
    expect(sides).toEqual({
      "seed:tp-coach-repeats-account": true,
      "eval-2026-10-05.json:amara:2": true,
      "eval-2026-10-05.json:amara:4": false,
      "item-0": false,
      "item-2": true,
    });
  });

  const idPatterns = [
    (i: number) => `item-${i}`,
    (i: number) => `run-${i % 5}:persona-${i % 13}:line-${i}`,
    (i: number) => `seed:case-${i}`,
    // Gold-set shape: run file, persona, coach line (always even).
    (i: number) => `eval-2026-10-0${i % 5}.json:persona-${i % 13}:${2 * Math.floor(i / 65) + 2}`,
  ];

  it("puts roughly 70% of ids on the calibration side", () => {
    for (const make of idPatterns) {
      let inCalibration = 0;
      for (let i = 0; i < 1000; i++) if (isCalibrationSplit(make(i))) inCalibration++;
      expect(inCalibration).toBeGreaterThanOrEqual(650);
      expect(inCalibration).toBeLessThanOrEqual(750);
    }
  });

  it("splits 70/30 within groups of ids that differ only in their characters' last bit", () => {
    // A hash without a final mixing step sent one half of these to tuning about 60% of the time and the other about 80%.
    const parity = (id: string) => [...id].reduce((x, c) => x ^ (c.charCodeAt(0) & 1), 0);
    for (const make of idPatterns) {
      const groups = [
        { n: 0, inCalibration: 0 },
        { n: 0, inCalibration: 0 },
      ];
      for (let i = 0; i < 1000; i++) {
        const id = make(i);
        const group = groups[parity(id)]!;
        group.n++;
        if (isCalibrationSplit(id)) group.inCalibration++;
      }
      for (const { n, inCalibration } of groups) {
        expect(n).toBeGreaterThan(400);
        expect(inCalibration / n).toBeGreaterThan(0.62);
        expect(inCalibration / n).toBeLessThan(0.78);
      }
    }
  });
});
