'use strict';
// PERMANENT RIDGE / AR BASELINE (forecast-ridge-v1)
//
// This model is MANDATORY and stays available even when the foundation models beat it. It is
// the minimum operational fallback, the required entry in every scoreboard, and the control any
// complex system must beat OUT OF SAMPLE before anyone believes it.
//
// Design:
//   * Closed-form ridge (normal equations + Cholesky) — deterministic, no iteration, fast enough
//     for unit tests and smoke backtests.
//   * One model PER HORIZON. The horizons have different label variances and different
//     autocorrelation; a shared multi-output fit would blur them for no gain.
//   * AR component: the trailing own-return lags (ret1/ret3/ret5/ret10/ret21) are part of the
//     feature vector, so this is a ridge-regularized AR-X model — autoregressive terms plus
//     exogenous cross-sectional features — not a bare cross-sectional regression.
//   * ALL preprocessing (winsorize limits, imputation, standardization) is fitted inside the
//     training window via lib/forecast/xsection.js fitScaler. The fitted scaler travels with
//     the model, so serving cannot re-fit on serving data.
//   * Uncertainty: the empirical distribution of TRAINING residuals (optionally conditioned on
//     a predicted-volatility bucket) supplies both the quantiles and the threshold
//     probabilities. That is a documented mapping, not a normal assumption smuggled in.
//
// Pure & deterministic: identical inputs give byte-identical outputs.

const { fitScaler, applyScaler } = require('./xsection');
const { makeForecast, makeModelIdentity, AVAILABILITY } = require('./contract');

const RIDGE_VERSION = 'forecast-ridge-v1';
const VOL_BUCKETS = 3;              // residual quantiles are conditioned on this many vol buckets

const isFin = Number.isFinite;

/** Solve (A + lambda I) x = b for symmetric positive-definite A via Cholesky. */
function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-12) return null;                  // not PD — caller raises lambda
        L[i * n + j] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** Empirical quantile of a SORTED array (linear interpolation). */
function quantileSorted(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Fraction of a SORTED array strictly greater than x — the empirical survival function. */
function survivalSorted(sorted, x) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
  return (sorted.length - lo) / sorted.length;
}

/**
 * Fit the ridge/AR baseline for ONE horizon.
 *   trainRows: [{ decisionDate, features, label: { residualReturn, maxDrawdown, ... } }]
 * Returns a frozen model, or { fitted:false, reason } when the training set is unusable.
 */
