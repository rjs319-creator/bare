'use strict';
// DYNAMIC ENSEMBLE WEIGHTING (forecast-ensemble-v1)
//
// Weights come from PREVIOUSLY REALIZED, MATURED out-of-sample performance and nothing else.
// Three rules make that literal rather than aspirational:
//
//   1. MATURITY GATE. An OOS observation may inform weights for a decision date `d` only when
//      its own label had fully closed strictly before `d` (`labelEnd < d`). A 10-session label
//      decided 3 sessions ago has NOT matured and is invisible to the weighting, even though its
//      row exists. `weightsAsOf` enforces this; `computeWeights` refuses to run without a cutoff.
//   2. NO SELF-REFERENCE. Weights are never fitted on the block they are applied to. Inside a
//      walk-forward test block, weights advance with time and only ever consume labels that had
//      already matured at each point.
//   3. SMALL SAMPLES DO NOT GET TO SPEAK. Below `minObservations` / `minDates` the whole
//      weighting falls back — to the last valid weights, then to static equal weights, then to
//      the baseline alone — and the fallback is named in the output.
//
// The dynamically weighted forecast is useful three ways: as an interpretable comparison model
// in the scoreboard, as an input feature to the LightGBM meta-ranker, and as the ranker of last
// resort when the meta-ranker is unavailable. It does not replace LightGBM when LightGBM runs.

const ENSEMBLE_VERSION = 'forecast-ensemble-v1';

const isFin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FALLBACK = Object.freeze({
  NONE: 'none',
  LAST_VALID: 'last-valid-weights',
  STATIC_EQUAL: 'static-equal-weights',
  BASELINE_ONLY: 'baseline-only',
});

/**
 * Filter OOS observations to those that had MATURED before `asOf`.
 *   observations: [{ model, horizon, decisionDate, labelEnd, rankIC?, netReturn?, brier?,
 *                    coverageError?, failed?, latencyMs? }]
 */
function maturedBefore(observations, asOf) {
  return (observations || []).filter((o) => o && o.labelEnd && o.labelEnd < asOf);
}

/** Aggregate one model's matured observations into the quality inputs the formula consumes. */
function summarizeModel(obs) {
  const rankICs = obs.map((o) => o.rankIC).filter(isFin);
  const nets = obs.map((o) => o.netReturn).filter(isFin);
  const briers = obs.map((o) => o.brier).filter(isFin);
  const covErrs = obs.map((o) => o.coverageError).filter(isFin).map(Math.abs);
  const lats = obs.map((o) => o.latencyMs).filter(isFin);
  const failures = obs.filter((o) => o.failed === true).length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sdOf = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
  };
  const netSd = sdOf(nets);
  return {
    observations: obs.length,
    dates: new Set(obs.map((o) => o.decisionDate)).size,
    meanRankIC: mean(rankICs),
    rankICStability: rankICs.length ? rankICs.filter((v) => v > 0).length / rankICs.length : null,
    netSharpe: (mean(nets) != null && netSd > 0) ? (mean(nets) / netSd) * Math.sqrt(252) : null,
    meanBrier: mean(briers),
    meanCoverageError: mean(covErrs),
    meanLatencyMs: mean(lats),
    failureRate: obs.length ? failures / obs.length : null,
  };
}

/**
 * Turn one model's summary into a non-negative raw weight.
 * Formula (recorded verbatim in the output so a reader can reproduce it):
 *
 *   quality = max(0, meanRankIC)
 *           * (0.5 + 0.5 * rankICStability)
 *           * (1 - failureRatePenalty * failureRate)
 *           * (1 - min(0.5, meanCoverageError))
 *
 * A model with a non-positive trailing rank IC gets weight 0 from the metric term and survives
 * only through the shrink-to-equal floor — which is the intended behaviour: a component that
 * has demonstrated nothing should not be voted off entirely on a short sample, but it must not
 * dominate either.
 */
const FORMULA = 'quality = max(0, meanRankIC) * (0.5 + 0.5*rankICStability) * (1 - failureRatePenalty*failureRate) * (1 - min(0.5, |meanCoverageError|)); w = normalize(quality); w = (1-shrink)*w + shrink*equal; w = clamp(w, minWeight, maxWeight); renormalize';

