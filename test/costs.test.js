// Tests for the transaction-cost model (cost-v1): round-trip haircut, liquidity
// tiering, and net/net-excess conversion. Pure functions, no network.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  COST_MODEL_VERSION, roundTripCostPct, tierForPick, netReturn, netExcess,
} = require('../lib/costs');

test('round-trip cost is charged on both sides and rises with illiquidity', () => {
  // liquid = 2×(3+5)bps = 16bps = 0.16%; small = 2×(15+15) = 0.60%;
  // micro = 2×(40+35) = 1.50%; biotech = 2×(25+25) = 1.00%.
  assert.strictEqual(roundTripCostPct('liquid'), 0.16);
  assert.strictEqual(roundTripCostPct('small'), 0.6);
  assert.strictEqual(roundTripCostPct('micro'), 1.5);
  assert.strictEqual(roundTripCostPct('biotech'), 1.0);
  assert.ok(roundTripCostPct('micro') > roundTripCostPct('small'));
  assert.ok(roundTripCostPct('small') > roundTripCostPct('liquid'));
});

test('unknown tier falls back to the liquid cost', () => {
  assert.strictEqual(roundTripCostPct('nonsense'), roundTripCostPct('liquid'));
  assert.strictEqual(roundTripCostPct(undefined), roundTripCostPct('liquid'));
});

test('tierForPick reads liquidity from the ledger metadata', () => {
  assert.strictEqual(tierForPick({ scope: 'micro' }), 'micro');
  assert.strictEqual(tierForPick({ scope: 'Small' }), 'small'); // case-insensitive
  assert.strictEqual(tierForPick({ section: 'Biotech' }), 'biotech');
  assert.strictEqual(tierForPick({ bench: 'XBI' }), 'biotech');
  assert.strictEqual(tierForPick({ scope: 'large' }), 'liquid');
  assert.strictEqual(tierForPick({}), 'liquid');
  assert.strictEqual(tierForPick(null), 'liquid');
});

test('netReturn subtracts the round-trip cost as a positive drag', () => {
  assert.strictEqual(netReturn(2.0, 'liquid'), 1.84);   // 2.00 − 0.16
  assert.strictEqual(netReturn(2.0, 'micro'), 0.5);     // 2.00 − 1.50
  // Works on shorts too: gross is already sign-flipped upstream, cost still drags.
  assert.strictEqual(netReturn(-1.0, 'liquid'), -1.16); // a loser gets worse
});

test('a thin edge can be flipped negative by costs (the whole point)', () => {
  const grossExcess = 0.8;                 // "beats the market by 0.8%" gross
  assert.ok(netExcess(grossExcess, 'micro') < 0); // 0.8 − 1.5 = −0.7 → net loser
  assert.ok(netExcess(grossExcess, 'liquid') > 0); // survives in liquid names
});

test('null / non-finite returns pass through as null', () => {
  assert.strictEqual(netReturn(null, 'liquid'), null);
  assert.strictEqual(netReturn(undefined, 'liquid'), null);
  assert.strictEqual(netReturn(NaN, 'liquid'), null);
  assert.strictEqual(netExcess(null, 'micro'), null);
});

test('cost model is versioned', () => {
  assert.strictEqual(COST_MODEL_VERSION, 'cost-v1');
});
