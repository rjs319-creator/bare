'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/swing-router');

// Build resolved-episode stubs: {origin:{strategyFamily,sourceStrategy}, assessment:{outcomeState,returnSinceFill,excessVsSpy}}
function ep(source, family, outcome, net = 0, excess = 0) {
  return { origin: { strategyFamily: family, sourceStrategy: source }, assessment: { outcomeState: outcome, returnSinceFill: net, excessVsSpy: excess } };
}

test('below the sample threshold every algorithm stays neutral (1.0) (test #23)', () => {
  const eps = [ep('coil', 'volatility', 'WIN'), ep('coil', 'volatility', 'LOSS'), ep('screener', 'priceTrend', 'WIN')];
  const router = R.buildRouter(eps);
  assert.equal(router.multiplierFor('volatility', 'coil'), 1);
  assert.equal(router.multiplierFor('priceTrend', 'screener'), 1);
});

test('a well-sampled strong algorithm and a weak one get DIFFERENT tilts — it can rerank (test #22)', () => {
  const eps = [];
  // screener: 16 resolved, 13 wins (strong)
  for (let i = 0; i < 13; i++) eps.push(ep('screener', 'priceTrend', 'WIN', 0.04, 0.03));
  for (let i = 0; i < 3; i++) eps.push(ep('screener', 'priceTrend', 'LOSS', -0.03, -0.02));
  // coil: 16 resolved, 4 wins (weak)
  for (let i = 0; i < 4; i++) eps.push(ep('coil', 'volatility', 'WIN', 0.03, 0.02));
  for (let i = 0; i < 12; i++) eps.push(ep('coil', 'volatility', 'LOSS', -0.04, -0.03));
  const router = R.buildRouter(eps);
  const mScreener = router.multiplierFor('priceTrend', 'screener');
  const mCoil = router.multiplierFor('volatility', 'coil');
  assert.ok(mScreener > 1, `screener should tilt up, got ${mScreener}`);
  assert.ok(mCoil < 1, `coil should tilt down, got ${mCoil}`);
  assert.notEqual(mScreener, mCoil);   // NOT a uniform multiplier
});

test('the tilt stays inside the shrinkage band (bounded, never extreme)', () => {
  const eps = [];
  for (let i = 0; i < 40; i++) eps.push(ep('screener', 'priceTrend', 'WIN', 0.1, 0.09));
  const router = R.buildRouter(eps);
  const m = router.multiplierFor('priceTrend', 'screener');
  assert.ok(m <= 1 + R.BAND + 1e-9);   // capped
});

test('unknown algorithm falls back to neutral', () => {
  const router = R.buildRouter([ep('screener', 'priceTrend', 'WIN')]);
  assert.equal(router.multiplierFor('mystery', 'nope'), 1);
});

test('router carries a shadow honesty stamp', () => {
  const router = R.buildRouter([]);
  assert.equal(router.shadow, true);
  assert.match(router.note, /Never originates or boosts a live trade/);
});
