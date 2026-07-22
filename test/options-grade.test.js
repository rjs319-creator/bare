'use strict';
// STEP 9b — realistic, leakage-resistant episode grading. Entry is the NEXT session's
// OPEN (never the decision-day close), returns are multi-horizon + SPY/sector-relative +
// cost-aware, bearish theses invert, and neutral theses are not graded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextOpenEntry, gradeEpisode, summarizeEpisodes } = require('../lib/options-grade');

// Build a simple ascending candle series. `closes[i]` sets day i; open = prior close.
function series(startDate, closes, { openEqPrevClose = true } = {}) {
  const out = [];
  let d = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    const open = openEqPrevClose && i > 0 ? closes[i - 1] : close;
    out.push({ date: d.toISOString().slice(0, 10), open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close });
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

test('nextOpenEntry enters the session AFTER the decision date, at its open (no close leak)', () => {
  const c = series('2026-07-20', [100, 101, 102, 103]);
  const e = nextOpenEntry(c, '2026-07-20');           // decision on day 0
  assert.equal(e.entryDate, '2026-07-21');            // enter day 1
  assert.equal(e.entryPx, 100);                       // day 1 open = day 0 close (not day 0 close-as-entry)
  assert.equal(e.entryIdx, 1);
});

test('a bullish episode that rises grades positive; cost is deducted', () => {
  const candles = series('2026-07-20', [100, 100, 105, 110, 112, 120]); // entry day1 open=100
  const spy = series('2026-07-20', [100, 100, 100, 100, 100, 100]);      // flat benchmark
  const ep = { id: 'e1', ticker: 'NVDA', side: 'bullish', firstSeenDate: '2026-07-20' };
  const g = gradeEpisode(ep, { candles, spy }, { horizons: [3], costBps: 10 });
  assert.equal(g.graded, true);
  assert.equal(g.entryPx, 100);
  // day 1 entry (100) → +3 sessions = index 4 close = 112 → +12% raw, minus 20bps cost.
  assert.equal(g.horizons[3].rawReturn, 12);
  assert.ok(g.horizons[3].directional < 12 && g.horizons[3].directional > 11.7, 'cost deducted');
  assert.ok(g.horizons[3].excessVsSpy != null);
});

test('a bearish thesis is graded on the inverted move (falling = correct)', () => {
  const candles = series('2026-07-20', [100, 100, 95, 90]); // falls after entry
  const spy = series('2026-07-20', [100, 100, 100, 100]);
  const ep = { id: 'e2', ticker: 'X', side: 'bearish', firstSeenDate: '2026-07-20' };
  const g = gradeEpisode(ep, { candles, spy }, { horizons: [2], costBps: 0 });
  // entry day1 open=100 → +2 sessions close=90 → raw -10%, bearish → directional +10%.
  assert.equal(g.horizons[2].rawReturn, -10);
  assert.equal(g.horizons[2].directional, 10);
});

test('SPY-relative excess strips a broad-market move', () => {
  const candles = series('2026-07-20', [100, 100, 110]); // +10% from entry
  const spy = series('2026-07-20', [100, 100, 106]);      // market +6% over the window
  const ep = { id: 'e3', ticker: 'X', side: 'bullish', firstSeenDate: '2026-07-20' };
  const g = gradeEpisode(ep, { candles, spy }, { horizons: [1], costBps: 0 });
  // raw +10, spy +6 → excess ~ +4 (benchReturn uses open→close, small rounding tolerated).
  assert.ok(g.horizons[1].excessVsSpy >= 3 && g.horizons[1].excessVsSpy <= 5, `got ${g.horizons[1].excessVsSpy}`);
});

test('neutral episodes are context, not graded', () => {
  const g = gradeEpisode({ id: 'n', side: 'neutral', firstSeenDate: '2026-07-20' }, { candles: series('2026-07-20', [1, 2, 3]) });
  assert.equal(g.graded, false);
  assert.equal(g.reason, 'non-directional');
});

test('no forward data → not graded (never grades on the decision bar alone)', () => {
  const candles = series('2026-07-20', [100, 101]); // only one bar after decision
  const g = gradeEpisode({ id: 'e', side: 'bullish', firstSeenDate: '2026-07-21' }, { candles }, { horizons: [5] });
  assert.equal(g.graded, false);
});

test('MFE/MAE are signed to the thesis direction', () => {
  const candles = series('2026-07-20', [100, 100, 108, 96, 104]);
  const g = gradeEpisode({ id: 'e', side: 'bullish', firstSeenDate: '2026-07-20' }, { candles }, { horizons: [3] });
  assert.ok(g.mfe > 0, 'favorable excursion positive for a bull that rallied');
  assert.ok(g.mae < 0, 'adverse excursion negative');
});

test('summarizeEpisodes reports sample, independent dates, hit rate and a CI', () => {
  const graded = [
    { graded: true, decisionDate: '2026-07-20', horizons: { 21: { excessVsSpy: 5 } } },
    { graded: true, decisionDate: '2026-07-20', horizons: { 21: { excessVsSpy: -2 } } },
    { graded: true, decisionDate: '2026-07-22', horizons: { 21: { excessVsSpy: 3 } } },
    { graded: false, reason: 'neutral' },
  ];
  const s = summarizeEpisodes(graded, { horizon: 21, metric: 'excessVsSpy' });
  assert.equal(s.n, 3);
  assert.equal(s.independentDates, 2);
  assert.equal(s.hitRate, 66.7);
  assert.equal(s.ci95.length, 2);
  assert.ok(s.ci95[0] <= s.meanExcess && s.meanExcess <= s.ci95[1]);
});

test('summary honestly reports insufficient data', () => {
  assert.equal(summarizeEpisodes([], {}).n, 0);
});
