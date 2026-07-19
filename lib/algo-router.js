'use strict';

// Conservative Market-Regime Router (algo-router-v1)
// --------------------------------------------------
// Turns a set of Algorithm-Effectiveness-Monitor verdicts (lib/algo-health.js) into a
// per-algorithm emphasis weight. The whole point is to shift focus toward what is working
// NOW *without* chasing whichever algorithm happened to win a few recent trades. Every
// mechanism here exists to make the shift cautious:
//
//   weight = positiveValidatedSkill        (shrunk toward zero by effective sample size)
//          × regimeCompatibility            (how much now looks like where it worked)
//          × healthMultiplier               (STRONG..BROKEN ladder)
//          × calibrationMultiplier
//          × independenceMultiplier         (correlated siblings share an evidence budget)
//          × executionMultiplier
//          × uncertaintyMultiplier          (wide CI ⇒ small weight)
//
//   then: per-algorithm cap · per-family cap · turnover-limited hysteresis vs the prior
//         weights · cooldowns after degradation · emergency disable · all-zero ⇒ ABSTAIN.
//
// Pure and clock-free (deterministic, testable). Weights are NOT renormalised to 1 after
// hysteresis: the unallocated remainder is honest "sit in cash / abstain", matching the
// one-directional governance haircut in lib/allocation.js (freed capital → cash, never
// force-reallocated).

const { HEALTH_STATES } = require('./algo-health');

const ROUTER_VERSION = 'algo-router-v1';

