'use strict';
// Regression: before the open Yahoo's v7 regularMarketPreviousClose is still one session
// stale (2026-10-27 08:54 ET: CLF 13.90 = the 10-23 close; the real prior close was 13.38 =
// regularMarketPrice). Every premarket gap was measured against the wrong base.
const test = require('node:test');
const assert = require('node:assert');
const { regularPrevCloseOf } = require('../lib/quote-provider');

test('premarket: the last regular close is regularMarketPrice', () => {
  assert.strictEqual(regularPrevCloseOf({ marketState: 'PRE', regularMarketPrice: 13.38, regularMarketPreviousClose: 13.9 }), 13.38);
});

test('regular session: regularMarketPreviousClose is used', () => {
  assert.strictEqual(regularPrevCloseOf({ marketState: 'REGULAR', regularMarketPrice: 13.6, regularMarketPreviousClose: 13.38 }), 13.38);
});

test('missing market state falls back to regularMarketPreviousClose', () => {
  assert.strictEqual(regularPrevCloseOf({ regularMarketPrice: 13.6, regularMarketPreviousClose: 13.38 }), 13.38);
});

test('no previous close at all → null', () => {
  assert.strictEqual(regularPrevCloseOf({ marketState: 'REGULAR', regularMarketPrice: 13.6 }), null);
});
