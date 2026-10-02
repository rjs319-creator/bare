'use strict';
// lib/exec-paper-measure — measurement of the paper ledger against the Scoreboard's
// daily-bar resolution: fill rates, slippage per cost tier, stop-first vs target-first
// (sameDayAmbiguous), and the reconciliation check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/exec-paper-measure');

const row = (over = {}) => ({
  rowId: 'r', symbol: 'ABC', side: 'long', grade: 'A', timeframe: 'swing', costTier: 'liquid', entryType: 'limit',
  entry: 100, stop: 95, target: 110, risk: 5, filled: true, fillPx: 100.1, exitKind: 'none', exitPx: null, realizedR: null,
  slippageVsFrozen: { px: 0.1, bps: 10 }, ...over,
});

test('fillRates: per grade and per timeframe, unfilled rows counted as placed', () => {
  const rows = [row({ rowId: 'a' }), row({ rowId: 'b', grade: 'B', timeframe: 'intraday', filled: false, fillPx: null, slippageVsFrozen: null }), row({ rowId: 'c', grade: 'B', timeframe: 'intraday' })];
  const fr = M.fillRates(rows);
  assert.deepEqual(fr.byGrade.A, { placed: 1, filled: 1, rate: 1 });
  assert.deepEqual(fr.byGrade.B, { placed: 2, filled: 1, rate: 0.5 });
  assert.deepEqual(fr.byTimeframe.intraday, { placed: 2, filled: 1, rate: 0.5 });
  assert.deepEqual(fr.total, { placed: 3, filled: 2, rate: +(2 / 3).toFixed(3) });
  assert.deepEqual(M.fillRates([]).total, { placed: 0, filled: 0, rate: null });
});

test('slippageByTier: quantiles of fill − frozen level in bps, only filled rows, per cost tier', () => {
  const rows = [
    row({ rowId: 'a', slippageVsFrozen: { px: 0.1, bps: 10 } }),
    row({ rowId: 'b', slippageVsFrozen: { px: 0.3, bps: 30 } }),
    row({ rowId: 'c', slippageVsFrozen: { px: -0.1, bps: -10 } }),
    row({ rowId: 'd', costTier: 'small', slippageVsFrozen: { px: 0.5, bps: 50 } }),
    row({ rowId: 'e', filled: false, slippageVsFrozen: null }),
  ];
  const s = M.slippageByTier(rows);
  assert.equal(s.liquid.n, 3);
  assert.equal(s.liquid.medianBps, 10);
  assert.equal(s.liquid.p25Bps, 0);
  assert.equal(s.liquid.p75Bps, 20);
  assert.equal(s.liquid.meanBps, 10);
  assert.equal(s.liquid.priorBps, 8, 'lib/costs TIERS liquid halfSpread 3 + slippage 5 — reported for recalibration, never changed here');
  assert.equal(s.small.n, 1);
  assert.equal(s.small.priorBps, 30);
  assert.equal(s.micro, undefined, 'tiers with no fills are absent, never zero-filled');
});

test('dailyBarResolution mirrors lib/outcome resolveTrade: stop-first on an ambiguous bar, gap-through at the open', () => {
  const r = row();
  // both barriers inside the bar → stop first (conservative) AND flagged ambiguous
  const both = M.dailyBarResolution(r, { open: 100, high: 111, low: 94, close: 105 });
  assert.equal(both.exitKind, 'stop'); assert.equal(both.sameDayAmbiguous, true); assert.equal(both.exitPx, 95);
  assert.equal(both.dailyR, -1);
  const tgt = M.dailyBarResolution(r, { open: 100, high: 111, low: 98, close: 109 });
  assert.equal(tgt.exitKind, 'target'); assert.equal(tgt.sameDayAmbiguous, false); assert.equal(tgt.dailyR, 2);
  const none = M.dailyBarResolution(r, { open: 100, high: 104, low: 98, close: 103 });
  assert.equal(none.exitKind, 'horizon'); assert.equal(none.exitPx, 103); assert.equal(none.dailyR, 0.6);
  const gap = M.dailyBarResolution(r, { open: 92, high: 96, low: 90, close: 93 });
  assert.equal(gap.exitKind, 'stop'); assert.equal(gap.exitPx, 92, 'gapped through the stop → fills at the open');
  // short: mirrored
  const s = row({ side: 'short', entry: 100, stop: 105, target: 90, risk: 5 });
  const sh = M.dailyBarResolution(s, { open: 100, high: 102, low: 89, close: 91 });
  assert.equal(sh.exitKind, 'target'); assert.equal(sh.dailyR, 2);
  assert.equal(M.dailyBarResolution(r, null), null);
  assert.equal(M.dailyBarResolution(r, { open: 'x' }), null);
});