function rawQuality(summary, cfg) {
  const ic = isFin(summary.meanRankIC) ? Math.max(0, summary.meanRankIC) : 0;
  const stab = isFin(summary.rankICStability) ? 0.5 + 0.5 * summary.rankICStability : 0.75;
  const fail = isFin(summary.failureRate) ? Math.max(0, 1 - cfg.ensemble.failureRatePenalty * summary.failureRate) : 1;
  const cov = isFin(summary.meanCoverageError) ? 1 - Math.min(0.5, Math.abs(summary.meanCoverageError)) : 1;
  return ic * stab * fail * cov;
}

/**
 * Compute dynamic weights for one horizon as of a decision date.
 *   observations: matured OOS observations (any horizon; filtered here)
 *   models:       the component names eligible for weight
 *   asOf:         the decision date the weights will be USED for — required
 *   lastValid:    optional previously computed weights, used as the first fallback
 */
function computeWeights({ observations, models, horizon, asOf, cfg, lastValid = null }) {
  if (!asOf) throw new Error('computeWeights requires an asOf date — weights may never be computed without a maturity cutoff');
  const eligible = maturedBefore(observations, asOf).filter((o) => o.horizon === horizon && models.includes(o.model));

  const perModel = {};
  for (const m of models) perModel[m] = summarizeModel(eligible.filter((o) => o.model === m));

  const totalObs = eligible.length;
  const totalDates = new Set(eligible.map((o) => o.decisionDate)).size;
  const base = {
    schema: 'ForecastEnsembleWeights', version: ENSEMBLE_VERSION,
    horizon, asOf, models: [...models],
    lookbackFolds: cfg.ensemble.lookbackFolds,
    metric: cfg.ensemble.metric,
    formula: FORMULA,
    inputs: perModel,
    observations: totalObs, dates: totalDates,
    minObservations: cfg.ensemble.minObservations, minDates: cfg.ensemble.minDates,
    shrinkToEqual: cfg.ensemble.shrinkToEqual,
    minWeight: cfg.ensemble.minWeight, maxWeight: cfg.ensemble.maxWeight,
  };

  if (totalObs < cfg.ensemble.minObservations || totalDates < cfg.ensemble.minDates) {
    if (lastValid && lastValid.status === 'dynamic') {
      return Object.freeze({ ...base, weights: { ...lastValid.weights }, status: 'fallback', fallback: FALLBACK.LAST_VALID, reason: `matured sample too small (${totalObs} obs / ${totalDates} dates)` });
    }
    if (models.length === 1 || cfg.ensemble.fallback === 'baseline-only') {
      const w = Object.fromEntries(models.map((m) => [m, m === 'ridge' ? 1 : 0]));
      if (models.includes('ridge')) {
        return Object.freeze({ ...base, weights: w, status: 'fallback', fallback: FALLBACK.BASELINE_ONLY, reason: `matured sample too small (${totalObs} obs / ${totalDates} dates); the permanent baseline carries the ensemble` });
      }
    }
    const eq = 1 / models.length;
    return Object.freeze({ ...base, weights: Object.fromEntries(models.map((m) => [m, eq])), status: 'fallback', fallback: FALLBACK.STATIC_EQUAL, reason: `matured sample too small (${totalObs} obs / ${totalDates} dates)` });
  }

  const quality = Object.fromEntries(models.map((m) => [m, rawQuality(perModel[m], cfg)]));
  const qSum = Object.values(quality).reduce((a, b) => a + b, 0);
  const eq = 1 / models.length;
  let w = Object.fromEntries(models.map((m) => [m, qSum > 0 ? quality[m] / qSum : eq]));

  const s = clamp(cfg.ensemble.shrinkToEqual, 0, 1);
  for (const m of models) w[m] = (1 - s) * w[m] + s * eq;
  w = projectToBounds(w, models, cfg.ensemble.minWeight, cfg.ensemble.maxWeight);

  return Object.freeze({ ...base, weights: w, quality, status: 'dynamic', fallback: FALLBACK.NONE, reason: null });
}

