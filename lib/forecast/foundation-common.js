'use strict';
// SHARED FOUNDATION-MODEL PLUMBING (forecast-foundation-v1)
//
// Chronos-2 and Moirai-2 have DIFFERENT native APIs and are deliberately not forced into one
// preprocessing path. What they do share is:
//   * how the input series is built (a point-in-time residual-return history, never raw price);
//   * how a per-step predictive path is aggregated to a horizon-h cumulative return;
//   * how the result is normalized into the one Forecast contract.
//
// AGGREGATION IS AN APPROXIMATION, AND IT SAYS SO. Both models forecast a PATH of h steps. The
// horizon-h cumulative residual return is the sum of that path. The sum's median is well
// approximated by the sum of per-step medians, but the sum's QUANTILES are not the sum of
// per-step quantiles unless the steps are independent. We therefore:
//     point   = sum of the per-step median (or mean, when the model gives one)
//     spread  = per-step spread aggregated as sqrt(sum of squared per-step spreads)
//     q_p     = point + z_p * spread, with z_p taken from the model's OWN per-step quantile
//               shape rather than a Gaussian assumption
// and every such record carries the note 'horizon-aggregated-under-step-independence'. For
// h = 1 the aggregation is exact and the note is omitted.
//
// FIXTURE MODE. `FORECAST_FIXTURE_MODE=1` (or an injected `fixture` function) makes an adapter
// return deterministic synthetic forecasts WITHOUT any Python. It exists so ordinary unit tests
// can exercise the adapter contract offline. A fixture forecast is stamped
// `model.modelId = 'fixture:<name>'` and `capabilityNotes` says it is synthetic, so a fixture
// can never be mistaken for a benchmark result.

const { makeForecast, makeModelIdentity, unavailableForecast, AVAILABILITY } = require('./contract');
const { trailingReturns, alignDated } = require('./targets');

const FOUNDATION_VERSION = 'forecast-foundation-v1';

const isFin = Number.isFinite;

/**
 * Point-in-time residual-return context for one name at one decision date.
 * Returns { values: number[], lastDate } or null when there is not enough history.
 * Uses ONLY bars at or before `idx` — the same trailing window the betas came from.
 */
function residualReturnSeries(nameCandles, nameIdx, benchCandles, benchIdx, betaMarket, contextLength) {
  const rn = trailingReturns(nameCandles, nameIdx, contextLength + 5);
  const rm = trailingReturns(benchCandles, benchIdx, contextLength + 5);
  const { xs, ys, dates } = alignDated(rn, rm);
  if (xs.length < 32) return null;
  const b = isFin(betaMarket) ? betaMarket : 1;
  const values = ys.map((y, i) => y - b * xs[i]);
  const cut = Math.max(0, values.length - contextLength);
  return { values: values.slice(cut), lastDate: dates[dates.length - 1] };
}

