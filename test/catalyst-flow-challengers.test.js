'use strict';
// CATALYST–FLOW CHALLENGERS — the transparent PEAD score and the ridge event model.
//
// The ridge tests carry a REGRESSION GUARD. The first implementation of the linear solver
// finished with `row[i][i]`, which reads a property of a number and yields NaN for every
// coefficient. Every prediction came back NaN, the arm scored zero candidates on every
// date, and the evaluator reported it as a clean abstention rather than as a broken model.
// A test that only checked `beta.length` would have passed. These check FINITENESS and
// that the fit actually recovers a known relationship.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/catalyst-flow/challengers');

test('the transparent PEAD score renormalises by the weight actually used', () => {
  const full = C.transparentPeadScore({ epsSurpriseStd: 2, revenueSurpriseStd: 2, surpriseSignAgreement: 1, firstSessionVsSector: 0.02, gapRetention: 1, closeLocationValue: 1 });
  const partial = C.transparentPeadScore({ epsSurpriseStd: 2 });
  assert.strictEqual(partial.componentsUsed, 1);
  // A row missing revenue surprise must not be mechanically ranked below one that has it.
  assert.ok(Math.abs(partial.score - 2) < 1e-12);
  assert.ok(full.componentsUsed === 6);
});

test('a row with NO measurable component scores null, not zero', () => {
  assert.strictEqual(C.transparentPeadScore({}), null);
  assert.strictEqual(C.transparentPeadScore({ epsSurpriseStd: null, gapRetention: undefined }), null);
});

test('the PEAD score is monotone in the surprise, holding everything else equal', () => {
  const at = (s) => C.transparentPeadScore({ epsSurpriseStd: s, firstSessionVsSector: 0.01 }).score;
  assert.ok(at(-2) < at(0) && at(0) < at(2));
});

test('ridge coefficients are FINITE — the NaN solver regression', () => {
  const X = [], y = [];
  for (let i = 0; i < 300; i++) {
    const a = Math.sin(i), b = Math.cos(i / 3);
    X.push([a, b, 1.0]);            // includes a constant column, which must not break the solve
    y.push(3 * a - 2 * b);
  }
  const m = C.fitRidge(X, y, 1.0);
  assert.ok(m, 'the fit must succeed');
  assert.ok(m.beta.every(Number.isFinite), 'every coefficient must be a real number');
  assert.ok(C.predictRidge(m, X).every(Number.isFinite), 'and every prediction too');
});

test('ridge recovers the SIGN and relative size of a known linear relationship', () => {
  const X = [], y = [];
  for (let i = 0; i < 500; i++) {
    const a = Math.sin(i), b = Math.cos(i / 7);
    X.push([a, b]);
    y.push(3 * a - 1 * b);
  }
  const m = C.fitRidge(X, y, 0.1);
  assert.ok(m.beta[0] > 0 && m.beta[1] < 0);
  assert.ok(Math.abs(m.beta[0]) > Math.abs(m.beta[1]), 'the stronger driver gets the larger coefficient');
});

test('the scaler is fit on TRAINING rows and reapplied unchanged — never refit downstream', () => {
  const train = [[0, 10], [2, 20], [4, 30]];
  const s = C.standardise(train);
  const applied = C.applyScaler([[2, 20]], s);
  assert.ok(Math.abs(applied[0][0]) < 1e-12, 'the training mean maps to 0');

  // A test row far outside the training range must NOT be renormalised to look ordinary.
  const far = C.applyScaler([[100, 20]], s);
  assert.ok(far[0][0] > 10, 'an outlier stays an outlier under the frozen scaler');
});

test('a missing feature is imputed to the TRAINING mean (0 after centring), not to the test mean', () => {
  const s = C.standardise([[0, 1], [2, 1], [4, 1]]);
  const z = C.applyScaler([[null, 1]], s);
  assert.strictEqual(z[0][0], 0);
});

test('fitRidge refuses malformed input instead of returning a broken model', () => {
  assert.strictEqual(C.fitRidge([], []), null);
  assert.strictEqual(C.fitRidge([[1, 2]], [1, 2]), null, 'row/label mismatch');
  assert.strictEqual(C.predictRidge(null, [[1]]), null);
});

test('the OMEGA arm refuses events with no genuine incumbent score rather than defaulting one', () => {
  const rows = [{ key: 'A' }, { key: 'B' }, { key: 'C' }];
  const r = C.omegaArmScores(rows, (x) => (x.key === 'B' ? null : 42));
  assert.strictEqual(r.scored.length, 2);
  assert.strictEqual(r.unresolved.length, 1);
  assert.strictEqual(r.unresolved[0].reason, 'no-incumbent-omega-score-for-this-event');

  const none = C.omegaArmScores(rows, () => null);
  assert.strictEqual(none.comparable, false, 'an arm with no resolvable incumbent is not comparable');
});
