'use strict';
// OPPORTUNITY SCORE (forecast-score-v1)
//
// A deterministic 0–100 RELATIVE opportunity score. It is NOT a probability and is never
// labelled as one: `probabilities` carries the calibrated probabilities, `opportunityScore`
// carries a ranking-oriented composite, and `scoreStatus` says which mapping produced it.
//
// COMPOSITE (each component mapped into [0,1] first; weights live in cfg.score.weights):
//   rank           within-date percentile of the final ranker score          (the dominant term)
//   probUp         calibrated P(residual > 0)
//   magnitude      bounded expected residual return, scaled by the date's dispersion
//   drawdownRisk   calibrated P(drawdown > threshold)                        (negative weight)
//   uncertainty    80% interval width, within-date percentile                (negative weight)
//   agreement      cross-model agreement in [0,1]
//   reliability    trailing OOS reliability of the components, KNOWN AT the as-of date
//   liquidityCost  estimated round-trip cost, within-date percentile         (negative weight)
//   freshness      feature coverage and staleness
//
// TWO MAPPINGS, AND THE OUTPUT SAYS WHICH:
//   'calibrated'             the composite is mapped through a CHRONOLOGICALLY FITTED empirical
//                            distribution of past composites, so 78 means the same thing on two
//                            different days.
//   'uncalibrated-percentile' the transparent fallback: the within-date percentile only. It is
//                            comparable across names on ONE day and NOT across days, and the
//                            score is bucketed to 5-point steps to avoid false precision.

const { percentileRanks } = require('./xsection');

const SCORE_VERSION = 'forecast-score-v1';

const STATUS = Object.freeze({
  CALIBRATED: 'calibrated',
  UNCALIBRATED: 'uncalibrated-percentile',
  INSUFFICIENT: 'insufficient-inputs',
});

const isFin = Number.isFinite;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Map a value to [0,1] by a bounded, symmetric squash — no unbounded term can dominate. */
const squash = (v, scale) => (isFin(v) && scale > 0 ? clamp01(0.5 + 0.5 * Math.tanh(v / scale)) : null);

/**
 * Build the components for a whole decision date at once (some are within-date percentiles, so
 * they cannot be computed one row at a time).
 *   rows: [{ rowKey, rankerScore, expectedResidualReturn, probabilities, intervalWidth80,
 *            agreement, reliability, estimatedCostPct, quality }]
 */
function componentsForDate(rows, cfg) {
  const rankPct = percentileRanks(rows.map((r) => (isFin(r.rankerScore) ? r.rankerScore : null)));
  const uncPct = percentileRanks(rows.map((r) => (isFin(r.intervalWidth80) ? r.intervalWidth80 : null)));
  const costPct = percentileRanks(rows.map((r) => (isFin(r.estimatedCostPct) ? r.estimatedCostPct : null)));
  const mags = rows.map((r) => (isFin(r.expectedResidualReturn) ? r.expectedResidualReturn : null)).filter(isFin);
  const magScale = mags.length >= 5
    ? Math.max(1e-6, Math.sqrt(mags.reduce((a, b) => a + b * b, 0) / mags.length))
    : 0.02;

  return rows.map((r, i) => {
    const probs = r.probabilities || {};
    const c = {
      rank: rankPct[i],
      probUp: isFin(probs['0']) ? probs['0'] : null,
      magnitude: squash(r.expectedResidualReturn, magScale),
      drawdownRisk: isFin(probs.drawdown) ? probs.drawdown : null,
      uncertainty: uncPct[i],
      agreement: isFin(r.agreement) ? clamp01(r.agreement) : null,
      reliability: isFin(r.reliability) ? clamp01(r.reliability) : null,
      liquidityCost: costPct[i],
      freshness: r.quality && isFin(r.quality.featureCoverage)
        ? clamp01(r.quality.featureCoverage * (1 - Math.min(1, (r.quality.staleSessions || 0) / 5)))
        : null,
    };
    return c;
  });
}

/**
 * Weighted composite in [0,1]. Components that are null are DROPPED and the remaining weights
 * renormalized over their absolute magnitudes, so a missing probability head shifts the mix
 * rather than silently scoring zero. Returns null when nothing usable is present.
 */
function composite(components, weights) {
  let num = 0, den = 0;
  const used = [];
  for (const [k, w] of Object.entries(weights)) {
    const v = components[k];
    if (!isFin(v)) continue;
    // A negative weight penalizes: use (1 - v) so every term still contributes in [0,1].
    num += Math.abs(w) * (w >= 0 ? v : 1 - v);
    den += Math.abs(w);
    used.push(k);
  }
  return den > 0 ? { value: clamp01(num / den), used, coverage: used.length / Object.keys(weights).length } : { value: null, used: [], coverage: 0 };
}

/**
 * A chronologically-fitted mapping from composite to 0–100.
 * `history` is the sorted array of composites observed on PAST decision dates only; the caller
 * (lib/forecast/walkforward.js) builds it from matured OOS rows, never from the rows being
 * scored. Returns null when there is not enough history to justify the mapping.
 */
function fitScoreMapping(history, { minSamples = 2000 } = {}) {
  const clean = (history || []).filter(isFin).slice().sort((a, b) => a - b);
  if (clean.length < minSamples) return null;
  return Object.freeze({
    schema: 'ForecastScoreMapping', version: SCORE_VERSION,
    n: clean.length, min: clean[0], max: clean[clean.length - 1],
    knots: Object.freeze(clean.filter((_, i) => i % Math.max(1, Math.floor(clean.length / 512)) === 0)),
  });
}

function applyScoreMapping(mapping, value) {
  if (!mapping || !isFin(value)) return null;
  const k = mapping.knots;
  let lo = 0, hi = k.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (k[mid] <= value) lo = mid + 1; else hi = mid; }
  return clamp01(lo / k.length);
}

/**
 * Score one decision date's rows.
 * Returns [{ rowKey, opportunityScore, scoreStatus, components, composite, scoreCoverage }].
 */
function scoreDate(rows, cfg, { mapping = null } = {}) {
  const comps = componentsForDate(rows, cfg);
  const composites = comps.map((c) => composite(c, cfg.score.weights));
  const usable = composites.map((c) => c.value);

  const calibrated = !!mapping;
  const bucket = calibrated ? Math.max(1, cfg.score.bucket) : 5;
  const withinDate = percentileRanks(usable);

  return rows.map((r, i) => {
    const cv = usable[i];
    if (!isFin(cv)) {
      return { rowKey: r.rowKey, opportunityScore: null, scoreStatus: STATUS.INSUFFICIENT, components: comps[i], composite: null, scoreCoverage: composites[i].coverage, componentsUsed: composites[i].used };
    }
    const p = calibrated ? applyScoreMapping(mapping, cv) : withinDate[i];
    const raw = 100 * clamp01(isFin(p) ? p : 0);
    const score = Math.round(raw / bucket) * bucket;
    return {
      rowKey: r.rowKey,
      opportunityScore: Math.max(0, Math.min(100, score)),
      scoreStatus: calibrated ? STATUS.CALIBRATED : STATUS.UNCALIBRATED,
      scoreBucket: bucket,
      components: comps[i],
      composite: +cv.toFixed(6),
      scoreCoverage: +composites[i].coverage.toFixed(3),
      componentsUsed: composites[i].used,
    };
  });
}

module.exports = { SCORE_VERSION, STATUS, componentsForDate, composite, scoreDate, fitScoreMapping, applyScoreMapping, squash };
