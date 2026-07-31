'use strict';
// MOMENTUM SURVIVAL — interpretable L2-regularized logistic baseline. Pure JS and DETERMINISTIC
// (zero-init weights, fixed iterations, no RNG), same standardize→linear→sigmoid form as the
// gap-go META_MODEL so it stays inspectable. It answers "P(reach the upside barrier before the
// failure barrier / timeout) from this decision" — but only when there is enough data to fit
// honestly: it returns null unless BOTH classes clear MIN_PER_CLASS, so the caller reports
// "insufficient data" rather than serving a spurious model. No tree model is reached for until
// this interpretable baseline is beaten out-of-sample (per the promotion gate).
//
// MISSINGNESS CONTRACT (v2). A missing feature is NEVER treated as a genuine zero observation.
// Each feature contributes TWO columns: the standardized value (imputed to the TRAINING mean —
// i.e. exactly neutral after standardization) and an explicit 0/1 missing indicator with its
// own learned coefficient. So "absent" carries only the information that it was absent, and the
// value column contributes nothing when the value did not exist.

const MIN_PER_CLASS = 30;   // need ≥ this many of BOTH outcomes before fitting at all

const sigmoid = z => 1 / (1 + Math.exp(-z));
const present = v => v != null && Number.isFinite(v);

// Present-only mean/std per feature (missing values excluded, not zero-counted).
function standardize(rows, keys) {
  const mean = [], std = [];
  keys.forEach((k, j) => {
    const vals = rows.map(r => r.features[k]).filter(present);
    const m = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    const sd = vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) : 0;
    mean[j] = m; std[j] = sd || 1;   // guard a zero-variance / all-missing feature
  });
  return { mean, std };
}

// One row → design vector: [stdValue×m, missingFlag×m]. Missing value ⇒ stdValue 0 (the
// training mean) + flag 1, so the value column is neutral and the flag carries the signal.
function designRow(features, keys, mean, std) {
  const x = new Array(keys.length * 2);
  keys.forEach((k, j) => {
    const v = features ? features[k] : null;
    const has = present(v);
    x[j] = has ? (v - mean[j]) / std[j] : 0;
    x[keys.length + j] = has ? 0 : 1;
  });
  return x;
}

// Fit. `label(row)` → 0|1. Returns { features, mean, std, coef, missCoef, intercept, n, pos,
// neg } or null. coef aligns with `features`; missCoef holds the missing-indicator weights.
function trainLogistic(rows, keys, label, { l2 = 1.0, iters = 600, lr = 0.1 } = {}) {
  const y = rows.map(label);
  const pos = y.filter(v => v === 1).length;
  const neg = y.length - pos;
  if (pos < MIN_PER_CLASS || neg < MIN_PER_CLASS) return null;

  const { mean, std } = standardize(rows, keys);
  const X = rows.map(r => designRow(r.features, keys, mean, std));
  const m = keys.length * 2, n = rows.length;
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
  return {
    features: keys, mean, std,
    coef: w.slice(0, keys.length).map(v => +v.toFixed(6)),
    missCoef: w.slice(keys.length).map(v => +v.toFixed(6)),
    intercept: +b.toFixed(6), n, pos, neg,
  };
}

function predictProba(model, features) {
  if (!model) return null;
  let z = model.intercept;
  model.features.forEach((k, j) => {
    const v = features ? features[k] : null;
    if (present(v)) z += model.coef[j] * ((v - model.mean[j]) / model.std[j]);
    else z += (model.missCoef ? model.missCoef[j] : 0);   // missing → indicator only, never a fake 0 value
  });
  return sigmoid(z);
}

module.exports = { MIN_PER_CLASS, sigmoid, standardize, designRow, trainLogistic, predictProba };
