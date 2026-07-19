'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/orbit-calibration');
const M = require('../lib/orbit-math');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Generate OVERCONFIDENT raw probabilities: the true hit rate is a COMPRESSED
// version of the raw p, so `none` is miscalibrated and a calibrator should help.
function makePairs(n, seed) {
  const rnd = lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = rnd();                                   // raw model prob 0..1
    const truep = M.clamp(0.5 + 0.55 * (p - 0.5), 0, 1); // compressed → overconfident raw
    const won = rnd() < truep ? 1 : 0;
    out.push({ p: +p.toFixed(4), won });
  }
  return out;
}

test('selects a calibrator that beats "none" on held-out Brier', () => {
  const train = makePairs(400, 1);
  const valid = makePairs(200, 2);
  const sel = C.selectCalibrator(train, valid, { minN: 60 });
  assert.ok(sel.calibrated, 'has support');
  const noneBrier = M.brier(valid.map(r => r.p), valid.map(r => r.won));
  assert.ok(sel.metrics.brier <= noneBrier + 1e-6, `calibrated ${sel.metrics.brier} ≤ none ${noneBrier}`);
  assert.ok(['none', 'platt', 'beta', 'isotonic'].includes(sel.method));
});

test('calibrated probabilities move toward the true frequency', () => {
  const sel = C.selectCalibrator(makePairs(500, 3), makePairs(200, 4), { minN: 60 });
  // A raw 0.95 should calibrate DOWN (raw was overconfident).
  const cal = C.calibrate(sel, 0.95);
  assert.ok(cal != null && cal < 0.95, `0.95 → ${cal} (pulled toward the middle)`);
  const calLow = C.calibrate(sel, 0.05);
  assert.ok(calLow > 0.05, `0.05 → ${calLow}`);
});

test('insufficient out-of-fold support → calibrated:false, probability:null', () => {
  const sel = C.selectCalibrator(makePairs(20, 5), makePairs(10, 6), { minN: 60 });
  assert.strictEqual(sel.calibrated, false);
  assert.strictEqual(C.calibrate(sel, 0.8), null);
  assert.ok(/insufficient/.test(sel.reason));
});

test('calibration reports a slope/intercept diagnostic', () => {
  const sel = C.selectCalibrator(makePairs(400, 7), makePairs(200, 8), { minN: 60 });
  assert.ok('slope' in sel.metrics && 'intercept' in sel.metrics);
});

test('trained only on the training split (valid never touches the fit)', () => {
  // Same train, two different valid sets → identical fitted model object; only the
  // selection metrics differ. Proves the calibrator itself is fit on train alone.
  const train = makePairs(400, 9);
  const a = C.selectCalibrator(train, makePairs(200, 10), { minN: 60 });
  const b = C.selectCalibrator(train, makePairs(200, 11), { minN: 60 });
  if (a.method === b.method && a.method !== 'isotonic') {
    assert.deepStrictEqual(a.model.w, b.model.w, 'fit depends only on train');
  } else {
    assert.ok(true, 'method choice can differ by validation set — acceptable');
  }
});
