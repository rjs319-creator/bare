'use strict';
// challenger-rank.js — cross-sectional residual-return ranker (`challenger-rank-v1`).
//
// SHADOW ONLY. Produces a model PREDICTION of relative residual-return strength by
// normalizing existing canonical signal features CROSS-SECTIONALLY within a single
// prediction date, then combining them with an interpretable, explicit, versioned set
// of prior weights. It does NOT emit a validated probability and never mutates inputs.
//
// Reuses canonical outputs already on the enriched signal (decision.rankSignals output):
// no indicator is recomputed here. Missing features are flagged, never fabricated.

const RANK_VERSION = 'challenger-rank-v1';
const FEATURE_VERSION = 'chal-feat-v1';

// Explicit prior weights. These are PRIORS until validated by the eval harness; the
// trained-shadow variant (ridge fit) lives in challenger-eval.js and only ever runs OOS.
// Each feature reads an existing canonical field; `get` returns a raw number or null
// (null => missing, excluded from that name's composite and reported in missingFlags).
const FEATURES = [
  { key: 'momentum',       label: 'Momentum / trend percentile', weight: 0.16, get: (s) => num(s.percentile) },
  { key: 'evidenceBreadth',label: 'Independent evidence',        weight: 0.12, get: (s) => num(s.evidence && s.evidence.familyCount) },
  { key: 'remainingEdge',  label: 'Remaining edge',              weight: 0.12, get: (s) => (s.remainingEdge && s.remainingEdge.rated ? num(s.remainingEdge.mult) : null) },
  { key: 'expectancy',     label: 'Realized track tilt',         weight: 0.10, get: (s) => (s.expectancyTilt ? num(s.expectancyTilt.tilt) : null) },
  { key: 'lowFailure',     label: 'Low failure risk',            weight: 0.10, get: (s) => (s.failure && isNum(s.failure.failureProb) ? 1 - s.failure.failureProb : null) },
  { key: 'confidence',     label: 'Signal conviction',           weight: 0.10, get: (s) => num(s.rawConfidence) },
  { key: 'execution',      label: 'Execution quality',           weight: 0.08, get: (s) => (s.execution ? num(s.execution.quality) : null) },
  { key: 'costEff',        label: 'Cost efficiency',             weight: 0.06, get: (s) => (s.cost && s.cost.known && isNum(s.cost.costShare) ? clamp01(1 - s.cost.costShare) : null) },
  { key: 'regimeFit',      label: 'Regime fit',                  weight: 0.06, get: (s) => num(s.regimeFit) },
  { key: 'eventSurprise',  label: 'Event surprise',              weight: 0.06, get: (s) => (s.eventSurprise && isNum(s.eventSurprise.score) ? s.eventSurprise.score / 100 : null) },
  { key: 'liquidity',      label: 'Liquidity',                   weight: 0.04, get: (s) => (s.liquidity && isNum(s.liquidity.dollarVol) && s.liquidity.dollarVol > 0 ? Math.log10(s.liquidity.dollarVol) : null) },
];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function num(v) { return isNum(v) ? v : null; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Cross-sectional percentile rank of each value within the set, robust to scale/outliers.
// Nulls stay null. Ties share the average rank. n<=1 => 0.5 (no cross-section to rank against).
function percentileRanks(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => isNum(v));
  const out = values.map(() => null);
  if (idx.length === 0) return out;
  if (idx.length === 1) { out[idx[0][1]] = 0.5; return out; }
  idx.sort((a, b) => a[0] - b[0]);
  // average-rank for ties
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2; // 0-based
    for (let k = i; k <= j; k++) out[idx[k][1]] = avgRank / (idx.length - 1);
    i = j + 1;
  }
  return out;
}

// Net-of-cost edge proxy (percent). Prefers the remaining-edge net figure, falls back to
// the cost model's net move. Honest: this is derived, NOT a fitted return. Null when unknown.
function netEdgeProxyPct(sig) {
  if (sig.remainingEdge && sig.remainingEdge.rated && isNum(sig.remainingEdge.netRemainingPct)) return sig.remainingEdge.netRemainingPct;
  if (sig.cost && sig.cost.known && isNum(sig.cost.netMovePct)) return sig.cost.netMovePct;
  return null;
}

