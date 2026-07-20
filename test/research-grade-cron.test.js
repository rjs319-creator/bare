'use strict';
// CRON WIRING for op=researchgrade.
//
// The failure this guards against is the one lib/warm-chains.js was rebuilt to fix:
// work that is declared but never actually runs, while health reports green. A chain
// that is neither a root nor reachable via `@` silently never executes, and a budget
// that is larger than its parent's gets killed before it can record anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const WC = require('../lib/warm-chains');
const RG = require('../lib/research-grade-routes');

// THE REGRESSION: fetchDailyHistory returns { candles, meta, ... }, not a bare array. If the
// route hands that wrapper to the grader, Array.isArray(candles) is false and EVERY prediction
// pends as `no-candles` forever — grading that silently never grades, invisible because
// cold-start pending looks identical. candlesOf must unwrap it.
test('candlesOf unwraps fetchDailyHistory({candles}) to the bare array the grader needs', () => {
  const arr = [{ date: '2026-01-05', open: 1, high: 1, low: 1, close: 1 }];
  assert.equal(RG.candlesOf({ candles: arr, meta: {}, adjustment: {} }), arr, 'must extract .candles');
  assert.equal(RG.candlesOf(arr), arr, 'a bare array passes through');
  assert.equal(RG.candlesOf(null), null);
  assert.equal(RG.candlesOf({ candles: null }), null, 'a wrapper with no candle array → null, not the object');
  assert.equal(RG.candlesOf({ nope: 1 }), null);
});

test('researchgrade is registered as a chain and actually dispatched', () => {
  assert.ok(WC.CHAINS.researchgrade, 'chain must exist');
  assert.ok(WC.CHAINS.researchgrade.length, 'chain must not be empty');
  assert.ok(WC.ROOT_CHAINS.includes('researchgrade'),
    'a chain that is neither root nor nested silently never runs — the exact bug warm-chains exists to prevent');
});

test('researchgrade is NOT also nested (it would run twice)', () => {
  const nested = new Set();
  for (const steps of Object.values(WC.CHAINS)) {
    for (const s of steps) if (s.startsWith('@')) nested.add(s.slice(1));
  }
  assert.equal(nested.has('researchgrade'), false);
});

test('THE BUDGET INVARIANT: the route stops before its parent chain does', () => {
  // If the route's deadline exceeded the chain's, the chain would abandon it mid-run
  // and no outcomes would be written at all — losing even days already graded.
  assert.ok(RG.RUN_DEADLINE_MS < WC.CHAIN_DEADLINE_MS,
    `route deadline ${RG.RUN_DEADLINE_MS}ms must be under chain deadline ${WC.CHAIN_DEADLINE_MS}ms`);
  // And both must clear the 60s function wall with headroom.
  assert.ok(WC.CHAIN_DEADLINE_MS < 60000);
});

test('grading rides its own invocation, not the decision chain', () => {
  // Grading refetches candles for up to MAX_DAYS_PER_RUN x MAX_TICKERS names. Putting
  // that behind op=today&log=1 would starve the re-prime — the same starvation the
  // `decision` chain was split to avoid.
  assert.equal(WC.CHAINS.decision.includes('op=researchgrade'), false);
  assert.equal(WC.CHAINS.reprime.includes('op=researchgrade'), false);
  assert.deepEqual(WC.CHAINS.researchgrade, ['op=researchgrade']);
});

test('per-run work stays bounded', () => {
  assert.ok(RG.MAX_DAYS_PER_RUN > 0 && RG.MAX_DAYS_PER_RUN <= 5);
  assert.ok(RG.MAX_TICKERS > 0 && RG.MAX_TICKERS <= 300);
});

test('the chain step resolves to the real tracker op', () => {
  assert.equal(WC.pathFor('op=researchgrade'), '/api/tracker?op=researchgrade');
});
