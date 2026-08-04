// Defect 2 — the legacy pattern backtest is NOT a production-parity replay and
// must say so on every response. The stamp is the machine-readable veto that
// keeps its numbers out of any promotion path.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LIVE_PARITY_STAMP } = require('../api/backtest');

test('legacy backtest exports a frozen non-parity stamp', () => {
  assert.strictEqual(LIVE_PARITY_STAMP.historicalLiveParity, false);
  assert.strictEqual(LIVE_PARITY_STAMP.promotionBlocked, true);
  assert.ok(Array.isArray(LIVE_PARITY_STAMP.parityMismatches));
  assert.ok(LIVE_PARITY_STAMP.parityMismatches.length >= 8, 'mismatch list enumerates the missing live gates');
  assert.match(LIVE_PARITY_STAMP.warning, /CANNOT validate production picks/);
  assert.ok(Object.isFrozen(LIVE_PARITY_STAMP), 'stamp is immutable');
  assert.ok(Object.isFrozen(LIVE_PARITY_STAMP.parityMismatches), 'mismatch list is immutable');
});

test('stamp names the concrete live-selection stages the legacy backtest lacks', () => {
  const joined = LIVE_PARITY_STAMP.parityMismatches.join(' | ');
  for (const needle of ['relative-strength', 'trend eligibility', 'percentile', 'composite', 'cap/buffer', 'liquidity', 'regime', 'dedup']) {
    assert.ok(joined.toLowerCase().includes(needle.toLowerCase()), `mismatch list mentions ${needle}`);
  }
});
