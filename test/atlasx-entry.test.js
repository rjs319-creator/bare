'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { decideEntry, resolveHistoricalFill } = require('../lib/atlasx-entry');
const { assessAtlasSurvival } = require('../lib/atlasx-survival');
const { prosecute } = require('../lib/atlasx-prosecutor');
const { validateEntryDecision } = require('../lib/atlasx-contracts');

// A cold-start survival read (empty table → prior) for a given entry-state override.
function survivalFor(over = {}) {
  const sig = {
    horizon: 'swing', strategyFamily: 'trend', state: 'ready', side: 'long',
    price: 100, entry: 100, stop: 97,
    ...over,
  };
  return assessAtlasSurvival(sig, { regime: { label: 'neutral' }, table: new Map() }, 'pre-entry');
}

// Two-session candle series: day1 is the signal bar, day2 the earliest executable session.
const CANDLES = [
  { date: '2023-03-01', open: 100, high: 102, low: 99, close: 101, volume: 1_000_000 },
  { date: '2023-03-02', open: 101, high: 103, low: 98, close: 100, volume: 1_000_000 },
];

// ── action mapping ────────────────────────────────────────────────────────────
test('excessive gap → DO_NOT_CHASE', () => {
  const candidate = { side: 'long', gapPct: 0.09, entry: 100, price: 100, target: 110, stop: 97, remainingRR: 3 };
  const d = decideEntry({
    candidate,
    survival: survivalFor({ state: 'ready' }),
    prosecutor: prosecute(candidate, {}),
    ctx: { costBps: 15 },
  });
  assert.strictEqual(d.action, 'DO_NOT_CHASE');
  assert.ok(validateEntryDecision(d).ok, JSON.stringify(validateEntryDecision(d).errors));
});

test('costs flip an apparently positive trade to AVOID', () => {
  const candidate = { side: 'long', gapPct: 0.0, entry: 100, price: 100, target: 103, stop: 99, remainingRR: 3 };
  const cheap = decideEntry({ candidate, survival: survivalFor(), prosecutor: prosecute(candidate, {}), ctx: { costBps: 5 } });
  const dear = decideEntry({ candidate, survival: survivalFor(), prosecutor: prosecute(candidate, {}), ctx: { costBps: 600 } });
  assert.ok(cheap.utilityNow > dear.utilityNow);
  assert.ok(['AVOID', 'NO_TRADE'].includes(dear.action), `got ${dear.action}`);
  assert.ok(validateEntryDecision(dear).ok);
});

test('utilityNow and utilityWait are computed separately', () => {
  const candidate = { side: 'long', state: 'extended', entry: 100, price: 100, target: 112, stop: 96, remainingRR: 3 };
  const d = decideEntry({
    candidate,
    survival: survivalFor({ state: 'extended', price: 108, entry: 100, stop: 96 }),
    prosecutor: prosecute(candidate, {}),
    ctx: { costBps: 15 },
  });
  assert.ok(typeof d.utilityNow === 'number' && typeof d.utilityWait === 'number');
  assert.notStrictEqual(d.utilityNow, d.utilityWait);
});

test('no tradeable setup → NO_TRADE', () => {
  const candidate = { side: 'long' }; // no geometry
  const d = decideEntry({ candidate, survival: survivalFor({ state: 'failed', entry: null, stop: null }), prosecutor: prosecute(candidate, {}), ctx: {} });
  assert.ok(['NO_TRADE', 'AVOID'].includes(d.action));
  assert.ok(validateEntryDecision(d).ok);
});

test('a clean setup can ENTER_NEXT_OPEN and its trigger is not the signal-day close', () => {
  const candidate = { side: 'long', gapPct: 0.005, entry: 100, price: 100, target: 118, stop: 97, remainingRR: 4 };
  const d = decideEntry({ candidate, survival: survivalFor({ state: 'ready' }), prosecutor: prosecute(candidate, {}), ctx: { costBps: 5 } });
  assert.ok(['ENTER_NEXT_OPEN', 'WAIT_FIRST_HOUR'].includes(d.action));
  if (d.action === 'ENTER_NEXT_OPEN') assert.strictEqual(d.trigger.style, 'next_open');
});

// ── historical fills (reuse exec-v1 planFill) — a no-fill is NOT a loss ─────────
test('pullback limit fills ONLY if the limit trades', () => {
  const filled = resolveHistoricalFill(CANDLES, '2023-03-01', { style: 'pullback_limit', trigger: 99, side: 'long' });
  assert.strictEqual(filled.filled, true);
  assert.ok(filled.fillPrice > 0 && filled.fillDate === '2023-03-02');

  const missed = resolveHistoricalFill(CANDLES, '2023-03-01', { style: 'pullback_limit', trigger: 96, side: 'long' });
  assert.strictEqual(missed.filled, false);
  assert.strictEqual(missed.fillPrice, null);        // no-fill is not graded as a loss
});

test('breakout order stays no-fill if the trigger is never reached', () => {
  const noFill = resolveHistoricalFill(CANDLES, '2023-03-01', { style: 'breakout_stop', trigger: 105, side: 'long' });
  assert.strictEqual(noFill.filled, false);
  assert.strictEqual(noFill.fillPrice, null);

  const fill = resolveHistoricalFill(CANDLES, '2023-03-01', { style: 'breakout_stop', trigger: 102, side: 'long' });
  assert.strictEqual(fill.filled, true);
  assert.ok(fill.fillPrice >= 102);
});

test('a deliberate gap-skip is a no-fill, never a loss', () => {
  const skip = resolveHistoricalFill(CANDLES, '2023-03-01', { style: 'gap-skip', side: 'long' });
  assert.strictEqual(skip.filled, false);
  assert.strictEqual(skip.fillPrice, null);
  assert.match(skip.reason, /not a loss/);
});
