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

test('a stale prior-session name keeps its freshness flags on the Best Opportunity card', () => {
  const stale = pick('OLD', {
    barIsToday: false, paced: false,
    freshness: { candidateDate: '2026-07-21', freshnessStatus: 'PRIOR_SESSION', barIsToday: false },
  });
  const [card] = buildBestOpportunities([stale]);
  assert.equal(card.barIsToday, false);
  assert.equal(card.freshness.freshnessStatus, 'PRIOR_SESSION');   // the UI can flag it as stale
  assert.equal(card.date, '2026-07-22');
});

test('the card never loses the average volume the spec requires', () => {
  const [card] = buildBestOpportunities([pick('AAA', { avgVol: 2_222_222 })]);
  assert.equal(card.avgVol, 2_222_222);
});
