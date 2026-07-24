'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBestOpportunities } = require('../lib/screener-routes');

// A pool pick that clears passesQualityGate (pctChange>0, carry>=50, not overextended, no
// fade catalyst) and carries the full point-in-time metadata the scan rows attach.
function pick(ticker, over = {}) {
  return {
    ticker, sector: 'Tech', scan: 'momentum_liquid', tier: 'A',
    pctChange: 5, carry: 70, overextended: false, catalyst: 'NONE',
    relScore: 80, relVol: 3, last: 20, entry: 20, stop: 19, target: 22, rr: 2, riskPct: 5, orb: null,
    avgVol: 1_500_000, date: '2026-07-22',
    barIsToday: true, paced: false,
    freshness: { candidateDate: '2026-07-22', freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    ...over,
  };
}

test('Best Opportunity cards carry the full live metadata (freshness/barIsToday/avgVol/date)', () => {
  const cards = buildBestOpportunities([pick('AAA'), pick('BBB')]);
  assert.equal(cards.length, 2);
  for (const c of cards) {
    for (const k of ['freshness', 'barIsToday', 'paced', 'avgVol', 'date', 'relVol', 'last', 'entry', 'stop', 'target']) {
      assert.ok(k in c, `card is missing ${k}`);
    }
    assert.ok(c.freshness && c.freshness.freshnessStatus, 'freshness object is carried, not dropped');
  }
});

// REDESIGN (was "keeps its freshness flags on the card"): the old test encoded the UNSAFE
// behavior — a stale prior-session name still appeared in Best Opportunities, merely flagged.
// The spec is explicit: "Do not merely expose a stale flag. Enforce it." A prior-session bar
// can DISCOVER a name but never make it a live buy, so it must be EXCLUDED from Best
// Opportunities (the actionable lane), not flagged-and-kept.
test('a stale prior-session name is EXCLUDED from Best Opportunities (not merely flagged)', () => {
  const stale = pick('OLD', {
    barIsToday: false, paced: false,
    freshness: { candidateDate: '2026-07-21', freshnessStatus: 'PRIOR_SESSION', barIsToday: false },
  });
  assert.deepEqual(buildBestOpportunities([stale]), [], 'a stale prior-session name cannot enter the actionable lane');
});

test('a canonically-classified non-actionable card is excluded even if its daily bar looks fresh', () => {
  // The live route stamps the lifecycle envelope. `actionable:false` (e.g. PRIOR_SESSION_WATCH
  // or a retired intraday state) must be excluded regardless of the descriptive daily flags.
  const notLive = pick('NOPE', { actionable: false, lifecycleState: 'PRIOR_SESSION_WATCH' });
  assert.deepEqual(buildBestOpportunities([notLive]), []);
});

test('a canonically ACTIONABLE_NOW card passes the gate', () => {
  const live = pick('YES', { actionable: true, lifecycleState: 'ACTIONABLE_NOW', currentSessionFresh: true });
  const [card] = buildBestOpportunities([live]);
  assert.equal(card.ticker, 'YES');
  assert.equal(card.actionable, true);
  assert.equal(card.lifecycleState, 'ACTIONABLE_NOW');
});

test('the card never loses the average volume the spec requires', () => {
  const [card] = buildBestOpportunities([pick('AAA', { avgVol: 2_222_222 })]);
  assert.equal(card.avgVol, 2_222_222);
});