// Main entry. `signals` = enriched signals for ONE prediction date. Returns NEW objects
// `{ ...sig, challengerRank }` (never mutates inputs). ctx: { asOf, snapshot }.
function rankCrossSection(signals, ctx = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const n = list.length;
  const asOf = ctx.asOf || null;
  const snapshot = ctx.snapshot || null;

  // Build the raw feature matrix, then percentile-normalize each column cross-sectionally.
  const rawCols = {};
  const normCols = {};
  for (const f of FEATURES) {
    const col = list.map((s) => f.get(s));
    rawCols[f.key] = col;
    normCols[f.key] = percentileRanks(col);
  }

  const composites = list.map((_, i) => {
    let wsum = 0;
    let acc = 0;
    for (const f of FEATURES) {
      const nv = normCols[f.key][i];
      if (nv == null) continue; // missing => excluded, weights renormalize over present
      acc += f.weight * nv;
      wsum += f.weight;
    }
    return wsum > 0 ? acc / wsum : null; // [0,1], or null if the name had zero usable features
  });

  const compPct = percentileRanks(composites);

  return list.map((sig, i) => {
    const missingFlags = FEATURES.filter((f) => rawCols[f.key][i] == null).map((f) => f.key);
    const presentFrac = (FEATURES.length - missingFlags.length) / FEATURES.length;
    const composite = composites[i];

    // Drivers: weighted deviation of each present, normalized feature from the median (0.5).
    const contribs = [];
    for (const f of FEATURES) {
      const nv = normCols[f.key][i];
      if (nv == null) continue;
      contribs.push({ feature: f.key, label: f.label, norm: round(nv, 3), contribution: round(f.weight * (nv - 0.5), 4) });
    }
    contribs.sort((a, b) => b.contribution - a.contribution);
    const positiveDrivers = contribs.filter((c) => c.contribution > 0).slice(0, 3);
    const negativeDrivers = contribs.filter((c) => c.contribution < 0).slice(-3).reverse();

    // Confidence: penalize missing data + reward independent evidence + realized sample.
    const famCount = (sig.evidence && sig.evidence.familyCount) || 0;
    const evTrust = 0.5 + 0.5 * Math.min(1, famCount / 3);
    const sampleN = (sig.expectancy && sig.expectancy.known && isNum(sig.expectancy.n)) ? sig.expectancy.n : 0;
    const sampleTrust = 0.7 + 0.3 * (sampleN / (sampleN + 8));
    const confidence = composite == null ? 0 : round(clamp01(presentFrac * evTrust * sampleTrust), 3);

    const features = {};
    for (const f of FEATURES) features[f.key] = { raw: rawCols[f.key][i] == null ? null : round(rawCols[f.key][i], 4), norm: normCols[f.key][i] == null ? null : round(normCols[f.key][i], 4) };

    return {
      ...sig,
      challengerRank: {
        modelVersion: RANK_VERSION,
        featureVersion: FEATURE_VERSION,
        predictionTimestamp: asOf,
        isPrediction: true, // explicit: model output, NOT a validated probability
        residualScore: composite == null ? null : round(100 * composite, 1),
        percentileRank: compPct[i] == null ? null : round(100 * compPct[i], 1),
        expectedNetUtilityPct: netEdgeProxyPct(sig),
        confidence,
        uncertainty: round(1 - confidence, 3),
        positiveDrivers,
        negativeDrivers,
        missingFlags,
        features,
        snapshot,
        crossSectionSize: n,
      },
    };
  });
}

function round(v, d) { const m = Math.pow(10, d); return Math.round(v * m) / m; }

module.exports = {
  RANK_VERSION,
  FEATURE_VERSION,
  FEATURES,
  percentileRanks,
  netEdgeProxyPct,
  rankCrossSection,
};
