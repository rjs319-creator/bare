'use strict';
// The counterfactual harness is what must gate router binding even after its
// evidence inputs land: bindingReady flipping true would otherwise enable a
// capital control never shown to beat equal weight. These tests pin the
// honesty contract: measurements only (verdict always null), pre-registered
// history minimum, no lookahead in the best-recent chaser, abstention = cash,
// and gross-basis labeling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRouterCounterfactual, MIN_HISTORY_DATES } = require('../lib/router-counterfactual');

const day = (i) => `2026-06-${String(i + 1).padStart(2, '0')}`;

// rowsFor: per date, algorithm A earns +2, algorithm B earns -1.
function fixture(nDates, weightsFn) {
  const rows = [], historyDays = [];
  for (let i = 0; i < nDates; i++) {
    rows.push({ date: day(i), algorithm: 'A', excess: 2 });
    rows.push({ date: day(i), algorithm: 'B', excess: -1 });
    historyDays.push({ date: day(i), weights: weightsFn(i) });
  }
  return { rows, historyDays };
}

test('below the pre-registered history minimum the status is INSUFFICIENT_HISTORY', () => {
  const { rows, historyDays } = fixture(10, () => ({ A: 0.5, B: 0.5 }));
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  assert.equal(r.status, 'INSUFFICIENT_HISTORY');
  assert.equal(r.verdict, null);
  assert.equal(r.coverage.remaining, MIN_HISTORY_DATES - 10);
});

test('a router that concentrates in the paying algorithm beats equal weight on the paired metric', () => {
  const { rows, historyDays } = fixture(MIN_HISTORY_DATES, () => ({ A: 0.9, B: 0.1 }));
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  assert.equal(r.status, 'EVALUABLE');
  // router = 0.9*2 + 0.1*(-1) = 1.7 ; equal = 0.5 ; paired diff = 1.2 daily.
  assert.equal(r.arms.router.meanDaily, 1.7);
  assert.equal(r.arms.equal.meanDaily, 0.5);
  assert.equal(r.routerMinusEqual.meanDaily, 1.2);
  assert.equal(r.verdict, null, 'even a winning comparison carries NO verdict — binding is decided elsewhere');
  assert.match(r.returnsBasis, /gross/i);
});

test('a router that concentrates in the LOSING algorithm shows up negative — no whitewash', () => {
  const { rows, historyDays } = fixture(MIN_HISTORY_DATES, () => ({ A: 0.1, B: 0.9 }));
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  assert.ok(r.routerMinusEqual.meanDaily < 0, `expected negative paired diff, got ${r.routerMinusEqual.meanDaily}`);
});

test('all-zero weights are the abstain arm: cash return, counted and disclosed', () => {
  const { rows, historyDays } = fixture(MIN_HISTORY_DATES, () => ({ A: 0, B: 0 }));
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  assert.equal(r.arms.router.meanDaily, 0);
  assert.equal(r.coverage.routerAbstainedDates, MIN_HISTORY_DATES);
});

test('bestRecent uses STRICTLY PRIOR dates — early dates without trailing history are skipped, not guessed', () => {
  const { rows, historyDays } = fixture(MIN_HISTORY_DATES, () => ({ A: 0.5, B: 0.5 }));
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  // The first dates lack the 20-row trailing minimum (2 rows/date → 10 dates needed).
  assert.ok(r.coverage.bestRecentSkippedDates >= 9, `expected early skips, got ${r.coverage.bestRecentSkippedDates}`);
  // Once trailing history exists the chaser correctly picks A (+2).
  assert.ok(r.arms.bestRecent.meanDaily > 1.5, `chaser should converge on A, got ${r.arms.bestRecent.meanDaily}`);
});

test('history dates with no graded rows are excluded, never zero-filled', () => {
  const { rows, historyDays } = fixture(5, () => ({ A: 1 }));
  historyDays.push({ date: '2026-12-25', weights: { A: 1 } });   // no rows for this date
  const r = evaluateRouterCounterfactual({ historyDays, rows });
  assert.equal(r.coverage.evaluatedDates, 5);
});
