'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/strategy-gate');

// ── the gate: production may trade, everything else may not ──────────────────
test('isTradeEligible: only production strategies are trade-eligible', () => {
  const registry = [
    { id: 'prod', maturity: 'production' },
    { id: 'shadow', maturity: 'shadow' },
    { id: 'exp', maturity: 'experimental' },
    { id: 'rej', maturity: 'rejected' },
  ];
  assert.equal(gate.isTradeEligible('prod', registry), true);
  assert.equal(gate.isTradeEligible('shadow', registry), false);
  assert.equal(gate.isTradeEligible('exp', registry), false);
  assert.equal(gate.isTradeEligible('rej', registry), false);
});

test('statusOf: omitted maturity defaults to production (validated backbone)', () => {
  const registry = [{ id: 'core' }];   // no maturity field
  assert.equal(gate.statusOf('core', registry), 'production');
  assert.equal(gate.isTradeEligible('core', registry), true);
});

test('statusOf: unregistered id fails CLOSED (shadow), never trade-eligible', () => {
  assert.equal(gate.statusOf('does-not-exist', []), 'shadow');
  assert.equal(gate.isTradeEligible('does-not-exist', []), false);
});

test('normalizeStatus: an unknown/typo maturity fails CLOSED to shadow', () => {
  // A copy-edit typo must NEVER accidentally grant live-trade eligibility.
  const registry = [{ id: 'oops', maturity: 'promoted-yesterday!!' }];
  assert.equal(gate.statusOf('oops', registry), 'shadow');
  assert.equal(gate.isTradeEligible('oops', registry), false);
});

// ── the actual registered state of the options overlays ─────────────────────
test('SAFETY: optionsflow + putsell are registered SHADOW (not trade-eligible)', () => {
  assert.equal(gate.statusOf('optionsflow'), 'shadow');
  assert.equal(gate.statusOf('putsell'), 'shadow');
  assert.equal(gate.isTradeEligible('optionsflow'), false);
  assert.equal(gate.isTradeEligible('putsell'), false);
});

test('the backbone screeners remain trade-eligible (behavior preserved)', () => {
  for (const id of ['screener', 'momentum', 'gapgo', 'daytrade', 'coil', 'ghost', 'biotech', 'downday']) {
    assert.equal(gate.isTradeEligible(id), true, `${id} must stay trade-eligible`);
  }
});

test('PROMOTION_GATE documents the bar and is frozen (not editable at runtime)', () => {
  assert.equal(gate.PROMOTION_GATE.minResolvedEpisodes, 50);
  assert.ok(Object.isFrozen(gate.PROMOTION_GATE));
});
