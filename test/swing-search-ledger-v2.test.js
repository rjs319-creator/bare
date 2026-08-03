'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSwingSnapshot, gradeSwingSnapshot, stableIdentity, HORIZONS } = require('../lib/swing-search-ledger');

const swingBuy = (over = {}) => ({
  version: 'swing-v1', action: 'BUY', setup: 'breakout', signedScore: 0.4, evidenceStrength: 6,
  reasons: ['Uptrend'], factors: { price: 100 }, dataAsOf: '2026-07-01',
  benchmarkAvailable: true, sectorAvailable: false,
  plan: { side: 'long', setupType: 'breakout-hold', trigger: 105, invalidation: 96, objective: 118, timeStop: '15 sessions' },
  ...over,
});
const bars = prices => prices.map((p, i) => ({ date: `2026-07-${String(i + 2).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p }));

test('identity is stable across repeated snapshots of the same setup', () => {
  const a = buildSwingSnapshot('AAPL', swingBuy());
  const b = buildSwingSnapshot('AAPL', swingBuy());
  assert.ok(a.identity && a.identity === b.identity);
});

test('a different trigger is a different episode identity', () => {
  const a = buildSwingSnapshot('AAPL', swingBuy());
  const b = buildSwingSnapshot('AAPL', swingBuy({ plan: { ...swingBuy().plan, trigger: 110 } }));
  assert.notStrictEqual(a.identity, b.identity);
});

test('snapshot records the primary recommendation state + freshness envelope', () => {
  const snap = buildSwingSnapshot('AAPL', swingBuy(), {
    primary: {
      action: 'WATCH', setupState: 'forming', direction: 'bullish', version: 'lookup-orchestrator-v1',
      freshness: { freshnessState: 'live', marketSession: 'regular', dataAsOf: '2026-07-01T20:00:00Z' },
      families: [{ family: 'price-trend' }], eventRisks: [], warnings: [],
    },
  });
  assert.strictEqual(snap.primary.action, 'WATCH');
  assert.strictEqual(snap.primary.freshnessState, 'live');
  assert.deepStrictEqual([...snap.primary.families], ['price-trend']);
  assert.strictEqual(snap.missingData.sector, true);
});

test('grading anchors trade returns at the FILL, not day-1 open', () => {
  // Price meanders below the 105 trigger for 4 bars, fills on bar 5, then runs.
  const prices = [100, 101, 100, 102, 106, 108, 110, 112, 111, 113, 115, 116, 117, 118, 119, 120,
    121, 122, 123, 124, 125, 126, 127, 128, 129, 130];
  const g = gradeSwingSnapshot(buildSwingSnapshot('AAPL', swingBuy()), bars(prices));
  assert.strictEqual(g.entryBasis, 'fill');
  assert.ok(g.entryIdx > 0, 'fill happened after day 1');
  assert.ok(Math.abs(g.entry - 105) < 2.2, `entry ~ trigger/gap-open, got ${g.entry}`);
  const h5 = g.byHorizon[5];
  assert.ok(h5.resolved && h5.directional > 0);
});

test('planless rows keep the next-open reference basis', () => {
  const wait = swingBuy({ action: 'WAIT', plan: null });
  const g = gradeSwingSnapshot(buildSwingSnapshot('AAPL', wait), bars(Array.from({ length: 20 }, (_, i) => 100 + i)));
  assert.strictEqual(g.entryBasis, 'next-open');
  assert.strictEqual(g.planOutcome, 'no-plan');
});

test('5-session horizon exists alongside the legacy horizons', () => {
  assert.deepStrictEqual([...HORIZONS], [5, 10, 21, 42, 63]);
});

test('no-fill is still never a loss', () => {
  const g = gradeSwingSnapshot(buildSwingSnapshot('AAPL', swingBuy()), bars(Array.from({ length: 20 }, () => 100)));
  assert.strictEqual(g.filled, false);
  assert.strictEqual(g.planOutcome, 'no-fill');
});
