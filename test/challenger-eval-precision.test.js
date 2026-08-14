'use strict';
// REGRESSION (audit 2026-08-14): challenger-eval's clusteredExpectancyCI took the
// ALREADY 2dp-ROUNDED display mean from summarizeDateSeries and re-rounded it to 3dp —
// false precision (0.120 pretending to be a 3dp measurement of a 0.1234 mean) — and the
// promotion criterion read an interval built from display fields. It must compute from
// the full-precision avgExact/seExact fields.
const test = require('node:test');
const assert = require('node:assert');
const { clusteredExpectancyCI, evaluate } = require('../lib/challenger-eval');

// 30 prediction dates, one resolved outcome per date, mean 0.1234% with tiny jitter.
function rows(n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`;
    out.push({ predDate: date, ticker: `T${i}`, horizon: 'swing', residualScore: i % 7, outcome: 0.1234 + (i % 2 === 0 ? -0.01 : 0.01), won: true });
  }
  return out;
}

test('clusteredExpectancyCI: mean is computed from the full-precision fields, not re-rounded display values', () => {
  // Arrange
  const preds = rows(30);
  const outcomes = preds.map((p) => p.outcome);
  // Act
  const ci = clusteredExpectancyCI(preds, outcomes);
  // Assert — old code: round(round(0.1234, 2), 3) = 0.12; exact-field code: 0.123.
  assert.match(ci.basis, /date-clustered/);
  assert.ok(Math.abs(ci.mean - 0.1234) <= 1e-3, `mean ${ci.mean} must be the exact mean at 3dp, not the 2dp display value`);
  assert.ok(Number.isFinite(ci.lo) && Number.isFinite(ci.hi) && ci.lo <= ci.mean && ci.mean <= ci.hi);
});

test('evaluate: netExpectancy.ci carries the exact-field clustered mean', () => {
  const preds = rows(30);
  const ev = evaluate(preds, { now: 't' });
  assert.ok(ev.netExpectancy && ev.netExpectancy.ci);
  assert.ok(Math.abs(ev.netExpectancy.ci.mean - 0.1234) <= 1e-3, `got ${ev.netExpectancy.ci.mean}`);
});
