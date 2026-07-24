'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { gradeBiotechEpisode, summarize, summarizeByArchetype } = require('../lib/biotech-grade');

function mk(closes) {
  return closes.map((c, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1e6 }));
}

test('gradeBiotechEpisode: enters next-open, resolves early horizons, keeps 21 open', () => {
  // decision on day index 0; 8 forward bars → 3 & 5 resolve, 10 & 21 do NOT.
  const candles = mk([10, 10.2, 10.5, 11, 11.5, 12, 12.4, 12.8, 13]);
  const xbi = mk(Array.from({ length: 9 }, (_, i) => 50 + i * 0.1));
  const g = gradeBiotechEpisode({ ticker: 'X', date: '2026-07-01', score: 80, archetype: 'POST_CATALYST', tier: 'Hot' }, { candles, xbi });
  assert.equal(g.graded, true);
  assert.equal(g.byHorizon[3].resolved, true);
  assert.equal(g.byHorizon[5].resolved, true);
  assert.equal(g.byHorizon[21].resolved, false, '21-session horizon must NOT resolve early');
  assert.ok(g.byHorizon[3].xbiRelative != null, 'XBI-relative excess computed');
});

test('gradeBiotechEpisode: no forward data → graded:false, not a fabricated outcome', () => {
  const candles = mk([10]);
  const g = gradeBiotechEpisode({ ticker: 'X', date: '2026-07-01', score: 80 }, { candles, xbi: [] });
  assert.equal(g.graded, false);
});

test('summarize: aggregates only RESOLVED horizons, dedups independent dates', () => {
  const candles = mk([10, 10.2, 10.5, 11, 11.5, 12, 12.4, 12.8, 13, 13.2, 13.4]);
  const xbi = mk(Array.from({ length: 11 }, (_, i) => 50 + i * 0.05));
  const g1 = gradeBiotechEpisode({ ticker: 'A', date: '2026-07-01', archetype: 'POST_CATALYST' }, { candles, xbi });
  const g2 = gradeBiotechEpisode({ ticker: 'B', date: '2026-07-01', archetype: 'POST_CATALYST' }, { candles, xbi });
  const s = summarize([g1, g2], { horizon: 5, metric: 'xbiRelative' });
  assert.equal(s.n, 2);
  assert.equal(s.independentDates, 1, 'same decision date counted once');
  assert.ok('ci95' in s);
});

test('summarizeByArchetype: lanes graded separately', () => {
  const candles = mk([10, 10.2, 10.5, 11, 11.5, 12, 12.4, 12.8, 13, 13.2, 13.4]);
  const xbi = mk(Array.from({ length: 11 }, (_, i) => 50 + i * 0.05));
  const g1 = gradeBiotechEpisode({ ticker: 'A', date: '2026-07-01', archetype: 'POST_CATALYST' }, { candles, xbi });
  const g2 = gradeBiotechEpisode({ ticker: 'B', date: '2026-07-02', archetype: 'PRE_EVENT' }, { candles, xbi });
  const by = summarizeByArchetype([g1, g2], { horizon: 5 });
  assert.ok(by.POST_CATALYST && by.PRE_EVENT, 'both lanes present');
  assert.notEqual(by.POST_CATALYST.n + by.PRE_EVENT.n, 0);
});
