'use strict';
// OMEGA-SWING calibration-maturity tests (Phase 9 / Phase 16): a probability is displayed ONLY
// when out-of-fold calibrated, sufficient sample, beats base rate, current, within drift.
const { test } = require('node:test');
const assert = require('node:assert');
const CAL = require('../lib/omega-calibration');

test('no calibration artifact ⇒ never display a percentage (uncalibrated baseline)', () => {
  const a = CAL.assessCalibration(0.63, null);
  assert.strictEqual(a.display, false);
  assert.strictEqual(a.maturity, CAL.MATURITY.UNCALIBRATED);
  assert.strictEqual(a.band, 'favorable');
});

test('insufficient sample ⇒ suppressed', () => {
  const a = CAL.assessCalibration(0.6, { version: 'v1', samples: 50, brierSkill: 0.1, driftError: 0.01 }, { currentVersion: 'v1' });
  assert.strictEqual(a.display, false);
  assert.strictEqual(a.maturity, CAL.MATURITY.INSUFFICIENT);
});

test('does not beat the base rate ⇒ suppressed', () => {
  const a = CAL.assessCalibration(0.6, { version: 'v1', samples: 500, brierSkill: -0.01, driftError: 0.01 }, { currentVersion: 'v1' });
  assert.strictEqual(a.display, false);
});

test('stale calibration version ⇒ suppressed', () => {
  const a = CAL.assessCalibration(0.6, { version: 'v0', samples: 500, brierSkill: 0.1, driftError: 0.01 }, { currentVersion: 'v1' });
  assert.strictEqual(a.display, false);
});

test('drift beyond tolerance ⇒ DRIFTED, suppressed', () => {
  const a = CAL.assessCalibration(0.6, { version: 'v1', samples: 500, brierSkill: 0.1, driftError: 0.2 }, { currentVersion: 'v1', maxDrift: 0.05 });
  assert.strictEqual(a.display, false);
  assert.strictEqual(a.maturity, CAL.MATURITY.DRIFTED);
});

test('all gates pass ⇒ CALIBRATED, display allowed', () => {
  const a = CAL.assessCalibration(0.6, { version: 'v1', samples: 500, brierSkill: 0.08, driftError: 0.02 }, { currentVersion: 'v1', maxDrift: 0.05 });
  assert.strictEqual(a.display, true);
  assert.strictEqual(a.maturity, CAL.MATURITY.CALIBRATED);
});

test('qualitative bands are monotone', () => {
  assert.strictEqual(CAL.qualitativeBand(0.7), 'favorable');
  assert.strictEqual(CAL.qualitativeBand(0.55), 'lean-favorable');
  assert.strictEqual(CAL.qualitativeBand(0.47), 'neutral');
  assert.strictEqual(CAL.qualitativeBand(0.3), 'unfavorable');
  assert.strictEqual(CAL.qualitativeBand(null), 'unknown');
});
