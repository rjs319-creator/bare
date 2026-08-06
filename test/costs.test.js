// Tests for the transaction-cost model (cost-v1): round-trip haircut, liquidity
// tiering, and net/net-excess conversion. Pure functions, no network.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  COST_MODEL_VERSION, BORROW_MODEL_VERSION, roundTripCostPct, tierForPick,
  netReturn, netExcess, borrowCostPct, BORROW_APR,
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

// ── SHORT-BORROW model (borrow-v1) ───────────────────────────────────────────
// Shorting is not free: a stock-loan fee accrues per session held, and it is
// worst exactly where the app's short sleeves live (hard-to-borrow small/micro).

test('borrow fee accrues per session held and rises with illiquidity', () => {
  // micro 30%/yr over 21 sessions = 30 × 21/252 = 2.5%.
  assert.strictEqual(borrowCostPct('micro', 21), 2.5);
  // small 8%/yr over 63 sessions = 8 × 63/252 = 2.0%.
  assert.strictEqual(borrowCostPct('small', 63), 2.0);
  // liquid is cheap to borrow: 0.5%/yr over 21 sessions ≈ 0.042%.
  assert.strictEqual(borrowCostPct('liquid', 21), 0.042);
  assert.ok(borrowCostPct('micro', 21) > borrowCostPct('small', 21));
  assert.ok(borrowCostPct('small', 21) > borrowCostPct('liquid', 21));
});

test('borrow fee is zero for a non-positive or non-finite hold', () => {
  assert.strictEqual(borrowCostPct('micro', 0), 0);
  assert.strictEqual(borrowCostPct('micro', -5), 0);
  assert.strictEqual(borrowCostPct('micro', NaN), 0);
  assert.strictEqual(borrowCostPct('micro', undefined), 0);
});

test('unknown borrow tier falls back to the liquid rate', () => {
  assert.strictEqual(borrowCostPct('nonsense', 21), borrowCostPct('liquid', 21));
});

test('netReturn is unchanged for longs (borrow only bites shorts)', () => {
  // No opts → identical to the pre-borrow behaviour (backward compatible).
  assert.strictEqual(netReturn(2.0, 'micro'), 0.5);              // 2.00 − 1.50
  // Explicitly long → still no borrow charged.
  assert.strictEqual(netReturn(2.0, 'micro', { short: false, holdSessions: 21 }), 0.5);
});

test('netReturn charges borrow on shorts over the holding period', () => {
  // micro short held 21 sessions: 2.00 gross − 1.50 round-trip − 2.50 borrow = −2.00.
  assert.strictEqual(netReturn(2.0, 'micro', { short: true, holdSessions: 21 }), -2.0);
  // A short that looked profitable gross can be flipped negative by borrow alone.
  assert.ok(netReturn(2.0, 'micro', { short: true, holdSessions: 21 }) <
            netReturn(2.0, 'micro', { short: false, holdSessions: 21 }));
  // netExcess honours the same opts.
  assert.strictEqual(netExcess(1.0, 'small', { short: true, holdSessions: 63 }),
                     +(1.0 - roundTripCostPct('small') - 2.0).toFixed(2));
});

test('borrow model is versioned and rates are ordered by borrow difficulty', () => {
  assert.strictEqual(BORROW_MODEL_VERSION, 'borrow-v1');
  assert.ok(BORROW_APR.micro > BORROW_APR.biotech);
  assert.ok(BORROW_APR.biotech > BORROW_APR.small);
  assert.ok(BORROW_APR.small > BORROW_APR.liquid);
});
