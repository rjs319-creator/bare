'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../lib/failure-model');

test('scoreFeatures: no failure features → ~0 probability, full size, no drivers', () => {
  const s = FM.scoreFeatures({});
  assert.equal(s.failureProb, 0);
  assert.equal(s.sizeMult, 1);
  assert.equal(s.drivers.length, 0);
  assert.equal(s.expectedMode, null);
});

test('scoreFeatures: co-firing features push probability up and trim size', () => {
  const s = FM.scoreFeatures({ earningsBinary: 1, extended: 1, volClimax: 1 });
  assert.ok(s.failureProb > 0.5, `got ${s.failureProb}`);
  assert.ok(s.sizeMult < 0.5);
  assert.equal(s.drivers[0].mode, 'earningsGap'); // highest weight fires first
  assert.equal(s.expectedMode, 'earningsGap');
});

test('scoreFeatures: probability is capped and size floored (never certainty / never zero)', () => {
  const all = Object.fromEntries(FM.FEATURES.map(f => [f.key, 1]));
  const s = FM.scoreFeatures(all);
  assert.ok(s.failureProb <= FM.CONFIG.MAX_PROB);
  assert.ok(s.sizeMult >= FM.CONFIG.MIN_SIZE);
});

test('assessSignal: SHADOW by default; adjusted score is display-only, base is untouched', () => {
  const sig = { score: 80, event: { kind: 'binary' }, execution: { quality: 0.4 }, expectancyTilt: 0.9 };
  const a = FM.assessSignal(sig, { regime: { riskOn: true } });
  assert.equal(a.shadow, true);
  assert.equal(a.baseScore, 80);
  assert.ok(a.adjustedScore < 80, 'shadow adjusted score reflects the failure read');
  assert.ok(a.failureProb > 0);
  assert.ok(['rejected', 'near-threshold', 'approved'].includes(a.bucket));
});

test('featuresFromSignal: reads earnings/extension/illiquidity/sector/breadth/track honestly', () => {
  const fv = FM.featuresFromSignal({
    event: { kind: 'binary' },
    remainingEdge: { rated: true, extensionR: 2.5, consumedPct: 70 },
    execution: { quality: 0.4 },
    sectorStrength: -0.8,
    evidence: { singleFamily: true },
    expectancyTilt: 0.85,
  }, { regime: { breadthPct: 30 } });
  assert.equal(fv.earningsBinary, 1);
  assert.ok(fv.extended > 0.5);
  assert.ok(fv.illiquid > 0);
  assert.ok(fv.sectorWeak > 0);
  assert.ok(fv.breadthWeak > 0);
  assert.equal(fv.singleFactor, 1);
  assert.ok(fv.poorTrack > 0);
  // candle-only features stay 0 from a live signal
  assert.equal(fv.volClimax, 0);
});

test('a clean, liquid, un-extended name in a healthy tape scores ~no failure risk', () => {
  const a = FM.assessSignal({ score: 75, execution: { quality: 1 }, sectorStrength: 0.5, expectancyTilt: 1.1,
    remainingEdge: { rated: true, extensionR: 0.2, consumedPct: 10 }, evidence: { singleFamily: false } },
    { regime: { riskOn: true, breadthPct: 65 } });
  assert.ok(a.failureProb < 0.1, `got ${a.failureProb}`);
  assert.equal(a.bucket, 'approved');
});

// ── Candle extractor (point-in-time, for the validation harness) ──────────────────────────
function series(base, dailyPct, volEach = 1e6) {
  let px = base; const out = [];
  for (let i = 0; i < dailyPct.length; i++) {
    const prev = px; px = px * (1 + dailyPct[i] / 100);
    out.push({ date: '2026-01-' + String(i + 1).padStart(2, '0'), close: +px.toFixed(4),
      high: +(Math.max(prev, px) * 1.01).toFixed(4), low: +(Math.min(prev, px) * 0.99).toFixed(4), volume: volEach });
  }
  return out;
}

test('featuresFromCandles: a parabolic, extended run reads as extended', () => {
  const up = series(100, Array(40).fill(2)); // relentless +2%/day → far above SMA20
  const fv = FM.featuresFromCandles(up, up.length - 1);
  assert.ok(fv.extended > 0.3, `extended=${fv.extended}`);
});

test('featuresFromCandles: a volume-climax spike bar is flagged', () => {
  const base = series(100, Array(30).fill(0.1), 1e6);
  // final bar: big move + 6x volume
  base.push({ date: '2026-02-01', close: 118, high: 120, low: 108, volume: 6e6 });
  const fv = FM.featuresFromCandles(base, base.length - 1);
  assert.ok(fv.volClimax > 0, `volClimax=${fv.volClimax}`);
});

test('featuresFromCandles: point-in-time — no look-ahead, returns zeros before enough history', () => {
  const short = series(100, Array(10).fill(1));
  const fv = FM.featuresFromCandles(short, 5);
  assert.equal(fv.extended, 0);
  assert.equal(fv.volClimax, 0);
});

test('featuresFromCandles: choppy tape (high ATR, no net drift) flags vol-without-persistence', () => {
  const chop = series(100, Array(40).fill(0).map((_, i) => (i % 2 ? -5 : 5)), 1e6); // ±5% zigzag, ~0 net
  const fv = FM.featuresFromCandles(chop, chop.length - 1);
  assert.ok(fv.volWithoutPersistence > 0.3, `chop=${fv.volWithoutPersistence}`);
});
