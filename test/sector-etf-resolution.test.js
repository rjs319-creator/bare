// Regression: sector → ETF resolution must survive the casing/alias variants the
// live path actually sees. Two real defects anchored here:
//   1. lib/atlasx-routes.js lowercased the probe against a TitleCase map, so every
//      sector resolved to null and sector residualization was silently dead.
//   2. lib/premove-inventory.js read assessment.lifecycle, but supervisor episodes
//      carry lifecycleState — every real episode collapsed to PRIMED/ARMED.
const test = require('node:test');
const assert = require('node:assert');

const { benchFor } = require('../lib/readthrough');
const { premoveState, STATES } = require('../lib/premove-inventory');
const { LIFECYCLE } = require('../lib/swing-lifecycle');

test('benchFor resolves canonical GICS TitleCase names', () => {
  assert.equal(benchFor('Technology'), 'XLK');
  assert.equal(benchFor('Health Care'), 'XLV');
  assert.equal(benchFor('Communication Services'), 'XLC');
});

test('benchFor resolves provider aliases (FMP/Yahoo spellings)', () => {
  assert.equal(benchFor('Healthcare'), 'XLV');
  assert.equal(benchFor('Financial Services'), 'XLF');
  assert.equal(benchFor('Information Technology'), 'XLK');
  assert.equal(benchFor('Consumer Cyclical'), 'XLY');
  assert.equal(benchFor('Basic Materials'), 'XLB');
});

test('benchFor is case-insensitive — THE atlasx-routes regression', () => {
  // The live path lowercased before lookup; that must now still resolve.
  assert.equal(benchFor('technology'), 'XLK');
  assert.equal(benchFor(' health care '), 'XLV');
});

test('benchFor never fabricates a sector ETF', () => {
  assert.equal(benchFor('Cryptocurrencies'), null);
  assert.equal(benchFor(''), null);
  assert.equal(benchFor(null), null);
  assert.equal(benchFor(undefined), null);
});

test('premoveState reads lifecycleState from REAL supervisor assessments', () => {
  // Real episodes carry lifecycleState (swing-episode makeAssessment), not lifecycle.
  const ep = (lifecycleState) => ({ assessment: { lifecycleState } });
  assert.equal(premoveState(ep(LIFECYCLE.TARGET_HIT)), STATES.COMPLETED);
  assert.equal(premoveState(ep(LIFECYCLE.INVALIDATED)), STATES.INVALIDATED);
  assert.equal(premoveState(ep(LIFECYCLE.WEAKENING)), STATES.WEAKENING);
  assert.equal(premoveState(ep(LIFECYCLE.ENTERABLE)), STATES.ARMED);
  assert.equal(premoveState(ep(LIFECYCLE.EXPIRED)), STATES.EXPIRED);
});

test('premoveState still accepts the loose lifecycle key for older callers', () => {
  assert.equal(premoveState({ assessment: { lifecycle: LIFECYCLE.TARGET_HIT } }), STATES.COMPLETED);
});
