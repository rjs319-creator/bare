'use strict';
// DATE-GROUPED BASELINE RANKERS (research-ranker-v1)
//
// A progression of rankers with a COMMON interface so the harness can compare them on identical
// folds (Part VII). Each ranker is { name, fit(trainRows) -> model, score(model, row) -> number }.
// Ranking is always evaluated WITHIN a decision date (group-aware) by the harness, so only the
// per-row score's relative order matters.
//
//   randomRanker            — control: deterministic pseudo-order (no information).
//   residualMomentumRanker  — market-residual 21d momentum; the "generic momentum" null model.
//   productionCompositeRanker — passthrough of the existing production composite `row.score`.
//   ridgeRanker             — regularized linear model over the continuous feature vector, fit on
//                             TRAIN rows only (weights standardized by train-fit mean/std → no leak).
//
// Pure & dependency-free. The ridge fit is deterministic (fixed init, fixed iterations) so reruns
// are byte-identical — a requirement for the reproducible manifest.

const { FEATURE_KEYS } = require('./features');

const RANKER_VERSION = 'research-ranker-v1';

const isFin = (v) => Number.isFinite(v);
const feat = (row, k) => (row && row.features && isFin(row.features[k]) ? row.features[k] : null);

// A stable, information-free pseudo-order from a string key — the negative-control ranker.
function hashOrder(s) {
  let h = 2166136261;
  for (let i = 0; i < (s || '').length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

const randomRanker = {
  name: 'control-random',
  fit() { return null; },
  score(_m, row) { return hashOrder(`${row.securityId || row.ticker || ''}|${row.decisionTs || ''}`); },
};

const residualMomentumRanker = {
  name: 'residual-momentum',
  fit() { return null; },
  score(_m, row) {
    const rm = feat(row, 'residMom21');
    return rm != null ? rm : (feat(row, 'ret21') != null ? feat(row, 'ret21') : 0);
  },
};

const productionCompositeRanker = {
  name: 'production-composite',
  fit() { return null; },
  score(_m, row) { return isFin(row && row.score) ? row.score : 0; },
};

// ── Ridge (L2) linear ranker over the continuous feature vector ──
// Standardize each feature by TRAIN mean/std (imputing missing to the mean → z=0), then fit
// w to predict `outcome` with L2 regularization via deterministic gradient descent.
function fitStats(rows, keys) {
  const stats = {};
  for (const k of keys) {
    const xs = rows.map((r) => feat(r, k)).filter(isFin);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const varr = xs.length ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length : 0;
    stats[k] = { mean, std: Math.sqrt(varr) || 1 };
  }
  return stats;
}
function zvec(row, keys, stats) {
  return keys.map((k) => { const v = feat(row, k); const s = stats[k]; return v == null ? 0 : (v - s.mean) / s.std; });
}

const ridgeRanker = {
  name: 'ridge-linear',
  // opts: { lambda, iters, lr }
  fit(trainRows, opts = {}) {
    const keys = FEATURE_KEYS;
    const rows = (trainRows || []).filter((r) => isFin(r && r.outcome));
    if (rows.length < 20) return { keys, stats: fitStats(rows, keys), w: keys.map(() => 0), b: 0, degenerate: true, n: rows.length };
    const stats = fitStats(rows, keys);
    const X = rows.map((r) => zvec(r, keys, stats));
    const y = rows.map((r) => r.outcome);
    const lambda = isFin(opts.lambda) ? opts.lambda : 0.1;
    const iters = opts.iters || 400;
    const lr = isFin(opts.lr) ? opts.lr : 0.05;
    const D = keys.length, N = rows.length;
    let w = new Array(D).fill(0), b = 0;
    for (let it = 0; it < iters; it++) {
      const gw = new Array(D).fill(0); let gb = 0;
      for (let i = 0; i < N; i++) {
        let pred = b; for (let j = 0; j < D; j++) pred += w[j] * X[i][j];
        const e = pred - y[i];
        for (let j = 0; j < D; j++) gw[j] += e * X[i][j];
        gb += e;
      }
      for (let j = 0; j < D; j++) w[j] -= lr * (gw[j] / N + lambda * w[j]);
      b -= lr * (gb / N);
    }
    return { keys, stats, w, b, degenerate: false, n: N };
  },
  score(model, row) {
    if (!model) return 0;
    const z = zvec(row, model.keys, model.stats);
    let s = model.b; for (let j = 0; j < z.length; j++) s += model.w[j] * z[j];
    return s;
  },
};

const ALL_RANKERS = [randomRanker, residualMomentumRanker, productionCompositeRanker, ridgeRanker];

module.exports = {
  RANKER_VERSION,
  randomRanker, residualMomentumRanker, productionCompositeRanker, ridgeRanker,
  ALL_RANKERS, fitStats, zvec, hashOrder,
};
