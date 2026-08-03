'use strict';
// Fill-aware grading: no pre-fill stops, honest gap execution, distinct outcomes,
// collision-free keys.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveOutcome, outcomeRecord } = require('../lib/patterns/grade');

const b = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const PLAN = { trigger: 100, stop: 95, target: 110 };

test('grade: a stop hit BEFORE the entry fills is never counted (the core defect)', () => {
  const forward = [
    b('d1', 98, 99, 94, 94.5),    // dips through the stop level — but no fill yet
    b('d2', 95, 100.5, 94.8, 100.2), // reaches the trigger → fill here
    b('d3', 101, 111, 100.5, 110.5), // target
  ];
  const r = resolveOutcome(PLAN, 'LONG', forward, { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'target');
  assert.strictEqual(r.targetFirst, true);
  assert.strictEqual(r.entryDate, 'd2', 'fill located on d2, not graded from d1');
});

test('grade: no forward bar reaches the trigger → distinct no-fill outcome', () => {
  const r = resolveOutcome(PLAN, 'LONG', [b('d1', 96, 99, 95.5, 98), b('d2', 97, 99.5, 96, 99)], { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'no-fill');
  assert.strictEqual(r.filled, false);
});

test('grade: gap through the ENTRY fills at the open (worse price), flagged gapEntry', () => {
  const r = resolveOutcome(PLAN, 'LONG', [b('d1', 103, 111, 102, 110.5)], { horizonBars: 10 });
  assert.strictEqual(r.entryPrice, 103, 'never the (better) trigger price on a gap');
  assert.strictEqual(r.gapEntry, true);
});

test('grade: gap through the STOP exits at the open (worse than the stop)', () => {
  const forward = [
    b('d1', 100.2, 101, 99.8, 100.5),  // fill at trigger
    b('d2', 92, 93, 91, 92.5),          // gaps far below the stop
  ];
  const r = resolveOutcome(PLAN, 'LONG', forward, { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'stop');
  assert.strictEqual(r.exitPrice, 92, 'exit at the gap open, not the stop level');
  assert.strictEqual(r.gapExit, true);
});

test('grade: target and stop inside one daily candle → conservative stop, labeled ambiguous', () => {
  const forward = [
    b('d1', 100.2, 101, 99.8, 100.5),
    b('d2', 100, 111, 94, 100),
  ];
  const r = resolveOutcome(PLAN, 'LONG', forward, { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'ambiguous');
  assert.strictEqual(r.targetFirst, false);
  assert.strictEqual(r.ambiguous, true);
});

test('grade: horizon exhausted after fill → timeout with the honest mark-to-close return', () => {
  const forward = [b('d1', 100.2, 101, 99.8, 100.5), b('d2', 100, 102, 99, 101), b('d3', 101, 103, 100, 102)];
  const r = resolveOutcome(PLAN, 'LONG', forward, { horizonBars: 3 });
  assert.strictEqual(r.outcome, 'timeout');
  assert.ok(r.netReturnPct < r.grossReturnPct, 'costs subtracted');
});

test('grade: SHORT direction mirrors correctly (short target below entry)', () => {
  const plan = { trigger: 100, stop: 105, target: 90 };
  const forward = [
    b('d1', 101, 102, 99.5, 100.5),  // touches trigger from above → fill
    b('d2', 99, 99.5, 89.5, 90.5),    // target hit
  ];
  const r = resolveOutcome(plan, 'SHORT', forward, { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'target');
  assert.ok(r.grossReturnPct > 0, 'a short that falls to target is a WIN');
});

test('grade: empty forward data → data-unavailable, never a fabricated result', () => {
  const r = resolveOutcome(PLAN, 'LONG', [], { horizonBars: 10 });
  assert.strictEqual(r.outcome, 'data-unavailable');
  assert.strictEqual(r.targetFirst, null);
});

test('grade: outcome record key is the full episode key (direction/timeframe/trigger/version included)', () => {
  const ep = {
    key: 'ABC|BULL_FLAG|LONG|20d|2026-05-20|flag-boundary@100|mv1',
    episodeId: 'e1', ticker: 'ABC', family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d',
    patternStart: '2026-05-20', patternAsOf: '2026-06-19', detectedDate: '2026-06-20',
    frozen: { trigger: { price: 100 }, invalidation: { price: 95 }, target: { price: 110 } },
    regimeAtDetection: 'RISK_ON', structuralValidity: 0.9, modelVersion: 'mv1', featureVersion: 'fv1',
  };
  const rec = outcomeRecord(ep, { outcome: 'target', targetFirst: true }, { horizonBars: 21, resolvedAt: 'now' });
  assert.strictEqual(rec.key, ep.key);
  assert.ok(rec.key.includes('LONG') && rec.key.includes('20d') && rec.key.includes('@100') && rec.key.includes('mv1'));
});
