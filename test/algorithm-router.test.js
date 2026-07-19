'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/algorithm-router');

const algo = (o) => ({ id: o.id, family: o.family || o.id, longTermSkill: 0.1, recentSkill: 0.1, scenarioCompat: 1, calibrationQuality: 1, independentValue: 1, executionQuality: 1, uncertainty: 0.1, health: 'HEALTHY', effN: 50, ...o });

test('BROKEN health → weight 0 (emergency disable)', () => {
  const out = R.routeWeights([algo({ id: 'a' }), algo({ id: 'b', health: 'BROKEN' })], {});
  assert.strictEqual(out.weights.b, 0);
  assert.ok(out.weights.a > 0);
});

test('all-zero abstention when nothing has credible edge', () => {
  const out = R.routeWeights([algo({ id: 'a', health: 'BROKEN' }), algo({ id: 'b', longTermSkill: -0.1, recentSkill: -0.1 })], {});
  assert.strictEqual(out.abstain, true);
  assert.ok(Object.values(out.weights).every(w => w === 0));
});

test('per-algo cap is enforced', () => {
  const out = R.routeWeights([algo({ id: 'a', longTermSkill: 5, recentSkill: 5 }), algo({ id: 'b' })], {}, { hysteresis: 1, turnoverCap: 1 });
  assert.ok(out.weights.a <= 0.35 + 1e-9, `capped ${out.weights.a}`);
});

test('per-family cap scales a crowded family down', () => {
  const algos = [algo({ id: 'a', family: 'momentum' }), algo({ id: 'b', family: 'momentum' }), algo({ id: 'c', family: 'momentum' }), algo({ id: 'd', family: 'other' })];
  const out = R.routeWeights(algos, {}, { hysteresis: 1, turnoverCap: 1, maxPerFamily: 0.5 });
  const famMom = out.weights.a + out.weights.b + out.weights.c;
  assert.ok(famMom <= 0.5 + 1e-3, `family total ${famMom}`);   // 1e-3 tol for 4dp rounding of 3 weights
});

test('hysteresis moves only partway from previous to target', () => {
  const prev = { a: 0, b: 0 };
  const out = R.routeWeights([algo({ id: 'a' }), algo({ id: 'b' })], prev, { hysteresis: 0.5, turnoverCap: 1 });
  // target ~0.5 each → with hysteresis 0.5 the step lands near 0.25, not 0.5.
  assert.ok(out.weights.a < out.target.a, 'does not jump straight to target');
});

test('turnover cap limits per-step change', () => {
  const out = R.routeWeights([algo({ id: 'a', longTermSkill: 5, recentSkill: 5 }), algo({ id: 'b' })], { a: 0, b: 0 }, { hysteresis: 1, turnoverCap: 0.1 });
  assert.ok(out.weights.a <= 0.1 + 1e-9, `turnover-limited ${out.weights.a}`);
});

test('small-cell shrink pulls thin recent skill toward long-term', () => {
  // Recent skill is high but effN tiny → should be shrunk toward the low long-term.
  const thin = R.targetScore({ id: 'x', longTermSkill: 0.05, recentSkill: 0.5, scenarioCompat: 1, calibrationQuality: 1, independentValue: 1, executionQuality: 1, uncertainty: 0, effN: 3, health: 'HEALTHY' }, R.DEFAULTS);
  const thick = R.targetScore({ id: 'x', longTermSkill: 0.05, recentSkill: 0.5, scenarioCompat: 1, calibrationQuality: 1, independentValue: 1, executionQuality: 1, uncertainty: 0, effN: 500, health: 'HEALTHY' }, R.DEFAULTS);
  assert.ok(thin < thick, 'thin sample shrinks harder toward long-term');
});

test('a shadow/unvalidated algorithm (ORBIT) earns ~no focus', () => {
  const algos = [algo({ id: 'proven' }), algo({ id: 'orbit', longTermSkill: 0, recentSkill: 0, calibrationQuality: 0, independentValue: 0.2, effN: 5, health: 'INSUFFICIENT_DATA' })];
  const out = R.routeWeights(algos, {}, { hysteresis: 1, turnoverCap: 1 });
  assert.strictEqual(out.weights.orbit, 0, 'shadow ORBIT gets zero focus until validated');
});

test('redundancy penalty: low independent value shrinks focus', () => {
  const indep = R.targetScore(algo({ id: 'x', independentValue: 1 }), R.DEFAULTS);
  const redundant = R.targetScore(algo({ id: 'x', independentValue: 0.1 }), R.DEFAULTS);
  assert.ok(redundant < indep);
});
