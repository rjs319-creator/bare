'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../lib/orbit-ml-features');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

function synth(n, seed) {
  const rnd = lcg(seed);
  let d = new Date('2022-01-03T00:00:00Z');
  let px = 100, spy = 400, xlk = 180, iwm = 200, vix = 18;
  const candles = [], marketCloses = [], sectorCloses = [], smallCloses = [], volCloses = [];
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const mret = (rnd() - 0.5) * 0.02; spy *= (1 + mret); xlk *= (1 + mret + (rnd() - 0.5) * 0.01);
    iwm *= (1 + mret + (rnd() - 0.5) * 0.015); vix *= (1 + (rnd() - 0.5) * 0.05);
    px *= (1 + 0.9 * mret + 0.0008 + (rnd() - 0.5) * 0.015);
    candles.push({ date, open: px, high: px * (1 + rnd() * 0.01), low: px * (1 - rnd() * 0.01), close: px, volume: Math.round(1e6 * (1 + rnd())) });
    marketCloses.push(spy); sectorCloses.push(xlk); smallCloses.push(iwm); volCloses.push(vix);
  }
  return { candles, factors: { marketCloses, sectorCloses, smallCloses, volCloses } };
}

test('adds specialist-evidence features on top of the reused ORBIT snapshot', () => {
  const { candles, factors } = synth(260, 1);
  const snap = F.orbitMlFeatures(candles, factors);
  assert.ok(snap.sufficient);
  for (const k of F.ML_FEATURE_NAMES) assert.ok(k in snap.features, `ml feature ${k} present`);
  // Base ORBIT features still present (reuse, not replace).
  for (const k of ['residMom63', 'drift', 'demandAsymmetry']) assert.ok(k in snap.features);
  assert.ok(Array.isArray(snap.unavailableEvidence) && snap.unavailableEvidence.includes('peadSurprise'));
});

test('LEAKAGE GUARD: appending future candles does not change an earlier ML snapshot', () => {
  const { candles, factors } = synth(260, 2);
  const asOfIdx = 180;
  const full = F.orbitMlFeatures(candles, factors, { asOfIdx });
  const trunc = F.orbitMlFeatures(candles.slice(0, asOfIdx + 1), {
    marketCloses: factors.marketCloses.slice(0, asOfIdx + 1),
    sectorCloses: factors.sectorCloses.slice(0, asOfIdx + 1),
    smallCloses: factors.smallCloses.slice(0, asOfIdx + 1),
    volCloses: factors.volCloses.slice(0, asOfIdx + 1),
  });
  assert.deepStrictEqual(full, trunc, 'ML snapshot identical with or without future bars');
});

test('LEAKAGE GUARD: mutating a FUTURE candle leaves an earlier ML snapshot byte-identical', () => {
  const { candles, factors } = synth(260, 3);
  const asOfIdx = 150;
  const before = F.orbitMlFeatures(candles, factors, { asOfIdx });
  const tampered = candles.map((c, i) => i > asOfIdx ? { ...c, close: c.close * 4, high: c.high * 4, volume: c.volume * 9 } : c);
  const after = F.orbitMlFeatures(tampered, factors, { asOfIdx });
  assert.deepStrictEqual(before, after);
});

test('breakout/dry-up/compression are finite and sensibly bounded', () => {
  const { candles, factors } = synth(260, 4);
  const f = F.orbitMlFeatures(candles, factors).features;
  assert.ok([0, 1].includes(f.breakout20));
  assert.ok(f.volDryUp > 0);
  assert.ok(f.rangeCompression > 0);
  assert.ok(f.signalFreshness == null || f.signalFreshness >= 0);
});
