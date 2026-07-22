'use strict';
// STEP 9a — immutable options decision episodes. Repeated daily appearances of the same
// ticker+lean collapse into ONE episode (so grading isn't inflated by dependent daily
// observations); a lean flip opens a new episode and closes the old; staleness closes an
// abandoned thesis; first-seen (the "decided at" record) is never rewritten.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldEpisodes, leanSide, episodeKey } = require('../lib/options-episodes');

const clock = iso => () => iso;
const row = (ticker, directionState, underlying, extra = {}) => ({ ticker, directionState, underlying, score: 42, ...extra });

test('leanSide maps direction states to coarse thesis sides', () => {
  assert.equal(leanSide('PROVISIONAL_BULLISH'), 'bullish');
  assert.equal(leanSide('PROVISIONAL_BEARISH'), 'bearish');
  assert.equal(leanSide('MIXED'), 'neutral');
  assert.equal(leanSide('DIRECTION_UNKNOWN'), 'neutral');
});

test('repeated daily appearances of the same ticker+lean collapse into ONE episode', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('NVDA', 'PROVISIONAL_BULLISH', 150)], { date: '2026-07-20', now: clock('t1') }));
  ({ episodes: led } = foldEpisodes(led, [row('NVDA', 'PROVISIONAL_BULLISH', 154)], { date: '2026-07-21', now: clock('t2') }));
  ({ episodes: led } = foldEpisodes(led, [row('NVDA', 'PROVISIONAL_BULLISH', 158)], { date: '2026-07-22', now: clock('t3') }));
  const open = led.filter(e => e.status === 'open');
  assert.equal(open.length, 1, 'three appearances = one episode');
  assert.equal(open[0].appearances, 3);
  assert.equal(open[0].snapshots.length, 3);
});

test('first-seen (decided-at) record is immutable across later snapshots', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('AMD', 'PROVISIONAL_BULLISH', 100)], { date: '2026-07-20', now: clock('first') }));
  ({ episodes: led } = foldEpisodes(led, [row('AMD', 'PROVISIONAL_BULLISH', 130, { score: 99 })], { date: '2026-07-21', now: clock('later') }));
  const ep = led.find(e => e.ticker === 'AMD');
  assert.equal(ep.firstSeen, 'first');
  assert.equal(ep.firstSeenDate, '2026-07-20');
  assert.equal(ep.firstSeenState.entryRef, 100, 'entry ref frozen at decision time');
  assert.equal(ep.firstSeenState.score, 42, 'first-seen score not overwritten by later 99');
});

test('a lean flip opens a NEW episode and closes the prior directional one', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('TSLA', 'PROVISIONAL_BULLISH', 300)], { date: '2026-07-20', now: clock('t1') }));
  let out;
  ({ episodes: led, transitions: out } = foldEpisodes(led, [row('TSLA', 'PROVISIONAL_BEARISH', 290)], { date: '2026-07-21', now: clock('t2') }));
  const bull = led.find(e => e.key === 'TSLA:bullish');
  const bear = led.find(e => e.key === 'TSLA:bearish');
  assert.equal(bull.status, 'closed_flip');
  assert.equal(bear.status, 'open');
  assert.ok(out.some(t => t.kind === 'flip'));
  assert.ok(out.some(t => t.kind === 'opened' && t.side === 'bearish'));
});

test('an abandoned thesis goes stale after the gap window', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('COIN', 'PROVISIONAL_BULLISH', 200)], { date: '2026-07-01', now: clock('t1') }));
  // Next fold is 6 days later with a DIFFERENT ticker → COIN not seen, gap 6 > 4.
  let out;
  ({ episodes: led, transitions: out } = foldEpisodes(led, [row('MSFT', 'PROVISIONAL_BULLISH', 400)], { date: '2026-07-07', now: clock('t2') }));
  const coin = led.find(e => e.ticker === 'COIN');
  assert.equal(coin.status, 'closed_stale');
  assert.ok(out.some(t => t.kind === 'stale' && t.ticker === 'COIN'));
});

test('a still-appearing thesis within the gap window stays open', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('COIN', 'PROVISIONAL_BULLISH', 200)], { date: '2026-07-01', now: clock('t1') }));
  ({ episodes: led } = foldEpisodes(led, [row('COIN', 'PROVISIONAL_BULLISH', 205)], { date: '2026-07-03', now: clock('t2') })); // gap 2 <= 4
  assert.equal(led.find(e => e.ticker === 'COIN').status, 'open');
});

test('foldEpisodes never mutates the input ledger', () => {
  let led = [];
  ({ episodes: led } = foldEpisodes(led, [row('NVDA', 'PROVISIONAL_BULLISH', 150)], { date: '2026-07-20', now: clock('t1') }));
  const frozen = JSON.parse(JSON.stringify(led));
  foldEpisodes(led, [row('NVDA', 'PROVISIONAL_BULLISH', 160)], { date: '2026-07-21', now: clock('t2') });
  assert.deepEqual(led, frozen, 'prior ledger untouched by a later fold');
});

test('neutral (mixed/unknown) days form their own episode, distinct from directional', () => {
  assert.equal(episodeKey({ ticker: 'x', directionState: 'MIXED' }), 'X:neutral');
  assert.notEqual(episodeKey({ ticker: 'x', directionState: 'PROVISIONAL_BULLISH' }), 'X:neutral');
});
