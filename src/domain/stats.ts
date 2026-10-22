/** Seeded PRNG (mulberry32) so analysis results are stable between renders. */
export function rng(seed = 12345): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/** Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { estimate: NaN, low: NaN, high: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { estimate: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface TwoGroupTest {
  diff: number; // mean(b) - mean(a)
  ci: Interval;
  pValue: number;
  nA: number;
  nB: number;
}

/**
 * Compares two groups of independent units (here: per-printer rates).
 * p-value from a label permutation test; CI from a bootstrap that resamples units within each group.
 */
export function compareUnits(a: number[], b: number[], iterations = 4000, seed = 1): TwoGroupTest {
  const nA = a.length;
  const nB = b.length;
  const diff = mean(b) - mean(a);
  if (nA < 2 || nB < 2) return { diff, ci: { estimate: diff, low: NaN, high: NaN }, pValue: NaN, nA, nB };
  const rand = rng(seed);
  const pooled = [...a, ...b];
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    for (let j = pooled.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [pooled[j], pooled[k]] = [pooled[k], pooled[j]];
    }
    const d = mean(pooled.slice(nA)) - mean(pooled.slice(0, nA));
    if (Math.abs(d) >= Math.abs(diff) - 1e-12) extreme++;
  }
  const boots: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sa = 0;
    let sb = 0;
    for (let j = 0; j < nA; j++) sa += a[Math.floor(rand() * nA)];
    for (let j = 0; j < nB; j++) sb += b[Math.floor(rand() * nB)];
    boots.push(sb / nB - sa / nA);
  }
  boots.sort((x, y) => x - y);
  return {
    diff,
    ci: { estimate: diff, low: quantile(boots, 0.025), high: quantile(boots, 0.975) },
    pValue: (extreme + 1) / (iterations + 1),
    nA,
    nB,
  };
}

export interface PairedTest {
  meanDiff: number;
  ci: Interval;
  pValue: number;
  n: number;
}

/** Paired comparison (e.g. Maintenance minus Control per cycle): sign-flip permutation p, bootstrap CI. */
export function comparePaired(diffs: number[], iterations = 4000, seed = 2): PairedTest {
  const n = diffs.length;
  const m = mean(diffs);
  if (n < 2) return { meanDiff: m, ci: { estimate: m, low: NaN, high: NaN }, pValue: NaN, n };
  const rand = rng(seed);
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (const d of diffs) s += rand() < 0.5 ? d : -d;
    if (Math.abs(s / n) >= Math.abs(m) - 1e-12) extreme++;
  }
  const boots: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(rand() * n)];
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  return {
    meanDiff: m,
    ci: { estimate: m, low: quantile(boots, 0.025), high: quantile(boots, 0.975) },
    pValue: (extreme + 1) / (iterations + 1),
    n,
  };
}

/** Bootstrap CI of the mean of independent values (e.g. per-cycle net value). */
export function bootstrapMean(xs: number[], iterations = 4000, seed = 3): Interval {
  const m = mean(xs);
  if (xs.length < 2) return { estimate: m, low: NaN, high: NaN };
  const rand = rng(seed);
  const boots: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rand() * xs.length)];
    boots.push(s / xs.length);
  }
  boots.sort((x, y) => x - y);
  return { estimate: m, low: quantile(boots, 0.025), high: quantile(boots, 0.975) };
}
