'use strict';
// NULL-CALIBRATED CONCENTRATION — "is this edge carried by a few observations?"
// asked in a way that does not answer "how many observations are there?".
//
// The prosecutor's fixed thresholds convicted on dispersion twice, and both
// convictions dissolved under calibration:
//
//   screener  n=18  post-excision mean at the 49.6th percentile of its own null,
//                   skew -0.16 (37th). Nothing there. WEAK, not fragile: 0.14
//                   Sharpe/date, and removing the top decile of a near-zero-mean
//                   series flips it negative by arithmetic.
//   events    n=27  post-excision mean at the 34.9th percentile — also not
//                   extreme, and 83% of matched null draws fail excision too.
//                   But skew +0.94 sits at the 98.5th percentile: a right tail a
//                   symmetric draw essentially never produces. That is real.
//
// Absolute thresholds cannot separate those, because what they measure is n and
// sd. This asks the question directly: is the series more TAIL-CARRIED than a
// symmetric distribution with the same mean, sd and n?
//
// NULL CHOICE. A seeded Gaussian with matched moments — deliberately NOT a
// bootstrap of the observed values, which would make the observed statistic the
// centre of its own null by construction and detect nothing. The Gaussian is the
// "same location and scale, no tail concentration" reference, which is exactly
// the counterfactual the question needs.
//
// SEEDED. The repo grades on reproducible statistics (dateNet pins a
// moving-block bootstrap at seed 20260805). An adversarial verdict that changes
// between runs is not a verdict, so the PRNG is explicit and fixed — no ambient
// randomness and no clock anywhere in this module (pinned by test).
//
// WHAT IT IS NOT. Calibration says a shape is unusual against a symmetric
// reference; it does not say the shape is wrong. An event-driven strategy
// (forced-flow dislocations, index deletions, lockup expiries) is lottery-shaped
// BY DESIGN, and convicting it for that is convicting it for working as
// specified. The verdict is evidence for a human reading, never a promotion.

const DEFAULT_SEED = 20260813;
const DEFAULT_DRAWS = 2000;
const DEFAULT_ALPHA = 0.05;
// Below this, mean and sd do not characterise a distribution well enough for a
// matched null to mean anything. Calibration is otherwise safe at small n by
// construction — that is the point of it — so this floor is about being able to
// ESTIMATE the null at all, not about the test being harsh on short samples.
const MIN_N = 8;
// Slice removed for the post-excision statistic. Proportional, so it means the
// same thing at n=20 and n=200.
const EXCISION_FRACTION = 0.10;

// mulberry32 — small, fast, fully deterministic given the seed.
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller. Guards u=0, which would give -Infinity through the log.
function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdev(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function skewness(xs) {
  const m = mean(xs);
  const s = stdev(xs);
  if (!(s > 0)) return null;
  return xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / xs.length;
}

// Mean of the series after removing its best `EXCISION_FRACTION` — proportional,
// so it carries the same meaning across sample sizes.
function postExcisionMean(xs, fraction = EXCISION_FRACTION) {
  const sorted = [...xs].sort((a, b) => b - a);
  const k = Math.max(1, Math.round(sorted.length * fraction));
  if (k >= sorted.length) return null;
  return mean(sorted.slice(k));
}

// Share of observations at or below `x`, as a percentile.
function percentileOf(nullValues, x) {
  const below = nullValues.reduce((acc, v) => acc + (v <= x ? 1 : 0), 0);
  return +((below / nullValues.length) * 100).toFixed(1);
}

function median(xs) {
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round = (v, p = 3) => (Number.isFinite(v) ? +v.toFixed(p) : null);

/**
 * Calibrate a return series against a matched symmetric null.
 *
 * @param values  per-observation returns (per-DATE for maturity's use: a
 *                same-day cluster is one decision, not many)
 * @returns { ran, concentrated, n, mean, sd, skew:{observed,nullMedian,percentile},
 *            postExcision:{...}, alpha, draws, seed, basis, reason? }
 */
function calibrateConcentration(values, { seed = DEFAULT_SEED, draws = DEFAULT_DRAWS, alpha = DEFAULT_ALPHA, fraction = EXCISION_FRACTION } = {}) {
  const xs = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  const n = xs.length;
  const base = { ran: false, concentrated: false, n, alpha, draws, seed };
  if (n < MIN_N) {
    return { ...base, reason: `only ${n} observation(s) — a matched null cannot be estimated below ${MIN_N}` };
  }
  const m = mean(xs);
  const sd = stdev(xs);
  if (!(sd > 0)) {
    return { ...base, mean: round(m), sd: round(sd), reason: 'zero variance — a degenerate series has no tail to characterise' };
  }

  const obsSkew = skewness(xs);
  const obsPost = postExcisionMean(xs, fraction);

  // One PRNG stream, consumed in a fixed order, so the whole verdict is a pure
  // function of (values, seed, draws).
  const rand = prng(seed);
  const nullSkew = [];
  const nullPost = [];
  for (let d = 0; d < draws; d++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = m + sd * gaussian(rand);
    const sk = skewness(sample);
    if (sk != null) nullSkew.push(sk);
    const pe = postExcisionMean(sample, fraction);
    if (pe != null) nullPost.push(pe);
  }
  if (!nullSkew.length || !nullPost.length) {
    return { ...base, mean: round(m), sd: round(sd), reason: 'null could not be generated' };
  }

  const skewPct = percentileOf(nullSkew, obsSkew);
  const postPct = percentileOf(nullPost, obsPost);
  // Concentration shows up as a right tail heavier than the null (high skew
  // percentile) OR a post-excision mean deeper than the null (low percentile).
  // Both are one-sided: a LEFT-tailed series is not concentrated in the sense
  // that matters here, and a post-excision mean better than the null is a
  // strategy whose edge does NOT depend on its best dates.
  const skewExtreme = skewPct >= (1 - alpha) * 100;
  const postExtreme = postPct <= alpha * 100;

  return {
    ran: true,
    concentrated: skewExtreme || postExtreme,
    n, mean: round(m), sd: round(sd),
    skew: { observed: round(obsSkew), nullMedian: round(median(nullSkew)), percentile: skewPct, extreme: skewExtreme },
    postExcision: { observed: round(obsPost), nullMedian: round(median(nullPost)), percentile: postPct, extreme: postExtreme, fraction },
    alpha, draws, seed,
    basis: `observed skew and post-${Math.round(fraction * 100)}%-excision mean compared against ${draws} seeded Gaussian draws matched on mean, sd and n; concentrated when either sits beyond the ${alpha * 100}% one-sided tail`,
  };
}

module.exports = { calibrateConcentration, MIN_N, DEFAULT_SEED, DEFAULT_DRAWS, DEFAULT_ALPHA, EXCISION_FRACTION, skewness, postExcisionMean };
