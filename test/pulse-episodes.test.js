'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ep = require('../lib/pulse-episodes');

const item = (over = {}) => ({
  headline: 'FDA approves XYZ drug', tickers: ['XYZ'], category: 'ticker',
  lifecycleState: 'Emerging', actionState: 'INVESTIGATE NOW', evidenceState: 'Multi-source',
  sentiment: 'bullish', crowding: 'early', rank: 1, independentSources: 2, enrichment: { ret3: 2 }, ...over,
});
const clock = ts => () => ts;

test('episodeKey: tickers key on primary; macro keys on theme slug', () => {
  assert.equal(ep.episodeKey({ tickers: ['TSLA', 'AAPL'] }), 'T:AAPL');
  assert.ok(ep.episodeKey({ tickers: [], headline: 'Rate cut inflation surprise' }).startsWith('M:'));
});

test('sameEpisode: ticker overlap = same; disjoint tickers = different', () => {
  assert.equal(ep.sameEpisode({ tickers: ['XYZ'] }, { tickers: ['XYZ', 'ABC'] }), true);
  assert.equal(ep.sameEpisode({ tickers: ['XYZ'] }, { tickers: ['ABC'] }), false);
});

test('sameEpisode: two macro themes cluster on shared significant words', () => {
  assert.equal(ep.sameEpisode(
    { tickers: [], headline: 'Inflation surprise rattles bonds' },
    { tickers: [], headline: 'Bonds sell off on inflation surprise' }), true);
  assert.equal(ep.sameEpisode(
    { tickers: [], headline: 'Oil spikes on supply shock' },
    { tickers: [], headline: 'Gold rallies to record' }), false);
});

test('foldSnapshot: creates an episode + emits an "appeared" transition', () => {
  const { episodes, transitions } = ep.foldSnapshot([], [item()], { date: '2026-07-20', generation: 'g1', now: clock('2026-07-20T20:00:00Z') });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].firstSeenDate, '2026-07-20');
  assert.equal(transitions[0].kind, 'appeared');
  assert.equal(transitions[0].to, 'Emerging');
});

test('foldSnapshot: FIRST-SEEN is immutable across later snapshots (no rewrite)', () => {
  const f1 = ep.foldSnapshot([], [item()], { date: '2026-07-20', generation: 'g1', now: clock('2026-07-20T20:00:00Z') });
  const f2 = ep.foldSnapshot(f1.episodes, [item({ lifecycleState: 'Crowded', crowding: 'crowded', enrichment: { ret3: 40 } })],
    { date: '2026-07-25', generation: 'g2', now: clock('2026-07-25T20:00:00Z') });
  assert.equal(f2.episodes.length, 1, 'same episode, not a duplicate');
  assert.equal(f2.episodes[0].firstSeenDate, '2026-07-20');
  assert.equal(f2.episodes[0].firstSeenState.lifecycleState, 'Emerging');
  assert.deepEqual(f2.episodes[0].firstSeenEnrichment, { ret3: 2 }, 'first-seen enrichment preserved');
});

test('foldSnapshot: emits a lifecycle transition when the stage changes', () => {
  const f1 = ep.foldSnapshot([], [item({ lifecycleState: 'Emerging' })], { date: '2026-07-20', generation: 'g1', now: clock('2026-07-20T20:00:00Z') });
  const f2 = ep.foldSnapshot(f1.episodes, [item({ lifecycleState: 'Building' })], { date: '2026-07-21', generation: 'g2', now: clock('2026-07-21T20:00:00Z') });
  const lc = f2.transitions.find(t => t.kind === 'lifecycle');
  assert.ok(lc);
  assert.equal(lc.from, 'Emerging');
  assert.equal(lc.to, 'Building');
});

test('foldSnapshot: emits an evidence transition (Search-summary → Multi-source)', () => {
  const f1 = ep.foldSnapshot([], [item({ evidenceState: 'Search-summary only' })], { date: '2026-07-20', generation: 'g1', now: clock('2026-07-20T20:00:00Z') });
  const f2 = ep.foldSnapshot(f1.episodes, [item({ evidenceState: 'Multi-source' })], { date: '2026-07-21', generation: 'g2', now: clock('2026-07-21T20:00:00Z') });
  const ev = f2.transitions.find(t => t.kind === 'evidence');
  assert.ok(ev);
  assert.equal(ev.to, 'Multi-source');
});

test('foldSnapshot: does NOT mutate the input ledger (immutable)', () => {
  const prev = [];
  const f1 = ep.foldSnapshot(prev, [item()], { date: '2026-07-20', generation: 'g1', now: clock('2026-07-20T20:00:00Z') });
  assert.equal(prev.length, 0, 'input array untouched');
  const snapshot = JSON.stringify(f1.episodes);
  ep.foldSnapshot(f1.episodes, [item({ lifecycleState: 'Building' })], { date: '2026-07-21', generation: 'g2', now: clock('2026-07-21T20:00:00Z') });
  assert.equal(JSON.stringify(f1.episodes), snapshot, 'prior fold result unchanged by a later fold');
});

test('ageDays: whole-day distance, floored at 0, tolerant of bad input', () => {
  assert.equal(ep.ageDays('2026-07-20', '2026-07-25'), 5);
  assert.equal(ep.ageDays('2026-07-25', '2026-07-20'), 0);
  assert.equal(ep.ageDays(null, '2026-07-20'), 0);
});
