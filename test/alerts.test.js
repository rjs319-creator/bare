'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mineText, rankPosts, analyzeEdge, CFG } = require('../lib/alerts');

// Build N graded directional entries with a fixed per-direction excess.
function gradedEntries({ bull = [], bear = [], score = 3, account = 'x' } = {}) {
  const mk = (direction, excess, i) => ({ ticker: 'T' + i, direction, account, weightedSignal: score, score, graded: true, excess });
  let i = 0;
  return [
    ...bull.map(x => mk('bullish', x, i++)),
    ...bear.map(x => mk('bearish', x, i++)),
  ];
}

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

// ── analyzeEdge.fade: the fade harness ───────────────────────────────────────
test('analyzeEdge: fade is the exact inversion of the follow signal', () => {
  // Bullish calls that lost 2% vs market, bearish calls that lost 1% (call wrong).
  const n = CFG.minGradedForEdge;
  const entries = gradedEntries({ bull: Array(n).fill(-2), bear: Array(n).fill(1) });
  const r = analyzeEdge(entries);
  assert.equal(r.meanExcessPct, -1.5, 'following loses on average');           // mean(signed): (-2 + -1)/2
  assert.equal(r.fade.meanExcessPct, +1.5, 'fade mirrors follow exactly');
  assert.equal(r.fade.convictionRankIC, +(-r.convictionRankIC).toFixed(3));
});

test('analyzeEdge: fade splits into a shortable bull bucket and a long bear bucket', () => {
  const n = CFG.minGradedForEdge;
  // Bullish pumps crater (excess -5 → fading them, i.e. SHORT, earns +5).
  // Bearish calls are right (excess -3 → fading them, i.e. LONG, loses -3).
  const entries = gradedEntries({ bull: Array(n).fill(-5), bear: Array(n).fill(-3) });
  const r = analyzeEdge(entries);
  assert.equal(r.fade.byDirection.bull.side, 'short');
  assert.equal(r.fade.byDirection.bear.side, 'long');
  assert.equal(r.fade.byDirection.bull.meanExcessPct, +5, 'fading bullish pumps = profitable short (gross)');
  assert.equal(r.fade.byDirection.bear.meanExcessPct, -3, 'fading correct bearish calls = losing long');
  assert.equal(r.fade.byDirection.bull.hitRatePct, 100);
  assert.equal(r.fade.byDirection.bear.hitRatePct, 0);
});

test('analyzeEdge: trimmedMean strips outliers so a few pump implosions cannot fake an edge', () => {
  const n = CFG.minGradedForEdge;
  // Follow signal ~0 for the body, but a couple of bullish names collapse -60%
  // (fade +60%). Keep #spikes within the 5% trim window so trimming excises them.
  const body = Array(n).fill(0.1);                 // bullish, roughly flat vs market
  const spikes = Array(Math.floor((n + 2) * 0.05)).fill(-60);  // bullish implosions
  const entries = gradedEntries({ bull: [...body, ...spikes] });
  const r = analyzeEdge(entries);
  assert.ok(r.fade.meanExcessPct > r.fade.trimmedMeanExcessPct, 'mean is inflated by the tail');
  assert.ok(Math.abs(r.fade.trimmedMeanExcessPct) < 0.5, 'trimmed center reveals no broad edge');
});