/**
 * Euclidean projection of `weights` onto { w_i in [lo, hi], sum(w) = 1 }.
 *
 * The obvious implementation — clamp each weight, then renormalize — is WRONG: renormalizing
 * after clipping pushes the clipped entry straight back above the cap (0.95/0.03/0.02 with a
 * 0.70 cap comes back as 0.875). The correct projection is a single additive shift followed by
 * a clamp,  w_i(theta) = clamp(v_i + theta, lo, hi),  with `theta` chosen so the weights sum to
 * one. sum(w(theta)) is non-decreasing in theta, so a bisection finds it exactly, and the result
 * satisfies both bounds AND the sum by construction — no renormalization afterwards.
 *
 * When the bounds are jointly infeasible (lo*n > 1 or hi*n < 1) equal weights are returned and
 * the bounds are reported as unsatisfiable, because a silently violated constraint is worse than
 * a documented one.
 */
function projectToBounds(weights, models, lo, hi) {
  const n = models.length;
  if (!n) return {};
  if (lo * n > 1 + 1e-12 || hi * n < 1 - 1e-12) {
    return Object.fromEntries(models.map((m) => [m, +(1 / n).toFixed(6)]));
  }
  const v = models.map((m) => (Number.isFinite(weights[m]) ? weights[m] : 1 / n));
  const sumAt = (theta) => v.reduce((a, x) => a + Math.max(lo, Math.min(hi, x + theta)), 0);

  let loT = lo - Math.max(...v);          // every entry pinned at the floor
  let hiT = hi - Math.min(...v);          // every entry pinned at the cap
  for (let i = 0; i < 100 && hiT - loT > 1e-12; i++) {
    const mid = (loT + hiT) / 2;
    if (sumAt(mid) < 1) loT = mid; else hiT = mid;
  }
  const theta = (loT + hiT) / 2;
  const out = {};
  models.forEach((m, i) => { out[m] = +Math.max(lo, Math.min(hi, v[i] + theta)).toFixed(6); });

  // Rounding to 6 dp can leave the sum a few ULPs off one; absorb the residue into the entry
  // with the most slack, which cannot push it through a bound.
  const drift = 1 - Object.values(out).reduce((a, b) => a + b, 0);
  if (Math.abs(drift) > 1e-9) {
    let best = null, bestSlack = -Infinity;
    for (const m of models) {
      const slack = drift > 0 ? hi - out[m] : out[m] - lo;
      if (slack > bestSlack) { bestSlack = slack; best = m; }
    }
    if (best && bestSlack >= Math.abs(drift)) out[best] = +(out[best] + drift).toFixed(6);
  }
  return out;
}

/**
 * Weighted point forecast from a frame's base records. Models whose record is unusable are
 * dropped and the remaining weights RENORMALIZED — never treated as a zero prediction.
 */
function weightedPoint(frame, weights) {
  let num = 0, den = 0;
  const used = [];
  for (const [m, w] of Object.entries(weights || {})) {
    const b = frame.base && frame.base[m];
    if (!b || !(b.availability === 'ok' || b.availability === 'degraded') || !isFin(b.point)) continue;
    num += w * b.point; den += w; used.push(m);
  }
  return den > 0 ? { point: num / den, usedModels: used, effectiveWeight: den } : { point: null, usedModels: [], effectiveWeight: 0 };
}

/** Cross-model disagreement: sd of usable base points, and a bounded agreement score in [0,1]. */
function agreement(frame) {
  const pts = Object.values(frame.base || {})
    .filter((b) => b && (b.availability === 'ok' || b.availability === 'degraded') && isFin(b.point))
    .map((b) => b.point);
  if (pts.length < 2) return { disagreement: null, agreement: null, n: pts.length };
  const m = pts.reduce((a, b) => a + b, 0) / pts.length;
  const sd = Math.sqrt(pts.reduce((a, b) => a + (b - m) * (b - m), 0) / (pts.length - 1));
  const scale = Math.max(1e-6, Math.abs(m) + sd);
  return { disagreement: sd, agreement: +(1 / (1 + sd / scale)).toFixed(6), n: pts.length };
}

module.exports = { ENSEMBLE_VERSION, FALLBACK, FORMULA, maturedBefore, summarizeModel, rawQuality, computeWeights, weightedPoint, agreement, projectToBounds };