const DEFAULT_CAPS = Object.freeze({
  maxAlgo: 0.25,    // no single algorithm may own more than a quarter of the emphasis
  maxFamily: 0.50,  // no evidence family (correlated cluster) may own more than half
  maxStepUp: 0.10,  // per-run increase is turnover-limited (slow to add conviction)
  maxStepDown: 0.20, // reductions may move twice as fast (quicker to cut a loser)
  shrinkK: 10,      // skill shrinks toward zero: w = effN / (effN + shrinkK)
  cooldownRuns: 3,  // after a DEGRADING/BROKEN verdict, block increases for N runs
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Positive, validated skill in [0,1], shrunk toward zero by the effective sample size so a
// tiny sample cannot claim a large edge. Requires BOTH a positive average excess and a
// beat-rate above the coin-flip line — a lucky average on a losing hit-rate earns nothing.
function validatedSkill(health, shrinkK) {
  const est = health && health.estimate;
  if (!est || !isNum(est.avgExcess) || est.avgExcess <= 0) return 0;
  if (!isNum(est.beatRate) || est.beatRate <= 0.5) return 0;
  const edge = clamp((est.beatRate - 0.5) * 2, 0, 1); // 0.5→0, 1.0→1
  const effN = health.effectiveSampleSize || 0;
  const shrink = effN / (effN + shrinkK);
  return +clamp(edge * shrink, 0, 1).toFixed(4);
}

// Assemble the seven multipliers for one algorithm.
function multipliersFor(health, execMult, shrinkK) {
  return {
    skill: validatedSkill(health, shrinkK),
    regime: isNum(health.regimeCompatibility) ? clamp(health.regimeCompatibility, 0, 1) : 0.5,
    health: (HEALTH_STATES[health.health] || { weight: 0 }).weight,
    calibration: isNum(health.calibrationQuality) ? clamp(health.calibrationQuality, 0, 1) : 0.8,
    independence: isNum(health.independentContribution) ? clamp(health.independentContribution, 0, 1) : 0.7,
    execution: isNum(execMult) ? clamp(execMult, 0, 1) : 1,
    uncertainty: isNum(health.certainty) ? clamp(health.certainty, 0, 1) : 0.5,
  };
}

const productOf = (m) => m.skill * m.regime * m.health * m.calibration * m.independence * m.execution * m.uncertainty;

// Scale down every member of any family whose target weights sum above the family cap, then
// return the adjusted map. Applied to the normalised target vector.
function applyFamilyCap(targets, familyOf, maxFamily) {
  const byFamily = new Map();
  for (const id of Object.keys(targets)) {
    const f = familyOf(id);
    byFamily.set(f, (byFamily.get(f) || 0) + targets[id]);
  }
  const capped = new Set();
  const out = { ...targets };
  for (const [f, sum] of byFamily) {
    if (sum > maxFamily && sum > 0) {
      const scale = maxFamily / sum;
      for (const id of Object.keys(out)) if (familyOf(id) === f) { out[id] *= scale; capped.add(f); }
    }
  }
  return { targets: out, cappedFamilies: capped };
}

// routeWeights(healths, opts)
//   healths   : Array<classifyAlgo result>
//   opts.prior: { weights: { id: number }, cooldowns: { id: runsRemaining } }
//   opts.familyOf(id) -> family key (default: the id itself)
//   opts.execOf(id)   -> 0..1 execution multiplier (default 1)
//   opts.emergency    : Set<id> forced to weight 0 immediately (leakage / data failure)
//   opts.caps         : partial override of DEFAULT_CAPS
function routeWeights(healths, opts = {}) {
  const caps = { ...DEFAULT_CAPS, ...(opts.caps || {}) };
  const familyOf = opts.familyOf || ((id) => id);
  const execOf = opts.execOf || (() => 1);
  const emergency = opts.emergency instanceof Set ? opts.emergency : new Set(opts.emergency || []);
  const prior = opts.prior || { weights: {}, cooldowns: {} };
  const priorW = prior.weights || {};
  const priorCd = prior.cooldowns || {};

  const list = (healths || []).filter((h) => h && h.id != null);

  // 1) raw multiplicative weight per algorithm (emergency / BROKEN / UNKNOWN → 0).
  const rows = list.map((h) => {
    const m = multipliersFor(h, execOf(h.id), caps.shrinkK);
    const isEmergency = emergency.has(h.id);
    const raw = isEmergency ? 0 : +productOf(m).toFixed(6);
    return { h, id: h.id, family: familyOf(h.id), health: h.health, multipliers: m, rawWeight: raw, emergency: isEmergency };
  });

  // 2) abstain when no algorithm has a positive conservative estimate.
  const rawSum = rows.reduce((a, r) => a + r.rawWeight, 0);
  const abstain = rawSum <= 1e-9;

  // 3) per-algorithm cap, then normalise the SURVIVORS to a target vector summing to 1.
  const cappedRaw = {};
  const cappedAlgo = new Set();
  for (const r of rows) {
    let v = r.rawWeight;
    if (v > caps.maxAlgo) { v = caps.maxAlgo; cappedAlgo.add(r.id); }
    cappedRaw[r.id] = v;
  }
  let targets = {};
  const capSum = Object.values(cappedRaw).reduce((a, v) => a + v, 0);
  for (const r of rows) targets[r.id] = abstain || capSum <= 0 ? 0 : cappedRaw[r.id] / capSum;

  // 4) per-family cap. Deliberately NOT renormalised afterwards: the weight a correlated
  //    cluster loses to its cap becomes UNALLOCATED (cash / abstain), never redistributed
  //    back to that same cluster — the one-directional haircut philosophy of allocation.js.
  //    Renormalising would re-inflate the capped family and defeat the cap.
  let cappedFamilies = new Set();
  if (!abstain) {
    const res = applyFamilyCap(targets, familyOf, caps.maxFamily);
    targets = res.targets;
    res.cappedFamilies.forEach((f) => cappedFamilies.add(f));
  }

  // 5) hysteresis + cooldown + emergency → the actual current weight the app would use.
  const nextCooldowns = {};
  const weights = rows.map((r) => {
    const priorWeight = +(priorW[r.id] || 0);
    const target = +(targets[r.id] || 0).toFixed(4);
    let current;
    let note;

    if (r.emergency || r.health === 'BROKEN') {
      current = 0; // faster reduction is permitted when demonstrably harmful
      note = r.emergency ? 'emergency disabled — snapped to 0' : 'BROKEN — snapped to 0';
    } else {
      const delta = target - priorWeight;
      const step = delta >= 0 ? Math.min(delta, caps.maxStepUp) : Math.max(delta, -caps.maxStepDown);
      current = priorWeight + step;
      // Cooldown: a recently-degraded algo may not INCREASE, only hold or fall.
      const cd = priorCd[r.id] || 0;
      if (cd > 0 && current > priorWeight) { current = priorWeight; note = `cooldown (${cd}) — increase blocked`; }
      else if (step >= 0 && delta > caps.maxStepUp) note = 'raising toward target (turnover-limited)';
      else if (step < 0) note = 'reducing toward target';
      else note = 'at/near target';
    }
    current = +clamp(current, 0, caps.maxAlgo).toFixed(4);

    // Set / decay the cooldown counter for the NEXT run.
    let cd = priorCd[r.id] || 0;
    if (r.health === 'DEGRADING' || r.health === 'BROKEN') cd = caps.cooldownRuns;
    else if (cd > 0) cd -= 1;
    if (cd > 0) nextCooldowns[r.id] = cd;

    return {
      id: r.id, family: r.family, health: r.health,
      priorWeight: +priorWeight.toFixed(4), rawWeight: r.rawWeight,
      targetWeight: target, currentWeight: current,
      cappedAlgo: cappedAlgo.has(r.id), cappedFamily: cappedFamilies.has(r.family),
      cooldown: nextCooldowns[r.id] || 0, emergency: r.emergency,
      multipliers: r.multipliers, note,
    };
  });

  const totalWeight = +weights.reduce((a, w) => a + w.currentWeight, 0).toFixed(4);

  return {
    version: ROUTER_VERSION,
    abstain,
    totalWeight,
    unallocated: +clamp(1 - totalWeight, 0, 1).toFixed(4),
    caps,
    cappedFamilies: [...cappedFamilies],
    weights: weights.sort((a, b) => b.currentWeight - a.currentWeight || b.targetWeight - a.targetWeight),
    cooldowns: nextCooldowns,
  };
}

module.exports = { ROUTER_VERSION, DEFAULT_CAPS, validatedSkill, multipliersFor, applyFamilyCap, routeWeights };
