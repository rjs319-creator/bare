'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { minerviniTemplate, detectVcp } = require('../lib/research/trend-template-vcp');

// Build a synthetic ascending series: `days` bars, price path via fn(i), volume via vol(i).
function candles(days, fn, vol = () => 1e6) {
  const out = [];
  const start = Date.parse('2024-01-01');
  let added = 0, t = 0;
  while (added < days) {
    const d = new Date(start + t * 864e5); t++;
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    const p = fn(added);
    out.push({ date: d.toISOString().slice(0, 10), open: p, high: p * 1.01, low: p * .99, close: p, volume: vol(added) });
    added++;
  }
  return out;
}

test('template passes a steady uptrend near its high', () => {
  const c = candles(280, i => 50 + i * .25);
  const r = minerviniTemplate(c, c.length - 1);
  assert.ok(r && r.pass, JSON.stringify(r));
  assert.ok(r.aboveSma50 && r.aboveSma150 && r.aboveSma200 && r.sma150AboveSma200);
  assert.ok(r.sma200Rising && r.above52wLowBy30pct && r.within25pctOf52wHigh);
});

test('template fails a downtrend', () => {
  const c = candles(280, i => 200 - i * .3);
  const r = minerviniTemplate(c, c.length - 1);
  assert.ok(r && !r.pass);
});

test('template fails far below the 52-week high even in a recent uptrend', () => {
  // Crash then partial recovery: still >25% below the old high.
  const c = candles(280, i => (i < 150 ? 100 + i : 250 - 100 + (i - 150) * .2));
  const r = minerviniTemplate(c, c.length - 1);
  assert.ok(r && !r.within25pctOf52wHigh);
});

test('template returns null with insufficient history', () => {
  const c = candles(100, i => 50 + i * .25);
  assert.strictEqual(minerviniTemplate(c, c.length - 1), null);
});

test('detectVcp finds successively smaller pullbacks with volume dry-up', () => {
  // Uptrend with three pullbacks: -20%, -12%, -6%, shrinking volume into the base.
  const path = [];
  let p = 100;
  const seg = (target, steps) => { const start = p; for (let k = 1; k <= steps; k++) path.push(start + (target - start) * (k / steps)); p = target; };
  seg(150, 40); seg(120, 12); // -20%
  seg(160, 30); seg(140.8, 10); // -12%
  seg(170, 25); seg(159.8, 8); // -6%
  seg(168, 5);
  const total = path.length;
  const c = candles(total, i => path[i], i => (i > total - 25 ? 4e5 : 1e6));
  const r = detectVcp(c, c.length - 1);
  assert.ok(r && r.isVcp, JSON.stringify(r));
  assert.ok(r.contractions.length >= 2 && r.contractions.length <= 5);
  for (let i = 1; i < r.contractions.length; i++) {
    assert.ok(r.contractions[i] < r.contractions[i - 1], 'contractions must shrink');
  }
  assert.ok(r.volumeContraction < 1, 'late volume must be below base volume');
});

test('detectVcp rejects expanding pullbacks', () => {
  const path = [];
  let p = 100;
  const seg = (target, steps) => { const start = p; for (let k = 1; k <= steps; k++) path.push(start + (target - start) * (k / steps)); p = target; };
  seg(150, 40); seg(141, 10); // -6%
  seg(160, 30); seg(140.8, 12); // -12%
  seg(170, 25); seg(136, 15); // -20% — expanding, not contracting
  const total = path.length;
  const c = candles(total, i => path[i]);
  const r = detectVcp(c, c.length - 1);
  assert.ok(!r || !r.isVcp);
});

test('detectVcp returns null on flat tape with no swings', () => {
  const c = candles(260, () => 100);
  const r = detectVcp(c, c.length - 1);
  assert.ok(!r || !r.isVcp);
});

const { geminiVcpScreen } = require('../lib/research/trend-template-vcp');

// Rise-then-tighten tape: 230 bars up to ~150, then 30 flat bars with half the range.
function riseThenTighten() {
  const out = [];
  const start = Date.parse('2024-01-01');
  let added = 0, t = 0;
  while (added < 260) {
    const d = new Date(start + t * 864e5); t++;
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    const rising = added < 230;
    const p = rising ? 50 + added * (100 / 230) : 150;
    const spread = rising ? .02 : .01;
    out.push({ date: d.toISOString().slice(0, 10), open: p, high: p * (1 + spread / 2), low: p * (1 - spread / 2), close: p, volume: 1e6 });
    added++;
  }
  return out;
}

test('geminiVcpScreen passes a tightening base near highs after a big run', () => {
  const c = riseThenTighten();
  const r = geminiVcpScreen(c, c.length - 1);
  assert.ok(r && r.signal, JSON.stringify(r));
  assert.ok(r.trendCondition && r.proximityCondition && r.volatilityCondition);
});

test('geminiVcpScreen fails a downtrend', () => {
  const c = candles(280, i => 200 - i * .3);
  const r = geminiVcpScreen(c, c.length - 1);
  assert.ok(r && !r.signal);
});

test('geminiVcpScreen returns null with insufficient history', () => {
  const c = candles(200, i => 50 + i * .25);
  assert.strictEqual(geminiVcpScreen(c, c.length - 1), null);
});
