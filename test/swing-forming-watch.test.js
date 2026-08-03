'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { swingRead } = require('../lib/swingread');
const { buildLiveSignal, calcEMA, calcRSI, calcMACD, calcAvgVolume, calcATR } = require('../lib/signal');

// Deterministic candle generator (mirrors test/swingread.test.js style).
function gen(n, priceFn, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = priceFn(i);
    const d = new Date(Date.UTC(2026, 0, 5) + i * 86400000);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: c * 0.995, high: c * 1.01, low: c * 0.99, close: c,
      volume: opts.vol ? opts.vol(i) : 1e6,
    });
  }
  return out;
}
const uptrend = n => gen(n, i => 50 + i * 0.4);
const spyFlat = n => gen(n, () => 100);

test('lastBarIncomplete: a forming bar spiking through the pivot cannot confirm a breakout', () => {
  const bars = uptrend(150);
  // Confirmed read off completed bars.
  const confirmed = swingRead(bars.slice(0, -1), spyFlat(149), {});
  // Forming last bar spikes 8% above the pivot on the same inputs.
  const spiked = [...bars.slice(0, -1), { ...bars[bars.length - 1], close: bars[bars.length - 2].close * 1.08, high: bars[bars.length - 2].close * 1.09 }];
  const provisional = swingRead(spiked, spyFlat(150), { lastBarIncomplete: true });
  assert.strictEqual(provisional.provisionalBar, true);
  assert.strictEqual(provisional.action, confirmed.action, 'forming bar does not change the confirmed action');
  assert.strictEqual(provisional.dataAsOf, confirmed.dataAsOf, 'read is anchored to the last CONFIRMED close');
  assert.match(provisional.provisionalNote, /forming/i);
});

test('lastBarIncomplete=false (default) keeps the legacy full-series behavior', () => {
  const bars = uptrend(150);
  assert.deepStrictEqual(swingRead(bars, spyFlat(150), {}), swingRead(bars, spyFlat(150)));
});

test('a constructive WAIT carries a watch plan with trigger/invalidation/objective/timeStop', () => {
  // Strong uptrend but severely extended → WAIT wait-pullback with a plan.
  const bars = gen(150, i => 50 + i * 0.4 + (i >= 145 ? (i - 144) * 6 : 0));
  const r = swingRead(bars, spyFlat(150), {});
  assert.strictEqual(r.action, 'WAIT');
  assert.ok(r.plan, 'WAIT with real evidence still has a watch plan');
  assert.strictEqual(r.plan.watchOnly, true);
  assert.ok(r.plan.trigger > 0 && r.plan.invalidation > 0 && r.plan.objective > r.plan.trigger);
  assert.match(r.plan.timeStop || '', /sessions/);
});

test('BUY/SELL plans carry an explicit timeStop', () => {
  const r = swingRead(uptrend(150), spyFlat(150), {});
  if (r.plan) assert.match(r.plan.timeStop || '', /sessions/);
});

test('intraday score of exactly 0 is neutral: no bull framing, evidence can be 0', () => {
  // Flat series → EMA/VWAP/MACD/RSI all ~flat → tiny/zero score.
  const candles = gen(60, () => 100, { vol: () => 1e6 })
    .map((c, i) => ({ ...c, t: 1_700_000_000 + i * 300, date: new Date((1_700_000_000 + i * 300) * 1000).toISOString() }));
  const closes = candles.map(c => c.close);
  const live = buildLiveSignal(candles,
    calcEMA(closes, 9), calcEMA(closes, 21), calcEMA(closes, 50),
    new Array(candles.length).fill(null), calcRSI(closes, 14), calcMACD(closes),
    calcAvgVolume(candles.map(c => c.volume), 20), calcATR(candles, 14), null, { execAtr: null });
  if (live.score === 0) {
    assert.strictEqual(live.bullish, false, 'score 0 must not read as bullish');
    assert.strictEqual(live.levels, null);
  }
  assert.strictEqual(live.action, 'HOLD');
});

test('execAtr:null declares execution levels unavailable instead of inventing them', () => {
  const candles = gen(60, i => 100 + i, { vol: () => 2e6 })
    .map((c, i) => ({ ...c, t: 1_700_000_000 + i * 300 }));
  const closes = candles.map(c => c.close);
  const live = buildLiveSignal(candles,
    calcEMA(closes, 9), calcEMA(closes, 21), calcEMA(closes, 50),
    new Array(candles.length).fill(null), calcRSI(closes, 14), calcMACD(closes),
    calcAvgVolume(candles.map(c => c.volume), 20), calcATR(candles, 14), null, { execAtr: null });
  assert.strictEqual(live.levels, null, 'no regular-session ATR ⇒ no published levels');
});

test('a tiny ATR (below the cost hurdle) suppresses execution levels', () => {
  const candles = gen(60, i => 100 + i, { vol: () => 2e6 })
    .map((c, i) => ({ ...c, t: 1_700_000_000 + i * 300 }));
  const closes = candles.map(c => c.close);
  const mk = execAtr => buildLiveSignal(candles,
    calcEMA(closes, 9), calcEMA(closes, 21), calcEMA(closes, 50),
    new Array(candles.length).fill(null), calcRSI(closes, 14), calcMACD(closes),
    calcAvgVolume(candles.map(c => c.volume), 20), calcATR(candles, 14), null, { execAtr });
  const thin = mk(0.05);    // 0.05 on a ~$160 stock ≈ 0.03% — cannot clear costs
  assert.strictEqual(thin.levels, null);
  const ok = mk(2.5);
  if (ok.action !== 'HOLD') assert.ok(ok.levels, 'a real ATR publishes levels');
});
