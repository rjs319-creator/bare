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

// ── REGRESSION (audit 2026-08-14): dateClusteredIC used the 2dp display fields ──
// Per-date IC means live at ~0.004-0.05; summarizeDateSeries rounds `avg` to 2dp for
// display, so a true mean of 0.0036 became ic 0.00 with t 0.00 and `significant` was
// decided from quantized garbage. The clustered lane must read avgExact/seExact.
test('dateClusteredIC: a ~0.004 per-date IC mean is reported at full precision with a non-zero t', () => {
  // Arrange — 12 dates × 20 picks. The outcome ordering is a fixed permutation with a
  // tiny positive Spearman rho vs score (~0.003), with one adjacent pair swapped per
  // date so the per-date ICs jitter slightly (sd small but non-zero → finite se).
  const BASE = [15, 6, 18, 12, 0, 14, 1, 9, 7, 10, 2, 4, 17, 8, 13, 11, 19, 16, 3, 5];
  const items = [];
  const perDateICs = [];
  for (let d = 0; d < 12; d++) {
    const date = `2026-01-${String(d + 1).padStart(2, '0')}`;
    const o = BASE.slice();
    [o[d + 2], o[d + 3]] = [o[d + 3], o[d + 2]];
    const cross = o.map((outcome, i) => ({ score: i, outcome, won: outcome > 10, date }));
    items.push(...cross);
    perDateICs.push(RQ.informationCoefficient(cross).ic); // ground truth, same estimator
  }
  const trueMean = perDateICs.reduce((s, x) => s + x, 0) / perDateICs.length;
  assert.ok(trueMean > 0.001 && trueMean < 0.01, `test premise: mean must be sub-2dp (got ${trueMean})`);

  // Act
  const r = RQ.dateClusteredIC(items);

  // Assert — the old code reported ic 0 / t 0 here (mean quantized to 0.00 before t).
  assert.equal(r.dates, 12);
  assert.notEqual(r.ic, 0, 'a ~0.004 mean must not be reported as exactly 0');
  assert.ok(Math.abs(r.ic - trueMean) <= 5e-4, `ic ${r.ic} must match the true mean ${trueMean} at 3dp precision, not 2dp`);
  assert.ok(Number.isFinite(r.t) && r.t !== 0, `t must be computed from full-precision fields (got ${r.t})`);
  assert.ok(Math.abs(r.t) > 0.3, `t should be ~0.8 for this series, got ${r.t}`);
});
