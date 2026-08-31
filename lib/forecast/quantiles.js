'use strict';
// QUANTILE HANDLING & CDF→PROBABILITY MAPPING (forecast-quantiles-v1)
//
// Two jobs, both of which the spec insists must be explicit rather than assumed:
//
//   1. MONOTONICITY REPAIR. A quantile vector that decreases is not a distribution. We repair it
//      with the Pool-Adjacent-Violators algorithm (isotonic projection onto the non-decreasing
//      cone) — the minimum-L2 monotone vector — and RECORD that a repair happened, per row, so
//      the scoreboard can report how often models emit invalid quantiles.
//
//   2. PROBABILITIES FROM QUANTILES. P(Y > t) is read off the quantile function by inverting it:
//      given levels q_1..q_k with values v_1..v_k, the CDF is piecewise-linear in v between
//      consecutive (v_i, q_i) knots, and constant-extrapolated by an EXPONENTIAL tail outside
//      [v_1, v_k] so a threshold beyond the outermost quantile does not snap to 0 or 1.
//      This is a documented interpolation, not "exact probabilities from quantiles" — the
//      returned status says `cdf-interpolated`, and calibration (lib/forecast/calibration.js)
//      is what makes such a probability trustworthy.
//
// Also provides pinball loss and empirical coverage, the two metrics that tell you whether the
// quantiles mean anything.

const QUANTILES_VERSION = 'forecast-quantiles-v1';

const isFin = Number.isFinite;

/** Pool-Adjacent-Violators: nearest non-decreasing vector in L2. Returns { values, repaired }. */
function isotonicIncreasing(values) {
  const n = values.length;
  const v = values.slice();
  const w = new Array(n).fill(1);
  const idx = new Array(n).fill(0).map((_, i) => i);
  let k = 0;
  for (let i = 0; i < n; i++) {
    v[k] = values[i]; w[k] = 1; idx[k] = i;
    while (k > 0 && v[k - 1] > v[k]) {
      const nw = w[k - 1] + w[k];
      v[k - 1] = (v[k - 1] * w[k - 1] + v[k] * w[k]) / nw;
      w[k - 1] = nw;
      k--;
    }
    k++;
  }
  const out = new Array(n);
  let pos = 0;
  for (let b = 0; b < k; b++) { for (let j = 0; j < w[b]; j++) out[pos++] = v[b]; }
  const repaired = out.some((x, i) => Math.abs(x - values[i]) > 1e-12);
  return { values: out, repaired };
}

/** Normalize a { level -> value } map into sorted parallel arrays, repairing monotonicity. */
function normalizeQuantiles(quantiles) {
  const levels = Object.keys(quantiles || {}).map(Number).filter((l) => isFin(l) && l > 0 && l < 1).sort((a, b) => a - b);
  const raw = levels.map((l) => quantiles[l] ?? quantiles[l.toFixed(2)]);
  if (!levels.length || raw.some((v) => !isFin(v))) return { levels: [], values: [], repaired: false, usable: false };
  const iso = isotonicIncreasing(raw);
  return { levels, values: iso.values, repaired: iso.repaired, usable: levels.length >= 2 };
}

/**
 * P(Y > threshold) from a quantile function.
 * Interior: linear interpolation of the CDF between knots.
 * Tails: exponential decay with a scale set by the outermost inter-quantile gap, so the tail
 * probability shrinks smoothly instead of snapping to 0/1.
 */
function survivalFromQuantiles(quantiles, threshold) {
  const q = normalizeQuantiles(quantiles);
  if (!q.usable || !isFin(threshold)) return null;
  const { levels, values } = q;
  const n = levels.length;

  if (threshold <= values[0]) {
    const scale = Math.max(1e-9, (values[Math.min(1, n - 1)] - values[0]) || 1e-6);
    const excess = (values[0] - threshold) / scale;
    return Math.min(1, 1 - levels[0] * Math.exp(-excess));
  }
  if (threshold >= values[n - 1]) {
    const scale = Math.max(1e-9, (values[n - 1] - values[Math.max(0, n - 2)]) || 1e-6);
    const excess = (threshold - values[n - 1]) / scale;
    return Math.max(0, (1 - levels[n - 1]) * Math.exp(-excess));
  }
  for (let i = 0; i < n - 1; i++) {
    if (threshold >= values[i] && threshold <= values[i + 1]) {
      const span = values[i + 1] - values[i];
      const w = span > 0 ? (threshold - values[i]) / span : 0;
      const cdf = levels[i] + w * (levels[i + 1] - levels[i]);
      return Math.max(0, Math.min(1, 1 - cdf));
    }
  }
  return null;
}

/** Threshold probabilities for a whole forecast. Returns { probabilities, status, repaired }. */
function thresholdProbabilities(forecast, thresholds) {
  const q = normalizeQuantiles(forecast.quantiles);
  if (!q.usable) return { probabilities: {}, status: 'no-usable-quantiles', repaired: false };
  const probabilities = {};
  for (const t of thresholds) {
    const p = survivalFromQuantiles(forecast.quantiles, t);
    if (p !== null) probabilities[String(t)] = p;
  }
  return { probabilities, status: 'cdf-interpolated', repaired: q.repaired };
}

/** Pinball (quantile) loss for one level. Lower is better. */
function pinball(actual, predicted, level) {
  if (!isFin(actual) || !isFin(predicted) || !isFin(level)) return null;
  const d = actual - predicted;
  return d >= 0 ? level * d : (level - 1) * d;
}

/**
 * Coverage diagnostics over many (actual, quantiles) pairs.
 * `belowRate[q]` should approximate q when the quantiles are calibrated.
 */
function coverage(pairs, levels) {
  const counts = Object.fromEntries(levels.map((l) => [l, { below: 0, n: 0, pinball: 0 }]));
  for (const { actual, quantiles } of pairs) {
    if (!isFin(actual)) continue;
    const q = normalizeQuantiles(quantiles);
    if (!q.usable) continue;
    for (let i = 0; i < q.levels.length; i++) {
      const l = q.levels[i];
      if (!counts[l]) continue;
      counts[l].n++;
      if (actual <= q.values[i]) counts[l].below++;
      const pb = pinball(actual, q.values[i], l);
      if (pb !== null) counts[l].pinball += pb;
    }
  }
  const out = {};
  for (const l of levels) {
    const c = counts[l];
    out[l] = c && c.n ? {
      n: c.n,
      empirical: +(c.below / c.n).toFixed(5),
      nominal: l,
      error: +(c.below / c.n - l).toFixed(5),
      pinball: +(c.pinball / c.n).toFixed(8),
    } : null;
  }
  return out;
}

module.exports = { QUANTILES_VERSION, isotonicIncreasing, normalizeQuantiles, survivalFromQuantiles, thresholdProbabilities, pinball, coverage };
