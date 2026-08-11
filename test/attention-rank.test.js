'use strict';
// ATTENTION RANK — the market-wide rank-acceleration layer. The defects these tests prevent:
// a name with missing data outranking real participation, surge firing on absolute rank
// instead of rank CHANGE, and history from a prior session contaminating today's velocity.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const attn = require('../lib/attention-rank');

const row = (ticker, over = {}) => ({
  ticker, fiveMinChange: 1, volumeAcceleration: 2, currentSessionDollarVolume: 5_000_000,
  relativeVolume: 4, dayChangePct: 10, floatTurnover: 0.3, ...over,
});

test('rank change is computable: a surging name climbs the ranking as its inputs improve', () => {
  const quiet = Array.from({ length: 30 }, (_, i) => row(`Q${i}`, { fiveMinChange: 0.2, volumeAcceleration: 1, relativeVolume: 1.6, dayChangePct: 3, floatTurnover: 0.05 }));
  const before = attn.rankCandidates([...quiet, row('SURGE', { fiveMinChange: 0.2, volumeAcceleration: 1, relativeVolume: 1.6, dayChangePct: 3, floatTurnover: 0.05 })]);
  const after = attn.rankCandidates([...quiet, row('SURGE', { fiveMinChange: 4, volumeAcceleration: 5, relativeVolume: 11, dayChangePct: 30, floatTurnover: 1.2 })]);
  assert.ok(after.byTicker.SURGE.rank < before.byTicker.SURGE.rank, 'improving inputs must improve rank');
  assert.equal(after.byTicker.SURGE.rank, 1);
});

test('missing inputs earn zero — a data-free name cannot outrank real participation', () => {
  const r = attn.rankCandidates([row('REAL'), { ticker: 'EMPTY' }]);
  assert.ok(r.byTicker.REAL.rank < r.byTicker.EMPTY.rank);
});

test('history: a session-date change resets accumulated ranks', () => {
  const ranks = attn.rankCandidates([row('A')]);
  const day1 = attn.updateHistory(null, ranks, '2026-08-10T14:00:00Z', '2026-08-10');
  const day2 = attn.updateHistory(day1, ranks, '2026-08-11T14:00:00Z', '2026-08-11');
  assert.equal(day2.byTicker.A.length, 1, 'prior session history must not carry over');
});

test('attention metrics report rank movement, velocity and surge from real stamps', () => {
  const mkRanks = rank => ({ byTicker: { HOT: { rank, score: 1, floatTurnover: 0.2 + (200 - rank) / 100 } }, universeRanked: 200 });
  const t = m => new Date(Date.UTC(2026, 7, 11, 14, m)).toISOString();
  let doc = null;
  doc = attn.updateHistory(doc, mkRanks(184), t(0), '2026-08-11');
  doc = attn.updateHistory(doc, mkRanks(72), t(10), '2026-08-11');
  doc = attn.updateHistory(doc, mkRanks(21), t(20), '2026-08-11');
  doc = attn.updateHistory(doc, mkRanks(5), t(30), '2026-08-11');
  const m = attn.attentionMetrics(doc, 'HOT', t(30));
  assert.equal(m.rankNow, 5);
  assert.equal(m.rank10mAgo, 21);
  assert.equal(m.rank20mAgo, 72);
  assert.ok(m.velocity > 0, 'improving rank = positive velocity');
  assert.equal(m.surge, true, '#72 → #5 inside 20 minutes into the top 25 is a surge');
  assert.ok(Number.isFinite(m.turnoverVelocityPerMin) && m.turnoverVelocityPerMin > 0, 'turnover velocity from cross-scan deltas');
});

test('no surge for a name that was already top-ranked (rank change, not rank level)', () => {
  const mkRanks = rank => ({ byTicker: { TOP: { rank, score: 1, floatTurnover: null } }, universeRanked: 200 });
  const t = m => new Date(Date.UTC(2026, 7, 11, 14, m)).toISOString();
  let doc = null;
  for (const [min, rank] of [[0, 3], [10, 2], [20, 4], [30, 2]]) doc = attn.updateHistory(doc, mkRanks(rank), t(min), '2026-08-11');
  assert.equal(attn.attentionMetrics(doc, 'TOP', t(30)).surge, false);
});

test('a ticker with no history reports null rank, not a fabricated one', () => {
  assert.equal(attn.attentionMetrics({ byTicker: {} }, 'GHOST').rankNow, null);
});
