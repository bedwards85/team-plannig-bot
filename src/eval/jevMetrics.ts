/**
 * Plain statistics for checking a yes/no classifier against gold labels:
 * precision and recall at a threshold, AUROC, calibration error, isotonic
 * recalibration and a repeat-run flip rate. No dependencies, so it is easy to test.
 */

export interface Scored {
  p: number;
  y: boolean;
}

export function precisionRecall(items: Scored[], threshold: number): { precision: number | null; recall: number | null } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const { p, y } of items) {
    const flagged = p >= threshold;
    if (flagged && y) tp++;
    else if (flagged && !y) fp++;
    else if (!flagged && y) fn++;
  }
  return {
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}

/** Area under the ROC curve: the chance a random positive scores above a random negative (ties count half). */
export function auroc(items: Scored[]): number | null {
  const pos = items.filter((i) => i.y).map((i) => i.p);
  const neg = items.filter((i) => !i.y).map((i) => i.p);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Expected calibration error over equal-width bins: how far stated probabilities sit from observed rates. */
export function expectedCalibrationError(items: Scored[], bins = 10): number | null {
  if (items.length === 0) return null;
  const sums = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { p, y } of items) {
    // Clamped at both ends: p = 1 joins the last bin, and a stray value below 0 the first.
    const b = sums[Math.min(Math.max(Math.floor(p * bins), 0), bins - 1)]!;
    b.n++;
    b.p += p;
    b.y += y ? 1 : 0;
  }
  return sums.reduce((acc, b) => (b.n ? acc + (b.n / items.length) * Math.abs(b.p / b.n - b.y / b.n) : acc), 0);
}

/** One step of an isotonic map: inputs from `lo` to `hi` map to `value`. */
export type IsotonicBlock = [lo: number, hi: number, value: number];

/**
 * Fits a non-decreasing map from score to observed rate (pool-adjacent-violators).
 * Equal scores are pooled first, so the fit does not depend on the order of the items.
 */
export function fitIsotonic(items: Scored[]): IsotonicBlock[] {
  const sorted = [...items].sort((a, b) => a.p - b.p);
  const groups: Array<{ lo: number; hi: number; sum: number; n: number }> = [];
  for (const { p, y } of sorted) {
    const same = groups[groups.length - 1];
    if (same && same.lo === p) {
      same.sum += y ? 1 : 0;
      same.n++;
    } else {
      groups.push({ lo: p, hi: p, sum: y ? 1 : 0, n: 1 });
    }
  }
  const blocks: typeof groups = [];
  for (const group of groups) {
    blocks.push(group);
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.n <= last.sum / last.n) break;
      blocks.splice(-2, 2, { lo: prev.lo, hi: last.hi, sum: prev.sum + last.sum, n: prev.n + last.n });
    }
  }
  return blocks.map((b) => [b.lo, b.hi, b.sum / b.n]);
}

/** Applies an isotonic map, interpolating between blocks and clamping at the ends. */
export function applyIsotonic(blocks: IsotonicBlock[], p: number): number {
  if (blocks.length === 0) return p;
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  if (p <= first[1]) return first[2];
  if (p >= last[0]) return last[2];
  for (let i = 0; i < blocks.length; i++) {
    const [lo, hi, value] = blocks[i]!;
    if (p >= lo && p <= hi) return value;
    const next = blocks[i + 1];
    if (next && p > hi && p < next[0]) {
      const t = (p - hi) / (next[0] - hi);
      return value + t * (next[2] - value);
    }
  }
  return last[2];
}

/**
 * The highest threshold that still catches at least `minRecall` of the positives,
 * which keeps false alarms as low as that recall allows.
 */
export function pickThreshold(items: Scored[], minRecall: number): number | null {
  const positives = items.filter((i) => i.y).length;
  if (positives === 0) return null;
  const candidates = [...new Set(items.map((i) => i.p))].sort((a, b) => b - a);
  for (const t of candidates) {
    const { recall } = precisionRecall(items, t);
    if (recall !== null && recall >= minRecall) return t;
  }
  return candidates[candidates.length - 1] ?? null;
}

/** Share of items whose yes/no decision changed across repeated identical requests. */
export function flipRate(decisionsPerItem: boolean[][]): number | null {
  const usable = decisionsPerItem.filter((d) => d.length > 1);
  if (usable.length === 0) return null;
  return usable.filter((d) => d.some((x) => x !== d[0])).length / usable.length;
}

/**
 * Stable 70/30 split by id, so the same item always lands on the same side.
 * The final mixing step matters: without it the hash's last bit just follows the
 * id's characters, so about half of all ids went to tuning 80% of the time and the
 * other half 60%, rather than all of them 70%.
 */
export function isCalibrationSplit(id: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32 < 0.7;
}
