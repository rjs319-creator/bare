'use strict';
// RESEARCH STATISTICS V3 (research-stats-v3) — the dependence-aware inference
// toolkit the v2 harness lacked.
//
// Fixes the verified defect: lib/research/harness.js summarizeICs called its
// resampler a "block bootstrap" while drawing SINGLE dates IID — blocks of
// length one, which destroys serial dependence and understates uncertainty for
// autocorrelated daily ICs. This module provides:
//   * neweyWest       — HAC (Bartlett-kernel) t-statistics with horizon-
//                       appropriate lags for temporal inference.
//   * movingBlockBootstrap / stationaryBootstrap — genuine block resampling
//                       that preserves local dependence.
//   * pairedDaily     — paired candidate-minus-baseline daily results (the unit
//                       of comparison is the DATE, not the pooled row).
//   * effectiveSampleSize — autocorrelation-discounted n.
//   * pFromT / normalCdf  — two-sided p-values for the BH correction.
//
// Deterministic: all randomness comes from a seeded LCG. Pure module.

const STATS_V3_VERSION = 'research-stats-v3';

function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function autocovariance(vals, lag) {
  const n = vals.length, m = mean(vals);
  let s = 0;
  for (let t = lag; t < n; t++) s += (vals[t] - m) * (vals[t - lag] - m);
  return s / n;
}

// Newey-West (1987) HAC variance of the sample mean with Bartlett weights.
// Default lag: horizon-appropriate — pass the label horizon in bars; overlapping
// h-bar labels induce autocorrelation out to ~h-1 lags.
function neweyWest(vals, { lags = null, horizonBars = null } = {}) {
  const xs = (vals || []).filter(Number.isFinite);
  const n = xs.length;
  if (n < 3) return { n, mean: null, tstat: null, se: null, lags: null, note: 'too few observations' };
  const L = lags != null ? lags
    : horizonBars != null ? Math.max(1, horizonBars - 1)
      : Math.max(1, Math.floor(1.5 * Math.cbrt(n)));   // Andrews-style rule of thumb
  const m = mean(xs);
  let lrv = autocovariance(xs, 0);
  for (let l = 1; l <= Math.min(L, n - 1); l++) {
    lrv += 2 * (1 - l / (L + 1)) * autocovariance(xs, l);
  }
  lrv = Math.max(lrv, 0);
  const se = Math.sqrt(lrv / n);
  return {
    n, lags: L, mean: m, se,
    tstat: se > 0 ? m / se : null,
    naiveTstat: (() => { const v = autocovariance(xs, 0) * (n / (n - 1)); const s0 = Math.sqrt(v / n); return s0 > 0 ? m / s0 : null; })(),
  };
}

// Effective sample size under serial correlation: n / (1 + 2·Σρ_k), truncated
// at the first non-positive autocorrelation (Geyer-style) and floored at 1.
function effectiveSampleSize(vals) {
  const xs = (vals || []).filter(Number.isFinite);
  const n = xs.length;
  if (n < 3) return { n, ess: n };
  const g0 = autocovariance(xs, 0);
  if (!(g0 > 0)) return { n, ess: n };
  let sum = 0;
  for (let l = 1; l < n - 1; l++) {
    const rho = autocovariance(xs, l) / g0;
    if (rho <= 0) break;
    sum += rho;
  }
  return { n, ess: Math.max(1, Math.round(n / (1 + 2 * sum))) };
}

