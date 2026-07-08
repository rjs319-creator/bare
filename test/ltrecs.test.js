// Tests for the long-term "second opinions" rec lenses (lib/ltrecs.js).
const test = require('node:test');
const assert = require('node:assert');
const { momentumRec, technicalRec, fundamentalRec, expertRec, consensusOf } = require('../lib/ltrecs');

const series = closes => closes.map(c => ({ close: c, high: c, low: c, open: c, volume: 1000 }));
const rising = (a, b, n = 300) => series(Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1)));

test('momentumRec: strong uptrend → Buy with positive trailing returns', () => {
  const r = momentumRec(rising(50, 100));
  assert.equal(r.rec, 'Buy');
  assert.ok(r.score > 5);
  assert.match(r.detail, /12mo \+/);
});

test('momentumRec: downtrend → Sell', () => {
  assert.equal(momentumRec(rising(100, 50)).rec, 'Sell');
});

test('momentumRec: thin history → null rec, never a guess', () => {
  assert.equal(momentumRec(series([1, 2, 3])).rec, null);
});

test('technicalRec: stacked uptrend → Buy, most signals bullish', () => {
  const r = technicalRec(rising(40, 120));
  assert.equal(r.rec, 'Buy');
  assert.ok(r.score >= 60);
  assert.match(r.detail, /signals bullish/);
});

test('technicalRec: sustained downtrend → Sell', () => {
  assert.equal(technicalRec(rising(120, 40)).rec, 'Sell');
});

test('fundamentalRec: growth + expanding margins → Buy', () => {
  const r = fundamentalRec({ revGrowth: 14, epsGrowth: 20, revAccel: 3, marginExpanding: true });
  assert.equal(r.rec, 'Buy');
  assert.match(r.detail, /Rev \+14%/);
});

test('fundamentalRec: shrinking + compressing → Sell', () => {
  assert.equal(fundamentalRec({ revGrowth: -8, epsGrowth: -12, revAccel: -2, marginExpanding: false }).rec, 'Sell');
});

test('fundamentalRec: no data → null', () => {
  assert.equal(fundamentalRec(null).rec, null);
});

test('expertRec: mostly buys → Buy with analyst tally', () => {
  const r = expertRec({ strongBuy: 10, buy: 8, hold: 3, sell: 1, strongSell: 0 });
  assert.equal(r.rec, 'Buy');
  assert.match(r.detail, /22 analysts/);
  assert.ok(r.score > 0);
});

test('expertRec: mostly sells → Sell', () => {
  assert.equal(expertRec({ strongBuy: 0, buy: 1, hold: 3, sell: 6, strongSell: 4 }).rec, 'Sell');
});

test('expertRec: no coverage → null', () => {
  assert.equal(expertRec({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }).rec, null);
  assert.equal(expertRec(null).rec, null);
});

test('consensusOf: tallies and leans, ignoring nulls', () => {
  const c = consensusOf(['Buy', 'Buy', 'Buy', 'Hold', null, 'Sell']);
  assert.equal(c.lean, 'Buy');
  assert.equal(c.buy, 3); assert.equal(c.hold, 1); assert.equal(c.sell, 1); assert.equal(c.n, 5);
});

test('consensusOf: all null → no lean', () => {
  assert.equal(consensusOf([null, null]).lean, null);
});
