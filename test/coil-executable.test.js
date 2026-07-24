'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coilExecutable, normCdf } = require('../lib/coil-executable');
const { coilPrediction, explodeProbability, coilTradePlan } = require('../lib/coil');
const { validatePrediction } = require('../lib/prediction-contract');

test('normCdf is a sane standard-normal CDF', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(normCdf(1.96) > 0.97 && normCdf(1.96) < 0.98);
  assert.ok(normCdf(-1.96) < 0.03);
});

test('pTargetBeforeStop is the driftless ruin ratio and is vol-INDEPENDENT', () => {
  const base = { current: 100, entry: 101, stop: 98, target: 110 };
  const a = coilExecutable({ ...base, dailyVol: 0.02 });
  const b = coilExecutable({ ...base, dailyVol: 0.05 });
  assert.equal(a.pTargetBeforeStopGivenFill, b.pTargetBeforeStopGivenFill);
  // far target + near stop ⇒ ordering prob well below 0.5
  assert.ok(a.pTargetBeforeStopGivenFill < 0.4);
});

test('symmetric barriers give ~0.5 ordering probability', () => {
  // choose stop/target roughly equidistant in log space from entry
  const e = 100, up = 110, dn = 100 * (100 / 110); // dn so ln(e/dn)=ln(up/e)
  const ex = coilExecutable({ current: 99, entry: e, stop: dn, target: up, dailyVol: 0.03 });
  assert.ok(Math.abs(ex.pTargetBeforeStopGivenFill - 0.5) < 0.02);
});

test('pTrigger rises as the buy-stop sits closer to current price', () => {
  const near = coilExecutable({ current: 100, entry: 100.2, stop: 97, target: 108, dailyVol: 0.02 });
  const far = coilExecutable({ current: 100, entry: 104, stop: 97, target: 108, dailyVol: 0.02 });
  assert.ok(near.pTrigger > far.pTrigger);
  assert.ok(near.pTrigger <= 1 && far.pTrigger >= 0);
});

test('all executable probabilities are in [0,1]', () => {
  const ex = coilExecutable({ current: 100, entry: 101, stop: 98, target: 110, dailyVol: 0.02 });
  for (const f of ['pTrigger', 'pTargetBeforeStopGivenFill', 'pProfitableNetGivenFill', 'severeLossProbability']) {
    assert.ok(ex[f] >= 0 && ex[f] <= 1, `${f}=${ex[f]} out of range`);
  }
});

test('costs make the net R strictly worse than a cost-free version', () => {
  const args = { current: 100, entry: 101, stop: 98, target: 110, dailyVol: 0.02 };
  const withCost = coilExecutable({ ...args, roundTripCostPct: 0.004 });
  const noCost = coilExecutable({ ...args, roundTripCostPct: 0 });
  assert.ok(withCost.expectedNetR < noCost.expectedNetR);
  assert.ok(withCost.costR > 0);
});

test('is explicitly UNCALIBRATED (model-estimate), never presented as validated', () => {
  const ex = coilExecutable({ current: 100, entry: 101, stop: 98, target: 110, dailyVol: 0.02 });
  assert.equal(ex.calibrationStatus, 'model-estimate');
  assert.equal(ex.validationStatus, 'research');
});

test('bad geometry (target below entry) returns null, not a fabricated number', () => {
  assert.equal(coilExecutable({ current: 100, entry: 101, stop: 98, target: 100, dailyVol: 0.02 }), null);
  assert.equal(coilExecutable({ current: 100, entry: 101, stop: 102, target: 110, dailyVol: 0.02 }), null);
});

test('coilPrediction keeps the EMPIRICAL excursion rate separate from executable win prob', () => {
  const prob = explodeProbability('small', 0.95);   // top-decile empirical abnormal-break rate
  // synthetic plan with a known executable estimate
  const plan = {
    entry: 101, stop: 98, target: 110,
    executable: coilExecutable({ current: 100, entry: 101, stop: 98, target: 110, dailyVol: 0.02 }),
  };
  const pred = coilPrediction({ prob, plan, percentile: 0.95, scope: 'small' });
  // the empirical excursion rate lives in extra, NEVER in a p*GivenFill field
  assert.ok(pred.extra.pAbnormalExpansion > 0);
  assert.notEqual(pred.extra.pAbnormalExpansion, pred.pProfitableNetGivenFill);
  // rankPercentile is a rank, not a probability
  assert.equal(pred.rankPercentile, 0.95);
  // executable probs flow through
  assert.equal(pred.pTargetBeforeStopGivenFill, plan.executable.pTargetBeforeStopGivenFill);
  // survivorship/PIT honesty
  assert.equal(pred.survivorshipSafe, false);
  assert.equal(validatePrediction(pred).ok, true);
});

test('coilTradePlan now emits an executable block on real candles', () => {
  // a rising-then-tight synthetic series long enough for the plan
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const c = 50 + i * 0.1 + Math.sin(i / 2) * 0.5;
    candles.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c + 0.6, low: c - 0.6, close: c, volume: 1e6 });
  }
  const plan = coilTradePlan(candles, candles.length - 1, 8.0);
  assert.ok(plan);
  assert.ok(plan.executable, 'plan carries executable estimate');
  assert.ok(plan.executable.pTargetBeforeStopGivenFill >= 0 && plan.executable.pTargetBeforeStopGivenFill <= 1);
});
