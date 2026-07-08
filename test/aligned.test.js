// Tests for the Dual-Confirmed pick ranking (lib/aligned.js).
const test = require('node:test');
const assert = require('node:assert');
const { isAligned, alignedScore, rankAligned } = require('../lib/aligned');

test('isAligned: only trend-continuation qualifies', () => {
  assert.equal(isAligned({ setupClass: 'trend-continuation' }), true);
  assert.equal(isAligned({ setupClass: 'pullback-buy' }), false);   // long-term up but short-term down
  assert.equal(isAligned({ setupClass: 'downtrend' }), false);
  assert.equal(isAligned(null), false);
});

test('alignedScore: both maxed → 100, weak → low', () => {
  assert.equal(alignedScore(10, 10), 100);
  assert.equal(alignedScore(5, 6), 55);
  assert.ok(alignedScore(3, 3) < alignedScore(8, 9));
});

test('alignedScore: clamps out-of-range inputs', () => {
  assert.equal(alignedScore(99, 99), 100);
  assert.equal(alignedScore(-5, -5), 0);
});

test('rankAligned: sorts by conviction, strongest first', () => {
  const out = rankAligned([
    { ticker: 'A', stConf: 4, ltScore: 4 },
    { ticker: 'B', stConf: 9, ltScore: 10 },
    { ticker: 'C', stConf: 6, ltScore: 7 },
  ]);
  assert.deepEqual(out.map(x => x.ticker), ['B', 'C', 'A']);
  assert.equal(out[0].conviction, alignedScore(9, 10));
});

test('rankAligned: ties broken by long-term score', () => {
  const out = rankAligned([
    { ticker: 'lowLT', stConf: 8, ltScore: 4 },
    { ticker: 'highLT', stConf: 6, ltScore: 8 },
  ]);
  // both conviction 60, but highLT has the stronger long-term trend
  assert.equal(out[0].ticker, 'highLT');
});
