// Defect 7 — score vs probability semantics. Scores physically cannot populate
// probability fields; uncalibrated models show probability null; the board signal
// contract carries the semantics explicitly.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RS = require('../lib/rank-semantics');
const { makeSignal } = require('../lib/decision');
const { makePrediction } = require('../lib/prediction-contract');

test('scores cannot populate probability fields — every synthesis path throws', () => {
  // A raw score in probability position without calibration → refused.
  assert.throws(() => RS.describeRank({ rankScore: 71, probability: 0.71 }),
    /scores can never become probabilities/);
  // Calibrated status but no named outcome → refused.
  assert.throws(() => RS.describeRank({ probability: 0.6, calibrationStatus: 'calibrated' }),
    /probabilityOutcome/);
  // Calibrated + outcome but no artifact version → refused.
  assert.throws(() => RS.describeRank({ probability: 0.6, calibrationStatus: 'calibrated', probabilityOutcome: 'target-before-stop@21s' }),
    /calibrationVersion/);
  // Calibrated + outcome + version but no validated sample → refused.
  assert.throws(() => RS.describeRank({ probability: 0.6, calibrationStatus: 'calibrated', probabilityOutcome: 'target-before-stop@21s', calibrationVersion: 'cal-v1' }),
    /sampleSize/);
  // Out-of-range value → refused.
  assert.throws(() => RS.describeRank({ probability: 71, calibrationStatus: 'calibrated', probabilityOutcome: 'x', calibrationVersion: 'v', sampleSize: 300 }),
    /\[0,1\]/);
  // "calibrated" with nothing to show is contradictory → refused.
  assert.throws(() => RS.describeRank({ calibrationStatus: 'calibrated' }), /contradictory/);
});

test('uncalibrated models show probability null with the standard display text', () => {
  const d = RS.rankOnly(71, 88);
  assert.strictEqual(d.probability, null);
  assert.strictEqual(d.probabilityOutcome, null);
  assert.strictEqual(d.calibrationStatus, 'uncalibrated');
  assert.strictEqual(d.rankScore, 71);
  assert.strictEqual(d.rankPercentile, 88);
  assert.strictEqual(d.displayWhenNull, 'Probability unavailable — evidence building');
});

test('a genuinely calibrated out-of-fold probability with full provenance is accepted', () => {
  const d = RS.describeRank({
    rankScore: 55, probability: 0.58, probabilityOutcome: 'target-before-stop@21s',
    calibrationStatus: 'calibrated', calibrationVersion: 'coil-cal-v2', sampleSize: 412,
    evidenceClass: 'RESEARCH',
  });
  assert.strictEqual(d.probability, 0.58);
  assert.strictEqual(d.probabilityOutcome, 'target-before-stop@21s');
  assert.strictEqual(d.sampleSize, 412);
});

test('board signals carry explicit uncalibrated semantics — probability structurally null', () => {
  const { signal } = makeSignal({ ticker: 'ABC', source: 'screener', horizon: 'swing', rawConfidence: 88 });
  assert.strictEqual(signal.probability, null);
  assert.strictEqual(signal.probabilityOutcome, null);
  assert.strictEqual(signal.calibrationStatus, 'uncalibrated');
});

test('the canonical prediction contract also refuses score-scale probabilities', () => {
  assert.throws(() => makePrediction({ modelId: 'm', modelVersion: '1', pTargetBeforeStopGivenFill: 71 }), /probability/i);
});
