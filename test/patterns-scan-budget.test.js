'use strict';
// patternlog time-budget regression (night-1 2026-08-03: the fixed 30s scan budget
// ignored invocation-elapsed time, tracker's 60s maxDuration killed the run, and the
// end-only writes lost everything) + scanPass cursor carry-over across days.
const { test } = require('node:test');
const assert = require('node:assert');
const { grantedScanBudget, PATTERNLOG_SOFT_DEADLINE_MS } = require('../lib/pattern-routes');
const { scanPass } = require('../lib/patterns/scan');

// ---- grantedScanBudget --------------------------------------------------------------

test('budget: default request is 30s and is granted in full when the deadline is far', () => {
  // Arrange / Act
  const { requestedMs, budgetMs } = grantedScanBudget(undefined, PATTERNLOG_SOFT_DEADLINE_MS);
  // Assert
  assert.strictEqual(requestedMs, 30000);
  assert.strictEqual(budgetMs, 30000);
});

test('budget: clamps the grant to the time remaining before the soft deadline', () => {
  const { budgetMs } = grantedScanBudget('30000', 12000);
  assert.strictEqual(budgetMs, 12000);
});

test('budget: never negative — an already-blown deadline grants 0, not a fresh window', () => {
  const { requestedMs, budgetMs } = grantedScanBudget('30000', -5000);
  assert.strictEqual(requestedMs, 30000);
  assert.strictEqual(budgetMs, 0);
});

test('budget: the request itself stays inside the 5s..40s guardrails', () => {
  assert.strictEqual(grantedScanBudget('1', 60000).requestedMs, 5000);
  assert.strictEqual(grantedScanBudget('999999', 60000).requestedMs, 40000);
  assert.strictEqual(grantedScanBudget('garbage', 60000).requestedMs, 30000);
});

// ---- scanPass under a zero budget ---------------------------------------------------

function tickersOf(n) {
  return Array.from({ length: n }, (_, i) => ({ ticker: `T${String(i).padStart(3, '0')}`, band: 'LARGE' }));
}

test('scanPass: zero budget touches no tickers but still returns persistable state', async () => {
  // Arrange
  let fetches = 0;
  // Act
  const { state, results, done } = await scanPass({
    tickers: tickersOf(10), state: null, date: '2026-08-04', budgetMs: 0,
    fetchDaily: async () => { fetches++; return []; },
    analyze: async () => null,
  });
  // Assert
  assert.strictEqual(fetches, 0);
  assert.strictEqual(results.length, 0);
  assert.strictEqual(state.cursor, 0);
  assert.strictEqual(state.date, '2026-08-04');
  assert.strictEqual(state.stats.universe, 10);
  assert.strictEqual(done, false);
});

// ---- scanPass cursor carry-over across days -----------------------------------------

test('scanPass: a new day carries yesterday\'s cursor instead of re-walking the head', async () => {
  const prev = { cursor: 6, date: '2026-08-03', startedAt: 'x', stats: { universe: 10, scanned: 4 } };
  const seen = [];
  const { state } = await scanPass({
    tickers: tickersOf(10), state: prev, date: '2026-08-04', budgetMs: 5000,
    fetchDaily: async t => { seen.push(t); return []; },
    analyze: async () => null,
  });
  assert.strictEqual(seen[0], 'T006', 'must resume where yesterday stopped');
  assert.strictEqual(state.date, '2026-08-04');
  assert.strictEqual(state.stats.scanned, 0, 'per-day stats reset on a new day');
});

test('scanPass: a completed sweep wraps to 0 on the next day', async () => {
  const prev = { cursor: 10, date: '2026-08-03', startedAt: 'x', stats: { universe: 10 } };
  const seen = [];
  await scanPass({
    tickers: tickersOf(10), state: prev, date: '2026-08-04', budgetMs: 5000,
    fetchDaily: async t => { seen.push(t); return []; },
    analyze: async () => null,
  });
  assert.strictEqual(seen[0], 'T000');
});

test('scanPass: same-day resume keeps both cursor and accumulated stats', async () => {
  const prev = { cursor: 3, date: '2026-08-04', startedAt: 'x', stats: { universe: 10, dataFailures: 2 } };
  const seen = [];
  const { state } = await scanPass({
    tickers: tickersOf(10), state: prev, date: '2026-08-04', budgetMs: 5000,
    fetchDaily: async t => { seen.push(t); return []; },
    analyze: async () => null,
  });
  assert.strictEqual(seen[0], 'T003');
  assert.ok(state.stats.dataFailures >= 2, 'same-day stats accumulate, not reset');
});