/** Related series a covariate-capable model may consume — deterministic, bounded, PIT-safe. */
function relatedSeries(benchCandles, benchIdx, sectorCandles, sectorIdx, contextLength) {
  const out = {};
  const mkt = trailingReturns(benchCandles, benchIdx, contextLength);
  if (mkt.length >= 32) out.market = mkt.slice(-contextLength).map((p) => p.r);
  if (sectorCandles && sectorIdx >= 0) {
    const sec = trailingReturns(sectorCandles, sectorIdx, contextLength);
    if (sec.length >= 32) out.sector = sec.slice(-contextLength).map((p) => p.r);
  }
  return Object.keys(out).length ? out : null;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * Aggregate a per-step predictive path into one horizon-h cumulative forecast.
 *   pathMean      number[h] | null
 *   pathQuantiles { "0.05": number[h], ... }
 * Returns { point, quantiles, sigma, notes } — or null when the path is unusable.
 */
function aggregatePath(pathMean, pathQuantiles, levels) {
  const q50 = pathQuantiles['0.50'] || pathQuantiles['0.5'] || null;
  const base = (Array.isArray(pathMean) && pathMean.every(isFin)) ? pathMean : q50;
  if (!Array.isArray(base) || !base.length || !base.every(isFin)) return null;
  const h = base.length;
  const point = sum(base);
  const notes = h > 1 ? ['horizon-aggregated-under-step-independence'] : [];

  const quantiles = {};
  if (h === 1) {
    for (const lv of levels) {
      const key = lv.toFixed(2);
      const arr = pathQuantiles[key];
      if (Array.isArray(arr) && isFin(arr[0])) quantiles[lv] = arr[0];
    }
  } else {
    // Per-step spread relative to the per-step median, aggregated in quadrature.
    const center = q50 && q50.length === h ? q50 : base;
    for (const lv of levels) {
      const key = lv.toFixed(2);
      const arr = pathQuantiles[key];
      if (!Array.isArray(arr) || arr.length !== h || !arr.every(isFin)) continue;
      // Quadrature-aggregate the per-step offsets from the median path, keeping the SIGN of
      // the model's own offset rather than assuming a symmetric distribution.
      let ss = 0, netOffset = 0;
      for (let i = 0; i < h; i++) { const d = arr[i] - center[i]; ss += d * d; netOffset += d; }
      const offsetSign = netOffset >= 0 ? 1 : -1;
      quantiles[lv] = point + offsetSign * Math.sqrt(ss);
    }
  }
  const q10 = quantiles[0.10], q90 = quantiles[0.90];
  const sigma = (isFin(q10) && isFin(q90)) ? (q90 - q10) / 2.563103 : null;   // normal-equivalent scale, labelled as such
  return { point, quantiles, sigma, notes };
}

/** Enforce non-decreasing quantiles; returns { quantiles, repaired }. */
function orderQuantiles(quantiles) {
  const levels = Object.keys(quantiles).map(Number).filter(isFin).sort((a, b) => a - b);
  let repaired = false, prev = -Infinity;
  const out = {};
  for (const lv of levels) {
    let v = quantiles[lv];
    if (v < prev) { v = prev; repaired = true; }
    out[lv] = v; prev = v;
  }
  return { quantiles: out, repaired };
}

/**
 * Normalize one sidecar forecast entry into a Forecast record.
 * `entry` is the raw { id, mean, quantiles } from the sidecar.
 */
function normalizeForecast({ entry, request, response, name, role, cfg, row, horizon, pit, extraNotes = [] }) {
  const identity = makeModelIdentity({
    name, role,
    modelId: (response.model && response.model.modelId) || request.modelId,
    revision: (response.model && response.model.revision) || request.revision,
    packageName: response.model && response.model.packageName,
    packageVersion: response.model && response.model.packageVersion,
    device: response.model && response.model.device,
    dtype: response.model && response.model.dtype,
    contextLength: response.model && response.model.contextLength,
    trainCutoff: row.decisionDate,
    dataCutoff: row.decisionDate,
    configHash: cfg.configHash,
    codeVersion: FOUNDATION_VERSION,
  });

  const agg = entry ? aggregatePath(entry.mean, entry.quantiles || {}, cfg.quantiles) : null;
  if (!agg) {
    return unavailableForecast({
      securityId: row.securityId, ticker: row.ticker, horizon, pit, model: identity,
      availability: AVAILABILITY.INFERENCE_FAILED,
      reason: 'model returned no usable predictive path',
    });
  }
  const ordered = orderQuantiles(agg.quantiles);
  const notes = [...agg.notes, ...extraNotes];
  if (ordered.repaired) notes.push('non-monotonic quantiles repaired by isotonic clamp');
  const caps = response.capabilities || {};
  if (caps.covariates === false) notes.push('covariates not supported by the installed pipeline');
  for (const n of response.notes || []) notes.push(n);

  const q = ordered.quantiles;
  return makeForecast({
    securityId: row.securityId, ticker: row.ticker, horizon, pit,
    targetDefinition: cfg.target.definition, targetVersion: cfg.target.version,
    point: agg.point, quantiles: q, sigma: agg.sigma,
    intervalWidth80: (isFin(q[0.10]) && isFin(q[0.90])) ? q[0.90] - q[0.10] : null,
    downsideTail: q[0.05] ?? null, upsideTail: q[0.95] ?? null,
    // A raw foundation model gives a predictive distribution, not calibrated event
    // probabilities. Threshold probabilities are produced downstream, from the quantile CDF
    // (lib/forecast/quantiles.js) and then calibrated — never asserted here.
    probabilities: {}, probabilityStatus: 'not-produced-by-this-model',
    availability: caps.covariates === false ? AVAILABILITY.DEGRADED : AVAILABILITY.OK,
    capabilityNotes: notes,
    model: identity,
    quality: row.quality,
    latencyMs: response.latencyMs || null,
  });
}

/**
 * Deterministic offline fixture: a seeded, reproducible predictive path derived from the
 * context's own trailing statistics. Used ONLY by tests and by FORECAST_FIXTURE_MODE.
 */
function fixturePath(context, horizon, levels, seed) {
  const n = context.length;
  const mean = n ? context.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(context.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0.01;
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const drift = mean * 0.5 + (rnd() - 0.5) * sd * 0.1;
  const path = Array.from({ length: horizon }, () => drift);
  const zOf = (p) => {
    // Acklam-style inverse normal, adequate for a fixture.
    const a = [-39.696830286653757, 220.94609842452050, -275.92851044696869, 138.35775186726900, -30.664798066147160, 2.5066282774592392];
    const b = [-54.476098798224058, 161.58583685804089, -155.69897985988661, 66.801311887719720, -13.280681552885721];
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  };
  const quantiles = {};
  for (const lv of levels) quantiles[lv.toFixed(2)] = path.map((m) => m + zOf(lv) * sd);
  return { mean: path, quantiles };
}

module.exports = {
  FOUNDATION_VERSION, residualReturnSeries, relatedSeries,
  aggregatePath, orderQuantiles, normalizeForecast, fixturePath,
};