// GENUINE moving-block bootstrap over an ORDERED series: resample overlapping
// blocks of length `blockLen` (order preserved inside each block) until n is
// reached. blockLen defaults to ~n^(1/3) — never 1 unless n is tiny.
function movingBlockBootstrap(vals, { blockLen = null, B = 1000, seed = 12345, stat = mean } = {}) {
  const xs = (vals || []).filter(Number.isFinite);
  const n = xs.length;
  if (n < 4) return { n, blockLen: null, B: 0, ci90: null, note: 'too few observations' };
  const L = Math.max(2, Math.min(blockLen || Math.round(Math.cbrt(n) * 1.5), Math.floor(n / 2)));
  const nBlocks = n - L + 1;
  const rnd = lcg(seed);
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rnd() * nBlocks);
      for (let j = 0; j < L && sample.length < n; j++) sample.push(xs[start + j]);
    }
    stats.push(stat(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p) => stats[Math.min(B - 1, Math.max(0, Math.floor(p * B)))];
  return {
    n, blockLen: L, B,
    mean: +mean(stats).toFixed(6),
    ci90: [+q(0.05).toFixed(6), +q(0.95).toFixed(6)],
    sd: +Math.sqrt(autocovariance(stats, 0)).toFixed(6),
  };
}

// Politis-Romano stationary bootstrap: geometric block lengths, expected L.
function stationaryBootstrap(vals, { expectedBlockLen = null, B = 1000, seed = 12345, stat = mean } = {}) {
  const xs = (vals || []).filter(Number.isFinite);
  const n = xs.length;
  if (n < 4) return { n, B: 0, ci90: null, note: 'too few observations' };
  const L = Math.max(2, Math.min(expectedBlockLen || Math.round(Math.cbrt(n) * 1.5), Math.floor(n / 2)));
  const p = 1 / L;
  const rnd = lcg(seed);
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    let idx = Math.floor(rnd() * n);
    while (sample.length < n) {
      sample.push(xs[idx]);
      idx = rnd() < p ? Math.floor(rnd() * n) : (idx + 1) % n;
    }
    stats.push(stat(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (pp) => stats[Math.min(B - 1, Math.max(0, Math.floor(pp * B)))];
  return { n, expectedBlockLen: L, B, mean: +mean(stats).toFixed(6), ci90: [+q(0.05).toFixed(6), +q(0.95).toFixed(6)] };
}

// Paired daily candidate-minus-baseline series. Only dates where BOTH sides
// have a value are compared — a missing side EXCLUDES the date and is reported,
// never scored as zero.
function pairedDaily(candidateByDate, baselineByDate) {
  const dates = Object.keys(candidateByDate).filter((d) => Number.isFinite(candidateByDate[d]) && Number.isFinite(baselineByDate[d])).sort();
  const diffs = dates.map((d) => candidateByDate[d] - baselineByDate[d]);
  const candOnly = Object.keys(candidateByDate).filter((d) => Number.isFinite(candidateByDate[d]) && !Number.isFinite(baselineByDate[d])).length;
  const baseOnly = Object.keys(baselineByDate).filter((d) => Number.isFinite(baselineByDate[d]) && !Number.isFinite(candidateByDate[d])).length;
  return { dates, diffs, pairedN: dates.length, candidateOnlyDates: candOnly, baselineOnlyDates: baseOnly };
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf approximation — plenty for q-value work.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
const pFromT = (t) => (Number.isFinite(t) ? Math.min(1, 2 * (1 - normalCdf(Math.abs(t)))) : null);

// Influence of individual outliers: max single-date effect on the mean.
function outlierDependence(vals) {
  const xs = (vals || []).filter(Number.isFinite);
  if (xs.length < 3) return null;
  const full = mean(xs);
  let maxShift = 0, at = -1;
  for (let i = 0; i < xs.length; i++) {
    const loo = (full * xs.length - xs[i]) / (xs.length - 1);
    const shift = Math.abs(full - loo);
    if (shift > maxShift) { maxShift = shift; at = i; }
  }
  return { meanAll: full, maxLeaveOneOutShift: maxShift, dominantIndex: at, dominantFrac: full !== 0 ? +(maxShift / Math.abs(full)).toFixed(3) : null };
}

module.exports = {
  STATS_V3_VERSION, lcg, mean, autocovariance,
  neweyWest, effectiveSampleSize, movingBlockBootstrap, stationaryBootstrap,
  pairedDaily, normalCdf, pFromT, outlierDependence,
};
