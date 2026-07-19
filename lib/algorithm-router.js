// Adaptive algorithm router (orbit-router-v1) — decides how much FOCUS each
// VALIDATED algorithm receives under current conditions. Conservative by design:
// it shrinks toward long-term skill, shrinks small regime cells, caps per algo and
// per evidence-family, penalises redundancy, applies hysteresis + turnover limits,
// disables broken algorithms outright, and returns ALL-ZERO weights (abstain) when
// no credible edge exists. It never uses "best recent returns wins".
//
// This is inspectable, not a black box. It is shadow context: ORBIT is one input
// and only earns focus once its validated skill, calibration, scenario fit, and
// independent-information value are all positive — which, in shadow, they are not.

const ROUTER_VERSION = 'orbit-router-v1';

const DEFAULTS = Object.freeze({
  maxPerAlgo: 0.35,        // no single algorithm dominates
  maxPerFamily: 0.55,      // cap total weight per evidence family
  shrinkK: 20,             // small-cell shrink: blend recent toward long-term by effN
  minEff: 10,              // below this effective sample → disabled
  hysteresis: 0.5,         // apply only this fraction of the move from prev → target
  turnoverCap: 0.15,       // max absolute weight change per algo per step
  fixedShare: 0.0,         // optional Fixed-Share exploration floor for ACTIVE algos
});

const clamp01 = x => Math.max(0, Math.min(1, x));

// Per-algorithm target score in [0,∞). Zero for broken / thin / disabled algos.
function targetScore(a, opt) {
  if (a.disabled === true || a.health === 'BROKEN' || (a.effN != null && a.effN < opt.minEff)) return 0;
  const eff = a.effN != null ? a.effN : opt.minEff;
  // Small-cell shrink: blend recent skill toward long-term by effective sample size.
  const lt = num(a.longTermSkill), rc = num(a.recentSkill, lt);
  const blended = (eff * rc + opt.shrinkK * lt) / (eff + opt.shrinkK);
  if (blended <= 0) return 0;   // no positive validated skill → no focus
  const factors = clamp01(num(a.scenarioCompat, 1)) * clamp01(num(a.calibrationQuality, 1))
    * clamp01(num(a.independentValue, 1)) * clamp01(num(a.executionQuality, 1))
    * (1 - clamp01(num(a.uncertainty, 0)));
  // DEGRADING halves focus but does not zero it (unlike BROKEN).
  const healthMult = a.health === 'DEGRADING' ? 0.5 : 1;
  return Math.max(0, blended) * factors * healthMult;
}
function num(x, fb = 0) { return (x == null || Number.isNaN(x)) ? fb : x; }

// Compute routed weights.
//   algos: [{ id, family, longTermSkill, recentSkill, scenarioCompat, calibrationQuality,
//             independentValue, executionQuality, uncertainty, health, effN, disabled, cooldown }]
//   prev:  { id: weight }   previous step's weights (for hysteresis + turnover)
function routeWeights(algos, prev = {}, opts = {}) {
  const opt = { ...DEFAULTS, ...opts };
  const scored = algos.map(a => ({ a, s: (a.cooldown === true ? 0 : targetScore(a, opt)) }));
  const total = scored.reduce((t, x) => t + x.s, 0);

  // All-zero → abstain when nothing has a credible edge.
  if (total <= 0) {
    return { version: ROUTER_VERSION, abstain: true, weights: Object.fromEntries(algos.map(a => [a.id, 0])), reason: 'no algorithm has positive validated, calibrated, incremental skill' };
  }

  // Normalise → raw target weights, then per-algo cap.
  let target = {};
  for (const { a, s } of scored) target[a.id] = Math.min(opt.maxPerAlgo, s / total);

  // Optional Fixed-Share exploration floor for ACTIVE algos, then re-cap.
  if (opt.fixedShare > 0) {
    const active = scored.filter(x => x.s > 0).map(x => x.a.id);
    for (const id of active) target[id] = Math.min(opt.maxPerAlgo, (1 - opt.fixedShare) * target[id] + opt.fixedShare / active.length);
  }

  // Per-family cap: scale down any family whose total exceeds maxPerFamily.
  const famTotals = {};
  for (const a of algos) { const f = a.family || a.id; famTotals[f] = (famTotals[f] || 0) + (target[a.id] || 0); }
  for (const a of algos) {
    const f = a.family || a.id, ft = famTotals[f];
    if (ft > opt.maxPerFamily && ft > 0) target[a.id] = target[a.id] * (opt.maxPerFamily / ft);
  }

  // Hysteresis + turnover cap relative to previous weights.
  const weights = {};
  for (const a of algos) {
    const p = num(prev[a.id], 0), t = num(target[a.id], 0);
    let w = p + opt.hysteresis * (t - p);
    const delta = w - p;
    if (Math.abs(delta) > opt.turnoverCap) w = p + Math.sign(delta) * opt.turnoverCap;
    weights[a.id] = +Math.max(0, w).toFixed(4);
  }

  return { version: ROUTER_VERSION, abstain: false, weights, target: mapRound(target), familyTotals: mapRound(famTotals) };
}
function mapRound(o) { const r = {}; for (const k in o) r[k] = +o[k].toFixed(4); return r; }

module.exports = { ROUTER_VERSION, DEFAULTS, targetScore, routeWeights };
