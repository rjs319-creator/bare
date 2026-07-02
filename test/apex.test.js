'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const apex = require('../lib/apex');

// A pillar bundle that scores in the 'apex' tier (no weak pillar, confirmed setup).
const strongPillars = { p1: 90, p2: 80, p3: 70, p4: 85 };
const confirmed = { status: 'Breakout' };

test('tierOf: strong balanced pillars + confirmed setup = apex (ungated)', () => {
  const score = apex.composite(strongPillars, apex.PRESETS.RISK_ON);
  assert.equal(apex.tierOf(score, strongPillars, confirmed), 'apex');
});

test('tierOf: gate is OFF by default — risk-off still returns apex/loaded', () => {
  const score = apex.composite(strongPillars, apex.PRESETS.RISK_OFF);
  // No opts → harnesses (exits/backfill/ledger) keep reconstructing risk-off.
  assert.equal(apex.tierOf(score, strongPillars, confirmed, { regime: 'RISK_OFF' }), 'apex');
});

test('tierOf: gateRiskOff caps apex → watch in RISK_OFF (no new longs)', () => {
  const score = apex.composite(strongPillars, apex.PRESETS.RISK_OFF);
  assert.equal(apex.tierOf(score, strongPillars, confirmed, { gateRiskOff: true, regime: 'RISK_OFF' }), 'watch');
});

test('tierOf: gateRiskOff caps loaded → watch in RISK_OFF', () => {
  // Loaded tier: high composite but a lagging pillar / unconfirmed status.
  const loadedPillars = { p1: 70, p2: 60, p3: 55, p4: 60 };
  const c = { status: 'Setup' };
  const score = apex.composite(loadedPillars, apex.PRESETS.RISK_OFF);
  assert.equal(apex.tierOf(score, loadedPillars, c, { regime: 'RISK_OFF' }), 'loaded');            // ungated
  assert.equal(apex.tierOf(score, loadedPillars, c, { gateRiskOff: true, regime: 'RISK_OFF' }), 'watch'); // gated
});

test('tierOf: gate is a no-op outside risk-off', () => {
  const score = apex.composite(strongPillars, apex.PRESETS.RISK_ON);
  assert.equal(apex.tierOf(score, strongPillars, confirmed, { gateRiskOff: true, regime: 'RISK_ON' }), 'apex');
  assert.equal(apex.tierOf(score, strongPillars, confirmed, { gateRiskOff: true, regime: 'NEUTRAL' }), 'apex');
});

test('tierOf: watch is left untouched by the gate (nothing to downgrade)', () => {
  const weak = { p1: 50, p2: 46, p3: 47, p4: 48 };   // score ~45-57 → watch, minP < 35 blocks loaded? keep simple
  const c = { status: 'Setup' };
  const score = apex.composite(weak, apex.PRESETS.RISK_OFF);
  const ungated = apex.tierOf(score, weak, c, { regime: 'RISK_OFF' });
  const gated = apex.tierOf(score, weak, c, { gateRiskOff: true, regime: 'RISK_OFF' });
  assert.equal(gated, ungated);   // watch/null unaffected either way
});

test('scoreCandidate: threads gateRiskOff through to the tier', () => {
  const c = { pct: { rs: 90, mom: 90, trend: 80, base: 75, prox: 70, accum: 85, ud: 85, volAdj: 80 }, status: 'Breakout' };
  const ungated = apex.scoreCandidate(c, 'RISK_OFF');
  const gated = apex.scoreCandidate(c, 'RISK_OFF', null, { gateRiskOff: true });
  assert.ok(ungated.tier === 'apex' || ungated.tier === 'loaded');
  assert.equal(gated.tier, 'watch');
  assert.equal(ungated.score, gated.score);   // gate changes only the tier, not the score
});
