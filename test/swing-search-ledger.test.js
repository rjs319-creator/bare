'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSwingSnapshot, gradeSwingSnapshot, summarize, resolvePlan, resolveLogUniverse, lightRegime } = require('../lib/swing-search-ledger');

const swingBuy = () => ({
  action: 'BUY', setup: 'breakout', signedScore: 0.4, evidenceStrength: 6,
  reasons: ['Uptrend'], version: 'swing-v1', dataAsOf: '2024-01-05', freshness: 'daily-close',
  factors: { price: 100, atr: 2 },
  plan: { side: 'long', setupType: 'breakout-hold', trigger: 101, invalidation: 96, objective: 110 },
});
const bars = (prices) => prices.map((p, i) => ({ date: `2024-02-${String(i + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 }));

test('snapshot is immutable and carries the full decision record', () => {
  const s = buildSwingSnapshot('aapl', swingBuy(), { asOf: '2024-01-05', regime: 'risk-on', cohort: 'universe' });
  assert.strictEqual(s.ticker, 'AAPL');
  assert.strictEqual(s.action, 'BUY');
  assert.strictEqual(s.cohort, 'universe');
  assert.strictEqual(s.calibrated, false);
  assert.ok(Object.isFrozen(s));
  assert.throws(() => { 'use strict'; s.action = 'SELL'; });
});

test('searched tickers are tagged separately from the universe cohort', () => {
  const s = buildSwingSnapshot('TSLA', swingBuy(), { cohort: 'searched' });
  assert.strictEqual(s.cohort, 'searched');
});

test('grade computes directional, spy-relative and cost-adjusted returns', () => {
  const snap = buildSwingSnapshot('X', swingBuy(), {});
  // rising forward path (25 sessions) so the 10/21 horizons resolve
  const fwd = bars(Array.from({ length: 25 }, (_, i) => 100 + i));
  const spy = bars(Array.from({ length: 25 }, () => 400));
  const g = gradeSwingSnapshot(snap, fwd, spy);
  assert.strictEqual(g.resolved, true);
  assert.ok(g.byHorizon[10].directional > 0, 'directional gain on a rising path');
  assert.ok(g.byHorizon[10].costAdjusted < g.byHorizon[10].directional, 'costs reduce return');
  assert.ok(g.byHorizon[10].spyRelative > 0, 'beat a flat SPY');
});

test('a no-fill is not graded as a losing trade', () => {
  const snap = buildSwingSnapshot('X', swingBuy(), {});   // trigger 101
  // price never reaches the trigger (stays at 100 and below)
  const fwd = bars(Array.from({ length: 25 }, () => 99));
  const g = gradeSwingSnapshot(snap, fwd, null);
  assert.strictEqual(g.filled, false);
  assert.strictEqual(g.planOutcome, 'no-fill');
});

test('plan resolves to target when the objective is hit first', () => {
  const snap = swingBuy();
  const fwd = bars([100, 102, 105, 111, 108]);   // crosses trigger 101 then objective 110
  const r = resolvePlan(snap.plan, fwd);
  assert.strictEqual(r.filled, true);
  assert.strictEqual(r.outcome, 'target');
});

test('plan resolves to invalidation when structure breaks first', () => {
  const snap = swingBuy();
  const fwd = bars([101.5, 100, 95, 94]);         // fills at 101.5 then breaks 96
  const r = resolvePlan(snap.plan, fwd);
  assert.strictEqual(r.outcome, 'invalidation');
});

test('SELL is graded with inverted direction (a fall is a win)', () => {
  const snap = buildSwingSnapshot('X', {
    action: 'SELL', signedScore: -0.4, evidenceStrength: 6, reasons: [], version: 'swing-v1',
    dataAsOf: '2024-01-05', factors: {},
    plan: { side: 'bearish', setupType: 'breakdown', trigger: 99, invalidation: 104, objective: 90 },
  }, {});
  const fwd = bars(Array.from({ length: 25 }, (_, i) => 100 - i));   // falling
  const g = gradeSwingSnapshot(snap, fwd, null);
  assert.ok(g.byHorizon[10].directional > 0, 'a falling price is a winning short call');
});

test('warm-cron default logs a CONSISTENT liquid panel tagged cohort=universe', () => {
  const a = resolveLogUniverse({ query: {} });
  const b = resolveLogUniverse({ query: {} });
  assert.strictEqual(a.cohort, 'universe');
  assert.ok(a.tickers.length > 50, 'a real panel');
  assert.deepStrictEqual(a.tickers, b.tickers, 'same panel every run (day-over-day consistent)');
});

test('cursor + limit slice the panel without breaking cohort', () => {
  const r = resolveLogUniverse({ query: { cursor: '10', limit: '20' } });
  assert.strictEqual(r.cohort, 'universe');
  assert.strictEqual(r.tickers.length, 20);
});

test('an explicit ticker is tagged cohort=searched, never pooled with the universe', () => {
  const r = resolveLogUniverse({ query: { ticker: 'tsla' } });
  assert.strictEqual(r.cohort, 'searched');
  assert.deepStrictEqual(r.tickers, ['TSLA']);
});

test('lightRegime reads risk-on/off from SPY vs its 50-DMA', () => {
  const up = Array.from({ length: 60 }, (_, i) => ({ close: 400 + i }));
  const down = Array.from({ length: 60 }, (_, i) => ({ close: 460 - i }));
  assert.strictEqual(lightRegime(up), 'risk-on');
  assert.strictEqual(lightRegime(down), 'risk-off');
  assert.strictEqual(lightRegime([]), 'unknown');
});

test('summarize grades BUY / WAIT / SELL separately and excludes no-fills', () => {
  const rows = [
    { resolved: true, action: 'BUY', filled: true, byHorizon: { 10: { resolved: true, directional: 0.05, spyRelative: 0.03 }, 21: {}, 42: {}, 63: {} } },
    { resolved: true, action: 'BUY', filled: false, byHorizon: { 10: { resolved: true, directional: -0.1, spyRelative: -0.1 } } },
    { resolved: true, action: 'SELL', filled: true, byHorizon: { 10: { resolved: true, directional: 0.02, spyRelative: 0.01 }, 21: {}, 42: {}, 63: {} } },
  ];
  const s = summarize(rows);
  assert.strictEqual(s.BUY.total, 2);
  assert.strictEqual(s.BUY.noFill, 1);
  assert.strictEqual(s.BUY.byHorizon[10].n, 1, 'no-fill excluded from P&L');
  assert.strictEqual(s.SELL.byHorizon[10].n, 1);
});
