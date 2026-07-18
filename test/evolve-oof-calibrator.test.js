'use strict';
// audit #18: the calibrator's reported Brier was computed on the SAME rows it was fit on
// (in-sample → optimistic). fitCalibrator now also reports a k-fold OUT-OF-FOLD Brier for the
// CALIBRATED probability, plus the raw-P OOF Brier it must beat.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');

// Overconfident raw model: p is always 0.9 but the true win rate is 60% → calibration should map
// 0.9 → ~0.6 and REDUCE the out-of-fold Brier.
function miscalibrated(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ p: 0.9, won: i % 10 < 6 });   // 60% win
  return rows;
}
// Already well-calibrated: p = 0.6 with a 60% win rate.
function wellCalibrated(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ p: 0.6, won: i % 10 < 6 });
  return rows;
}

test('fitCalibrator: reports out-of-fold Brier fields (calibrated + raw baseline)', () => {
  const cal = E.fitCalibrator(miscalibrated(100));
  assert.ok(cal);
  assert.ok('oofBrier' in cal && 'oofBrierRaw' in cal && 'calibrationHelpsOOS' in cal);
  assert.ok(Number.isFinite(cal.oofBrier) && Number.isFinite(cal.oofBrierRaw));
});

test('oof Brier is HONEST: on an overconfident model, calibration lowers the OOF Brier', () => {
  const cal = E.fitCalibrator(miscalibrated(100));
  assert.ok(cal.oofBrier < cal.oofBrierRaw, `calibrated OOF (${cal.oofBrier}) < raw OOF (${cal.oofBrierRaw})`);
  assert.equal(cal.calibrationHelpsOOS, true);
});

test('oof Brier does not manufacture improvement on an already-calibrated model', () => {
  const cal = E.fitCalibrator(wellCalibrated(100));
  // Calibrated OOF should be ~ the raw OOF (no material gain), never wildly better.
  assert.ok(Math.abs(cal.oofBrier - cal.oofBrierRaw) < 0.02, `no spurious gain (${cal.oofBrier} vs ${cal.oofBrierRaw})`);
});

test('oofCalibratorBrier: deterministic and null when too thin to split', () => {
  const rows = miscalibrated(100).filter(r => Number.isFinite(r.p));
  const a = E.oofCalibratorBrier(rows), b = E.oofCalibratorBrier(rows);
  assert.deepStrictEqual(a, b);
  assert.equal(E.oofCalibratorBrier([{ p: 0.5, won: true }, { p: 0.5, won: false }]), null);
});

test('binnedMap: monotone non-decreasing table', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ p: i / 50, won: i % 3 === 0 }));  // deterministic
  const { edges, table } = E.binnedMap(rows, 5);
  assert.equal(edges.length, 5);
  for (let i = 1; i < table.length; i++) assert.ok(table[i] >= table[i - 1], 'monotone');
});
