'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/algo-router');

// A minimal health object shaped like a classifyAlgo result.
function health(id, over = {}) {
  return {
    id, health: 'STRONG',
    estimate: { avgExcess: 1.2, beatRate: 0.7 },
    ci: { lo: 0.56, hi: 0.82 },
    effectiveSampleSize: 40,
    regimeCompatibility: 0.8, calibrationQuality: 0.85,
    independentContribution: 0.9, certainty: 0.8,
    ...over,
  };
}

// ── validatedSkill: shrinks toward zero on small samples, zero without real edge ──
test('validatedSkill: requires positive avgExcess AND beatRate above 0.5', () => {
  assert.equal(R.validatedSkill(health('a', { estimate: { avgExcess: -1, beatRate: 0.7 } }), 10), 0);
  assert.equal(R.validatedSkill(health('a', { estimate: { avgExcess: 1, beatRate: 0.5 } }), 10), 0);
  assert.ok(R.validatedSkill(health('a'), 10) > 0);
});

test('validatedSkill: a small sample earns less than the same edge on a large sample', () => {
  const small = R.validatedSkill(health('a', { effectiveSampleSize: 5 }), 10);
  const large = R.validatedSkill(health('a', { effectiveSampleSize: 200 }), 10);
  assert.ok(large > small);
});

// ── abstention: no positive conservative estimate → abstain, all weights 0 ────
test('all-zero raw weights → ABSTAIN with every current weight 0', () => {
  const hs = [
    health('a', { health: 'UNKNOWN', estimate: { avgExcess: null, beatRate: null } }),
    health('b', { health: 'BROKEN', estimate: { avgExcess: -1, beatRate: 0.3 } }),
  ];
  const out = R.routeWeights(hs, {});
  assert.equal(out.abstain, true);
  assert.ok(out.weights.every((w) => w.currentWeight === 0));
  assert.equal(out.totalWeight, 0);
});

// ── hysteresis: focus shifts gradually, not in one jump ───────────────────────
test('a strong algorithm from zero prior rises by at most one step (turnover limit)', () => {
  const out = R.routeWeights([health('a'), health('b', { id: 'b' })], { prior: { weights: {}, cooldowns: {} } });
  const a = out.weights.find((w) => w.id === 'a');
  assert.ok(a.targetWeight > a.currentWeight); // target not reached in one run
  assert.ok(a.currentWeight <= out.caps.maxStepUp + 1e-9);
});

test('reductions may move faster than increases', () => {
  // Prior heavy weight, now BROKEN → snaps toward 0 immediately (faster than maxStepUp).
  const out = R.routeWeights([health('a', { health: 'BROKEN', estimate: { avgExcess: -1, beatRate: 0.3 } })],
    { prior: { weights: { a: 0.25 }, cooldowns: {} } });
  assert.equal(out.weights[0].currentWeight, 0);
});

// ── emergency disable ─────────────────────────────────────────────────────────
test('an emergency-disabled algorithm is forced to 0 regardless of skill', () => {
  const out = R.routeWeights([health('a'), health('b', { id: 'b' })],
    { emergency: new Set(['a']), prior: { weights: { a: 0.2 }, cooldowns: {} } });
  const a = out.weights.find((w) => w.id === 'a');
  assert.equal(a.currentWeight, 0);
  assert.equal(a.rawWeight, 0);
  assert.ok(a.emergency);
});

// ── cooldown ──────────────────────────────────────────────────────────────────
test('a cooling-down algorithm may hold or fall but not increase', () => {
  const out = R.routeWeights([health('a')], { prior: { weights: { a: 0.05 }, cooldowns: { a: 2 } } });
  const a = out.weights[0];
  assert.ok(a.currentWeight <= 0.05 + 1e-9); // increase blocked
});

test('a DEGRADING verdict arms the cooldown for the next run', () => {
  const out = R.routeWeights([health('a', { health: 'DEGRADING' })], { prior: { weights: { a: 0.1 }, cooldowns: {} } });
  assert.ok((out.cooldowns.a || 0) > 0);
});

// ── per-family cap: correlated siblings share an evidence budget ──────────────
test('two strong algorithms in one family are capped at the family limit', () => {
  const hs = [health('a'), health('b', { id: 'b' }), health('c', { id: 'c' })];
  const familyOf = (id) => (id === 'c' ? 'other' : 'momentum'); // a,b share a family
  const out = R.routeWeights(hs, { familyOf, caps: { ...R.DEFAULT_CAPS, maxStepUp: 1, maxStepDown: 1 } });
  const famSum = out.weights.filter((w) => w.family === 'momentum').reduce((s, w) => s + w.targetWeight, 0);
  assert.ok(famSum <= R.DEFAULT_CAPS.maxFamily + 1e-6);
  assert.ok(out.cappedFamilies.includes('momentum'));
});

