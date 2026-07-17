'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EV = require('../lib/failure-model-eval');

// candle series helper: base + daily % deltas, with volume.
// Clean candles (tight highs/lows, no artificial wicks that would fake failed-breakouts).
// Dates run past day 31 lexicographically ('2026-01-40') — fine, detectIdx compares strings.
function series(startIdx, base, dailyPct, vol = 1e6) {
  let px = base; const out = [];
  for (let i = 0; i < dailyPct.length; i++) {
    const prev = px; px *= 1 + dailyPct[i] / 100;
    out.push({ date: '2026-01-' + String(startIdx + i).padStart(2, '0'),
      close: +px.toFixed(4), high: +Math.max(prev, px).toFixed(4), low: +Math.min(prev, px).toFixed(4), volume: vol });
  }
  return out;
}
// EXTENDED/parabolic history (high failure features) then a forward DROP → rejected & loses.
const parabolicThenDrop = series(1, 100, [...Array(40).fill(2), ...Array(25).fill(-1.5)]);
// CALM base then a forward RISE → approved & wins.
const calmThenRise = series(1, 100, [...Array(40).fill(0.1), ...Array(25).fill(1.2)]);

test('insufficient sample → honest insufficient verdict, no false claim', () => {
  const hist = new Map([['A', parabolicThenDrop]]);
  const out = EV.evaluateFailureModel([{ ticker: 'A', date: '2026-01-30', section: 'X', tier: 'T' }], hist);
  assert.equal(out.verdict, 'insufficient');
  assert.equal(out.promoted, false);
});

test('§5 acceptance: rejected names underperform approved ones OOS → predictive', () => {
  const hist = new Map(), picks = [];
  for (let i = 0; i < 25; i++) { hist.set('BAD' + i, parabolicThenDrop); picks.push({ ticker: 'BAD' + i, date: '2026-01-30', section: 'Ext', tier: 'T' }); }
  for (let i = 0; i < 25; i++) { hist.set('OK' + i, calmThenRise); picks.push({ ticker: 'OK' + i, date: '2026-01-30', section: 'Calm', tier: 'T' }); }
  const out = EV.evaluateFailureModel(picks, hist);
  assert.ok(out.coverage.evaluated >= 40);
  assert.ok(out.buckets.rejected.n >= 10 && out.buckets.approved.n >= 10, JSON.stringify(out.buckets));
  assert.equal(out.verdict, 'predictive');
  assert.ok(out.predictiveGap > 0, 'approved must out-return rejected');
});

test('§5 discipline: a predictive verdict on a SINGLE window is held in SHADOW (not promoted)', () => {
  const hist = new Map(), picks = [];
  for (let i = 0; i < 25; i++) { hist.set('BAD' + i, parabolicThenDrop); picks.push({ ticker: 'BAD' + i, date: '2026-01-30', section: 'Ext', tier: 'T' }); }
  for (let i = 0; i < 25; i++) { hist.set('OK' + i, calmThenRise); picks.push({ ticker: 'OK' + i, date: '2026-01-30', section: 'Calm', tier: 'T' }); }
  const out = EV.evaluateFailureModel(picks, hist);
  assert.equal(out.verdict, 'predictive');
  assert.equal(out.promoted, false, 'one regime window must not promote it out of shadow');
  assert.ok(out.promotionBlockedReason, 'and it says why it is held');
  assert.equal(out.coverage.distinctMonths, 1);
});

test('promotion gate mechanics: only clears when span + sample bars are met', () => {
  const hist = new Map(), picks = [];
  for (let i = 0; i < 25; i++) { hist.set('BAD' + i, parabolicThenDrop); picks.push({ ticker: 'BAD' + i, date: '2026-01-30', section: 'Ext', tier: 'T' }); }
  for (let i = 0; i < 25; i++) { hist.set('OK' + i, calmThenRise); picks.push({ ticker: 'OK' + i, date: '2026-01-30', section: 'Calm', tier: 'T' }); }
  // Relax the bar to a single window → the gate now clears, proving the mechanics work.
  const out = EV.evaluateFailureModel(picks, hist, { config: { PROMOTE_MIN_MONTHS: 1, PROMOTE_MIN_TOTAL: 40 } });
  assert.equal(out.verdict, 'predictive');
  assert.equal(out.promoted, true);
  assert.equal(out.promotionBlockedReason, null);
});

test('byMode reports a per-failure-mode loss rate (the historical analog)', () => {
  const hist = new Map(), picks = [];
  for (let i = 0; i < 30; i++) { hist.set('P' + i, parabolicThenDrop); picks.push({ ticker: 'P' + i, date: '2026-01-30', section: 'Ext', tier: 'T' }); }
  const out = EV.evaluateFailureModel(picks, hist);
  assert.ok(Array.isArray(out.byMode) && out.byMode.length >= 1);
  assert.ok(out.byMode.every(m => Number.isFinite(m.lossRate) && m.n > 0));
});

test('no-signal when the failure split does not separate outcomes', () => {
  // Every name identical & flat → both buckets (whichever form) have the same ~0 return.
  const flat = series(1, 100, [...Array(40).fill(0.05), ...Array(25).fill(0.0)]);
  const hist = new Map(), picks = [];
  for (let i = 0; i < 60; i++) { hist.set('F' + i, flat); picks.push({ ticker: 'F' + i, date: '2026-01-30', section: 'Flat', tier: 'T' }); }
  const out = EV.evaluateFailureModel(picks, hist);
  // flat names have ~no failure features → nearly all 'approved'; too few rejected → insufficient
  // OR no-signal. Either way it must NOT falsely claim predictive.
  assert.notEqual(out.verdict, 'predictive');
  assert.equal(out.promoted, false);
});

test('point-in-time: picks whose forward window has not elapsed are excluded', () => {
  const shortHist = series(1, 100, Array(30).fill(1)); // pick near the end → no 21-bar forward room
  const hist = new Map([['S', shortHist]]);
  const out = EV.evaluateFailureModel([{ ticker: 'S', date: '2026-01-29', section: 'X', tier: 'T' }], hist);
  assert.equal(out.coverage.evaluated, 0);
});
