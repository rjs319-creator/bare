'use strict';
// NOVEL SIGNAL LAB — Engine 9: invariant-mechanism selector (invariance-v1).
//
// Prefer a weaker signal that keeps its DIRECTION across independent environments (decades,
// sectors, cap groups, liquidity/volatility regimes) over a stronger one produced by a single
// exceptional interval. This evaluator partitions resolved samples by an environment key,
// measures the signal's rank-IC in each environment, and reports directional consistency,
// heterogeneity and FRAGILITY (does one environment supply nearly all the value?).
//
// SAFETY (acceptance criterion): environment definitions are supplied by the caller and must be
// chosen WITHOUT viewing the final holdout — this module does not select them. Pure &
// deterministic; no network, no clock.

const { rankIC, mean, sd } = require('./stats');
const { makeEnvelope, unavailable, STATUS, DIRECTION } = require('./registry');

const CONFIG = Object.freeze({ MIN_ENV_N: 20, MIN_ENVS: 3 });

// PURE. samples = [{ signal:number, outcome:number, env:string|number }].
// (Caller has already projected the chosen environment definition onto `env`.)
function evaluateInvariance(samples, cfg = CONFIG) {
  const clean = (samples || []).filter(s => s && Number.isFinite(s.signal) && Number.isFinite(s.outcome) && s.env != null);
  if (clean.length < cfg.MIN_ENV_N * cfg.MIN_ENVS) return { insufficient: true, n: clean.length };

  const byEnv = new Map();
  for (const s of clean) { if (!byEnv.has(s.env)) byEnv.set(s.env, []); byEnv.get(s.env).push(s); }
  const perEnv = [];
  for (const [envVal, rows] of byEnv) {
    if (rows.length < cfg.MIN_ENV_N) continue;
    const ic = rankIC(rows.map(r => r.signal), rows.map(r => r.outcome));
    if (ic != null) perEnv.push({ env: envVal, n: rows.length, ic });
  }
  if (perEnv.length < cfg.MIN_ENVS) return { insufficient: true, envs: perEnv.length };

  const totalN = perEnv.reduce((s, e) => s + e.n, 0);
  const overallIC = perEnv.reduce((s, e) => s + e.ic * e.n, 0) / totalN; // n-weighted pooled IC
  const sign = Math.sign(overallIC) || 1;

  // Directional consistency: n-weighted share of environments agreeing with the overall sign.
  const agreeN = perEnv.filter(e => Math.sign(e.ic) === sign).reduce((s, e) => s + e.n, 0);
  const directionConsistency = agreeN / totalN;
  const heterogeneity = sd(perEnv.map(e => e.ic));

  // Fragility: leave-one-environment-out. If removing the single most favourable environment
  // collapses the pooled IC, the effect is fragile (one interval carries it).
  let worstDrop = 0;
  for (const drop of perEnv) {
    const rest = perEnv.filter(e => e !== drop);
    const restN = rest.reduce((s, e) => s + e.n, 0);
    if (!restN) continue;
    const restIC = rest.reduce((s, e) => s + e.ic * e.n, 0) / restN;
    const rel = Math.abs(overallIC) > 1e-9 ? (overallIC - restIC) / Math.abs(overallIC) : 0;
    if (rel > worstDrop) worstDrop = rel;
  }
  const fragility = Math.max(0, Math.min(1, worstDrop));
  // Invariance score rewards consistency, penalises heterogeneity and fragility.
  const invariance = Math.max(0, Math.min(1, directionConsistency * (1 - fragility) * (1 - Math.min(1, heterogeneity / (Math.abs(overallIC) + 0.05)))));

  return {
    insufficient: false,
    overallIC: +overallIC.toFixed(4), envCount: perEnv.length, sampleN: totalN,
    directionConsistency: +directionConsistency.toFixed(3),
    heterogeneity: +heterogeneity.toFixed(4),
    fragility: +fragility.toFixed(3),
    invariance: +invariance.toFixed(3),
    perEnv: perEnv.map(e => ({ env: e.env, n: e.n, ic: +e.ic.toFixed(3) })).sort((a, b) => b.n - a.n),
  };
}

function toEnvelope(r, { signal, ticker = null, securityId = null, asOf = null } = {}) {
  if (!r || r.insufficient) return unavailable('invariance', { engine: 9, ticker, securityId, asOf, reason: `insufficient environments/samples (${r ? (r.envs || r.n) : 0})` });
  return makeEnvelope({
    engine: 9, signal: 'invariance', signalVersion: 'invariance-v1', ticker, securityId, asOf,
    status: STATUS.USABLE,
    score: r.invariance,
    direction: r.overallIC > 0 ? DIRECTION.LONG : (r.overallIC < 0 ? DIRECTION.SHORT : DIRECTION.NEUTRAL),
    confidence: +Math.max(0, Math.min(1, r.invariance * r.directionConsistency)).toFixed(3),
    coverage: 1,
    historicalSupport: { n: r.sampleN, note: `${r.envCount} environments` },
    warnings: [r.fragility > 0.5 ? 'fragile — one environment carries most of the effect' : null, r.directionConsistency < 0.6 ? 'direction reverses across environments' : null].filter(Boolean),
    inputs: {
      subject_signal: signal || null,
      invariance_score: r.invariance, environment_coverage: r.envCount,
      effect_direction_consistency: r.directionConsistency, effect_heterogeneity: r.heterogeneity,
      mechanism_confidence: +Math.max(0, Math.min(1, r.invariance * r.directionConsistency)).toFixed(3),
      fragility_score: r.fragility, overall_ic: r.overallIC, per_environment: r.perEnv,
    },
  });
}

module.exports = { CONFIG, evaluateInvariance, toEnvelope };