function fitRidge(trainRows, featureKeys, cfg, { horizon, lambda = null } = {}) {
  const usable = trainRows.filter((r) => r && r.features && r.label && isFin(r.label.residualReturn));
  const p = featureKeys.length;
  if (usable.length < Math.max(50, p + 10)) {
    return Object.freeze({ fitted: false, reason: `insufficient training rows (${usable.length} < ${Math.max(50, p + 10)})`, horizon, version: RIDGE_VERSION });
  }

  const scaler = fitScaler(usable, featureKeys, cfg);
  const lam = isFin(lambda) ? lambda : cfg.models.ridge.lambda;

  // Normal equations on the standardized design with an explicit intercept column.
  const n = p + 1;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  const yMean = usable.reduce((a, r) => a + r.label.residualReturn, 0) / usable.length;

  const rowsX = new Array(usable.length);
  for (let t = 0; t < usable.length; t++) {
    const xs = applyScaler(usable[t], scaler, { standardize: cfg.models.ridge.standardize });
    rowsX[t] = xs;
    const y = usable[t].label.residualReturn - yMean;
    for (let i = 0; i < p; i++) {
      const xi = xs[i];
      b[i] += xi * y;
      for (let j = i; j < p; j++) A[i * n + j] += xi * xs[j];
    }
    b[p] += y;                                      // intercept column of ones
    for (let i = 0; i < p; i++) A[i * n + p] += xs[i];
    A[p * n + p] += 1;
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[i * n + j] = A[j * n + i];
  for (let i = 0; i < p; i++) A[i * n + i] += lam;  // the intercept is NOT penalized

  let w = choleskySolve(A, b, n);
  let usedLambda = lam;
  for (let bump = 0; w === null && bump < 6; bump++) {   // numerically singular → raise ridge
    usedLambda *= 10;
    const A2 = Float64Array.from(A);
    for (let i = 0; i < p; i++) A2[i * n + i] += usedLambda - lam;
    w = choleskySolve(A2, b, n);
  }
  if (w === null) return Object.freeze({ fitted: false, reason: 'design matrix not positive definite even at lambda*1e6', horizon, version: RIDGE_VERSION });

  // In-sample residuals → the empirical predictive distribution, bucketed by predicted vol so a
  // quiet mega-cap and a volatile small-cap do not share one interval width.
  const volKey = featureKeys.indexOf('vol21');
  const residualsAll = [];
  const buckets = Array.from({ length: VOL_BUCKETS }, () => []);
  const volValues = [];
  for (let t = 0; t < usable.length; t++) {
    let yhat = w[p];
    for (let i = 0; i < p; i++) yhat += w[i] * rowsX[t][i];
    const res = (usable[t].label.residualReturn - yMean) - yhat;
    residualsAll.push(res);
    if (volKey >= 0) volValues.push(rowsX[t][volKey]);
  }
  let volCuts = null;
  if (volKey >= 0 && volValues.length === residualsAll.length) {
    const sortedVol = volValues.slice().sort((a, b2) => a - b2);
    volCuts = [quantileSorted(sortedVol, 1 / 3), quantileSorted(sortedVol, 2 / 3)];
    for (let t = 0; t < residualsAll.length; t++) {
      const v = volValues[t];
      const bIdx = v <= volCuts[0] ? 0 : v <= volCuts[1] ? 1 : 2;
      buckets[bIdx].push(residualsAll[t]);
    }
  }
  const sortAsc = (a) => a.slice().sort((x, y) => x - y);
  const minObs = cfg.models.ridge.residualQuantileMinObs;
  const residualDist = {
    all: sortAsc(residualsAll),
    buckets: buckets.map((bk) => (bk.length >= minObs ? sortAsc(bk) : null)),
    volCuts,
  };

  const sse = residualsAll.reduce((a, r) => a + r * r, 0);
  const sigma = Math.sqrt(sse / Math.max(1, residualsAll.length - n));

  return Object.freeze({
    schema: 'ForecastRidgeModel', version: RIDGE_VERSION,
    fitted: true, horizon,
    featureKeys: Object.freeze([...featureKeys]),
    weights: w, intercept: w[p], yMean, lambda: usedLambda,
    scaler, sigma,
    residualDist: Object.freeze({ all: Object.freeze(residualDist.all), buckets: Object.freeze(residualDist.buckets), volCuts: Object.freeze(residualDist.volCuts) }),
    trainRows: usable.length,
    trainThroughDate: scaler.fittedThroughDate,
    volFeatureIndex: volKey,
  });
}

/** Point prediction only — the hot path used by cross-fitting and ranking. */
function predictPoint(model, row) {
  if (!model || !model.fitted) return null;
  const xs = applyScaler(row, model.scaler, { standardize: true });
  const p = model.featureKeys.length;
  let yhat = model.weights[p];
  for (let i = 0; i < p; i++) yhat += model.weights[i] * xs[i];
  return model.yMean + yhat;
}

/** The residual distribution that applies to `row` (vol-bucketed when it has enough support). */
function residualsFor(model, row) {
  const d = model.residualDist;
  if (!d.volCuts || model.volFeatureIndex < 0) return d.all;
  const xs = applyScaler(row, model.scaler, { standardize: true });
  const v = xs[model.volFeatureIndex];
  const idx = v <= d.volCuts[0] ? 0 : v <= d.volCuts[1] ? 1 : 2;
  return d.buckets[idx] || d.all;
}

/**
 * Full contract-shaped forecast: point, quantiles, sigma, tails and threshold probabilities.
 * Probabilities come from the EMPIRICAL residual survival function — P(y > th) =
 * P(residual > th - yhat) — which is a documented mapping, not an assumed Gaussian.
 */
function forecast(model, row, cfg, { pit = null, artifactId = null } = {}) {
  const identity = makeModelIdentity({
    name: 'ridge', role: 'baseline', modelId: 'in-repo/ridge-ar', revision: RIDGE_VERSION,
    packageName: null, packageVersion: null, device: 'cpu', dtype: 'float64',
    artifactId, trainCutoff: model && model.trainThroughDate, configHash: cfg.configHash, codeVersion: RIDGE_VERSION,
  });
  if (!model || !model.fitted) {
    return makeForecast({
      securityId: row.securityId, ticker: row.ticker, horizon: model ? model.horizon : null, pit,
      availability: AVAILABILITY.INSUFFICIENT_HISTORY, availabilityReason: (model && model.reason) || 'model not fitted',
      model: identity,
    });
  }
  const point = predictPoint(model, row);
  const res = residualsFor(model, row);
  const quantiles = {};
  for (const q of cfg.quantiles) {
    const v = quantileSorted(res, q);
    if (v != null) quantiles[q] = point + v;
  }
  const q10 = quantiles[0.10], q90 = quantiles[0.90];
  const probabilities = {};
  for (const th of cfg.returnThresholds) {
    const s = survivalSorted(res, th - point);
    if (s != null) probabilities[String(th)] = s;
  }
  return makeForecast({
    securityId: row.securityId, ticker: row.ticker, horizon: model.horizon, pit,
    targetDefinition: cfg.target.definition, targetVersion: cfg.target.version,
    point, quantiles, sigma: model.sigma,
    intervalWidth80: (isFin(q10) && isFin(q90)) ? q90 - q10 : null,
    downsideTail: quantiles[0.05] ?? null, upsideTail: quantiles[0.95] ?? null,
    probabilities, probabilityStatus: 'uncalibrated-empirical-residual',
    availability: AVAILABILITY.OK,
    model: identity,
    quality: row.quality,
  });
}

/**
 * Ridge fitted on the WITHIN-DATE z-scored residual return instead of the raw one.
 *
 * WHY THIS EXISTS AS A SEPARATE ARM. The evaluation metric is a within-date rank IC, but a raw
 * residual-return target is dominated by high-volatility names — a squared-error fit spends most
 * of its capacity on the few names that move most, which is not what ranking a cross-section
 * rewards. Standardizing the target inside each decision date aligns the loss with the metric.
 *
 * It is a RANKING arm, not a base model: its output is a z-score, not an expected return, so it
 * must never be averaged into an ensemble point or read as a forecast magnitude. The permanent
 * `ridge` baseline is untouched and remains the fallback and the reference.
 */
function fitRidgeRank(trainRows, featureKeys, cfg, { horizon } = {}) {
  const byDate = new Map();
  for (const r of trainRows) {
    if (!r || !r.label || !Number.isFinite(r.label.residualReturn)) continue;
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const standardized = [];
  for (const group of byDate.values()) {
    const vals = group.map((r) => r.label.residualReturn);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (vals.length - 1)) : 0;
    if (!(sd > 0)) continue;                       // a degenerate date carries no ordering
    for (const r of group) standardized.push({ ...r, label: { ...r.label, residualReturn: (r.label.residualReturn - m) / sd } });
  }
  const model = fitRidge(standardized, featureKeys, cfg, { horizon });
  return model.fitted ? Object.freeze({ ...model, targetBasis: 'within-date-z-scored-residual', rankingOnly: true }) : model;
}

module.exports = { RIDGE_VERSION, fitRidge, fitRidgeRank, predictPoint, forecast, residualsFor, quantileSorted, survivalSorted, choleskySolve };
