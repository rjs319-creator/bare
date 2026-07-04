'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDecayCurves } = require('../lib/cern-decay');
const { forwardReturn, spyForwardReturn } = require('../lib/apex-routes');

const FNS = { forwardReturn, spyForwardReturn };
// SPY held flat, so excess == the pick's own return (keeps the arithmetic obvious).
const SPY_FLAT = [
  { date: '2026-01-01', close: 100 },
  { date: '2026-01-02', close: 100 },
  { date: '2026-01-03', close: 100 },
  { date: '2026-01-04', close: 100 },
];

test('computeDecayCurves: builds a per-day excess curve and picks the peak as the hold window', () => {
  // AAA runs +10% by day 1, gives some back to +5% by day 2 → edge peaks at day 1.
  const hist = new Map([['AAA', [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 110 },
    { date: '2026-01-03', close: 105 },
  ]]]);
  const picks = [{ date: '2026-01-01', tier: 'INDEX_DELETE', ticker: 'AAA', entry: null, short: false }];
  const out = computeDecayCurves(picks, hist, SPY_FLAT, FNS, { maxDay: 2, minSample: 1, minTrust: 1 });
  const t = out.types.INDEX_DELETE;
  assert.equal(t.curve.length, 2);
  assert.equal(t.curve[0].avgExcess, 10); // day 1
  assert.equal(t.curve[1].avgExcess, 5);  // day 2
  assert.equal(t.recommendedHold, 1);     // edge peaks at day 1
  assert.equal(t.peakExcess, 10);
  assert.equal(t.trustworthy, true);      // n20 (=1) >= minTrust (=1)
  assert.equal(t.fades, false);
});

test('computeDecayCurves: a type that never beats the market has no hold window (fades)', () => {
  const hist = new Map([['BBB', [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 95 },   // -5%
    { date: '2026-01-03', close: 98 },   // -2%
  ]]]);
  const picks = [{ date: '2026-01-01', tier: 'LOCKUP_EXPIRY', ticker: 'BBB', entry: null, short: false }];
  const out = computeDecayCurves(picks, hist, SPY_FLAT, FNS, { maxDay: 2, minSample: 1, minTrust: 1 });
  const t = out.types.LOCKUP_EXPIRY;
  assert.equal(t.recommendedHold, null); // never positive
  assert.equal(t.fades, true);
  assert.equal(t.peakExcess, -2);        // best (least-bad) day still < 0
});

test('computeDecayCurves: small sample is flagged not-trustworthy with days-needed', () => {
  const hist = new Map([['CCC', [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 103 },
  ]]]);
  const picks = [{ date: '2026-01-01', tier: 'FIRE_SALE', ticker: 'CCC', entry: null, short: false }];
  const out = computeDecayCurves(picks, hist, SPY_FLAT, FNS, { maxDay: 1, minSample: 1, minTrust: 20 });
  const t = out.types.FIRE_SALE;
  assert.equal(t.trustworthy, false);
  assert.equal(t.daysNeeded, 19); // 20 required − 1 resolved
});

test('computeDecayCurves: days below the sample floor report null avgExcess and no window', () => {
  const hist = new Map([['DDD', [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 120 },
  ]]]);
  const picks = [{ date: '2026-01-01', tier: 'TAX_LOSS', ticker: 'DDD', entry: null, short: false }];
  // minSample 5 but only 1 pick → the day has n=1 < 5 → not eligible for the peak.
  const out = computeDecayCurves(picks, hist, SPY_FLAT, FNS, { maxDay: 1, minSample: 5, minTrust: 1 });
  const t = out.types.TAX_LOSS;
  assert.equal(t.curve[0].n, 1);
  assert.equal(t.recommendedHold, null); // no day cleared the sample floor
});

test('computeDecayCurves: an isolated positive day in a negative curve is NOT a window', () => {
  // Underwater from day 1, then one lucky spike at day 3 — must still read as "fades",
  // not "hold 3 days" (the LOCKUP_EXPIRY failure mode found on real data).
  const hist = new Map([['EEE', [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 98 },   // -2%
    { date: '2026-01-03', close: 97 },   // -3%
    { date: '2026-01-04', close: 104 },  // +4% lucky spike
  ]]]);
  const picks = [{ date: '2026-01-01', tier: 'LOCKUP_EXPIRY', ticker: 'EEE', entry: null, short: false }];
  const out = computeDecayCurves(picks, hist, SPY_FLAT, FNS, { maxDay: 3, minSample: 1, minTrust: 1 });
  const t = out.types.LOCKUP_EXPIRY;
  assert.equal(t.fades, true);           // negative from day 1
  assert.equal(t.recommendedHold, null); // the day-3 spike does not create a window
  assert.equal(t.peakExcess, 4);         // still reported for display
});

test('computeDecayCurves: no picks → empty types map', () => {
  const out = computeDecayCurves([], new Map(), SPY_FLAT, FNS);
  assert.deepEqual(out.types, {});
});
