'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../lib/orbit-decision');

function hz({ cal = true, robustUp = 0.6, expectedNet = 0.03, severe = 0.1, rawUp = 0.62, residualUp = 0.6 } = {}) {
  return { calibrated: cal, robustUp, expectedNet, severe, rawUp, residualUp, lowerBound: robustUp - 0.05, upperBound: robustUp + 0.05, pUpper: 0.4, pLower: 0.3, pTimeout: 0.3, rankScore: residualUp };
}

test('cold start (no calibrated horizon) → ABSTAIN, probabilities null', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days5: hz({ cal: false }), days21: hz({ cal: false }), days63: hz({ cal: false }) } });
  assert.strictEqual(out.classification, 'ABSTAIN');
  assert.ok(out.rejectionReasons.includes('insufficient-out-of-fold-calibration'));
  assert.strictEqual(out.horizonProbabilities.days21.residualUp, null, 'no probability without calibration');
  assert.strictEqual(out.horizonProbabilities.days21.uncalibratedRankScore != null, true, 'rank score still exposed');
});

test('hard gate (liquidity) → ABSTAIN regardless of scores', () => {
  const out = D.decideCandidate({ ticker: 'X', gates: { liquidityOk: false }, horizons: { days21: hz() } });
  assert.strictEqual(out.classification, 'ABSTAIN');
  assert.ok(out.rejectionReasons.includes('liquidity-failed'));
});

test('only 21d qualifies → ORBIT_SWING', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days5: hz({ robustUp: 0.4 }), days21: hz({ robustUp: 0.62 }), days63: hz({ expectedNet: -0.01 }) } });
  assert.strictEqual(out.classification, 'ORBIT_SWING');
  assert.ok(out.confidence > 0.5);
});

test('all horizons qualify → ORBIT_ALIGNED (evidence AND, not a product)', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days5: hz(), days21: hz(), days63: hz() } });
  assert.strictEqual(out.classification, 'ORBIT_ALIGNED');
});

test('calibrated but below hurdle → WATCH, not a pick', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days21: hz({ robustUp: 0.5, expectedNet: 0.001 }) } });
  assert.ok(['WATCH', 'ABSTAIN'].includes(out.classification));
});

test('severe-loss probability above the cap disqualifies the horizon', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days21: hz({ severe: 0.5 }) } });
  assert.notStrictEqual(out.classification, 'ORBIT_SWING');
});

test('always shadow: affectsLiveRank false, deploymentWeight 0', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days21: hz() } });
  assert.strictEqual(out.shadow, true);
  assert.strictEqual(out.affectsLiveRank, false);
  assert.strictEqual(out.deploymentWeight, 0);
  assert.strictEqual(out.governanceStatus, 'paper');
});

test('a qualifying pick surfaces calibrated horizon probabilities', () => {
  const out = D.decideCandidate({ ticker: 'X', horizons: { days21: hz({ robustUp: 0.6 }) } });
  assert.strictEqual(out.horizonProbabilities.days21.robustUp, 0.6);
  assert.ok(out.horizonProbabilities.days21.rawUp != null);
});
