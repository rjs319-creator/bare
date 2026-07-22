'use strict';
// OMEGA-SWING validation-gate + governance tests (Phase 13 / Phase 15 / Phase 16): fail-closed
// promotion gates, tier monotonicity, baseline outperformance, deadline-truncation, and central
// shadow registration.
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateGates } = require('../lib/omega-backfill');
const gate = require('../lib/strategy-gate');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

const strong = {
  blockICs: [0.05, 0.06, 0.04], deadlineTruncated: false,
  tierNet: { prime: 0.03, qualified: 0.01, watch: -0.01 }, scoreIC: 0.05, baseICs: [0.02, 0.01],
};

test('a statistically strong static-universe result passes but is NOT promotable (fail closed)', () => {
  const g = evaluateGates({ ...strong, historicalLiveParity: false, survivorshipSafe: false });
  assert.strictEqual(g.passed, true);
  assert.strictEqual(g.promotable, false, 'static universe can never be promotable');
  assert.strictEqual(g.gates.liveFunnelParity, false);
  assert.strictEqual(g.gates.survivorshipSafe, false);
});

test('deadline-truncated evaluation can NEVER pass', () => {
  const g = evaluateGates({ ...strong, deadlineTruncated: true });
  assert.strictEqual(g.passed, false);
  assert.strictEqual(g.verdict, 'inconclusive-truncated');
});

test('non-monotone tier payoff fails the gate', () => {
  const g = evaluateGates({ ...strong, tierNet: { prime: 0.01, qualified: 0.03, watch: 0.0 } });
  assert.strictEqual(g.gates.tierMonotone, false);
  assert.strictEqual(g.passed, false);
});

test('failing to beat every simple baseline fails the gate', () => {
  const g = evaluateGates({ ...strong, scoreIC: 0.015, baseICs: [0.02, 0.01] });
  assert.strictEqual(g.gates.beatsBaselines, false);
  assert.strictEqual(g.passed, false);
});

test('fewer than 3 positive blocks fails', () => {
  const g = evaluateGates({ ...strong, blockICs: [0.05, 0.06] });
  assert.strictEqual(g.gates.minBlocksPositive, false);
  assert.strictEqual(g.passed, false);
});

test('even a fully-clean, parity+survivorship result is only promotable when EVERY gate passes', () => {
  const g = evaluateGates({ ...strong, historicalLiveParity: true, survivorshipSafe: true });
  assert.strictEqual(g.passed, true);
  assert.strictEqual(g.promotable, true);
  // but flip one statistical gate and promotable collapses
  const g2 = evaluateGates({ ...strong, historicalLiveParity: true, survivorshipSafe: true, deadlineTruncated: true });
  assert.strictEqual(g2.promotable, false);
});

test('OMEGA is registered centrally as SHADOW and is NOT trade-eligible', () => {
  const entry = STRATEGY_REGISTRY.find(s => s.id === 'omega');
  assert.ok(entry, 'omega is in the registry');
  assert.strictEqual(entry.section, 'OMEGA');
  assert.strictEqual(entry.maturity, 'shadow');
  assert.strictEqual(gate.statusOf('omega'), 'shadow');
  assert.strictEqual(gate.isTradeEligible('omega'), false, 'shadow MUST NOT originate a live trade');
});
