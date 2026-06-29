'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mineText, rankPosts } = require('../lib/alerts');

// ── mineText: pull structured signal out of a post ───────────────────────────
test('mineText: tags catalysts from the thesis language', () => {
  const m = mineText('$ABCD breaking out to new highs ahead of earnings next week');
  assert.ok(m.catalysts.includes('breakout'));
  assert.ok(m.catalysts.includes('earnings'));
});

test('mineText: extracts stated price levels (target / stop / entry)', () => {
  const m = mineText('$XYZ entry 100, target 130, stop 92');
  assert.deepEqual(m.levels, { target: 130, stop: 92, entry: 100 });
});

test('mineText: conviction is high for intense language + emoji, low for tentative', () => {
  const hot = mineText('ALL IN $NVDA 🚀🚀🔥 loading the boat!!!');
  const cool = mineText('watching $NVDA here, maybe a small starter');
  assert.ok(hot.conviction >= 60, `hot was ${hot.conviction}`);
  assert.ok(cool.conviction <= 10, `cool was ${cool.conviction}`);
});

test('mineText: detects options context and timeframe', () => {
  const m = mineText('grabbed $TSLA 300 calls for a swing trade');
  assert.equal(m.options.type, 'calls');
  assert.equal(m.options.strike, 300);
  assert.equal(m.timeframe, 'swing');
});

test('mineText: returns null levels/options when none stated', () => {
  const m = mineText('$SPY looking strong today');
  assert.equal(m.levels, null);
  assert.equal(m.options, null);
});

// ── rankPosts: the mined fields are aggregated onto each ranked alert ─────────
test('rankPosts: surfaces catalysts, conviction, levels, options, timeframe', () => {
  const posts = [
    { text: '$ABCD breakout! target 130 stop 90, 120 calls 🚀🔥 all in', account: 'a1', timestamp: new Date().toISOString() },
    { text: '$ABCD swing long, earnings catalyst coming', account: 'a2', timestamp: new Date().toISOString() },
  ];
  const ranked = rankPosts(posts, {});
  const a = ranked.find(r => r.ticker === 'ABCD' && r.direction === 'bullish');
  assert.ok(a, 'bullish ABCD alert exists');
  assert.ok(a.catalysts.includes('breakout') && a.catalysts.includes('earnings'));
  assert.equal(a.levels.target, 130);
  assert.equal(a.levels.stop, 90);
  assert.equal(a.options.type, 'calls');
  assert.ok(a.conviction >= 50);
  assert.equal(a.timeframe, 'swing');
});
