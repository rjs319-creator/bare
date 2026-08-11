'use strict';
// CFL DUD GRADING — canonical resolveTrade contract + deterministic attribution.
const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/cfl/duds');

function tradingDates(n, start = '2025-06-02') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DATES = tradingDates(120);
function flat(px = 100) {
  return DATES.map(date => ({ date, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1e6 }));
}

test('a pick whose stop is gapped through immediately grades as a dud with a deterministic category', () => {
  const candles = flat(100).map((b, i) => i >= 61 ? { ...b, open: 88, high: 89, low: 85, close: 86 } : b);
  const r = D.gradePick({ pick: { ticker: 'X', date: DATES[60], entry: 100, stop: 92, target: 120, section: 'screener' }, candles });
  assert.strictEqual(r.status, 'dud');
  assert.ok(r.attribution && r.attribution.primaryFailure, 'dud carries an attribution');
});

test('a pick that hits target grades success and gets NO dud attribution', () => {
  const candles = flat(100).map((b, i) => i >= 63 ? { ...b, high: 130, close: 125, low: 99 } : b);
  const r = D.gradePick({ pick: { ticker: 'W', date: DATES[60], entry: 100, stop: 92, target: 120, section: 'screener' }, candles });
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.attribution, null);
});

test('missing candles grade ungradable with DATA_FAILURE — never silently dropped', () => {
  const r = D.gradePick({ pick: { ticker: 'GONE', date: DATES[60], entry: 100, stop: 92, target: 120 }, candles: null });
  assert.strictEqual(r.status, 'ungradable');
  assert.strictEqual(r.attribution.primaryFailure, 'DATA_FAILURE');
});

test('a still-open pick is unresolved — never counted as a dud or a success', () => {
  const r = D.gradePick({ pick: { ticker: 'OPEN', date: DATES[115], entry: 100, stop: 92, target: 120 }, candles: flat(100) });
  assert.strictEqual(r.status, 'unresolved');
});

test('gradeDuds dedups on first appearance per (section,ticker) — the Scoreboard convention', () => {
  const candles = flat(100);
  const picks = [
    { ticker: 'A', date: DATES[10], entry: 100, stop: 92, target: 120, section: 'screener' },
    { ticker: 'A', date: DATES[30], entry: 100, stop: 92, target: 120, section: 'screener' },   // dup — skipped
    { ticker: 'A', date: DATES[30], entry: 100, stop: 92, target: 120, section: 'momentum' },   // different section — kept
  ];
  const r = D.gradeDuds({ picks, histOf: () => candles });
  assert.strictEqual(r.graded, 2);
});

test('gradeDuds respects the deadline and reports truncation', () => {
  let t = 0;
  const picks = Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, date: DATES[10], entry: 100, stop: 92, target: 120, section: 'screener' }));
  const r = D.gradeDuds({ picks, histOf: () => flat(100), deadline: 5, now: () => (t += 3) });
  assert.strictEqual(r.truncated, true);
  assert.ok(r.graded < 10);
});
