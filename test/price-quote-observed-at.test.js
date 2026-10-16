'use strict';
// /api/price — the quote carries WHEN the market printed it (observedAt), separately from
// when we fetched it (fetchedAt) and from the clock-derived session (marketState). A missing
// provider timestamp stays null; it is never replaced by "now" (review 2026-10, Prompt 2.1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeYahooQuote, isoFromEpochSec } = require('../api/price');

const FRI_CLOSE = Date.parse('2026-10-02T20:00:00Z') / 1000;       // Fri 16:00 ET
const result = (over = {}) => ({
  meta: { regularMarketPrice: 101.5, previousClose: 100, regularMarketTime: FRI_CLOSE, ...(over.meta || {}) },
  timestamp: over.timestamp || [FRI_CLOSE - 600, FRI_CLOSE - 300],
  indicators: { quote: [{ close: over.close || [101.2, 101.5] }] },
});

test('a Saturday read of Friday bars is CLOSED and observed on Friday — not at fetch time', () => {
  const q = shapeYahooQuote(result(), 'CLOSED', '2026-10-03T15:00:00.000Z');
  assert.equal(q.marketState, 'CLOSED');
  assert.equal(q.observedAt, '2026-10-02T20:00:00.000Z');
  assert.equal(q.fetchedAt, '2026-10-03T15:00:00.000Z');
  assert.notEqual(q.observedAt, q.fetchedAt);
  assert.equal(q.source, 'yahoo');
  assert.equal(q.price, '101.50');
  assert.equal(q.changePct, '1.50');
});

test('no provider timestamp → observedAt is null (never the fetch time)', () => {
  const q = shapeYahooQuote(result({ meta: { regularMarketTime: undefined }, timestamp: [] }), 'REGULAR', '2026-10-05T15:00:00.000Z');
  assert.equal(q.observedAt, null);
  assert.equal(q.fetchedAt, '2026-10-05T15:00:00.000Z');
  assert.equal(isoFromEpochSec(null), null);
  assert.equal(isoFromEpochSec('garbage'), null);
  assert.equal(isoFromEpochSec(0), null);
});

test('extended hours: the shown price and its observedAt both come from the last printed bar', () => {
  const post = FRI_CLOSE + 1800;
  const q = shapeYahooQuote(result({ timestamp: [FRI_CLOSE - 300, post, post + 300], close: [101.5, 103, null] }), 'POST', null);
  assert.equal(q.price, '103.00');
  assert.equal(q.afterHours.session, 'post');
  assert.equal(q.observedAt, new Date(post * 1000).toISOString(), 'null trailing bar is skipped with its timestamp');
  assert.equal(q.fetchedAt, null);
});

test('existing fields are unchanged (additive contract) and a meta-less result is null', () => {
  const q = shapeYahooQuote(result(), 'REGULAR', null);
  for (const k of ['price', 'regularPrice', 'change', 'changePct', 'previousClose', 'marketState', 'afterHours']) assert.ok(k in q, k);
  assert.equal(shapeYahooQuote({}, 'REGULAR'), null);
  assert.equal(shapeYahooQuote(null, 'REGULAR'), null);
});
