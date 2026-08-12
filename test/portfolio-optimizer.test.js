const test = require('node:test');
const assert = require('node:assert');
const { optimizeBook, evaluateBook } = require('../lib/portfolio-optimizer');

const cand = (ticker, expectedNetPct, over = {}) => ({
  ticker, sector: 'Tech', expectedNetPct, idioVol: 0.02, dollarVol: 50e6, ...over,
});

test('allocates toward higher net expectation and never exceeds gross or name caps', () => {
  // Arrange
  const out = optimizeBook([cand('A', 3), cand('B', 1), cand('C', 0.5)], { maxSectorWeight: 1 });

  // Assert
  const gross = Object.values(out.weights).reduce((a, w) => a + w, 0);
  assert.ok(gross <= 1.0 + 1e-9, 'gross must never exceed 100%');
  for (const w of Object.values(out.weights)) assert.ok(w <= 0.10 + 1e-9, 'per-name cap');
  assert.ok((out.weights.A || 0) >= (out.weights.C || 0), 'higher net expectation gets at least as much');
});

test('holds cash when every candidate has negative expected net — abstention is the answer', () => {
  // Arrange/Act
  const out = optimizeBook([cand('A', -0.5), cand('B', -1)]);

  // Assert
  assert.deepStrictEqual(out.weights, {});
  assert.strictEqual(out.book.cash, 1);
  assert.strictEqual(out.reasons.A, 'negative-marginal-utility');
});

test('sector cap binds: a one-sector cohort cannot exceed maxSectorWeight', () => {
  const out = optimizeBook([cand('A', 3), cand('B', 3), cand('C', 3), cand('D', 3)], { maxSectorWeight: 0.02 });
  const gross = Object.values(out.weights).reduce((a, w) => a + w, 0);
  assert.ok(gross <= 0.02 + 1e-9);
  // Names shut out by the binding cap say so.
  const blocked = Object.entries(out.reasons).filter(([t]) => !(out.weights[t] > 0)).map(([, r]) => r);
  assert.ok(blocked.every(r => r === 'at-sector-cap'), JSON.stringify(out.reasons));
});

test('impact inside the objective: an illiquid name gets less weight than an identical liquid one', () => {
  // Arrange — same expectation and vol; only ADV differs. Small book so impact binds.
  const out = optimizeBook(
    [cand('LIQ', 1.2, { dollarVol: 500e6 }), cand('ILLIQ', 1.2, { dollarVol: 300e3 })],
    { bookUsd: 1e6, maxSectorWeight: 1 },
  );

  // Assert
  assert.ok((out.weights.LIQ || 0) > (out.weights.ILLIQ || 0),
    `liquid ${out.weights.LIQ} should out-weight illiquid ${out.weights.ILLIQ}`);
});

test('optimizer book scores at least as well as equal-weight and rank-weight under the identical objective', () => {
  // Arrange — heterogeneous cohort where naive schemes overspend on bad names.
  const cohort = [
    cand('A', 2.0, { idioVol: 0.015 }), cand('B', 0.8, { idioVol: 0.05 }),
    cand('C', 0.2, { idioVol: 0.06 }), cand('D', -0.5), cand('E', 1.1, { dollarVol: 400e3 }),
  ];

  // Act
  const out = optimizeBook(cohort, { maxSectorWeight: 1, bookUsd: 1e6 });

  // Assert
  assert.ok(out.book.value >= out.comparisons.equalWeight.value - 1e-9, 'must not lose to equal weight');
  assert.ok(out.book.value >= out.comparisons.rankWeight.value - 1e-9, 'must not lose to rank weight');
});

test('turnover penalty holds the prior book when the improvement is marginal', () => {
  // Arrange — B is negligibly better than the incumbent A.
  const prior = { A: 0.05 };
  const hold = optimizeBook([cand('A', 1.0), cand('B', 1.001)], { priorWeights: prior, lambdaTurnover: 0.5, maxSectorWeight: 1 });

  // Assert — A (no turnover charge up to its prior) is not dumped for a 0.001 edge.
  assert.ok((hold.weights.A || 0) >= (hold.weights.B || 0));
});

test('evaluateBook charges exiting the prior as turnover too', () => {
  const cohort = [cand('A', 1)];
  const withExit = evaluateBook({}, cohort, { priorWeights: { GONE: 0.10 }, lambdaTurnover: 0.1 });
  assert.strictEqual(withExit.turnover, 0.1);
  assert.ok(withExit.value < 0, 'unwinding the prior book is not free');
});

test('the result declares shadow status, zero live weight, and the diagonal-risk honesty note', () => {
  const out = optimizeBook([cand('A', 1)]);
  assert.strictEqual(out.shadow, true);
  assert.strictEqual(out.liveWeight, 0);
  assert.match(out.riskModel, /no pairwise covariance/i);
});
