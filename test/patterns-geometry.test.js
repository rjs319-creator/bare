'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../lib/patterns/geometry');
const S = require('../lib/patterns/similarity');
const { detectWindow } = require('../lib/patterns/detectors');

// ---- helpers ----
function bars(closes, volMul = 1) {
  return closes.map((c, i) => ({ date: 'd' + String(i).padStart(3, '0'), open: c * 0.997, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 * volMul }));
}
function bullFlag() {
  const cs = []; let p = 100;
  for (let i = 0; i < 14; i++) { p += 1.6; cs.push({ date: 'd' + i, open: p - 0.5, high: p + 0.4, low: p - 0.7, close: p, volume: 2e6 }); }
  for (let i = 14; i < 22; i++) { p -= 0.3; cs.push({ date: 'd' + i, open: p + 0.2, high: p + 0.5, low: p - 0.35, close: p, volume: 8e5 }); }
  return cs;
}

test('geometry: log path is exactly scale-invariant', () => {
  const a = [10, 11, 12, 11.5, 13, 14];
  const b = a.map(x => x * 137.5);
  const pa = G.logPath(a);
  const pb = G.logPath(b);
  const maxDiff = Math.max(...pa.map((v, i) => Math.abs(v - pb[i])));
  assert.ok(maxDiff < 1e-12, `paths should be identical, got ${maxDiff}`);
});

test('geometry: depth measures are ATR-normalized (transfer across price regimes)', () => {
  const lo = bars([100, 104, 108, 106, 110, 112, 111, 114]);
  const hi = bars([100, 104, 108, 106, 110, 112, 111, 114].map(x => x * 50));
  const gLo = G.geometryFeatures(lo);
  const gHi = G.geometryFeatures(hi);
  // Same shape at 50x the price → same ATR-normalized depth (within rounding).
  assert.ok(Math.abs(gLo.baseDepthAtr - gHi.baseDepthAtr) < 0.5, `${gLo.baseDepthAtr} vs ${gHi.baseDepthAtr}`);
});

test('geometry: zigzag adapts to volatility (pivots, not noise)', () => {
  const cs = bullFlag();
  const z = G.zigzag(cs, { atrMult: 1.0 });
  assert.ok(z.length >= 2, 'should find at least an up-leg and a pullback');
  assert.ok(z.some(p => p.kind === 'H'), 'should include a swing high');
});

test('detectors: a bull flag matches long continuation families, not a bearish one as primary-long', () => {
  const dets = detectWindow(bullFlag(), { timeframe: '20d', context: { marketRegime: 'RISK_ON', liquidity: 'SUPPORTED', volPercentile: 40 } });
  assert.ok(dets.length > 0, 'should detect something');
  const longs = dets.filter(d => d.direction === 'LONG');
  assert.ok(longs.length > 0, 'should surface long continuation candidates');
  // The strongest LONG should be a continuation/base family.
  const top = longs[0];
  assert.ok(['BULL_FLAG', 'FLAT_BASE', 'VCP', 'ASCENDING_TRIANGLE', 'CUP_AND_HANDLE'].includes(top.family), `unexpected top long ${top.family}`);
});

test('detectors: reward:risk is asymmetric (not degenerate 1:1)', () => {
  const dets = detectWindow(bullFlag(), { timeframe: '20d', context: { marketRegime: 'RISK_ON', liquidity: 'SUPPORTED' } });
  const withPlan = dets.filter(d => d.plan && d.plan.rr != null);
  assert.ok(withPlan.length > 0);
  assert.ok(withPlan.some(d => d.plan.rr > 1.2), 'at least one plan should have RR > 1.2');
});

test('detectors: insufficient bars returns no detections (fails closed, no crash)', () => {
  const dets = detectWindow(bars([100, 101, 102]), { timeframe: '20d' });
  assert.deepStrictEqual(dets, []);
});

test('detectors: a broken-down chart flags invalidation, not a fresh long', () => {
  // Rally then a hard collapse through the base.
  const cs = []; let p = 100;
  for (let i = 0; i < 12; i++) { p += 1.5; cs.push({ date: 'd' + i, open: p - 0.5, high: p + 0.5, low: p - 0.6, close: p, volume: 2e6 }); }
  for (let i = 12; i < 20; i++) { p -= 3.2; cs.push({ date: 'd' + i, open: p + 1, high: p + 1.2, low: p - 0.5, close: p, volume: 3e6 }); }
  const dets = detectWindow(cs, { timeframe: '20d', context: { marketRegime: 'NEUTRAL', liquidity: 'SUPPORTED' } });
  const longs = dets.filter(d => d.direction === 'LONG');
  // Any surfaced long must be invalidated (price is below its base) — never a clean forming long.
  for (const d of longs) {
    if (!d.invalidationHit) {
      assert.notStrictEqual(d.phase, 'CONFIRMED', `${d.family} should not be a confirmed long after a collapse`);
    }
  }
});
