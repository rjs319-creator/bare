// Tests for the long-term daily read + dual-horizon combiner (lib/longterm.js).
const test = require('node:test');
const assert = require('node:assert');
const { longTermRead, combineDualRead, stSide } = require('../lib/longterm');

// Build a daily candle series from an array of closes (highs = closes).
const series = closes => closes.map((c, i) => ({ date: `d${i}`, open: c, high: c, low: c, close: c, volume: 1000 }));

// A steadily rising 260-session series ending at `end`.
function rising(start, end, n = 260) {
  const closes = [];
  for (let i = 0; i < n; i++) closes.push(start + ((end - start) * i) / (n - 1));
  return series(closes);
}
function falling(start, end, n = 260) { return rising(start, end, n); } // linear either way

test('longTermRead: strong uptrend above rising SMAs reads bullish', () => {
  const stock = rising(50, 100);      // +100% over the year, near highs
  const spy = rising(400, 420);       // SPY roughly flat → stock is a leader
  const r = longTermRead(stock, spy);
  assert.equal(r.trend, 'bullish');
  assert.ok(r.score >= 3, `score ${r.score} should clear the bull threshold`);
  assert.ok(r.factors.pctFrom200 > 0);
});

test('longTermRead: sustained downtrend reads bearish', () => {
  const stock = falling(100, 50);     // halved over the year
  const spy = rising(400, 440);       // SPY up while stock falls → laggard
  const r = longTermRead(stock, spy);
  assert.equal(r.trend, 'bearish');
  assert.ok(r.score <= -3, `score ${r.score} should clear the bear threshold`);
});

test('longTermRead: insufficient history is flagged neutral', () => {
  const r = longTermRead(series([1, 2, 3, 4, 5]), null);
  assert.equal(r.trend, 'neutral');
  assert.equal(r.insufficient, true);
});

test('longTermRead: works without SPY (RS factors skipped)', () => {
  const r = longTermRead(rising(50, 100), null);
  assert.equal(r.trend, 'bullish');
  assert.equal(r.factors.rs3mPct, undefined);
});

test('stSide maps actions to coarse sides', () => {
  assert.equal(stSide('STRONG_BUY'), 'bullish');
  assert.equal(stSide('SELL'), 'bearish');
  assert.equal(stSide('HOLD'), 'neutral');
});

test('combineDualRead: short-term bearish + long-term bullish = pullback-buy', () => {
  const d = combineDualRead('STRONG_SELL', 'bullish');
  assert.equal(d.setupClass, 'pullback-buy');
  assert.equal(d.quadrant, 'bearish|bullish');
  assert.match(d.verdict, /Pullback/);
});

test('combineDualRead: both bearish = confirmed downtrend', () => {
  const d = combineDualRead('SELL', 'bearish');
  assert.equal(d.setupClass, 'downtrend');
  assert.equal(d.stance, 'avoid');
});

test('combineDualRead: both bullish = trend continuation', () => {
  const d = combineDualRead('STRONG_BUY', 'bullish');
  assert.equal(d.setupClass, 'trend-continuation');
  assert.equal(d.stance, 'aligned');
});

test('combineDualRead: unknown trend falls back to range', () => {
  const d = combineDualRead('HOLD', undefined);
  assert.equal(d.setupClass, 'range');
});
