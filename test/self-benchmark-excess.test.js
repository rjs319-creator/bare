'use strict';
// F-14: THE EXPECTATION-GAP CHALLENGER WAS GRADED SPY-VS-SPY.
//
// lib/expgap-routes.js logs, on every RISK_REDUCE day, exactly one row:
//
//     { ticker: 'SPY', section: 'ExpGap', tier: 'RISK_REDUCE', short: true }
//
// The Scoreboard then grades every row against SPY. The pick leg is
// direction-adjusted (`if (pick.short) ret = -ret`) but the BENCHMARK leg is
// not, so for this row:
//
//     exc = (-spyReturn) - (+spyReturn) = -2 x spyReturn
//
// A number that moves, carries a sign, and reads like alpha — while being a
// deterministic restatement of the benchmark's own return. It cannot express
// skill: no forecast, no threshold, no state of the world changes it.
//
// The long case is degenerate in the opposite direction: exc = 0 identically,
// a fabricated "exactly matched the market" record on every horizon.
//
// The fix refuses to publish either. A pick whose INSTRUMENT is the benchmark
// has no benchmark-relative channel, so the channel is null and counted --
// mirroring how a missing sector history is counted (`benchFallback`) rather
// than silently substituted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSelfBenchmarked, excessOrNull, MARKET_BENCH_SYMBOL } = require('../lib/apex-routes');

// ── the predicate ──────────────────────────────────────────────────────────
test('a pick whose ticker IS the benchmark is self-benchmarked', () => {
  assert.equal(isSelfBenchmarked('SPY', 'SPY'), true);
});

test('self-benchmark detection is case- and whitespace-insensitive', () => {
  // Ledger rows are written by many call sites; casing is not guaranteed.
  assert.equal(isSelfBenchmarked('spy', 'SPY'), true);
  assert.equal(isSelfBenchmarked(' SPY ', 'spy'), true);
});

test('a normal pick graded against the market is not self-benchmarked', () => {
  assert.equal(isSelfBenchmarked('AAPL', 'SPY'), false);
});

test('a sector ETF graded against its own sector ETF is self-benchmarked', () => {
  // Not ExpGap-specific: any section that logs the ETF it benchmarks against
  // hits the identical degeneracy.
  assert.equal(isSelfBenchmarked('XLK', 'XLK'), true);
});

test('missing symbols never count as self-benchmarked', () => {
  // Fail OPEN here on purpose: an unknown symbol must not silently null a
  // legitimate excess. Only a positive identity match suppresses the channel.
  assert.equal(isSelfBenchmarked(null, 'SPY'), false);
  assert.equal(isSelfBenchmarked('SPY', null), false);
  assert.equal(isSelfBenchmarked('', ''), false);
});

test('the market benchmark symbol is SPY', () => {
  assert.equal(MARKET_BENCH_SYMBOL, 'SPY');
});

// ── the channel ────────────────────────────────────────────────────────────
test('a SHORT row on the benchmark itself yields no excess, not -2x the market', () => {
  // The ExpGap shape: SPY rose 5%, the short-framed row's own return is -5%.
  // The old arithmetic published -10 as "excess".
  const ret = -5, benchRet = 5;
  assert.equal(+(ret - benchRet).toFixed(2), -10);          // what it used to publish
  assert.equal(excessOrNull(ret, benchRet, true), null);    // what it publishes now
});

test('a LONG row on the benchmark itself yields no excess, not a fabricated 0', () => {
  assert.equal(excessOrNull(5, 5, true), null);
});

test('a normal pick keeps its excess untouched', () => {
  assert.equal(excessOrNull(3, 1, false), 2);
  assert.equal(excessOrNull(-2, 1.5, false), -3.5);
});

test('excess still fails closed on a missing benchmark or unresolved return', () => {
  assert.equal(excessOrNull(3, null, false), null);
  assert.equal(excessOrNull(null, 1, false), null);
  assert.equal(excessOrNull(NaN, 1, false), null);
});

test('excess is rounded to 2dp like every other graded channel', () => {
  // NB 1.005 is NOT usable here: it is not exactly representable, so toFixed(2)
  // gives "1.00". That is pre-existing repo-wide rounding behaviour, unchanged.
  assert.equal(excessOrNull(1.006, 0, false), 1.01);
  assert.equal(excessOrNull(3.14159, 0, false), 3.14);
});

// ── wiring ─────────────────────────────────────────────────────────────────
// The arithmetic above is only worth anything if the Scoreboard actually routes
// its three benchmark channels through it. Pin that, so a future edit cannot
// reintroduce a raw subtraction (the repo already pins the summarize side the
// same way in graduation-league.test.js).
test('the Scoreboard computes exc, mktExc and secExc through the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
  assert.match(src, /r\.exc = excessOrNull\(/);
  assert.match(src, /r\.mktExc = excessOrNull\(/);
  assert.match(src, /r\.secExc = excessOrNull\(/);
});

test('ExpGap still logs a short-framed SPY row — the reason the guard exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'expgap-routes.js'), 'utf8');
  assert.match(src, /ticker: 'SPY'/);
  assert.match(src, /short: true/);
});
