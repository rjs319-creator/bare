'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPlan, dayBefore } = require('../lib/biotech-plan');
const { ARCHETYPES: A } = require('../lib/biotech-config');

const feat = { atrPct: 0.05, event: { distEventHigh: -3, distEventLow: -12, anchoredVwap: 11.5, holdsEventLow: true } };

test('post-catalyst: event-high breakout with entry/stop/target and valid R:R', () => {
  const p = buildPlan({ archetype: A.POST_CATALYST, price: 12, features: feat });
  assert.equal(p.entryStyle, 'event-high-breakout');
  assert.ok(p.trigger > 12, 'trigger above price (event high not yet cleared)');
  assert.ok(p.stop < p.trigger, 'stop below entry');
  assert.ok(p.target1 > p.trigger);
  assert.ok(p.rewardRisk >= 1.3);
  assert.equal(p.planStatus, 'wait-trigger');
  assert.ok(p.costEstimate != null && p.costEstimate < 5, 'biotech cost estimate is a small percent');
});

test('pre-event: carries a MANDATORY exit-before date', () => {
  const p = buildPlan({ archetype: A.PRE_EVENT, price: 12, features: feat, event: { expectedDate: '2026-08-10' } });
  assert.equal(p.exitBeforeDate, '2026-08-09');
  assert.equal(p.binaryWithinHoldingPeriod, true);
  assert.ok(/reduced/.test(p.positionRiskTier));
});

test('non-actionable archetype → no plan (no fake precision)', () => {
  const p = buildPlan({ archetype: A.BINARY_WATCH, price: 12, features: feat });
  assert.equal(p.planStatus, 'no-plan');
  assert.equal(p.trigger, null);
  assert.equal(p.stop, null);
});

test('no ATR available → no plan rather than fabricated levels', () => {
  const p = buildPlan({ archetype: A.POST_CATALYST, price: 12, features: { event: {} } });
  assert.equal(p.planStatus, 'no-plan');
});

test('reward:risk math is internally consistent', () => {
  const p = buildPlan({ archetype: A.CATALYST_BASE, price: 20, features: { atrPct: 0.04 } });
  if (p.planStatus !== 'no-plan') {
    const ref = p.trigger != null ? p.trigger : p.entryZone[1];
    const rr = (p.target1 - ref) / (ref - p.stop);
    assert.ok(Math.abs(rr - p.rewardRisk) < 0.2, 'published R:R matches the levels');
  }
});

test('dayBefore helper', () => {
  assert.equal(dayBefore('2026-08-10'), '2026-08-09');
  assert.equal(dayBefore(null), null);
});
