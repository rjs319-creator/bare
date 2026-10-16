'use strict';
// Review Prompt 5.3 (lib/evolve-labels): the benchmark leg must cover the SAME interval the
// label actually ran — a day-1 barrier exit is compared with SPY to day 1, aligned by DATE,
// never with SPY to the end of the window by array position. A missing benchmark bar on the
// entry or exit date is "unavailable" with a reason. Gap-through barriers fill at the open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/evolve-labels');

const mk = (d, o, h, l, c) => ({ date: d, open: o, high: h, low: l, close: c });
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13'];
const flat = (dates, px) => dates.map(d => mk(d, px, px, px, px));
// Stock: +8% on day 1 (upper barrier of `fast` = +8%), then flat.
const STOCK = [mk(D[0], 100, 100, 100, 100), mk(D[1], 100, 109, 100, 108), ...flat(D.slice(2), 108)];
// SPY: flat on day 1, then +10% by day 5.
const SPY = [mk(D[0], 100, 100, 100, 100), mk(D[1], 100, 100, 100, 100), mk(D[2], 100, 102, 100, 102), mk(D[3], 102, 105, 102, 105), mk(D[4], 105, 108, 105, 108), mk(D[5], 108, 110, 108, 110), mk(D[6], 110, 110, 110, 110)];

test('early +8% exit with flat SPY to the exit is +8% matched excess, although SPY is +10% later', () => {
  const r = L.labelEvent({ entry: 100, candles: STOCK, predDate: D[0], horizon: 'fast', spyCandles: SPY });
  assert.equal(r.barrier, 'upper');
  assert.equal(r.barsToBarrier, 1);
  assert.equal(r.labelEndDate, D[1]);
  assert.equal(r.spyReturn, 0);                 // SPY over D[1] only — not 0.10 over the full window
  assert.equal(r.spyRelReturn, 0.08);
  assert.equal(r.benchmarkReason, null);
  assert.equal(r.benchmarkStartDate, D[1]);
  assert.equal(r.benchmarkEndDate, D[1]);
  assert.equal(r.version, 'evolve-labels-v2');
});

test('a time-exit label still benchmarks over the full window, by date', () => {
  const stock = [mk(D[0], 100, 100, 100, 100), ...flat(D.slice(1), 101)];
  const r = L.labelEvent({ entry: 100, candles: stock, predDate: D[0], horizon: 'fast', spyCandles: SPY });
  assert.equal(r.barrier, 'time');
  assert.equal(r.labelEndDate, D[5]);           // 5th forward bar
  assert.equal(r.spyReturn, 0.10);              // SPY open D[1] 100 → close D[5] 110
  assert.equal(r.spyRelReturn, +(0.01 - 0.10).toFixed(4));
});

test('a missing benchmark bar on the exit date makes the relative return UNAVAILABLE with a reason', () => {
  const spyMissingExit = SPY.filter(c => c.date !== D[1]);
  const r = L.labelEvent({ entry: 100, candles: STOCK, predDate: D[0], horizon: 'fast', spyCandles: spyMissingExit });
  assert.equal(r.barrier, 'upper', 'the stock label itself still resolves');
  assert.equal(r.spyReturn, null);
  assert.equal(r.spyRelReturn, null);
  assert.equal(r.benchmarkReason, 'missing-benchmark-date');
});

test('a missing benchmark bar on the ENTRY date is also unavailable; no benchmark at all says so', () => {
  const stock = [mk(D[0], 100, 100, 100, 100), ...flat(D.slice(1), 101)];
  const spyMissingEntry = SPY.filter(c => c.date !== D[1]);
  const r = L.labelEvent({ entry: 100, candles: stock, predDate: D[0], horizon: 'fast', spyCandles: spyMissingEntry });
  assert.equal(r.spyRelReturn, null);
  assert.equal(r.benchmarkReason, 'missing-benchmark-date');
  const none = L.labelEvent({ entry: 100, candles: stock, predDate: D[0], horizon: 'fast' });
  assert.equal(none.spyRelReturn, null);
  assert.equal(none.benchmarkReason, 'benchmark-unavailable');
});

test('matchedBenchmarkReturn is the dated primitive; benchmarkReturn keeps its fixed-window default', () => {
  const m = L.matchedBenchmarkReturn(SPY, { startDate: D[1], endDate: D[3] });
  assert.deepEqual(m, { ret: 0.05, reason: null, startDate: D[1], endDate: D[3] });   // open 100 → close 105
  assert.equal(L.matchedBenchmarkReturn(SPY, { startDate: D[1], endDate: '2026-02-01' }).reason, 'missing-benchmark-date');
  assert.equal(L.matchedBenchmarkReturn(null, { startDate: D[1], endDate: D[3] }).reason, 'benchmark-unavailable');
  // fixed-window callers (omega residualForward) are byte-identical: first forward open → nth close
  assert.equal(L.benchmarkReturn(L.sliceForward(SPY, D[0], 10), 5), 0.10);
});

test('gap-through LOWER barrier fills at the (worse) open, not the barrier price', () => {
  const stock = [mk(D[0], 100, 100, 100, 100), mk(D[1], 90, 91, 89, 90), ...flat(D.slice(2), 90)];
  const r = L.labelEvent({ entry: 100, candles: stock, predDate: D[0], horizon: 'fast', spyCandles: SPY });
  assert.equal(r.barrier, 'lower');
  assert.equal(r.exitPrice, 90);                // was 96 (the −4% barrier)
  assert.equal(r.terminalReturn, -0.10);
  assert.equal(r.gapThrough, true);
});

test('gap-through UPPER barrier fills at the (better) open; an in-bar touch fills at the barrier', () => {
  const gap = [mk(D[0], 100, 100, 100, 100), mk(D[1], 112, 113, 111, 112), ...flat(D.slice(2), 112)];
  const r = L.labelEvent({ entry: 100, candles: gap, predDate: D[0], horizon: 'fast' });
  assert.equal(r.exitPrice, 112);
  assert.equal(r.gapThrough, true);
  const touch = L.labelEvent({ entry: 100, candles: STOCK, predDate: D[0], horizon: 'fast' });
  assert.equal(touch.exitPrice, 108);           // +8% barrier touched from below
  assert.equal(touch.gapThrough, false);
});
