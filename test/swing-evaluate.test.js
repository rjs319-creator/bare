'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EV = require('../lib/swing-evaluate');
const { makeOrigin } = require('../lib/swing-episode');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

function longOrigin(extra = {}) {
  return makeOrigin({
    episodeId: 'e1', ticker: 'ABC', side: 'long', horizon: 'swing',
    firstDecisionDate: '2026-07-20', firstSuggestedPrice: 10,
    originalEntry: 10.5, originalStop: 9.5, originalTargets: [12], originalHoldingWindow: 10,
    ...extra,
  });
}

test('enter-now setup fills at the next session open (T+1), never the decision close', () => {
  const o = makeOrigin({ episodeId: 'e', ticker: 'ABC', side: 'long', firstDecisionDate: '2026-07-20', firstSuggestedPrice: 10, originalStop: 9, originalTargets: [12] });
  const candles = [bar('2026-07-20', 10, 10.1, 9.9, 10), bar('2026-07-21', 10.2, 10.4, 10.1, 10.3)];
  const f = EV.resolveFill(o, candles);
  assert.equal(f.status, 'filled'); assert.equal(f.fillDate, '2026-07-21'); assert.equal(f.fillPrice, 10.2);
});

test('breakout trigger fills the first bar that reaches the entry (test #6 setup)', () => {
  const candles = [bar('2026-07-20', 10, 10.1, 9.9, 10), bar('2026-07-21', 10.2, 10.6, 10.1, 10.5)];
  const f = EV.resolveFill(longOrigin(), candles);
  assert.equal(f.status, 'filled'); assert.equal(f.fillDate, '2026-07-21'); assert.equal(f.fillPrice, 10.5);
});

test('a gap open beyond the max-entry is a gap-skip NO-FILL, never a chase', () => {
  const o = longOrigin({ originalMaxEntry: 11 });
  const candles = [bar('2026-07-20', 10, 10.1, 9.9, 10), bar('2026-07-21', 11.5, 12, 11.4, 11.9)];
  const f = EV.resolveFill(o, candles);
  assert.equal(f.status, 'gap-skip'); assert.equal(f.reason, 'GAP_BEYOND_MAX_ENTRY');
});

test('a trigger never reached within the hold window is an unfilled NO-FILL (test #7)', () => {
  const o = longOrigin({ originalEntry: 20, originalHoldingWindow: 3 });
  const candles = [bar('2026-07-20', 10, 10.1, 9.9, 10), bar('2026-07-21', 10, 10.2, 9.8, 10), bar('2026-07-22', 10, 10.3, 9.9, 10.1), bar('2026-07-23', 10, 10.2, 9.9, 10)];
  const f = EV.resolveFill(o, candles);
  assert.equal(f.status, 'unfilled'); assert.equal(f.reason, 'TRIGGER_NOT_REACHED');
});

test('target hit after fill resolves the target barrier (test #6)', () => {
  const candles = [
    bar('2026-07-20', 10, 10.1, 9.9, 10),
    bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),  // fill 10.5
    bar('2026-07-22', 10.6, 12.2, 10.5, 12.1),  // high 12.2 ≥ target 12
  ];
  const m = EV.evaluate(longOrigin(), { candles, asOf: '2026-07-22' });
  assert.equal(m.fill.status, 'filled');
  assert.equal(m.barrier.barrier, 'target');
  assert.equal(m.barrier.hitPrice, 12);
});

test('stop breach after fill resolves the stop barrier (test #5)', () => {
  const candles = [
    bar('2026-07-20', 10, 10.1, 9.9, 10),
    bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),  // fill 10.5
    bar('2026-07-22', 10.4, 10.5, 9.4, 9.5),    // low 9.4 ≤ stop 9.5
  ];
  const m = EV.evaluate(longOrigin(), { candles, asOf: '2026-07-22' });
  assert.equal(m.barrier.barrier, 'stop');
});

test('both barriers in one bar resolves pessimistically to the stop (no inflation)', () => {
  const candles = [
    bar('2026-07-20', 10, 10.1, 9.9, 10),
    bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),
    bar('2026-07-22', 10.5, 12.5, 9.0, 11),     // hits BOTH target 12 and stop 9.5
  ];
  const m = EV.evaluate(longOrigin(), { candles, asOf: '2026-07-22' });
  assert.equal(m.barrier.barrier, 'stop');
});

test('time exit when neither barrier hits within the hold window', () => {
  const o = longOrigin({ originalHoldingWindow: 2 });
  const candles = [
    bar('2026-07-20', 10, 10.1, 9.9, 10),
    bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),  // fill
    bar('2026-07-22', 10.5, 10.9, 10.3, 10.7),  // held 1
    bar('2026-07-23', 10.7, 11.2, 10.5, 11.0),  // held 2 → time exit
  ];
  const m = EV.evaluate(o, { candles, asOf: '2026-07-23' });
  assert.equal(m.barrier.barrier, 'time');
  assert.equal(m.barrier.sessionsHeld, 2);
});

test('returns, excess vs SPY, MFE/MAE and consumed% compute from bars', () => {
  const candles = [
    bar('2026-07-20', 10, 10.1, 9.9, 10),
    bar('2026-07-21', 10.2, 10.6, 10.1, 10.5),
    bar('2026-07-22', 10.6, 11.4, 10.5, 11.0),  // no barrier (target 12, stop 9.5)
  ];
  const spy = [bar('2026-07-20', 100, 100, 100, 100), bar('2026-07-21', 100, 100, 100, 100), bar('2026-07-22', 101, 101, 101, 101)];
  const m = EV.evaluate(longOrigin(), { candles, spy, asOf: '2026-07-22' });
  assert.equal(m.currentPrice, 11.0);
  assert.ok(Math.abs(m.returnSinceSuggestion - 0.10) < 1e-9);   // 10 → 11
  assert.ok(m.excessVsSpy > 0.089 && m.excessVsSpy < 0.091);     // 10% vs SPY 1%
  assert.ok(m.mfeSinceSuggestion >= 0.14);                        // high 11.4 from 10
  assert.ok(m.consumedPct > 0 && m.consumedPct <= 1.5);           // some of the 10.5→12 move
});

test('a short episode signs returns and excursions in its own direction', () => {
  const o = makeOrigin({ episodeId: 's', ticker: 'XYZ', side: 'short', firstDecisionDate: '2026-07-20', firstSuggestedPrice: 20, originalStop: 21, originalTargets: [18] });
  const candles = [bar('2026-07-20', 20, 20.1, 19.9, 20), bar('2026-07-21', 19.8, 19.9, 19.4, 19.5)];
  const m = EV.evaluate(o, { candles, asOf: '2026-07-21' });
  assert.ok(m.returnSinceSuggestion > 0);   // price fell → a short is up
});

test('missing data yields nulls, not fabricated numbers', () => {
  const m = EV.evaluate(longOrigin(), { candles: [], asOf: '2026-07-22' });
  assert.equal(m.currentPrice, null);
  assert.equal(m.returnSinceSuggestion, null);
  assert.equal(m.ma20, null);
});
