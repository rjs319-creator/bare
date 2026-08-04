// Regime-router constraint verification (audit requirement): algorithms shift
// focus only on sufficiently-sampled, regime-compatible, validated evidence —
// with explicit shrinkage, per-algo/family caps, bounded per-update changes,
// abstention to cash, and neutral treatment of unmeasured inputs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AR = require('../lib/algorithm-router');
const SR = require('../lib/swing-router');

const algo = (id, over = {}) => ({
  id, family: over.family || id,
  longTermSkill: 0.1, recentSkill: 0.1, effN: 60,
  scenarioCompat: 0.8, calibrationQuality: 0.8, independentValue: 0.8, executionQuality: 0.8,
  uncertainty: 0.2, health: 'HEALTHY',
  ...over,
});

test('insufficient current-regime evidence receives zero incremental weight', () => {
  const r = AR.routeWeights([algo('thin', { effN: 3 }), algo('ok')], {});
  assert.strictEqual(AR.targetScore(algo('thin', { effN: 3 }), AR.DEFAULTS), 0, 'below minEff → disabled');
  assert.ok(r.weights.ok > 0);
});

test('no "best of bad noise": all-negative skill → abstain with every weight zero', () => {
  const r = AR.routeWeights([algo('a', { longTermSkill: -0.05, recentSkill: -0.02 }), algo('b', { longTermSkill: -0.01, recentSkill: -0.2 })], {});
  assert.strictEqual(r.abstain, true, 'capital not allocated under uncertainty goes to cash/abstention');
  assert.deepStrictEqual(Object.values(r.weights), [0, 0]);
});

test('unmeasured regime/calibration inputs take the neutral midpoint — never a flattering default', () => {
  const measured = AR.targetScore(algo('m'), AR.DEFAULTS);
  const unmeasured = AR.targetScore(algo('u', { scenarioCompat: null, calibrationQuality: null, uncertainty: null }), AR.DEFAULTS);
  assert.ok(unmeasured < measured, 'missing quality signals reduce (never boost) focus');
});

test('per-algorithm and per-family caps bind', () => {
  const r = AR.routeWeights([algo('solo')], {});
  assert.ok(r.weights.solo <= AR.DEFAULTS.maxPerAlgo + 1e-9, 'single algo cannot exceed maxPerAlgo');
  const fam = AR.routeWeights([algo('f1', { family: 'trend' }), algo('f2', { family: 'trend' }), algo('f3', { family: 'trend' }), algo('x', { family: 'other' })], {});
  const trendTotal = fam.target.f1 + fam.target.f2 + fam.target.f3;
  assert.ok(trendTotal <= AR.DEFAULTS.maxPerFamily + 1e-6, 'family cap binds on the target weights');
});

test('changes per update are bounded (hysteresis + turnover cap) and cooldown zeroes focus', () => {
  const prev = { a: 0 };
  const r = AR.routeWeights([algo('a')], prev);
  assert.ok(Math.abs(r.weights.a - prev.a) <= AR.DEFAULTS.turnoverCap + 1e-9, 'per-step move bounded');
  const cd = AR.routeWeights([algo('a', { cooldown: true }), algo('b')], {});
  assert.strictEqual(cd.target.a, 0, 'emergency cooldown removes focus immediately');
});

test('swing router: thin per-algorithm cells stay pinned to the neutral 1.0 multiplier', () => {
  const ep = (source, win) => ({ origin: { sourceStrategy: source, strategyFamily: 'priceTrend' }, assessment: { outcomeState: win ? 'WIN' : 'LOSS' } });
  // 8 episodes (< MIN_EPISODES=12) of perfect wins must NOT tilt.
  const thin = SR.buildRouter(Array.from({ length: 8 }, () => ep('hotalgo', true)));
  assert.strictEqual(thin.multiplierFor('priceTrend', 'hotalgo'), 1, 'thin evidence never tilts');
  // 40 episodes with a real record tilts, but stays inside the band.
  const eps = [...Array.from({ length: 30 }, () => ep('steady', true)), ...Array.from({ length: 10 }, () => ep('steady', false))];
  const built = SR.buildRouter(eps);
  const m = built.multiplierFor('priceTrend', 'steady');
  assert.ok(m >= 1 - SR.BAND && m <= 1 + SR.BAND, 'multiplier bounded by the band');
  assert.strictEqual(built.shadow, true, 'router remains shadow — never originates or boosts a live trade');
});
