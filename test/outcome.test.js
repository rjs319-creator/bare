'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTrade } = require('../lib/outcome');

// Helper: build candles from [high, low, close] triples starting at a base date.
function candlesFrom(rows, start = '2026-01-01') {
  return rows.map((r, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    high: r[0], low: r[1], close: r[2],
  }));
}

test('resolveTrade long: target hit before stop is a WIN at the target R', () => {
  // entry 100, stop 95, target 110. Day 1 ranges up to 111 → target first.
  const c = candlesFrom([[100, 100, 100], [111, 99, 108]]);
  const r = resolveTrade(c, '2026-01-01', 100, 95, 110);
  assert.equal(r.outcome, 'WIN');
  assert.equal(+(r.r * 100).toFixed(1), 10); // (110−100)/100
});

test('resolveTrade long: stop hit first is a LOSS at the stop R', () => {
  const c = candlesFrom([[100, 100, 100], [102, 94, 96]]); // low 94 < stop 95
  const r = resolveTrade(c, '2026-01-01', 100, 95, 110);
  assert.equal(r.outcome, 'LOSS');
  assert.equal(+(r.r * 100).toFixed(1), -5); // (95−100)/100
});

test('resolveTrade long: same-bar target AND stop resolves to the STOP (conservative)', () => {
  const c = candlesFrom([[100, 100, 100], [111, 94, 100]]); // hits both 111≥target and 94≤stop
  const r = resolveTrade(c, '2026-01-01', 100, 95, 110);
  assert.equal(r.outcome, 'LOSS');
});

test('resolveTrade short: price falls to target first is a WIN', () => {
  // short entry 100, stop 105 (above), target 90 (below). Day 1 low 89 → target first.
  const c = candlesFrom([[100, 100, 100], [101, 89, 92]]);
  const r = resolveTrade(c, '2026-01-01', 100, 105, 90, 63, true);
  assert.equal(r.outcome, 'WIN');
  assert.equal(+(r.r * 100).toFixed(1), 10); // (100−90)/100 — profit when it fell
});

test('resolveTrade short: price rises to stop first is a LOSS', () => {
  const c = candlesFrom([[100, 100, 100], [106, 99, 104]]); // high 106 ≥ stop 105
  const r = resolveTrade(c, '2026-01-01', 100, 105, 90, 63, true);
  assert.equal(r.outcome, 'LOSS');
  assert.equal(+(r.r * 100).toFixed(1), -5); // (100−105)/100
});

test('resolveTrade short: same-bar stop AND target resolves to the STOP (conservative)', () => {
  const c = candlesFrom([[100, 100, 100], [106, 89, 100]]);
  const r = resolveTrade(c, '2026-01-01', 100, 105, 90, 63, true);
  assert.equal(r.outcome, 'LOSS');
});

test('resolveTrade: neither level within maxHold → EXPIRED at the final close', () => {
  const c = candlesFrom([[100, 100, 100], [101, 99, 100.5], [101, 99, 101]]);
  const r = resolveTrade(c, '2026-01-01', 100, 95, 110, 2); // maxHold 2, no level hit
  assert.equal(r.outcome, 'EXPIRED');
  assert.equal(+(r.r * 100).toFixed(1), 1); // (101−100)/100 close of bar idx+2
});

test('resolveTrade: too little history → OPEN', () => {
  const c = candlesFrom([[100, 100, 100], [101, 99, 100.5]]);
  const r = resolveTrade(c, '2026-01-01', 100, 95, 110, 5); // only 1 bar after entry
  assert.equal(r.outcome, 'OPEN');
});

test('resolveTrade long path is unchanged when short defaults to false', () => {
  const c = candlesFrom([[100, 100, 100], [111, 99, 108]]);
  const withDefault = resolveTrade(c, '2026-01-01', 100, 95, 110);
  const explicitLong = resolveTrade(c, '2026-01-01', 100, 95, 110, 63, false);
  assert.deepEqual(withDefault, explicitLong);
});
