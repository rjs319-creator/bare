'use strict';
// CFL LABELS — barrier geometry, target-before-stop ordering, gap classification,
// executable-entry honesty. Guards the leak the label family exists to prevent:
// crediting a fill at the signal-day close, or crediting a gap-only move.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/cfl/labels');
const CFG = require('../lib/cfl/config');

// Deterministic daily bars: base drift + injected overrides. Dates are synthetic
// but monotonic ISO strings so the calendar logic is exercised.
function bars(n, { start = 100, drift = 0, overrides = {} } = {}) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px = px * (1 + drift);
    const o = overrides[i] || {};
    const open = o.open ?? px, close = o.close ?? px;
    out.push({
      date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      open, high: o.high ?? Math.max(open, close) * 1.01, low: o.low ?? Math.min(open, close) * 0.99,
      close, volume: o.volume ?? 1_000_000,
    });
  }
  return out;
}

test('barriersFor scales with ATR and horizon — a volatile name gets wider barriers than a quiet one', () => {
  const quiet = L.barriersFor({ atrPct: 1.0, horizonKey: 'h21' });
  const wild = L.barriersFor({ atrPct: 4.0, horizonKey: 'h21' });
  assert.ok(wild.upPct > quiet.upPct && wild.downPct > quiet.downPct);
  assert.strictEqual(quiet.atrBasis, 'atr');
});

test('barriersFor falls back HONESTLY when ATR is unavailable — basis says so, never silent', () => {
  const b = L.barriersFor({ atrPct: null, horizonKey: 'h5' });
  assert.strictEqual(b.atrBasis, 'fallback-atr');
  assert.strictEqual(b.atrPct, CFG.FALLBACK_ATR_PCT);
});

test('barriersFor refuses the delegated intraday horizon', () => {
  assert.strictEqual(L.barriersFor({ atrPct: 2, horizonKey: 'intraday' }), null);
});

test('resolveBarrierPath: target-before-stop when the high crosses first', () => {
  const c = bars(40, { overrides: { 10: { high: 130, close: 120 } } });
  const p = L.resolveBarrierPath({ candles: c, fillIdx: 5, fillPrice: 100, upPct: 10, downPct: 8, horizonSessions: 21 });
  assert.strictEqual(p.outcome, 'target-before-stop');
  assert.strictEqual(p.timeToTarget, 5);
  assert.strictEqual(p.timeToStop, null);
});

test('resolveBarrierPath: same-bar ambiguity resolves to the STOP (conservative — mirrors lib/outcome)', () => {
  const c = bars(40, { overrides: { 8: { high: 140, low: 80, close: 100 } } });
  const p = L.resolveBarrierPath({ candles: c, fillIdx: 5, fillPrice: 100, upPct: 10, downPct: 8, horizonSessions: 21 });
  assert.strictEqual(p.outcome, 'stop-before-target');
});

test('resolveBarrierPath: neither barrier within a MATURED window ⇒ neither-stagnant; short window ⇒ pending', () => {
  const flat = bars(40);
  const matured = L.resolveBarrierPath({ candles: flat, fillIdx: 5, fillPrice: 100, upPct: 50, downPct: 50, horizonSessions: 21 });
  assert.strictEqual(matured.outcome, 'neither-stagnant');
  const pending = L.resolveBarrierPath({ candles: flat, fillIdx: 35, fillPrice: 100, upPct: 50, downPct: 50, horizonSessions: 21 });
  assert.strictEqual(pending.outcome, 'pending');
  assert.strictEqual(pending.matured, false);
});

test('classifyGap flags a gap-dominant move — the return existed only at prices nobody could get', () => {
  // Every session: +4% overnight gap, then a flat regular session.
  const c = [];
  let close = 100;
  for (let i = 0; i < 30; i++) {
    const open = close * 1.04;
    c.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, open, high: open * 1.001, low: open * 0.999, close: open, volume: 1e6 });
    close = open;
  }
  const g = L.classifyGap({ candles: c, decisionIdx: 2, horizonSessions: 20 });
  assert.strictEqual(g.class, 'gap-dominant');
  assert.ok(g.overnightShare > CFG.CROSS_SECTION.gapDominantShare);
});

test('pathLabel enters at the NEXT session, never the decision close (PIT execution invariant)', () => {
  const c = bars(120, { drift: 0.002 });
  const decisionDate = c[80].date;
  const lbl = L.pathLabel({ candles: c, decisionDate, horizonKey: 'h5' });
  assert.ok(lbl.ok);
  assert.ok(lbl.entryDate > decisionDate, `entry ${lbl.entryDate} must be after decision ${decisionDate}`);
});

test('pathLabel with no next session reports no-fill — a missing fill is never a fabricated price', () => {
  const c = bars(80);
  const lbl = L.pathLabel({ candles: c, decisionDate: c[c.length - 1].date, horizonKey: 'h5' });
  assert.strictEqual(lbl.outcome, 'no-fill');
});

test('crossSectionLabels: top-percentile flag, liquid-winner set, and gap-dominant moves marked non-executable', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ symbol: `T${i}`, excessReturn: i / 100, dollarVol: i >= 10 ? 10e6 : 1e5, gapClass: 'no-gap', outcome: 'target-before-stop' });
  }
  rows.push({ symbol: 'GAPPY', excessReturn: 0.5, dollarVol: 20e6, gapClass: 'gap-dominant', outcome: 'target-before-stop' });
  const cs = L.crossSectionLabels(rows);
  const gappy = cs.find(r => r.symbol === 'GAPPY');
  assert.strictEqual(gappy.topPercentile, true);
  assert.strictEqual(gappy.executable, false);   // a gap-only move is not an actionable miss
  const illiquid = cs.find(r => r.symbol === 'T9');
  assert.strictEqual(illiquid.largestLiquidWinner, false);   // below the liquidity floor
  const best = cs.find(r => r.symbol === 'T19');
  assert.strictEqual(best.largestLiquidWinner, true);
});
