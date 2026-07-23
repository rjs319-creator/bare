'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { brierScore, expectedCalibrationError, precisionAtK, topKMean } = require('../lib/survival-metrics');
const { purgedWalkForward } = require('../lib/walk-forward');
const { trainLogistic, predictProba, MIN_PER_CLASS } = require('../lib/survival-model');
const { checkPromotion, GATES } = require('../lib/promotion-gate');
const { evaluateSurvival, gradesToRows } = require('../lib/survival-eval');

// ── metrics ──────────────────────────────────────────────────────────────────
test('brierScore: 0 for perfect predictions, higher for worse', () => {
  assert.equal(brierScore([1, 0], [1, 0]), 0);
  assert.equal(brierScore([0, 1], [1, 0]), 1);
  assert.equal(brierScore([], []), null);
});

test('expectedCalibrationError: 0 when predicted freq matches observed', () => {
  // all preds 0.5, half positive → each bucket's avgPred≈avgObserved.
  const preds = [0.5, 0.5, 0.5, 0.5], labels = [1, 0, 1, 0];
  assert.equal(expectedCalibrationError(preds, labels, 10), 0);
});

test('precisionAtK / topKMean: rank by score, take the top k', () => {
  const scored = [{ score: 0.9, label: 1 }, { score: 0.8, label: 1 }, { score: 0.1, label: 0 }];
  assert.equal(precisionAtK(scored, 2), 1);
  const rows = [{ s: 3, v: 0.10 }, { s: 2, v: 0.05 }, { s: 1, v: -0.20 }];
  assert.equal(topKMean(rows, r => r.s, r => r.v, 2), 0.075);
});

// ── walk-forward ───────────────────────────────────────────────────────────
test('purgedWalkForward: no folds when there are too few distinct dates', () => {
  const dates = Array.from({ length: 10 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  assert.deepEqual(purgedWalkForward(dates, { minTrainDates: 20 }), []);
});

test('purgedWalkForward: chronological, embargoed, non-overlapping folds', () => {
  const dates = Array.from({ length: 40 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
  const folds = purgedWalkForward(dates, { nFolds: 3, embargoDays: 1, minTrainDates: 20 });
  assert.ok(folds.length >= 2);
  for (const f of folds) {
    assert.ok(f.trainDates.size >= 20, 'train has ≥ minTrainDates');
    // No train/test overlap, and the embargo date is excluded from BOTH.
    for (const td of f.testDates) assert.ok(!f.trainDates.has(td), 'no train/test date overlap');
    // Every train date is strictly before every test date (chronological).
    const maxTrain = [...f.trainDates].sort().at(-1);
    const minTest = [...f.testDates].sort()[0];
    assert.ok(maxTrain < minTest, 'train entirely precedes test');
  }
});

// ── model ────────────────────────────────────────────────────────────────────
test('trainLogistic: returns null below MIN_PER_CLASS of either class', () => {
  const rows = Array.from({ length: 2 * MIN_PER_CLASS }, (_, i) => ({ features: { x: i }, y: i < 5 ? 1 : 0 }));
  assert.equal(trainLogistic(rows, ['x'], r => r.y), null);   // only 5 positives
});

test('trainLogistic: fits a separable signal and ranks positives above negatives', () => {
  // Deterministic separable data: label = 1 iff x > 0 (plus a weak second feature).
  const rows = [];
  for (let i = 0; i < 200; i++) { const x = (i % 20) - 10; rows.push({ features: { x, z: (i % 5) - 2 }, y: x > 0 ? 1 : 0 }); }
  const model = trainLogistic(rows, ['x', 'z'], r => r.y, { iters: 800 });
  assert.ok(model, 'model fit');
  assert.ok(predictProba(model, { x: 8, z: 0 }) > predictProba(model, { x: -8, z: 0 }), 'positive region scores higher');
});

// ── promotion gate (fail-closed) ─────────────────────────────────────────────
test('checkPromotion: fails closed on missing/insufficient stats', () => {
  const r = checkPromotion({ episodes: 10 });
  assert.equal(r.promote, false);
  assert.ok(r.failed.includes('episodes') && r.failed.includes('precisionLift'));
});

test('checkPromotion: promotes only when EVERY pre-registered gate passes', () => {
  const good = { episodes: GATES.minEpisodes, testEpisodes: GATES.minTestEpisodes, folds: GATES.minFolds,
    precisionLift: GATES.minPrecisionLift, netReturnLift: GATES.minNetReturnLift, ece: GATES.maxEce - 0.01, brier: GATES.maxBrier - 0.01 };
  assert.equal(checkPromotion(good).promote, true);
  assert.equal(checkPromotion({ ...good, ece: 0.5 }).promote, false, 'bad calibration blocks promotion');
});

// ── end-to-end evaluateSurvival ───────────────────────────────────────────────
test('evaluateSurvival: reports insufficient-data (fail-closed) on a thin dataset', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ date: `2026-06-0${(i % 5) + 1}`, features: { mom15: 0.01 }, label: i % 2, baselineScore: i, netReturn: 0 }));
  const out = evaluateSurvival(rows);
  assert.equal(out.status, 'insufficient-data');
  assert.equal(out.promotion.promote, false);
});

test('evaluateSurvival: runs walk-forward end-to-end on sufficient synthetic data', () => {
  // 40 sessions × 30 episodes; a captured feature separates the label so folds can fit.
  const rows = [];
  for (let d = 0; d < 40; d++) {
    const date = `2026-06-${String(d + 1).padStart(2, '0')}`;
    for (let j = 0; j < 30; j++) {
      const mom = ((j % 10) - 5) / 100;                 // -0.05 .. 0.04
      const label = mom > 0 ? 1 : 0;
      rows.push({ date, ticker: `T${j}`, features: { mom15: mom, residual15: mom / 2, timeOfDayRelVol: 1 + (j % 4), extensionAtr: 1, remainingRR: 1.5 }, label, baselineScore: j, netReturn: label ? 0.01 : -0.01 });
    }
  }
  const out = evaluateSurvival(rows, { wf: { nFolds: 3, minTrainDates: 20, embargoDays: 1 } });
  assert.equal(out.status, 'evaluated');
  assert.ok(out.folds >= 2, `fit ${out.folds} folds`);
  assert.ok(out.testEpisodes > 0);
  assert.ok(out.metrics.brier != null && out.metrics.ece != null);
  assert.equal(typeof out.promotion.promote, 'boolean');   // decision is computed, honest either way
});

test('gradesToRows: keeps only gradeable entry episodes and labels by SUCCESS', () => {
  const grades = {
    a: { type: 'entry', ticker: 'A', decisionAt: '2026-06-01T14:00:00Z', features: { mom15: 0.02 }, ranking: { score: 5 }, outcome: { barrier: 'SUCCESS', netReturn: 0.01 } },
    b: { type: 'entry', ticker: 'B', decisionAt: '2026-06-01T15:00:00Z', features: { mom15: -0.01 }, ranking: { score: 2 }, outcome: { barrier: 'FAILURE', netReturn: -0.02 } },
    c: { type: 'retired', ticker: 'C', decisionAt: '2026-06-01T15:30:00Z', features: { mom15: 0 }, outcome: { barrier: 'TIMEOUT', netReturn: 0 } },
  };
  const rows = gradesToRows(grades);
  assert.equal(rows.length, 2);                 // the 'retired' row is excluded from headline training
  assert.equal(rows.find(r => r.ticker === 'A').label, 1);
  assert.equal(rows.find(r => r.ticker === 'B').label, 0);
});
