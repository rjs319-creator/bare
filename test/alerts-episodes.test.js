'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ep = require('../lib/alerts-episodes');

const lead = (o = {}) => ({ ticker: 'AAA', side: 'long', isNewThesis: true, event: 'ENTRY_LONG', sourceKey: 'x:a', handle: 'a', identityKnown: true, publishedAt: '2026-07-21T14:00:00Z', collectedAt: '2026-07-21T15:00:00Z', clusterId: 'c1', coordinated: false, catalysts: ['breakout'], levels: null, horizon: 'swing', execRef: 100, skillWeight: 0, ...o });
const now = () => '2026-07-21T15:00:00Z';

test('episode creation: a new thesis opens exactly one immutable episode', () => {
  const { episodes, transitions } = ep.foldEpisodes([], [lead()], { date: '2026-07-21', now });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].side, 'long');
  assert.equal(episodes[0].firstSeenDate, '2026-07-21');
  assert.equal(episodes[0].execRef, 100);
  assert.ok(transitions.some(t => t.kind === 'opened'));
});

test('no duplicate statistical episodes: repeated posts about the same thesis update ONE episode', () => {
  let st = ep.foldEpisodes([], [lead()], { date: '2026-07-21', now });
  st = ep.foldEpisodes(st.episodes, [lead({ sourceKey: 'x:a', clusterId: 'c1', publishedAt: '2026-07-22T14:00:00Z' })], { date: '2026-07-22', now });
  assert.equal(st.episodes.length, 1);
  assert.equal(st.episodes[0].appearances, 2);
});

test('discovery vs confirmation vs echo credit', () => {
  const leads = [
    lead({ sourceKey: 'x:a', clusterId: 'c1', publishedAt: '2026-07-21T14:00:00Z' }),      // discoverer
    lead({ sourceKey: 'x:b', clusterId: 'c2', publishedAt: '2026-07-21T15:00:00Z' }),      // independent confirmer
    lead({ sourceKey: 'x:c', clusterId: 'c1', publishedAt: '2026-07-21T16:00:00Z' }),      // echo of c1
  ];
  const { episodes } = ep.foldEpisodes([], leads, { date: '2026-07-21', now });
  const roles = episodes[0].contributors.map(c => c.role);
  assert.ok(roles.includes('DISCOVERER'));
  assert.ok(roles.includes('CONFIRMER'));
  assert.ok(roles.includes('ECHO'));
  assert.equal(ep.independentClusterCount(episodes[0]), 2);   // echo does NOT add an independent cluster
});

test('immutable first-seen: a later post never rewrites the decision-time record', () => {
  let st = ep.foldEpisodes([], [lead({ execRef: 100 })], { date: '2026-07-21', now });
  st = ep.foldEpisodes(st.episodes, [lead({ execRef: 250, publishedAt: '2026-07-22T14:00:00Z' })], { date: '2026-07-22', now });
  assert.equal(st.episodes[0].execRef, 100);   // unchanged
  assert.equal(st.episodes[0].firstSeenDate, '2026-07-21');
});

test('direction flip closes the old episode and opens a new one (material change)', () => {
  let st = ep.foldEpisodes([], [lead({ side: 'long' })], { date: '2026-07-21', now });
  st = ep.foldEpisodes(st.episodes, [lead({ side: 'short', event: 'ENTRY_SHORT', publishedAt: '2026-07-22T14:00:00Z' })], { date: '2026-07-22', now });
  const open = st.episodes.filter(e => !e.closedDate);
  assert.equal(open.length, 1);
  assert.equal(open[0].side, 'short');
  assert.ok(st.episodes.some(e => e.closeReason === 'flip'));
});

test('exit/stop lifecycle updates transition status but do NOT create a new prediction', () => {
  let st = ep.foldEpisodes([], [lead()], { date: '2026-07-21', now });
  st = ep.foldEpisodes(st.episodes, [lead({ isNewThesis: false, event: 'STOP_HIT', publishedAt: '2026-07-22T14:00:00Z' })], { date: '2026-07-22', now });
  assert.equal(st.episodes.length, 1);                 // no new episode
  assert.equal(st.episodes[0].status, 'INVALIDATED');
});

test('coordinated leads are RETAINED (coordinatedSeen flagged, kept for grading)', () => {
  const { episodes } = ep.foldEpisodes([], [lead({ coordinated: true })], { date: '2026-07-21', now });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].coordinatedSeen, true);
});

test('bullish and bearish episodes on the same ticker are SEPARATE records', () => {
  const { episodes } = ep.foldEpisodes([], [
    lead({ ticker: 'BBB', side: 'long', clusterId: 'l', sourceKey: 'x:a' }),
    lead({ ticker: 'BBB', side: 'short', event: 'ENTRY_SHORT', clusterId: 's', sourceKey: 'x:b', publishedAt: '2026-07-21T14:30:00Z' }),
  ], { date: '2026-07-21', now });
  // the later short flips the long; but both records exist with distinct ids
  assert.ok(episodes.length >= 2);
  assert.notEqual(episodes[0].id, episodes[1].id);
});

test('unknown-identity lead opens/updates with UNKNOWN role (no account credit)', () => {
  const { episodes } = ep.foldEpisodes([], [lead({ identityKnown: false, sourceKey: null })], { date: '2026-07-21', now });
  assert.equal(episodes[0].firstSourceKey, null);
  assert.equal(episodes[0].contributors[0].role, 'UNKNOWN');
});
