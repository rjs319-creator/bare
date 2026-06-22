'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrediction, claimLabel, priceOnOrAfter, computeCalibration } = require('../lib/predict');

const mkCall = (confidence, correct) => ({ confidence, status: correct ? 'correct' : 'incorrect' });

// Build candles with explicit closes on sequential dates from 2026-01-01.
const cds = closes => closes.map((c, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: c }));
const D0 = '2026-01-01';

test('priceOnOrAfter finds the first index on or after a date', () => {
  const c = cds([10, 11, 12, 13]);
  assert.equal(priceOnOrAfter(c, D0), 0);
  assert.equal(priceOnOrAfter(c, '2026-01-03'), 2);
  assert.equal(priceOnOrAfter(c, '2030-01-01'), -1);
});

test('resolvePrediction: up call is correct when it clears the threshold', () => {
  const subj = cds([100, 100, 100, 100, 100, 105]);   // +5% at horizon 5
  const r = resolvePrediction({ date: D0, horizon: 5, direction: 'up', threshold: 3 }, subj, null);
  assert.equal(r.status, 'correct');
  assert.equal(r.actualPct, 5);
  assert.equal(r.exitDate, subj[5].date);
});

test('resolvePrediction: up call is incorrect below the threshold', () => {
  const subj = cds([100, 100, 100, 100, 100, 102]);   // +2% < 3%
  const r = resolvePrediction({ date: D0, horizon: 5, direction: 'up', threshold: 3 }, subj, null);
  assert.equal(r.status, 'incorrect');
});

test('resolvePrediction: down call is correct on a drop past -threshold', () => {
  const subj = cds([100, 100, 100, 100, 100, 95]);    // -5%
  const r = resolvePrediction({ date: D0, horizon: 5, direction: 'down', threshold: 3 }, subj, null);
  assert.equal(r.status, 'correct');
  assert.equal(r.actualPct, -5);
});

test('resolvePrediction: outperform grades excess vs SPY', () => {
  const subj = cds([100, 100, 100, 100, 100, 108]);   // +8%
  const spy = cds([100, 100, 100, 100, 100, 102]);    // +2%
  const r = resolvePrediction({ date: D0, horizon: 5, direction: 'outperform', threshold: 0 }, subj, spy);
  assert.equal(r.status, 'correct');
  assert.equal(r.excPct, 6);
});

test('resolvePrediction: underperform is incorrect when subject beats SPY', () => {
  const subj = cds([100, 100, 100, 100, 100, 108]);
  const spy = cds([100, 100, 100, 100, 100, 102]);
  const r = resolvePrediction({ date: D0, horizon: 5, direction: 'underperform', threshold: 0 }, subj, spy);
  assert.equal(r.status, 'incorrect');
});

test('resolvePrediction: returns null when not matured', () => {
  const subj = cds([100, 101, 102]);                  // only 3 bars, horizon 10
  assert.equal(resolvePrediction({ date: D0, horizon: 10, direction: 'up', threshold: 1 }, subj, null), null);
});

test('resolvePrediction: returns null with no candles', () => {
  assert.equal(resolvePrediction({ date: D0, horizon: 5, direction: 'up' }, [], null), null);
});

test('computeCalibration: empty input', () => {
  assert.deepEqual(computeCalibration([]), { n: 0 });
  assert.deepEqual(computeCalibration([{ status: 'correct' }]), { n: 0 });  // no confidence
});

test('computeCalibration: high-confidence misses → overconfident', () => {
  const calls = [mkCall(9, false), mkCall(9, true), mkCall(8, false), mkCall(8, false), mkCall(8, true),
    mkCall(7, true), mkCall(6, false), mkCall(6, true), mkCall(5, true), mkCall(4, false)];
  const c = computeCalibration(calls);
  assert.equal(c.verdict, 'overconfident');
  assert.equal(c.n, 10);
  const high = c.buckets.find(b => b.key === 'high');
  assert.ok(high.stated > high.actual);    // claims more than it delivers
  assert.ok(c.brier > 0 && c.brier < 1);
});

test('computeCalibration: stated ≈ actual → well-calibrated', () => {
  // ~70% stated, ~70% actual
  const calls = [mkCall(7, true), mkCall(7, true), mkCall(7, false), mkCall(7, true), mkCall(7, true),
    mkCall(7, true), mkCall(7, false), mkCall(7, true), mkCall(7, true), mkCall(7, false)];
  assert.equal(computeCalibration(calls).verdict, 'well-calibrated');
});

test('claimLabel formats each direction', () => {
  assert.equal(claimLabel({ subject: 'QQQ', direction: 'up', threshold: 3, horizon: 10 }), 'QQQ +3% in 10d');
  assert.equal(claimLabel({ subject: 'SPY', direction: 'down', threshold: 2, horizon: 5 }), 'SPY −2% in 5d');
  assert.equal(claimLabel({ subject: 'XLF', direction: 'outperform', horizon: 21 }), 'XLF beats SPY in 21d');
  assert.equal(claimLabel({ subject: 'XLE', direction: 'underperform', horizon: 10 }), 'XLE lags SPY in 10d');
});
