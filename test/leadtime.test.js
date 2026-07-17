'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const LT = require('../lib/leadtime');

// Build a synthetic candle series: start at `base`, then apply daily close deltas (%).
function series(startDate, base, dailyPct) {
  const out = [];
  let px = base;
  const d = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < dailyPct.length; i++) {
    px = px * (1 + dailyPct[i] / 100);
    const date = new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10);
    out.push({ date, close: +px.toFixed(4), high: +(px * 1.001).toFixed(4), low: +(px * 0.999).toFixed(4) });
  }
  return out;
}

// A name that drifts up slowly for 10 days then breaks +8% cumulative around day ~9.
const EARLY = series('2026-01-01', 100, [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 3, 1, 1, 1, ...Array(60).fill(0.1)]);
// A name that does nothing (never reaches +8%).
const DUD = series('2026-01-01', 100, Array(70).fill(0.02));

test('pickLeadTime: measures days-to-breakout, early share, and MFE for a real move', () => {
  const r = LT.pickLeadTime({ ticker: 'E', date: '2026-01-01', section: 'X', tier: 'T' }, EARLY);
  assert.ok(r.reached, 'should reach the +8% breakout');
  assert.ok(r.daysToBreakout > 0 && r.daysToBreakout < 15);
  assert.ok(r.mfe >= 8);
  assert.ok(r.earlyShare != null && r.earlyShare > 0 && r.earlyShare <= 1);
});

test('pickLeadTime: a name that never moves is not "reached" (false-early)', () => {
  const r = LT.pickLeadTime({ ticker: 'D', date: '2026-01-01', section: 'X', tier: 'T' }, DUD);
  assert.equal(r.reached, false);
  assert.equal(r.daysToBreakout, null);
  assert.ok(r.mfe < 8);
});

test('pickLeadTime: returns null when the forward window has not elapsed', () => {
  const short = series('2026-01-01', 100, [0, 1]); // only 2 bars, pick on last → no forward room
  const r = LT.pickLeadTime({ ticker: 'S', date: '2026-01-02', section: 'X', tier: 'T' }, short);
  assert.equal(r, null);
});

test('§7 acceptance: a screener that signals early but rarely CONVERTS is NOT labeled early', () => {
  // 20 picks, only 2 ever break out → breakoutRate 0.1 < MIN_BREAKOUT_RATE.
  const histMap = new Map();
  const picks = [];
  for (let i = 0; i < 20; i++) {
    const tk = 'DUD' + i;
    histMap.set(tk, i < 2 ? EARLY : DUD);
    picks.push({ ticker: tk, date: '2026-01-01', section: 'NoisyEarly', tier: 'T' });
  }
  const out = LT.computeLeadTime(picks, histMap);
  const row = out.algorithms.find(a => a.key === 'NoisyEarly');
  assert.ok(row.n >= LT.CONFIG.MIN_N);
  assert.equal(row.early, false, 'must not be early without conversion');
  assert.equal(row.verdict, 'low-conversion');
  // And it can never top the "earliest detector" leaderboard (drawn only from converters).
  assert.notEqual(out.leaderboard.earliestDetector, 'NoisyEarly');
});

test('§7: a genuinely-early converting screener earns the label and the leaderboard slot', () => {
  const histMap = new Map();
  const picks = [];
  for (let i = 0; i < 15; i++) {
    const tk = 'G' + i;
    histMap.set(tk, EARLY);
    picks.push({ ticker: tk, date: '2026-01-01', section: 'GoodEarly', tier: 'T' });
  }
  const out = LT.computeLeadTime(picks, histMap);
  const row = out.algorithms.find(a => a.key === 'GoodEarly');
  assert.equal(row.verdict, 'genuinely-early');
  assert.equal(row.early, true);
  assert.equal(out.leaderboard.earliestDetector, 'GoodEarly');
  assert.equal(out.leaderboard.bestMoveCaptured, 'GoodEarly');
});

test('computeLeadTime: below the sample floor → insufficient, never a false verdict', () => {
  const histMap = new Map([['A', EARLY]]);
  const out = LT.computeLeadTime([{ ticker: 'A', date: '2026-01-01', section: 'Thin', tier: 'T' }], histMap);
  const row = out.algorithms.find(a => a.key === 'Thin');
  assert.equal(row.verdict, 'insufficient');
  assert.equal(row.early, false);
});

test('computeLeadTime: missing candle history for a ticker is skipped, not crashed', () => {
  const out = LT.computeLeadTime([{ ticker: 'GHOST', date: '2026-01-01', section: 'X', tier: 'T' }], new Map());
  assert.equal(out.coverage.evaluated, 0);
  assert.equal(out.algorithms.length, 0);
});

test('shorts: earliness measured on the downside (favorable = price falls)', () => {
  const down = series('2026-01-01', 100, [0, -1, -1, -1.5, -2, -3, ...Array(60).fill(-0.05)]);
  const r = LT.pickLeadTime({ ticker: 'SH', date: '2026-01-01', section: 'X', tier: 'T', short: true }, down);
  assert.ok(r.reached, 'downside move should reach the breakout marker');
  assert.ok(r.mfe >= 8);
});
