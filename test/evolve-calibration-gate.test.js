'use strict';
// AN IN-SAMPLE CALIBRATOR WAS APPLIED TO EVERY LIVE CANDIDATE (alpha-research pass 3).
//
// fitCalibrator computes the honest out-of-fold read — oofBrier (calibrated) vs
// oofBrierRaw (the baseline it must beat) — and sets `calibrationHelpsOOS`. But
// scoreCandidate applied the 5-bin map whenever a calibrator merely EXISTED, so the
// displayed probability could be reshaped by a map its own out-of-fold evidence said
// made things WORSE. fitCalibrator's own comment concedes the in-sample Brier is
// "optimistic".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../lib/evolve');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve.js'), 'utf8');
const cal = (helps) => ({ edges: [0, 0.5, 1], table: [0.2, 0.8], calibrationHelpsOOS: helps });

test('a calibrator is usable only when it BEAT raw P out-of-fold', () => {
  assert.equal(E.calibratorUsable(cal(true)), true);
  assert.equal(E.calibratorUsable(cal(false)), false, 'a map that hurts OOF must not be applied');
});

test('an unproven calibration fails CLOSED', () => {
  // null = the OOF check could not be computed (too few rows to fold). That is not
  // evidence that calibration helps, so the raw probability is shown instead.
  assert.equal(E.calibratorUsable(cal(null)), false);
  assert.equal(E.calibratorUsable(cal(undefined)), false);
  assert.equal(E.calibratorUsable(null), false);
  assert.equal(E.calibratorUsable({ calibrationHelpsOOS: true }), false, 'no map = nothing to apply');
});

test('the LIVE application is gated', () => {
  assert.match(SRC, /const calUsable = calibratorUsable\(calibrator\)/);
  assert.match(SRC, /if \(p != null && calUsable\) p = applyCalibrator\(calibrator, p\)/);
  assert.ok(!/if \(p != null && calibrator\) p = applyCalibrator/.test(SRC),
    'the ungated application must not return');
});

test('applyCalibrator does NOT self-gate — that would disable the OOF measurement', () => {
  // oofCalibratorBrier applies a fold-fitted {edges,table} that has no OOF verdict yet,
  // by construction: the verdict is what that loop computes. Gating inside
  // applyCalibrator made every fold return raw P, collapsing oofBrier === oofBrierRaw
  // and silently disabling the evidence the live gate depends on. Caught by an existing
  // test failing, not by review.
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const p = Math.min(0.99, Math.max(0.01, 0.5 + 0.45 * Math.sin(i)));
    rows.push({ p, won: (i % 100) < 40 });
  }
  const fitted = E.fitCalibrator(rows);
  assert.ok(fitted && Number.isFinite(fitted.oofBrier) && Number.isFinite(fitted.oofBrierRaw));
  assert.notEqual(fitted.oofBrier, fitted.oofBrierRaw,
    'the OOF comparison must still discriminate — if these collapse, the gate is self-blinding');
  // And the map still applies when called directly with a real calibrator.
  assert.ok(Number.isFinite(E.applyCalibrator(fitted, 0.5)));
});

test('the row states which probability the reader is looking at', () => {
  assert.match(SRC, /calibrationStatus: calUsable \? 'calibrated' : 'uncalibrated'/);
  assert.match(SRC, /calibrationHelpsOOS: calibrator \? \(calibrator\.calibrationHelpsOOS \?\? null\) : null/);
});

test('modelHealth.calibrated means it EARNED it, not that a map exists', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve-routes.js'), 'utf8');
  assert.match(routes, /calibrated: E\.calibratorUsable\(ctx\.calibrator\)/);
  assert.match(routes, /calibratorPresent: !!ctx\.calibrator/, 'presence is still reported separately');
  assert.ok(!/calibrated: !!ctx\.calibrator/.test(routes));
});
