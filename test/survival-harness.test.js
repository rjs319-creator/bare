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

// ── ranking-quality metrics (rocAuc / prAuc / topDecileLift) ─────────────────
const { rocAuc, prAuc, topDecileLift } = require('../lib/survival-metrics');
const { abstentionReport, sliceReport, liquidityTierOf, MIN_SLICE_ROWS, ABSTENTION_THRESHOLD } = require('../lib/intraday-training');

test('rocAuc: 1 for perfect ranking, 0 for inverted, null when a class is empty', () => {
  // Arrange
  const perfect = [{ score: 0.9, label: 1 }, { score: 0.8, label: 1 }, { score: 0.2, label: 0 }];
  const inverted = [{ score: 0.1, label: 1 }, { score: 0.9, label: 0 }];

  // Act + Assert
  assert.equal(rocAuc(perfect), 1);
  assert.equal(rocAuc(inverted), 0);
  assert.equal(rocAuc([{ score: 0.5, label: 1 }]), null, 'no negatives → null, not 0.5');
  assert.equal(rocAuc([]), null);
});

test('rocAuc: symmetric interleaved fixture scores exactly 0.5', () => {
  // pos scores {4,1}, neg scores {3,2}: 2 of 4 pairs concordant → 0.5.
  const rows = [
    { score: 4, label: 1 }, { score: 3, label: 0 },
    { score: 2, label: 0 }, { score: 1, label: 1 },
  ];
  assert.equal(rocAuc(rows), 0.5);
});

test('rocAuc: tied scores are rank-averaged (count 1/2), not broken arbitrarily', () => {
  // pos {3,2}, neg {2,1}: pairs (3>2)=1, (3>1)=1, (2==2)=0.5, (2>1)=1 → 3.5/4.
  const rows = [
    { score: 3, label: 1 }, { score: 2, label: 1 },
    { score: 2, label: 0 }, { score: 1, label: 0 },
  ];
  assert.equal(rocAuc(rows), 0.875);
  assert.equal(rocAuc([{ score: 2, label: 1 }, { score: 2, label: 0 }]), 0.5, 'all-tied → exactly 0.5');
});

test('rocAuc: weights change the estimate, never the ranking', () => {
  // pos {3 w3, 1 w1}, neg {2 w1}: weighted concordant mass 3 of 4 → 0.75; unweighted 0.5.
  const rows = [
    { score: 3, label: 1, weight: 3 }, { score: 1, label: 1, weight: 1 },
    { score: 2, label: 0, weight: 1 },
  ];
  assert.equal(rocAuc(rows), 0.5);
  assert.equal(rocAuc(rows, { weighted: true }), 0.75);
});

test('prAuc: hand-computed average precision; null with no positives', () => {
  // Ranked: pos@1 (prec 1), neg@2, pos@3 (prec 2/3) → AP = (1 + 2/3) / 2.
  const rows = [{ score: 0.9, label: 1 }, { score: 0.8, label: 0 }, { score: 0.7, label: 1 }];
  assert.equal(prAuc(rows), +((1 + 2 / 3) / 2).toFixed(4));
  assert.equal(prAuc([{ score: 0.9, label: 1 }, { score: 0.1, label: 0 }]), 1, 'perfect ranking → AP 1');
  assert.equal(prAuc([{ score: 0.5, label: 0 }]), null, 'no positive class → null, never a flattering number');
  assert.equal(prAuc([]), null);
});

test('topDecileLift: top-10% label rate over base rate; null under 10 rows or zero base', () => {
  // Arrange: 20 rows, 4 positives; the top-2 by score are both positive → lift 1/0.2 = 5.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ score: 20 - i, label: i < 2 || i === 10 || i === 15 ? 1 : 0, id: `r${i}` });

  // Act + Assert
  assert.equal(topDecileLift(rows), 5);
  assert.equal(topDecileLift(rows.slice(0, 9)), null, '< 10 rows → no meaningful decile');
  assert.equal(topDecileLift(rows.map(r => ({ ...r, label: 0 }))), null, 'zero base rate → lift undefined, not ∞');
});

// ── abstention report (research reporting, not a live gate) ──────────────────
test('abstentionReport: pre-registered threshold 0, honest traded/abstained accounting', () => {
  // Arrange: 3 decidable rows (2 positive-utility, 1 negative), 1 with utility null.
  const oof = [
    { utility: 0.5, netReturn: 0.02 },
    { utility: -0.1, netReturn: -0.01 },
    { utility: 0.2, netReturn: 0.01 },
    { utility: null, netReturn: 0 },
  ];

  // Act
  const r = abstentionReport(oof);

  // Assert
  assert.equal(r.threshold, ABSTENTION_THRESHOLD);
  assert.equal(r.threshold, 0, 'threshold is pre-registered at 0 — utility must be positive after costs');
  assert.equal(r.decisions, 3);
  assert.equal(r.undecidable, 1, 'null-utility rows reported, not folded in');
  assert.equal(r.abstainRate, +(1 / 3).toFixed(4));
  assert.equal(r.tradedCount, 2);
  assert.equal(r.tradedMeanNetReturn, 0.015);
  assert.equal(r.allMeanNetReturn, +((0.02 - 0.01 + 0.01) / 3).toFixed(5));
});

test('abstentionReport: empty input degrades to nulls, never NaN', () => {
  const r = abstentionReport([]);
  assert.equal(r.decisions, 0);
  assert.equal(r.abstainRate, null);
  assert.equal(r.tradedMeanNetReturn, null);
});

// ── population slices ────────────────────────────────────────────────────────
test('liquidityTierOf: pre-registered dollar-volume cutoffs at 5e6 / 5e7', () => {
  assert.equal(liquidityTierOf(Math.log10(4e6)), 'micro-small');
  assert.equal(liquidityTierOf(Math.log10(1e7)), 'mid');
  assert.equal(liquidityTierOf(Math.log10(1e8)), 'large');
  assert.equal(liquidityTierOf(null), 'unknown');
});

test('sliceReport: thin slices report insufficiency instead of numbers; thick slices report metrics', () => {
  // Arrange: 60 open30/large rows (enough) + 10 midday/unknown-liquidity rows (thin).
  const mkOof = (i, sessionBucket, logDollarVol) => ({
    id: `s${sessionBucket}${i}`, sessionBucket,
    pTarget: (i % 10) / 10, labelTarget: i % 10 >= 7 ? 1 : 0,
    utility: ((i % 10) - 5) / 100, weight: 1,
    features: { logDollarVol },
  });
  const oof = [
    ...Array.from({ length: 60 }, (_, i) => mkOof(i, 'open30', 8)),
    ...Array.from({ length: 10 }, (_, i) => mkOof(i, 'midday', null)),
  ];

  // Act
  const slices = sliceReport(oof);

  // Assert
  const thick = slices.sessionBucket.open30;
  assert.equal(thick.n, 60);
  assert.ok(thick.n >= MIN_SLICE_ROWS);
  assert.ok(thick.brier != null && thick.baseRate != null && thick.utilityPrecisionAtK != null);
  assert.equal(thick.k, Math.max(1, Math.floor(60 * 0.05)), 'k adapts to slice size');
  assert.deepEqual(slices.sessionBucket.midday, { n: 10, note: 'insufficient' }, 'thin slice: honest note, no numbers');
  assert.equal(slices.liquidity.large.n, 60);
  assert.deepEqual(slices.liquidity.unknown, { n: 10, note: 'insufficient' });
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