test('compareDailyBar: paper exit vs daily-bar exit per row, with ambiguity and coverage counts', () => {
  const rows = [
    row({ rowId: 'agree', exitKind: 'target', exitPx: 110, realizedR: 1.98 }),
    row({ rowId: 'disagree', symbol: 'DEF', exitKind: 'target', exitPx: 110, realizedR: 1.98 }),   // daily bar says stop (ambiguous)
    row({ rowId: 'open', symbol: 'GHI', exitKind: 'none' }),
    row({ rowId: 'unfilled', symbol: 'JKL', filled: false, fillPx: null }),
    row({ rowId: 'nobar', symbol: 'MNO', exitKind: 'stop', exitPx: 95 }),
  ];
  const bars = {
    ABC: { open: 100, high: 111, low: 98, close: 109 },
    DEF: { open: 100, high: 111, low: 94, close: 105 },
    GHI: { open: 100, high: 104, low: 98, close: 103 },
    JKL: { open: 100, high: 104, low: 98, close: 103 },
  };
  const c = M.compareDailyBar(rows, bars);
  assert.deepEqual(c.counts, { placed: 5, compared: 2, agree: 1, disagree: 1, sameDayAmbiguous: 1, paperOpen: 1, notFilled: 1, noBar: 1 });
  const d = c.rows.find((x) => x.rowId === 'disagree');
  assert.equal(d.paperExit, 'target'); assert.equal(d.dailyExit, 'stop'); assert.equal(d.agree, false); assert.equal(d.sameDayAmbiguous, true);
  assert.equal(d.paperR, 1.98); assert.equal(d.dailyR, -1);
  assert.equal(c.rows.find((x) => x.rowId === 'unfilled').dailyExit, 'horizon', 'daily bar still resolved — only the paper side is missing');
});

test('reconciliationCheck: every snapshot row id appears in the plan or carries notPlaced; extras and duplicates flagged', () => {
  const plan = { orders: [{ rowId: 'a' }], notPlaced: [{ rowId: 'b', reason: 'no-stop' }] };
  assert.deepEqual(M.reconciliationCheck(['a', 'b'], plan), { ok: true, missing: [], extra: [], duplicates: [] });
  assert.deepEqual(M.reconciliationCheck(['a', 'b', 'c'], plan), { ok: false, missing: ['c'], extra: [], duplicates: [] });
  assert.deepEqual(M.reconciliationCheck(['a'], plan), { ok: false, missing: [], extra: ['b'], duplicates: [] });
  const dup = { orders: [{ rowId: 'a' }], notPlaced: [{ rowId: 'a', reason: 'x' }] };
  assert.deepEqual(M.reconciliationCheck(['a'], dup), { ok: false, missing: [], extra: [], duplicates: ['a'] });
});

test('summarize: compact read for the Session Board tab + full measurement block', () => {
  const doc = {
    version: 'paper-exec-v1', date: '2026-09-21', snapshotId: 'sb-2026-09-21', snapshotRowIds: ['a', 'b', 'c'], placedAt: '2026-09-21T13:35:00Z', lastPollAt: '2026-09-21T15:05:00Z',
    plan: { orders: [{ rowId: 'a' }, { rowId: 'b' }], notPlaced: [{ rowId: 'c', reason: 'grade-below-B' }] },
    rows: [row({ rowId: 'a', exitKind: 'target', exitPx: 110, realizedR: 1.98 }), row({ rowId: 'b', symbol: 'DEF', grade: 'B', filled: false, fillPx: null, slippageVsFrozen: null })],
    polls: [{ at: 't' }, { at: 't2' }],
  };
  const s = M.summarize(doc);
  assert.equal(s.exists, true);
  assert.equal(s.date, '2026-09-21');
  assert.equal(s.placed, 2); assert.equal(s.filled, 1); assert.equal(s.notPlaced, 1);
  assert.equal(s.medianSlippageBps, 10);
  assert.deepEqual(s.exits, { stop: 0, target: 1, horizon: 0, none: 0 });
  assert.equal(s.reconciliation.ok, true);
  assert.equal(s.polls, 2);
  assert.equal(s.compare, null, 'no bars supplied → no daily-bar comparison, never a fabricated one');
  const withBars = M.summarize(doc, { barByTicker: { ABC: { open: 100, high: 111, low: 94, close: 105 } } });
  assert.equal(withBars.compare.counts.sameDayAmbiguous, 1);
  assert.equal(withBars.compare.counts.disagree, 1);
  assert.deepEqual(M.summarize(null), { exists: false });
});
