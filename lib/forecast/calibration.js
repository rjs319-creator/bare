'use strict';
// PROBABILITY CALIBRATION (forecast-calibration-v1)
//
// A calibrator maps a raw score (a CDF-interpolated probability, a classifier margin, a ranker
// output) to a probability that MEANS something: among rows the model calls 0.30, about 30%
// should be positive.
//
// THE RULE THAT MATTERS MOST: a calibrator is fitted ONLY on cross-fitted or separate
// chronological validation predictions — never on the rows it will later score. `fit` records
// `fittedThroughDate` and `sourceEvaluationType`, and lib/forecast/leakage.js asserts that no
// row a calibrator scores is dated at or before its own fitting window without being marked.
//
// When the sample is too small or one class is too rare to support calibration, we do NOT
// silently return the raw number as if it were calibrated. `status` becomes
// 'insufficient-data' and the identity mapping is returned WITH that status attached, so the
// API can say "uncalibrated" instead of implying a probability it cannot support.
//
// Implementations (both pure JS, deterministic, no dependency):
//   * isotonic — PAVA on (score, label) pairs; the non-parametric default.
//   * platt    — single-variable logistic regression fitted by Newton-Raphson.

const CALIBRATION_VERSION = 'forecast-calibration-v1';

const STATUS = Object.freeze({
  CALIBRATED: 'calibrated',
  INSUFFICIENT_DATA: 'insufficient-data',
  DEGENERATE: 'degenerate-single-class',
  DISABLED: 'disabled',
});

const isFin = Number.isFinite;
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));

/** Weighted PAVA producing a step function over sorted scores. */
function fitIsotonic(pairs) {
  const sorted = pairs.slice().sort((a, b) => a.x - b.x);
  const blocks = [];
  for (const { x, y } of sorted) {
    blocks.push({ sum: y, n: 1, xMin: x, xMax: x });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ sum: a.sum + b.sum, n: a.n + b.n, xMin: a.xMin, xMax: b.xMax });
    }
  }
  return blocks.map((b) => ({ xMin: b.xMin, xMax: b.xMax, p: b.sum / b.n }));
}

function applyIsotonic(steps, x) {
  if (!steps.length || !isFin(x)) return null;
  if (x <= steps[0].xMax) return steps[0].p;
  if (x >= steps[steps.length - 1].xMin) return steps[steps.length - 1].p;
  for (let i = 0; i < steps.length; i++) {
    if (x >= steps[i].xMin && x <= steps[i].xMax) return steps[i].p;
    if (i + 1 < steps.length && x > steps[i].xMax && x < steps[i + 1].xMin) {
      // Linear bridge across the gap between two blocks — avoids a discontinuous jump.
      const span = steps[i + 1].xMin - steps[i].xMax;
      const w = span > 0 ? (x - steps[i].xMax) / span : 0;
      return steps[i].p + w * (steps[i + 1].p - steps[i].p);
    }
  }
  return steps[steps.length - 1].p;
}

/** Platt scaling: logistic regression of y on x, Newton-Raphson, deterministic. */
function fitPlatt(pairs, { maxIter = 50, tol = 1e-9 } = {}) {
  let a = 0, b = 0;
  for (let it = 0; it < maxIter; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const { x, y } of pairs) {
      const z = a * x + b;
      const p = 1 / (1 + Math.exp(-z));
      const w = Math.max(1e-9, p * (1 - p));
      const r = p - y;
      g0 += r * x; g1 += r;
      h00 += w * x * x; h01 += w * x; h11 += w;
    }
    const det = h00 * h11 - h01 * h01;
    if (!isFin(det) || Math.abs(det) < 1e-14) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const db = (g1 * h00 - g0 * h01) / det;
    a -= da; b -= db;
    if (Math.abs(da) < tol && Math.abs(db) < tol) break;
  }
  return { a, b };
}

/**
 * Fit a calibrator.
 *   pairs: [{ x: rawScore, y: 0|1, date }]
 *   opts.sourceEvaluationType: 'cross-fitted' | 'validation'  — REQUIRED for provenance.
 * Returns a frozen calibrator with `apply(x)`.
 */
