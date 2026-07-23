'use strict';
// MOMENTUM SURVIVAL — interpretable L2-regularized logistic baseline. Pure JS and DETERMINISTIC
// (zero-init weights, fixed iterations, no RNG), same standardize→linear→sigmoid form as the
// gap-go META_MODEL so it stays inspectable. It answers "P(reach the upside barrier before the
// failure barrier / timeout) from this decision" — but only when there is enough data to fit
// honestly: it returns null unless BOTH classes clear MIN_PER_CLASS, so the caller reports
// "insufficient data" rather than serving a spurious model. No tree model is reached for until
// this interpretable baseline is beaten out-of-sample (per the promotion gate).

const MIN_PER_CLASS = 30;   // need ≥ this many of BOTH outcomes before fitting at all

const sigmoid = z => 1 / (1 + Math.exp(-z));

function standardize(rows, keys) {
  const n = rows.length;
  const mean = keys.map(k => rows.reduce((s, r) => s + (r.features[k] ?? 0), 0) / n);
  const std = keys.map((k, j) => {
    const v = rows.reduce((s, r) => s + ((r.features[k] ?? 0) - mean[j]) ** 2, 0) / n;
    return Math.sqrt(v) || 1;   // guard a zero-variance feature
  });
  return { mean, std };
}

// Fit. `label(row)` → 0|1. Returns { features, mean, std, coef, intercept, n, pos, neg } or null.
function trainLogistic(rows, keys, label, { l2 = 1.0, iters = 600, lr = 0.1 } = {}) {
  const y = rows.map(label);
  const pos = y.filter(v => v === 1).length;
  const neg = y.length - pos;
  if (pos < MIN_PER_CLASS || neg < MIN_PER_CLASS) return null;

  const { mean, std } = standardize(rows, keys);
  const X = rows.map(r => keys.map((k, j) => ((r.features[k] ?? 0) - mean[j]) / std[j]));
  const m = keys.length, n = rows.length;
  const w = new Array(m).fill(0); let b = 0;

  for (let it = 0; it < iters; it++) {
    const gw = new Array(m).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < m; j++) z += X[i][j] * w[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < m; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < m; j++) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n);   // L2 shrinkage
    b -= lr * (gb / n);
  }
  return { features: keys, mean, std, coef: w.map(v => +v.toFixed(6)), intercept: +b.toFixed(6), n, pos, neg };
}

function predictProba(model, features) {
  if (!model) return null;
  let z = model.intercept;
  model.features.forEach((k, j) => { z += model.coef[j] * (((features[k] ?? 0) - model.mean[j]) / model.std[j]); });
  return sigmoid(z);
}

module.exports = { MIN_PER_CLASS, sigmoid, standardize, trainLogistic, predictProba };
