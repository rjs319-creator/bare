'use strict';
// OMEGA-SWING data-contract tests (Phase 1 / Phase 2 / Phase 16): provenance required, causal
// guarantee (no same-close fill), signal price vs fill separated, immutability, live-track filter.
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/omega-contract');

const good = () => ({
  ticker: 'AAA', signalDate: '2025-03-01', provenance: C.PROVENANCE.PROSPECTIVE_LIVE,
  strategyVersion: 'omega-swing-v2', signalReferencePrice: 100,
  assumedFillPrice: 100.6, assumedFillDate: '2025-03-02', fillStatus: 'filled', entryPolicy: 'NEXT_OPEN_PLUS_SLIPPAGE',
});

test('a valid observation passes and is frozen (immutable)', () => {
  const r = C.makeOmegaObservation(good());
  assert.strictEqual(C.validateOmegaObservation(r).valid, true);
  assert.ok(Object.isFrozen(r));
  assert.throws(() => { r.tier = 'X'; }, /Cannot assign|read only|not extensible/);
});

test('provenance is REQUIRED and must be a known value (fail closed)', () => {
  const r = C.makeOmegaObservation({ ...good(), provenance: undefined });
  const v = C.validateOmegaObservation(r);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /provenance/.test(e)));
  assert.strictEqual(C.validateOmegaObservation(C.makeOmegaObservation({ ...good(), provenance: 'made_up' })).valid, false);
});

test('causal guarantee: a filled non-MOC observation may not fill at/before the signal date', () => {
  const same = C.makeOmegaObservation({ ...good(), assumedFillDate: '2025-03-01' });    // same day
  assert.strictEqual(C.validateOmegaObservation(same).valid, false);
  // A pre-committed MOC order IS allowed to fill same-close.
  const moc = C.makeOmegaObservation({ ...good(), assumedFillDate: '2025-03-01', entryPolicy: 'MARKET_ON_CLOSE_PRECOMMITTED' });
  assert.strictEqual(C.validateOmegaObservation(moc).valid, true);
});

test('signal reference price and assumed fill are DISTINCT fields', () => {
  const r = C.makeOmegaObservation(good());
  assert.strictEqual(r.signalReferencePrice, 100);
  assert.strictEqual(r.assumedFillPrice, 100.6);
  assert.notStrictEqual(r.signalReferencePrice, r.assumedFillPrice);
});

test('only prospective_live / paper_trade contribute to the live track', () => {
  assert.strictEqual(C.contributesToLiveTrack(C.PROVENANCE.PROSPECTIVE_LIVE), true);
  assert.strictEqual(C.contributesToLiveTrack(C.PROVENANCE.PAPER_TRADE), true);
  assert.strictEqual(C.contributesToLiveTrack(C.PROVENANCE.HISTORICAL_RECONSTRUCTION), false);
  assert.strictEqual(C.contributesToLiveTrack(C.PROVENANCE.MIGRATED_LEGACY), false);
});

test('observationId is deterministic', () => {
  const a = C.observationId({ provenance: 'prospective_live', strategyVersion: 'v2', signalDate: '2025-03-01', ticker: 'AAA', episodeId: 'OMEGA_PRIME' });
  const b = C.observationId({ provenance: 'prospective_live', strategyVersion: 'v2', signalDate: '2025-03-01', ticker: 'AAA', episodeId: 'OMEGA_PRIME' });
  assert.strictEqual(a, b);
});
