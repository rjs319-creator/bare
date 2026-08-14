'use strict';
// Audit 2026-08-14: the registry freezes screener's promoted claim to the Early:large
// cohort (policyTiers/policyScopes) and records Breakout/Setup and small/micro lanes as
// proven-negative excluded controls — but the cohort was read ONLY by governance grading
// (lib/maturity.js), never by the live gate. A Breakout:small row was tradeEligible under
// Early:large's clearance. These tests pin the new POLICY_COHORT gate in lib/eligibility.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/eligibility');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

const NOW = Date.parse('2026-07-24T12:00:00Z');
const GOV = {
  savedAt: '2026-07-24T00:00:00.000Z',
  scoreboardGeneratedAt: '2026-07-23T22:00:00.000Z',
  strategies: [{ id: 'screener', status: 'production', weight: 1, version: 'screener-v2' }],
};
// The gate must hold even if screener's real maturity moves — pin it to production here.
const REG = STRATEGY_REGISTRY.map(e => (e.id === 'screener' ? { ...e, maturity: 'production' } : e));

const sig = (over = {}) => ({
  source: 'screener', ticker: 'AAA', side: 'long',
  tier: 'Early', universeScope: 'large',
  entry: 10, stop: 9, target: 12, liquidity: { dollarVol: 5e6 },
  ...over,
});

const gate = (signals) => EL.gateSignals(signals, { registry: REG, governance: GOV, nowMs: NOW });

test('fixture sanity: the registry still freezes screener to Early:large', () => {
  const e = STRATEGY_REGISTRY.find(x => x.id === 'screener');
  assert.deepEqual(e.policyTiers, ['Early']);
  assert.deepEqual(e.policyScopes, ['large']);
});

test('an in-cohort row (Early:large) stays trade-eligible under earned clearance', () => {
  const g = gate([sig()]);
  assert.equal(g.annotated[0].eligibility.tradeEligible, true);
  assert.equal(g.annotated[0].eligibility.signalClass, 'ACTIONABLE');
});

test('THE REGRESSION: a Breakout row no longer trades under the Early cohort clearance', () => {
  const g = gate([sig({ tier: 'Breakout' })]);
  const el = g.annotated[0].eligibility;
  assert.equal(el.tradeEligible, false, 'Breakout is a registry-declared excluded control');
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.POLICY_COHORT), `codes: ${el.reasonCodes}`);
  assert.equal(el.signalClass, 'RESEARCH');
});

test('a small-scope Early row is excluded — scope is part of the frozen cohort', () => {
  const g = gate([sig({ universeScope: 'small' })]);
  const el = g.annotated[0].eligibility;
  assert.equal(el.tradeEligible, false);
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.POLICY_COHORT));
});

test('an unlabeled row fails CLOSED — it cannot prove it belongs to the validated cohort', () => {
  const g = gate([sig({ tier: undefined, universeScope: undefined })]);
  const el = g.annotated[0].eligibility;
  assert.equal(el.tradeEligible, false);
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.POLICY_COHORT));
});

test('a source that declares NO cohort is not affected by the gate', () => {
  // coremo declares no policyTiers/policyScopes; inject clearance and confirm the gate
  // does not invent a cohort requirement.
  const reg = STRATEGY_REGISTRY.map(e => (e.id === 'coremo' ? { ...e, maturity: 'production' } : e));
  const gov = { ...GOV, strategies: [{ id: 'coremo', status: 'production', weight: 1, version: 'coremo-v1' }] };
  const g = EL.gateSignals([sig({ source: 'coremo', tier: undefined, universeScope: undefined })], { registry: reg, governance: gov, nowMs: NOW });
  assert.equal(g.annotated[0].eligibility.tradeEligible, true);
});

test('excluded controls surface with the machine-readable POLICY_COHORT code', () => {
  const g = gate([sig({ tier: 'Setup', ticker: 'BBB' })]);
  const ex = g.excluded.find(x => x.ticker === 'BBB');
  assert.ok(ex, 'row must appear in excluded');
  assert.equal(ex.code, EL.REASON_CODE.POLICY_COHORT);
});
