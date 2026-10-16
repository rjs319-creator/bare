'use strict';
// Review Prompt 5 (api/backtest.js): outcomes follow ONE documented fill policy — the same one
// lib/outcome.js resolveTrade and lib/paper-portfolio resolveExit already use — immature
// trades stay OPEN instead of being closed by the end of history, and a missing benchmark
// date is "unavailable", never silently the raw return.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BT = require('../api/backtest');
const { perSideSlippagePct } = require('../lib/execution-policy');
const { resolveTrade } = require('../lib/outcome');

const mk = (d, o, h, l, c) => ({ date: d, open: o, high: h, low: l, close: c, volume: 1e6 });
const run = (c, atr = 2) => BT.simAtrTrade(c, c.map(x => x.close), c.map(x => x.high), c.map(x => x.low), atr, 0, 'liquid');
const SLIP = perSideSlippagePct('liquid');   // 0.0008 under exec-v1
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('gap-through STOP fills at the (worse) open, not at the stop price', () => {
  // signal 01-05 → fill 01-06 open 100 (+slip) → entry 100.08, stop 97.08; 01-07 opens at 90.
  const c = [mk('2026-01-05', 100, 101, 99, 100), mk('2026-01-06', 100, 101, 99.5, 100.5), mk('2026-01-07', 90, 91, 89, 90), mk('2026-01-08', 90, 91, 89, 90)];
  const t = run(c);
  near(t.entry, 100.08, 'entry');
  near(t.stop, 97.08, 'stop');
  near(t.r, (90 - 100.08) / 100.08 - SLIP, 'r realises the open, less the exit leg');   // −0.10152, not −0.03078
  assert.equal(t.gapThrough, true);
  assert.equal(t.exitDate, '2026-01-07');
  assert.equal(t.won, false);
});

test('gap-through TARGET fills at the (better) open, mirroring the stop policy', () => {
  const c = [mk('2026-01-05', 100, 101, 99, 100), mk('2026-01-06', 100, 101, 99.5, 100.5), mk('2026-01-07', 110, 112, 109, 111), mk('2026-01-08', 111, 112, 110, 111)];
  const t = run(c);
  near(t.target, 106.08, 'target');
  near(t.r, (110 - 100.08) / 100.08 - SLIP, 'r realises the open');
  assert.equal(t.gapThrough, true);
  assert.equal(t.won, true);
});

test('a bar that touches BOTH barriers resolves to the stop (conservative, documented)', () => {
  const c = [mk('2026-01-05', 100, 101, 99, 100), mk('2026-01-06', 100, 107, 96.5, 100.5), mk('2026-01-07', 100, 101, 99, 100)];
  const t = run(c);
  near(t.r, (97.08 - 100.08) / 100.08 - SLIP, 'stop first');
  assert.equal(t.exitDate, '2026-01-06');
  assert.equal(t.gapThrough, false);
});

test('an immature trade (history ends before a barrier or the time-stop) is OPEN, not a closed win', () => {
  const c = [mk('2026-01-05', 100, 101, 99, 100), mk('2026-01-06', 100, 101, 99.5, 100.5)];
  const t = run(c);
  assert.equal(t.open, true);
  assert.equal(t.r, undefined, 'no realised return');
  assert.equal(t.won, undefined);
  assert.equal(t.markDate, '2026-01-06');
  near(t.markR, (100.5 - 100.08) / 100.08, 'unrealised mark at the last close, no exit leg charged');
});

test('flat prices lose exactly the configured costs (entry slippage + exit leg)', () => {
  const c = [];
  for (let i = 0; i < BT.MAX_HOLD + 2; i++) c.push(mk(`2026-02-${String(i + 1).padStart(2, '0')}`, 100, 100, 100, 100));
  const t = run(c, 1);
  assert.equal(t.open, undefined);
  assert.equal(t.hold, BT.MAX_HOLD);
  // entry = 100·(1+slip); exit at 100 → (1/(1+slip) − 1) − slip
  near(t.r, 1 / (1 + SLIP) - 1 - SLIP, 'flat path loses only costs');
  assert.ok(t.r < 0 && t.r > -2.1 * SLIP);
});

test('benchmarkExcess: matched to the fill→exit dates; a missing date is unavailable, not the raw return', () => {
  const spy = { '2026-01-06': { close: 400 }, '2026-01-09': { close: 404 } };
  const ok = BT.benchmarkExcess(0.05, spy, '2026-01-06', '2026-01-09');
  near(ok.excess, 0.05 - 0.01, 'excess vs matched SPY move');
  assert.equal(ok.reason, null);
  const missing = BT.benchmarkExcess(0.05, spy, '2026-01-06', '2026-01-08');
  assert.equal(missing.excess, null);
  assert.equal(missing.reason, 'missing-benchmark-date');
  assert.deepEqual(BT.benchmarkExcess(0.05, null, '2026-01-06', '2026-01-09'), { excess: null, reason: 'benchmark-unavailable' });
});

test('agg: rows without a benchmark are excluded from alpha and COUNTED, not averaged as raw return', () => {
  const rows = [
    { r: 0.10, excess: 0.08, won: true, hold: 3, date: '2026-01-05' },
    { r: -0.02, excess: null, won: false, hold: 5, date: '2026-01-06' },
  ];
  const a = BT.agg(rows);
  assert.equal(a.n, 2);
  assert.equal(a.avgAlpha, 8);            // mean over the ONE row with a benchmark
  assert.equal(a.alphaN, 1);
  assert.equal(a.benchmarkMissing, 1);
  assert.equal(a.avgReturn, 4);           // (10 − 2) / 2 — returns need no benchmark
});

test('version bump: results under the new fill policy are stamped and declared non-comparable', () => {
  assert.equal(BT.BACKTEST_VERSION, 'backtest-exec-v3');
  assert.match(BT.FILL_POLICY_NOTE, /gap/i);
  assert.match(BT.FILL_POLICY_NOTE, /not comparable/i);
});

// ── Prompt 5 cross-checks on the shared outcome engine (lib/outcome.js) ───────────────
test('long +10% and a short on the SAME path carry opposite gross signs', () => {
  const path = [mk('2026-01-05', 100, 100, 100, 100), mk('2026-01-06', 103, 106, 102, 105), mk('2026-01-07', 108, 111, 107, 110)];
  const long = resolveTrade(path, '2026-01-05', 100, 95, 110, 10, false);
  const short = resolveTrade(path, '2026-01-05', 100, 110, 90, 10, true);
  assert.equal(long.outcome, 'WIN');
  assert.equal(short.outcome, 'LOSS');
  near(long.r, 0.10, 'long gross');
  near(short.r, -0.10, 'short gross');
});