// ── per-algorithm cap ─────────────────────────────────────────────────────────
test('no single algorithm exceeds the per-algorithm cap', () => {
  const out = R.routeWeights([health('a')], { caps: { ...R.DEFAULT_CAPS, maxStepUp: 1 } });
  assert.ok(out.weights[0].currentWeight <= R.DEFAULT_CAPS.maxAlgo + 1e-9);
});

// ── regime incompatibility drags weight down ─────────────────────────────────
test('an INCOMPATIBLE regime verdict gets far less weight than a compatible one', () => {
  const compatible = R.routeWeights([health('a')], { caps: { ...R.DEFAULT_CAPS, maxStepUp: 1 } });
  const incompatible = R.routeWeights([health('a', { health: 'INCOMPATIBLE', regimeCompatibility: 0.15 })],
    { caps: { ...R.DEFAULT_CAPS, maxStepUp: 1 } });
  assert.ok(incompatible.weights[0].rawWeight < compatible.weights[0].rawWeight);
});

// ── determinism ──────────────────────────────────────────────────────────────
test('routeWeights is deterministic', () => {
  const a = R.routeWeights([health('a'), health('b', { id: 'b' })], {});
  const b = R.routeWeights([health('a'), health('b', { id: 'b' })], {});
  assert.deepEqual(a, b);
});

// ── quant-redesign-3: binding risk-cap budgets ───────────────────────────────
test('budgets: any missing input fails CLOSED to 0 (no flattering default constants)', () => {
  const out = R.computeStrategyBudgets([
    { id: 'a', family: 'fa', baseBudget: 0.2, governanceWeight: 1, health: 'STRONG',
      regimeCompatibility: 0.8, calibrationQuality: null, independentContribution: 0.9, executionConfidence: 1 },
  ]);
  assert.equal(out.budgets[0].budget, 0);
  assert.equal(out.budgets[0].inputsValid, false);
  assert.ok(out.budgets[0].missingInputs.includes('calibrationQuality'));
  assert.equal(out.bindingReady, false);
  assert.equal(out.cash, 1);
});

test('budgets: cap-only — the final budget never exceeds the validated base budget', () => {
  const out = R.computeStrategyBudgets([
    { id: 'a', family: 'fa', baseBudget: 0.2, governanceWeight: 1, health: 'STRONG',
      regimeCompatibility: 1, calibrationQuality: 1, independentContribution: 1, executionConfidence: 1 },
  ]);
  assert.ok(out.budgets[0].budget <= 0.2 + 1e-9);
  assert.equal(out.budgets[0].inputsValid, true);
  assert.equal(out.bindingReady, true);
});

test('budgets: multipliers only ever REDUCE, freed capital goes to cash', () => {
  const out = R.computeStrategyBudgets([
    { id: 'a', family: 'fa', baseBudget: 0.4, governanceWeight: 0.5, health: 'SUPPORTED',
      regimeCompatibility: 0.5, calibrationQuality: 0.8, independentContribution: 0.7, executionConfidence: 1 },
  ]);
  const b = out.budgets[0].budget;
  assert.ok(b < 0.4 && b > 0);
  assert.ok(Math.abs(out.cash - (1 - b)) < 1e-6);
});

test('budgets: a correlated family shares one collective cap, excess surrendered to cash', () => {
  const mk = (id) => ({ id, family: 'trend', baseBudget: 0.4, governanceWeight: 1, health: 'STRONG',
    regimeCompatibility: 1, calibrationQuality: 1, independentContribution: 1, executionConfidence: 1 });
  const out = R.computeStrategyBudgets([mk('a'), mk('b'), mk('c')]);
  const famSum = out.budgets.reduce((s, r) => s + r.budget, 0);
  // 4-dp rounding on each member can overshoot the cap by ≤ n×5e-5 — that is display
  // precision, not a cap breach.
  assert.ok(famSum <= 0.5 + 1e-3, 'family sum must respect the collective cap');
  assert.deepEqual(out.cappedFamilies, ['trend']);
  assert.ok(out.cash >= 0.5 - 1e-3);
});