function fit(pairs, cfg, { method = null, sourceEvaluationType = null, label = null } = {}) {
  const m = method || cfg.calibration.method;
  const clean = (pairs || []).filter((p) => p && isFin(p.x) && (p.y === 0 || p.y === 1));
  const positives = clean.reduce((a, p) => a + p.y, 0);
  const negatives = clean.length - positives;
  let maxDate = null;
  for (const p of clean) if (p.date && (maxDate === null || p.date > maxDate)) maxDate = p.date;

  const base = {
    schema: 'ForecastCalibrator', version: CALIBRATION_VERSION,
    method: m, label,
    n: clean.length, positives, negatives,
    prevalence: clean.length ? positives / clean.length : null,
    fittedThroughDate: maxDate,
    sourceEvaluationType: sourceEvaluationType || 'unknown',
  };

  if (m === 'none') return Object.freeze({ ...base, status: STATUS.DISABLED, apply: (x) => (isFin(x) ? clamp01(x) : null) });
  if (clean.length < cfg.calibration.minSamples) {
    return Object.freeze({ ...base, status: STATUS.INSUFFICIENT_DATA, reason: `${clean.length} rows < ${cfg.calibration.minSamples}`, apply: (x) => (isFin(x) ? clamp01(x) : null) });
  }
  if (positives < cfg.calibration.minPositives || negatives < cfg.calibration.minNegatives) {
    return Object.freeze({ ...base, status: STATUS.DEGENERATE, reason: `positives=${positives} negatives=${negatives} below minimum`, apply: (x) => (isFin(x) ? clamp01(x) : null) });
  }

  if (m === 'platt') {
    const { a, b } = fitPlatt(clean);
    return Object.freeze({ ...base, status: STATUS.CALIBRATED, params: { a, b }, apply: (x) => (isFin(x) ? clamp01(1 / (1 + Math.exp(-(a * x + b)))) : null) });
  }
  const steps = fitIsotonic(clean.map(({ x, y }) => ({ x, y })));
  return Object.freeze({ ...base, status: STATUS.CALIBRATED, steps: Object.freeze(steps), apply: (x) => { const p = applyIsotonic(steps, x); return p === null ? null : clamp01(p); } });
}

/** An explicitly uncalibrated pass-through, for when no calibrator could be fitted at all. */
function identityCalibrator(label = null, reason = 'no calibrator fitted') {
  return Object.freeze({
    schema: 'ForecastCalibrator', version: CALIBRATION_VERSION, method: 'identity', label,
    n: 0, positives: 0, negatives: 0, prevalence: null, fittedThroughDate: null,
    sourceEvaluationType: 'none', status: STATUS.INSUFFICIENT_DATA, reason,
    apply: (x) => (isFin(x) ? clamp01(x) : null),
  });
}

/** Reliability bins for a calibration curve — equal-count bins, reported with their prevalence. */
function reliability(pairs, bins = 10) {
  const clean = (pairs || []).filter((p) => p && isFin(p.x) && (p.y === 0 || p.y === 1)).sort((a, b) => a.x - b.x);
  if (!clean.length) return [];
  const per = Math.max(1, Math.floor(clean.length / bins));
  const out = [];
  for (let i = 0; i < clean.length; i += per) {
    const chunk = clean.slice(i, i + per);
    if (chunk.length < Math.max(5, per / 2) && out.length) { // fold a ragged tail into the last bin
      const last = out[out.length - 1];
      last.n += chunk.length;
      last.meanPredicted = (last.meanPredicted * (last.n - chunk.length) + chunk.reduce((a, p) => a + p.x, 0)) / last.n;
      last.observed = (last.observed * (last.n - chunk.length) + chunk.reduce((a, p) => a + p.y, 0)) / last.n;
      continue;
    }
    out.push({
      n: chunk.length,
      meanPredicted: chunk.reduce((a, p) => a + p.x, 0) / chunk.length,
      observed: chunk.reduce((a, p) => a + p.y, 0) / chunk.length,
      lo: chunk[0].x, hi: chunk[chunk.length - 1].x,
    });
  }
  return out.map((b) => ({ ...b, meanPredicted: +b.meanPredicted.toFixed(6), observed: +b.observed.toFixed(6), gap: +(b.observed - b.meanPredicted).toFixed(6) }));
}

module.exports = { CALIBRATION_VERSION, STATUS, fit, identityCalibrator, reliability, fitIsotonic, applyIsotonic, fitPlatt };
