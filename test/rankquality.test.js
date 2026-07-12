'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RQ = require('../lib/rankquality');

// A clean predictive relationship: outcome tracks score (+noise). Higher score → better.
function predictive(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const score = (i * 97) % 100;                 // spread 0..99 deterministically
    const noise = ((i * 37) % 11) - 5;            // -5..5
    const outcome = (score - 50) * 0.2 + noise;   // monotone in score
    out.push({ score, outcome, won: outcome > 0 });
  }
  return out;
}
// Pure noise: outcome independent of score.
function noise(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ score: (i * 97) % 100, outcome: ((i * 31) % 21) - 10, won: (i % 2) === 0 });
  return out;
}

test('averageRanks: ties get the average rank', () => {
  assert.deepEqual(RQ.averageRanks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('informationCoefficient: strong positive relationship → high significant IC', () => {
  const r = RQ.informationCoefficient(RQ.quantileStats ? predictive(60) : []);
  assert.ok(r.ic > 0.5);
  assert.equal(r.significant, true);
});

test('informationCoefficient: monotone data → IC ~1', () => {
  const items = [1, 2, 3, 4, 5, 6].map(s => ({ score: s, outcome: s * 2, won: true }));
  const r = RQ.informationCoefficient(items);
  assert.ok(r.ic > 0.99);
});

test('quantileStats: highest bucket first, monotone avgOutcome for predictive data', () => {
  const b = RQ.quantileStats(predictive(50), 5);
  assert.equal(b[0].bucket, 5);                    // top bucket first
  assert.ok(b[0].avgOutcome > b[b.length - 1].avgOutcome);
});

test('analyzeRankQuality: predictive data → verdict "predictive", positive lift', () => {
  const r = RQ.analyzeRankQuality(predictive(80));
  assert.equal(r.ready, true);
  assert.equal(r.verdict, 'predictive');
  assert.ok(r.ic.ic > 0.3);
  assert.ok(r.topBottomSpread > 0);
  assert.ok(r.monotonicity.monotone);
  assert.ok(r.topKprecision >= r.baseWinRate);      // top-K beats the base rate
});

test('analyzeRankQuality: noise → verdict "noise", IC ~0', () => {
  const r = RQ.analyzeRankQuality(noise(80));
  assert.equal(r.ready, true);
  assert.ok(Math.abs(r.ic.ic) < 0.2);
  assert.ok(['noise', 'weak-positive'].includes(r.verdict));
});

test('analyzeRankQuality: inverted relationship → verdict "inverted"', () => {
  const items = predictive(80).map(x => ({ ...x, outcome: -x.outcome, won: -x.outcome > 0 }));
  const r = RQ.analyzeRankQuality(items);
  assert.equal(r.verdict, 'inverted');
  assert.ok(r.ic.ic < 0);
});

test('analyzeRankQuality: too few picks → not ready', () => {
  const r = RQ.analyzeRankQuality(predictive(10));
  assert.equal(r.ready, false);
  assert.ok(r.note.includes('Need'));
});

test('calibration: perfectly-calibrated scores → low Brier', () => {
  // score=90 wins 90% of the time, score=10 wins 10% — well calibrated.
  const items = [];
  for (let i = 0; i < 100; i++) items.push({ score: 90, outcome: 1, won: i < 90 });
  for (let i = 0; i < 100; i++) items.push({ score: 10, outcome: 1, won: i < 10 });
  const c = RQ.calibration(items);
  assert.ok(c.brier < 0.15);
  const hi = c.table.find(t => t.band.startsWith('80'));
  assert.ok(Math.abs(hi.predicted - hi.actual) <= 5);
});
