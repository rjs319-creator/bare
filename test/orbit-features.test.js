'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../lib/orbit-features');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Build `n` daily candles + aligned factor close series from a seed. Deterministic.
function synth(n, seed) {
  const rnd = lcg(seed);
  const dates = [];
  let d = new Date('2022-01-03T00:00:00Z');
  let px = 100, spy = 400, xlk = 180, iwm = 200, vix = 18;
  const candles = [], marketCloses = [], sectorCloses = [], smallCloses = [], volCloses = [];
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const mret = (rnd() - 0.5) * 0.02;
    spy *= (1 + mret); xlk *= (1 + mret + (rnd() - 0.5) * 0.01);
    iwm *= (1 + mret + (rnd() - 0.5) * 0.015); vix *= (1 + (rnd() - 0.5) * 0.05);
    const idio = 0.0008 + (rnd() - 0.5) * 0.015;  // small positive idiosyncratic drift
    px *= (1 + 0.9 * mret + idio);
    const high = px * (1 + rnd() * 0.01), low = px * (1 - rnd() * 0.01);
    candles.push({ date, open: px * (1 + (rnd() - 0.5) * 0.005), high, low, close: px, volume: Math.round(1e6 * (1 + rnd())) });
    dates.push(date);
    marketCloses.push(spy); sectorCloses.push(xlk); smallCloses.push(iwm); volCloses.push(vix);
  }
  return { candles, factors: { marketCloses, sectorCloses, smallCloses, volCloses } };
}

test('produces a sufficient snapshot with the expected feature families', () => {
  const { candles, factors } = synth(200, 1);
  const snap = F.orbitFeatures(candles, factors);
  assert.ok(snap.sufficient, 'sufficient with 200 bars + factors');
  const f = snap.features;
  for (const k of ['ret5', 'ret21', 'ret63', 'residMom21', 'residConsistency', 'demandAsymmetry', 'drift', 'driftProbPositive', 'udDollarImbalance', 'marketTrend']) {
    assert.ok(k in f, `feature ${k} present`);
  }
  assert.ok(snap.factor.exposures.market != null, 'market beta estimated');
});

test('LEAKAGE GUARD: appending future candles does not change an earlier snapshot', () => {
  const { candles, factors } = synth(200, 2);
  const asOfIdx = 130;
  // Full series, snapshot as-of 130.
  const full = F.orbitFeatures(candles, factors, { asOfIdx });
  // Truncated to exactly 131 bars, snapshot as-of its last bar (=130).
  const truncCandles = candles.slice(0, asOfIdx + 1);
  const truncFactors = {
    marketCloses: factors.marketCloses.slice(0, asOfIdx + 1),
    sectorCloses: factors.sectorCloses.slice(0, asOfIdx + 1),
    smallCloses: factors.smallCloses.slice(0, asOfIdx + 1),
    volCloses: factors.volCloses.slice(0, asOfIdx + 1),
  };
  const trunc = F.orbitFeatures(truncCandles, truncFactors);
  assert.deepStrictEqual(full, trunc, 'snapshot identical with or without future bars');
});

test('LEAKAGE GUARD: mutating a FUTURE candle leaves the earlier snapshot byte-identical', () => {
  const { candles, factors } = synth(200, 3);
  const asOfIdx = 120;
  const before = F.orbitFeatures(candles, factors, { asOfIdx });
  const tampered = candles.map((c, i) => i > asOfIdx ? { ...c, close: c.close * 5, high: c.high * 5 } : c);
  const after = F.orbitFeatures(tampered, factors, { asOfIdx });
  assert.deepStrictEqual(before, after, 'future tampering cannot leak into the past');
});

test('market-beta removal: a pure-beta stock has near-zero residual momentum', () => {
  // Stock that is exactly 1.0*market with no idio → residuals ~0 → residMom ~0.
  const rnd = lcg(4);
  let spy = 400, px = 100;
  const candles = [], marketCloses = [];
  let d = new Date('2022-01-03T00:00:00Z');
  for (let i = 0; i < 180; i++) {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const mret = (rnd() - 0.5) * 0.02; spy *= (1 + mret); px *= (1 + mret);
    candles.push({ date, open: px, high: px * 1.001, low: px * 0.999, close: px, volume: 1e6 });
    marketCloses.push(spy);
  }
  const snap = F.orbitFeatures(candles, { marketCloses });
  assert.ok(Math.abs(snap.features.residMom63) < 5e-3, `residMom63 ~0, got ${snap.features.residMom63}`);
  assert.ok(Math.abs(snap.factor.exposures.market - 1) < 0.03);
});

test('degrades gracefully with too few bars', () => {
  const { candles, factors } = synth(20, 5);
  const snap = F.orbitFeatures(candles, factors);
  assert.strictEqual(snap.sufficient, false);
  assert.ok(snap.missing.bars);
});

test('alignByDate maps to the last factor bar on/before each date (no lookahead)', () => {
  const dates = ['2022-01-03', '2022-01-04', '2022-01-05'];
  const fc = [{ date: '2022-01-02', close: 10 }, { date: '2022-01-04', close: 20 }];
  const out = F.alignByDate(dates, fc);
  assert.deepStrictEqual(out, [10, 20, 20], 'jan-03 uses jan-02 bar; jan-05 uses jan-04');
});
