// Tests for the dual-read self-improvement tuner (lib/dualread-adapt.js).
const test = require('node:test');
const assert = require('node:assert');
const { championChallenger, fitWeights, factorICs, DEFAULT_LT_WEIGHTS, LT_FACTORS } = require('../lib/dualread-adapt');

// Deterministic LCG so the synthetic ledger is reproducible (no flaky tests).
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const sign = r => (r < 0.5 ? -1 : 1);

// Build N resolved rows. `driver` = the factor whose signal drives forward excess;
// every other factor is independent noise. `noise` scales the residual.
function ledger(n, driver, noise, seed = 7) {
  const rnd = lcg(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const signals = {};
    for (const k of LT_FACTORS) signals[k] = sign(rnd());
    const fwd = driver ? signals[driver] + noise * (rnd() * 2 - 1) : (rnd() * 2 - 1);
    rows.push({ signals, fwd, date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  return rows;
}

test('dormant while accruing (< MIN_RESOLVED)', () => {
  const cc = championChallenger(ledger(20, 'rs3m', 0.3), DEFAULT_LT_WEIGHTS);
  assert.equal(cc.promoted, false);
  assert.deepEqual(cc.weights, DEFAULT_LT_WEIGHTS);
  assert.match(cc.reason, /accruing/);
});

test('factorICs: the driving factor scores a high IC, noise factors ~0', () => {
  const ic = factorICs(ledger(200, 'rs3m', 0.3));
  assert.ok(ic.rs3m > 0.5, `rs3m IC ${ic.rs3m} should be strong`);
  assert.ok(Math.abs(ic.high52) < 0.2, `noise factor IC ${ic.high52} should be near zero`);
});

test('fitWeights up-weights the predictive factor above its prior', () => {
  const { weights } = fitWeights(ledger(200, 'rs3m', 0.3), DEFAULT_LT_WEIGHTS);
  assert.ok(weights.rs3m > DEFAULT_LT_WEIGHTS.rs3m, `rs3m ${weights.rs3m} should exceed prior ${DEFAULT_LT_WEIGHTS.rs3m}`);
  const tot = LT_FACTORS.reduce((s, k) => s + weights[k], 0);
  assert.ok(Math.abs(tot - 1) < 0.02, `weights should renormalize to ~1 (got ${tot})`);
});

test('promotes a challenger when one factor genuinely predicts', () => {
  const cc = championChallenger(ledger(160, 'rs3m', 0.4), DEFAULT_LT_WEIGHTS);
  assert.equal(cc.promoted, true, cc.reason);
  assert.ok(cc.weights.rs3m > DEFAULT_LT_WEIGHTS.rs3m);
  assert.ok(cc.oosIcChallenger > cc.oosIcChampion);
});

test('keeps champion on pure noise (no promotion on randomness)', () => {
  const cc = championChallenger(ledger(160, null, 1), DEFAULT_LT_WEIGHTS);
  assert.equal(cc.promoted, false);
  assert.deepEqual(cc.weights, DEFAULT_LT_WEIGHTS);
});
