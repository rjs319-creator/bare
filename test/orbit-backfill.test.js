'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const BF = require('../lib/orbit-backfill');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Synthetic stock candles + aligned factor candle arrays.
function synth(n, seed) {
  const rnd = lcg(seed);
  let d = new Date('2021-01-04T00:00:00Z');
  let px = 100, spy = 400, xlk = 180, iwm = 200, vix = 18;
  const candles = [], market = [], sector = [], small = [], vol = [];
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const mret = (rnd() - 0.5) * 0.02; spy *= (1 + mret); xlk *= (1 + mret + (rnd() - 0.5) * 0.01);
    iwm *= (1 + mret + (rnd() - 0.5) * 0.015); vix *= (1 + (rnd() - 0.5) * 0.05);
    px *= (1 + 0.9 * mret + 0.001 + (rnd() - 0.5) * 0.02);
    candles.push({ date, open: px, high: px * (1 + rnd() * 0.02), low: px * (1 - rnd() * 0.02), close: px, volume: 2e6 });
    market.push({ date, close: spy }); sector.push({ date, close: xlk }); small.push({ date, close: iwm }); vol.push({ date, close: vix });
  }
  return { candles, factorCandles: { market, sector, small, vol } };
}

test('buildTickerSamples produces PIT samples with features and resolved horizons', () => {
  const { candles, factorCandles } = synth(300, 1);
  const samples = BF.buildTickerSamples({ ticker: 'TEST', tier: 'liquid', sector: 'Technology', candles, factorCandles }, { step: 21, minBars: 160 });
  assert.ok(samples.length > 0, 'built at least one sample');
  const s = samples[0];
  assert.ok(s.decisionDate && s.features && s.horizons);
  assert.ok(s.features.residMom63 != null, 'residual features present');
  assert.ok(s.horizons.days5, 'has a 5-day horizon');
});

test('samples never use a decision date past the resolvable window', () => {
  const { candles, factorCandles } = synth(250, 2);
  const samples = BF.buildTickerSamples({ ticker: 'X', candles, factorCandles }, { step: 10, minBars: 160 });
  const lastDate = candles[candles.length - 1].date;
  for (const s of samples) assert.ok(s.decisionDate < lastDate, 'decision date leaves room to resolve');
});

test('runBackfill orchestrates fetch + build and flags survivorship', async () => {
  const bundle = synth(300, 3);
  const factorBundle = synth(300, 99);   // factor proxies share the date grid
  const fakeFetch = async (ticker) => {
    if (['SPY', 'IWM', '^VIX', 'XLK', 'XLF'].includes(ticker)) return { candles: factorBundle.factorCandles.market.map((m, i) => ({ date: m.date, open: m.close, high: m.close, low: m.close, close: m.close, volume: 1e6 })) };
    return { candles: bundle.candles };
  };
  const out = await BF.runBackfill({ universe: ['AAPL', 'MSFT'], scope: 'large', fetchHistory: fakeFetch, step: 21, minBars: 160 });
  assert.ok(out.nSamples > 0, `built ${out.nSamples} samples`);
  assert.strictEqual(out.researchValidity.survivorshipSafe, false);
  assert.strictEqual(out.researchValidity.productionGrade, false);
});

test('atrPctAt is a positive fraction', () => {
  const { candles } = synth(60, 4);
  const a = BF.atrPctAt(candles, 40);
  assert.ok(a > 0 && a < 1, `atr% ${a}`);
});
