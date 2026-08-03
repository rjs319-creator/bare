'use strict';
// Confirmation paths (daily-close vs intraday) + position-aware actions + fail-closed
// recommendation eligibility. Also the wording guarantees: a SHORT never says "buy".
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../lib/patterns/confirm');
const { ACTIONS, ACTION_LABEL, actionFor, noviceLine } = require('../lib/patterns/actions');
const { EP_STATES } = require('../lib/patterns/episodes');

function ep(over = {}) {
  return {
    direction: 'LONG',
    frozen: { trigger: { price: 100, type: 'neckline' }, invalidation: { price: 95 }, target: { price: 110 }, atr: 2 },
    current: { target: 110, invalidation: 95 },
    ...over,
  };
}

test('confirm: daily-close path distinguishes close-through from intraday penetration', () => {
  const closeThrough = C.technicalStatusDaily(ep(), { date: 'd1', open: 99, high: 101.5, low: 98.5, close: 101, volume: 2e6 }, { avgVolume: 1e6 });
  assert.strictEqual(closeThrough.triggered, true);
  assert.strictEqual(closeThrough.penetration, 'close');
  assert.strictEqual(closeThrough.executionIntent, 'next-session');
  const wick = C.technicalStatusDaily(ep(), { date: 'd1', open: 99, high: 101.5, low: 98.5, close: 99.4 });
  assert.strictEqual(wick.triggered, false);
  assert.strictEqual(wick.penetration, 'intraday');
});

test('confirm: intraday path is fail-closed on unknown volume (no confirmation without evidence)', () => {
  const snap = { last: 101, vwap: 100.2, dayHigh: 101.2, dayLow: 99, cumVolume: 5e5, bars: 30 };
  const noVol = C.technicalStatusIntraday(ep(), snap);              // no avgVolume context
  assert.strictEqual(noVol.confirmed, false, 'unknown relVol cannot confirm');
  const withVol = C.technicalStatusIntraday(ep(), { ...snap, cumVolume: 3e6 }, { avgVolume: 1e6 });
  assert.strictEqual(withVol.confirmed, true);
});

test('confirm: a swing setup needs NO intraday feed — the daily path stands alone', () => {
  const st = C.technicalStatusDaily(ep(), { date: 'd1', open: 99, high: 101.5, low: 98.5, close: 101 });
  assert.strictEqual(st.path, 'daily-close');
  assert.strictEqual(st.triggered, true);
});

test('eligibility: no evidence table → fail-closed, with the honest no-history message', () => {
  const e = C.recommendationEligibility({ evidenceTable: null, family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d' });
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /No independently graded Pattern Radar history/);
});

test('eligibility: a cell that exists but is not proven stays ineligible with its reasons', () => {
  const table = { version: 'v', cells: { 'BULL_FLAG|LONG|20d': { proven: false, reasons: ['out-of-sample n 12 < 40'], effectiveN: 12 } } };
  const e = C.recommendationEligibility({ evidenceTable: table, family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d' });
  assert.strictEqual(e.eligible, false);
  assert.match(e.reason, /n 12 < 40/);
});

test('eligibility: only a proven cell grants eligibility', () => {
  const table = { version: 'v', cells: { 'BULL_FLAG|LONG|20d': { proven: true, effectiveN: 60, incrementalLift: 0.08 } } };
  const e = C.recommendationEligibility({ evidenceTable: table, family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d' });
  assert.strictEqual(e.eligible, true);
});

// ---- actions ----

const ELIGIBLE = { eligible: true };
const NOT_ELIGIBLE = { eligible: false };

test('actions: confirmed + fresh + validated → LONG_TRIGGERED / SHORT_TRIGGERED', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: ELIGIBLE, fresh: true, remainingRR: 2 }), ACTIONS.LONG_TRIGGERED);
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'SHORT', eligibility: ELIGIBLE, fresh: true, remainingRR: 2 }), ACTIONS.SHORT_TRIGGERED);
});

test('actions: confirmed but UNVALIDATED family → RESEARCH_ONLY, never a trade call', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: NOT_ELIGIBLE, fresh: true, remainingRR: 2 }), ACTIONS.RESEARCH_ONLY);
});

test('actions: stale data can never be actionable', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: ELIGIBLE, fresh: false, remainingRR: 2 }), ACTIONS.WATCH);
});

test('actions: poor plan quality or vanished reward:risk → AVOID', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: ELIGIBLE, fresh: true, planQuality: 'poor' }), ACTIONS.AVOID);
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: ELIGIBLE, fresh: true, remainingRR: 0.4 }), ACTIONS.AVOID);
});

test('actions: severe conflicting setup → AVOID', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.CONFIRMED, direction: 'LONG', eligibility: ELIGIBLE, fresh: true, remainingRR: 2, conflictSevere: true }), ACTIONS.AVOID);
});

test('actions: position management is direction-aware (hold/trim vs hold/cover)', () => {
  assert.strictEqual(actionFor({ state: EP_STATES.MANAGING, direction: 'LONG', remainingRR: 2 }), ACTIONS.HOLD_LONG);
  assert.strictEqual(actionFor({ state: EP_STATES.MANAGING, direction: 'SHORT', remainingRR: 2 }), ACTIONS.HOLD_SHORT);
  assert.strictEqual(actionFor({ state: EP_STATES.MANAGING, direction: 'LONG', remainingRR: 0.3 }), ACTIONS.TRIM_LONG);
  assert.strictEqual(actionFor({ state: EP_STATES.MANAGING, direction: 'SHORT', remainingRR: 0.3 }), ACTIONS.COVER_SHORT);
});

test('wording: NO short-side action or line ever says "buy"', () => {
  const shortActions = [ACTIONS.SHORT_ENTRY_READY, ACTIONS.SHORT_TRIGGERED, ACTIONS.HOLD_SHORT, ACTIONS.COVER_SHORT];
  for (const a of shortActions) {
    assert.ok(!/buy/i.test(ACTION_LABEL[a]), `${a} label must not say buy`);
    const line = noviceLine(a, { direction: 'SHORT', trigger: 100, invalidation: 105 });
    assert.ok(!/\bbuy\b/i.test(line), `${a} novice line must not say buy: "${line}"`);
  }
});

test('wording: SHORT_TRIGGERED explicitly separates "enter short" from "sell your long"', () => {
  const line = noviceLine(ACTIONS.SHORT_TRIGGERED, { direction: 'SHORT', trigger: 100, invalidation: 105 });
  assert.match(line, /NEW short/);
  assert.match(line, /not a "sell your shares" alert/);
});

test('wording: RESEARCH_ONLY says triggered-but-unproven, not "proven buy"', () => {
  const line = noviceLine(ACTIONS.RESEARCH_ONLY, { direction: 'LONG', trigger: 100, invalidation: 95 });
  assert.match(line, /research only/i);
  assert.match(line, /no independently validated edge/i);
  assert.ok(!/proven/i.test(ACTION_LABEL[ACTIONS.RESEARCH_ONLY]) || /unproven/i.test(ACTION_LABEL[ACTIONS.RESEARCH_ONLY]));
});
