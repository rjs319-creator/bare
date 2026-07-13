'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/evolve-regime');

function trendingSeries(n, start, drift) {
  const c = []; let px = start;
  let d = new Date('2025-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    px *= (1 + drift);
    c.push({ date: d.toISOString().slice(0, 10), open: px, high: px * 1.005, low: px * 0.995, close: px, volume: 1e6 });
    d = new Date(d.getTime() + 86400000);
  }
  return c;
}

test('indexFeatures returns null below 60 bars, features above', () => {
  assert.strictEqual(R.indexFeatures(trendingSeries(30, 100, 0.001)), null);
  const f = R.indexFeatures(trendingSeries(260, 100, 0.001));
  assert.ok(f.aboveSma50 && f.aboveSma200);          // steady uptrend
  assert.ok(f.mom63 > 0);
});

test('buildRegimeVector marks unknown dims when inputs missing', () => {
  const v = R.buildRegimeVector({});
  assert.strictEqual(v.dims.breadth.known, false);
  assert.strictEqual(v.dims.creditStress.known, false);
  assert.ok(v.knownCount < v.of);
});

test('buildRegimeVector: risk-on inputs produce healthy trend scores', () => {
  const up = R.indexFeatures(trendingSeries(260, 100, 0.0015));
  const v = R.buildRegimeVector({
    macro: { asOf: '2026-01-05', regime: 'risk-on', macroRisk: 15, vix: { pctile: 20 }, credit: { belowSma: false } },
    indices: { SPY: up, QQQ: up, IWM: up },
    sectors: [{ name: 'Tech', changePct: 1.2 }, { name: 'Fin', changePct: 0.8 }, { name: 'Energy', changePct: 0.5 }],
  });
  assert.ok(v.dims.spyTrend.value > 0.6);
  assert.ok(v.dims.breadth.value > 0.9);            // all sectors positive
  assert.ok(v.dims.riskAppetite.value > 0.7);
  assert.strictEqual(v.label, 'risk-on');
});

test('regimeSimilarity: identical vectors ≈ 1, opposite < identical', () => {
  const up = R.indexFeatures(trendingSeries(260, 100, 0.0015));
  const down = R.indexFeatures(trendingSeries(260, 100, -0.0012));
  const riskOn = R.buildRegimeVector({ macro: { macroRisk: 15, vix: { pctile: 20 }, credit: {} }, indices: { SPY: up, QQQ: up, IWM: up }, sectors: [{ name: 'a', changePct: 1 }] });
  const riskOff = R.buildRegimeVector({ macro: { macroRisk: 80, vix: { pctile: 95 }, credit: { belowSma: true, sma50: 1, ratio: 0.9 } }, indices: { SPY: down, QQQ: down, IWM: down }, sectors: [{ name: 'a', changePct: -1 }] });
  assert.ok(R.regimeSimilarity(riskOn, riskOn).similarity > 0.98);
  assert.ok(R.regimeSimilarity(riskOn, riskOff).similarity < R.regimeSimilarity(riskOn, riskOn).similarity);
});

test('regimeSimilarity returns null when no shared known dims', () => {
  const a = R.buildRegimeVector({});   // all-unknown except trend defaults
  const b = R.buildRegimeVector({});
  // trend dims default known:false when no indices → no shared known dims
  assert.strictEqual(R.regimeSimilarity(a, b), null);
});

test('similarityWeights normalize to 1 and reward recent+similar', () => {
  const up = R.indexFeatures(trendingSeries(260, 100, 0.0015));
  const cur = R.buildRegimeVector({ macro: { macroRisk: 15, vix: { pctile: 20 }, credit: {} }, indices: { SPY: up, QQQ: up, IWM: up }, sectors: [{ name: 'a', changePct: 1 }] });
  const hist = [
    { asOf: '2026-01-01', vector: cur, ageDays: 5 },
    { asOf: '2020-01-01', vector: cur, ageDays: 2000 },
  ];
  const w = R.similarityWeights(cur, hist);
  const sum = w.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-3);
  assert.ok(w[0].weight > w[1].weight);   // recent identical outweighs ancient identical
});
