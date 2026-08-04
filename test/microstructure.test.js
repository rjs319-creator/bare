'use strict';
// MICROSTRUCTURE ADAPTER — explicit missingness (null, never fabricated zeros), null
// provider default, unknown-provider fallback, and the backward-compatible schema seam.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MICROSTRUCTURE_FIELDS, NULL_PROVIDER, getProvider, microstructureFeaturesOf } = require('../lib/microstructure');
const schema = require('../lib/intraday-schema');

test('MICROSTRUCTURE_FIELDS is the pre-registered provider-neutral field list', () => {
  assert.deepEqual([...MICROSTRUCTURE_FIELDS], [
    'signedAggressorVolume', 'orderFlowImbalance', 'queueImbalance', 'quoteDepletion',
    'spreadBps', 'bidDepth', 'askDepth', 'tradeThroughRate', 'persistenceScore',
  ]);
});

// ── Provider registry ────────────────────────────────────────────────────────
test('getProvider: no env → null provider; unknown provider name falls back to null provider', () => {
  assert.equal(getProvider({}), NULL_PROVIDER);
  assert.equal(getProvider({ MICROSTRUCTURE_PROVIDER: 'polygon-l2' }), NULL_PROVIDER, 'unregistered name → missing data, never a crash or fake data');
  assert.equal(getProvider({ MICROSTRUCTURE_PROVIDER: '' }), NULL_PROVIDER);
});

test('null provider returns explicit unavailability, not empty-looking data', async () => {
  const out = await NULL_PROVIDER.fetchMicrostructure(['AAPL', 'TSLA']);
  assert.deepEqual(out, { provider: null, available: false, byTicker: {} });
});

// ── Feature assembly: every field present, null when unavailable ─────────────
test('microstructureFeaturesOf: every field is an own-property null when no provider — never 0', () => {
  // Act: null-provider shape (empty byTicker).
  const f = microstructureFeaturesOf({}, 'AAPL');

  // Assert
  for (const k of MICROSTRUCTURE_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, k), `${k} present as own property`);
    assert.equal(f[k], null, `${k} is null, not a fabricated zero`);
    assert.notEqual(f[k], 0, `${k} must never read as "flow was flat"`);
  }
  assert.equal(f.microAvailable, false);
  assert.equal(Object.keys(f).length, MICROSTRUCTURE_FIELDS.length + 1, 'fields + microAvailable, nothing else');
});

test('microstructureFeaturesOf: real values pass through and flip microAvailable', () => {
  const byTicker = { AAPL: { spreadBps: 4.2, bidDepth: 0, queueImbalance: NaN } };
  const f = microstructureFeaturesOf(byTicker, 'AAPL');
  assert.equal(f.spreadBps, 4.2);
  assert.equal(f.bidDepth, 0, 'a GENUINE zero from a provider is a real observation and survives');
  assert.equal(f.queueImbalance, null, 'non-finite provider junk → null, not propagated');
  assert.equal(f.signedAggressorVolume, null, 'unsupplied fields stay null');
  assert.equal(f.microAvailable, true);
});

test('microstructureFeaturesOf: a ticker the provider did not cover is fully missing', () => {
  const f = microstructureFeaturesOf({ AAPL: { spreadBps: 4.2 } }, 'TSLA');
  assert.equal(f.microAvailable, false);
  for (const k of MICROSTRUCTURE_FIELDS) assert.equal(f[k], null);
});

// ── Schema seam: backward-compatible, version contract untouched ─────────────
test('schema exports MICRO_FEATURES separately; DATASET_FEATURES and the version are unchanged', () => {
  assert.deepEqual([...schema.MICRO_FEATURES], [...MICROSTRUCTURE_FIELDS, 'microAvailable']);
  assert.equal(schema.FEATURE_SCHEMA_VERSION, 'intraday-features-v2', 'no silent version drift');
  for (const k of MICROSTRUCTURE_FIELDS) {
    assert.ok(!schema.DATASET_FEATURES.includes(k), `${k} joins DATASET_FEATURES only at the next version bump`);
    assert.ok(!schema.MODEL_FEATURES.includes(k), `${k} not silently added to the model design matrix`);
    assert.ok(schema.MICRO_FIELDS[k] && schema.MICRO_FIELDS[k].kind, `${k} documented with units in MICRO_FIELDS`);
  }
});

test('missingnessOf handles microstructure keys with no schema changes', () => {
  const f = microstructureFeaturesOf({}, 'AAPL');
  const miss = schema.missingnessOf(f, MICROSTRUCTURE_FIELDS);
  for (const k of MICROSTRUCTURE_FIELDS) assert.equal(miss[k], true, `${k} flagged missing`);
  const some = schema.missingnessOf(microstructureFeaturesOf({ A: { spreadBps: 3 } }, 'A'), MICROSTRUCTURE_FIELDS);
  assert.equal(some.spreadBps, false);
  assert.equal(some.bidDepth, true);
});
