'use strict';
// NOVEL SIGNAL LAB — Engine 8: counterfactual historical-twin estimation (historical-twin-v1).
//
// For a current candidate, find historical states that closely matched its PRE-DECISION
// attributes and report what happened next — as conditional historical-analog evidence, NOT a
// causal claim. This complements the existing component-lab (which measures a component's
// matched effect); here we characterise ONE candidate against the whole resolved pool.
//
// SAFETY (acceptance criteria): matching uses only pre-decision features; every pool member
// must have a decision date STRICTLY BEFORE the candidate's asOf and an already-resolved
// outcome (no peeking). Security identity never leaks into the metric. Fully PURE and
// deterministic — no network, no clock, no store.

const { makeEnvelope, unavailable, STATUS, DIRECTION } = require('./registry');

const CONFIG = Object.freeze({
  K: 40,               // twins to retain
  CALIPER_Z: 3.0,      // max standardized distance for a valid twin
  MIN_TWINS: 12,       // below this ⇒ out-of-support / low confidence
  OOS_NEAREST_Z: 2.0,  // if the SINGLE nearest twin is beyond this, candidate is near the edge of support
});

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a, mu) => { if (a.length < 2) return 1; const m = mu == null ? mean(a) : mu; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)) || 1; };
function quantile(sorted, q) { if (!sorted.length) return null; const i = (sorted.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }

// PURE. candidate = { features:{k:v} }, pool = [{ features, outcome:number, date, ticker }].
function findTwins(candidate, pool, featureKeys, asOf, cfg = CONFIG) {
  const eligible = (pool || []).filter(p => p && p.date && p.date < asOf && Number.isFinite(p.outcome) && p.features);
  if (eligible.length < cfg.MIN_TWINS) return { insufficient: true, n: eligible.length };

  // Per-feature standardizer built from the eligible pool (diagonal Mahalanobis).
  const stat = {};
  for (const k of featureKeys) { const vals = eligible.map(p => p.features[k]).filter(Number.isFinite); const mu = mean(vals) || 0; stat[k] = { mu, sd: sd(vals, mu) }; }
  const z = (feats, k) => (Number.isFinite(feats[k]) ? (feats[k] - stat[k].mu) / stat[k].sd : 0);
  const dist = (feats) => Math.sqrt(featureKeys.reduce((s, k) => { const d = z(feats, k) - z(candidate.features, k); return s + d * d; }, 0) / featureKeys.length);

  const ranked = eligible.map(p => ({ p, d: dist(p.features) })).sort((a, b) => a.d - b.d);
  const nearestZ = ranked.length ? ranked[0].d : Infinity;
  const twins = ranked.filter(r => r.d <= cfg.CALIPER_Z).slice(0, cfg.K);
  if (twins.length < cfg.MIN_TWINS) return { insufficient: true, n: twins.length, nearestZ };

  const outcomes = twins.map(t => t.p.outcome).sort((a, b) => a - b);
  const positive = twins.filter(t => t.p.outcome > 0).length;
  const similarity = mean(twins.map(t => Math.exp(-t.d))); // 1 = identical

  // Covariate balance: mean |z-diff| between candidate and matched set, per feature (lower = better).
  const balance = {};
  for (const k of featureKeys) { const cz = z(candidate.features, k); balance[k] = +Math.abs(cz - mean(twins.map(t => z(t.p.features, k)))).toFixed(3); }
  const worstBalance = Math.max(...Object.values(balance));

  // Sensitivity: re-median at K/2 and 2K; report the spread of medians.
  const medAt = (n) => { const o = ranked.filter(r => r.d <= cfg.CALIPER_Z).slice(0, n).map(r => r.p.outcome).sort((a, b) => a - b); return o.length ? quantile(o, 0.5) : null; };
  const medians = [medAt(Math.floor(cfg.K / 2)), medAt(cfg.K), medAt(cfg.K * 2)].filter(Number.isFinite);
  const sensitivity = medians.length > 1 ? +(Math.max(...medians) - Math.min(...medians)).toFixed(4) : 0;

  return {
    insufficient: false,
    count: twins.length,
    median: +quantile(outcomes, 0.5).toFixed(4),
    downside: +quantile(outcomes, 0.1).toFixed(4),
    upside: +quantile(outcomes, 0.9).toFixed(4),
    positiveFraction: +(positive / twins.length).toFixed(3),
    similarity: +similarity.toFixed(3),
    nearestZ: +nearestZ.toFixed(3),
    outOfSupport: nearestZ > cfg.OOS_NEAREST_Z,
    balance, worstBalance: +worstBalance.toFixed(3),
    sensitivity,
    examples: twins.slice(0, 3).map(t => ({ ticker: t.p.ticker, date: t.p.date, outcome: +t.p.outcome.toFixed(4), z: +t.d.toFixed(3) })),
  };
}

function toEnvelope(t, { ticker, securityId, asOf } = {}) {
  if (!t || t.insufficient) {
    return unavailable('historical_twin', { engine: 8, ticker, securityId, asOf, reason: `insufficient analogs (${t ? t.n : 0} < ${CONFIG.MIN_TWINS})` });
  }
  const dispersion = t.upside - t.downside;
  return makeEnvelope({
    engine: 8, signal: 'historical_twin', signalVersion: 'historical-twin-v1', ticker, securityId, asOf,
    status: STATUS.USABLE,
    score: t.median, // conditional analog median outcome — NOT a promise
    direction: t.median > 0 ? DIRECTION.LONG : (t.median < 0 ? DIRECTION.SHORT : DIRECTION.NEUTRAL),
    // Confidence falls with out-of-support, poor balance, high sensitivity and wide dispersion.
    confidence: +Math.max(0, Math.min(1,
      0.6 * t.similarity * (t.outOfSupport ? 0.4 : 1) * (t.worstBalance > 0.5 ? 0.6 : 1)
      - Math.min(0.3, t.sensitivity * 2))).toFixed(3),
    coverage: 1,
    historicalSupport: { n: t.count, note: `${t.positiveFraction * 100}% positive; dispersion ${dispersion.toFixed(3)}${t.outOfSupport ? '; near edge of support' : ''}` },
    warnings: [t.outOfSupport ? 'candidate near edge of historical support' : null, t.worstBalance > 0.5 ? 'imperfect covariate balance' : null, t.sensitivity > 0.02 ? 'median sensitive to twin count' : null].filter(Boolean),
    inputs: {
      twin_count: t.count, twin_median_outcome: t.median, twin_upside_q: t.upside, twin_downside_q: t.downside,
      twin_similarity: t.similarity, twin_out_of_support: t.outOfSupport, twin_balance: t.balance,
      twin_sensitivity: t.sensitivity, positive_fraction: t.positiveFraction, examples: t.examples,
    },
  });
}

module.exports = { CONFIG, findTwins, toEnvelope };
