'use strict';
// Trade-plan geometry (review Prompt 4.1/4.2). A nominal level that is impossible (a short
// whose 2R target is below zero) must be REJECTED before any rounding or clamp — the row
// stays as research with `invalid_target_geometry`, no executable plan, no invented target.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orbLowLevels, scoreGapDown } = require('../lib/gapdown');
const N = require('../lib/decision-normalizers');
const D = require('../lib/decision');
const EL = require('../lib/eligibility');
const { buildLiveSignal } = require('../lib/signal');
const { evaluateSetup } = require('../lib/stock-setup');

// GRML: every bar has a true range of 2.94 and the last low is 9.60 → stop 16.95, risk 7.35,
// nominal 2R target = 9.60 − 14.70 = −5.10.
function grmlCandles() {
  const c = [];
  for (let i = 0; i < 16; i++) c.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, open: 11, high: 12.54, low: 9.60, close: 11, volume: 3_000_000 });
  return c;
}

test('GRML: a short whose 2R target is negative is invalid geometry — never clamped to a penny', () => {
  const p = orbLowLevels(grmlCandles());
  assert.equal(p.trigger, 9.6);
  assert.equal(p.stop, 16.95);
  assert.equal(p.target, null, 'no invented target');
  assert.equal(p.rr, null, 'no R:R off an impossible target');
  assert.equal(p.valid, false);
  assert.equal(p.invalidReason, 'invalid_target_geometry');
});

test('a valid short plan survives and keeps its 1:2 geometry', () => {
  const c = grmlCandles().map(b => ({ ...b, open: 50, high: 50.5, low: 49.5, close: 50 }));
  const p = orbLowLevels(c);
  assert.equal(p.valid, true);
  assert.equal(p.invalidReason, null);
  assert.equal(p.rr, 2);
  assert.ok(p.target > 0 && p.target < p.trigger && p.trigger < p.stop);
});

test('rounding cannot invert price ordering: a sub-cent nominal target is invalid, not 0.00', () => {
  // trigger 1.00, ATR 0.1996 → risk 0.499, nominal target 0.002 → rounds to 0.00.
  const c = [];
  for (let i = 0; i < 16; i++) c.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, open: 1.1, high: 1.1996, low: 1.0, close: 1.1, volume: 1e7 });
  const p = orbLowLevels(c);
  assert.equal(p.valid, false);
  assert.equal(p.target, null);
  assert.equal(p.invalidReason, 'invalid_target_geometry');
});

test('an invalid plan can never be actionable — even with confirmed borrow — and both reasons stay attributable', () => {
  // A −20% gap-down on a volatile $10 name: liquid, qualifies, but the ATR makes 2R impossible.
  const c = [];
  for (let i = 0; i < 40; i++) c.push({ date: `2026-02-${String((i % 27) + 1).padStart(2, '0')}`, open: 12, high: 14.5, low: 9.6, close: 12, volume: 3_000_000 });
  c.push({ date: '2026-03-02', open: 9.7, high: 12.5, low: 9.6, close: 9.65, volume: 9_000_000 });
  const s = scoreGapDown(c, null, { borrow: { shortable: true, available: true, feeBps: 50 } });
  assert.ok(s, 'row is kept as research, not dropped');
  assert.equal(s.plan.valid, false);
  assert.equal(s.execution.executable, true, 'borrow is assessed on its own');
  assert.equal(s.actionable, false);
  assert.equal(s.actionability, 'research-watch');
  assert.equal(s.planInvalidReason, 'invalid_target_geometry');
});

// ── decision layer ──────────────────────────────────────────────────────────
const GRML_ROW = { ticker: 'GRML', tier: 'STRONG', last: 9.7, avgDollarVol: 2e7, continuationScore: 80,
  plan: { trigger: 9.6, stop: 16.95, target: null, rr: null, valid: false, invalidReason: 'invalid_target_geometry', side: 'short' } };

test('fromGapDown + makeSignal: an invalid plan reaches the board with NO target and NO R:R', () => {
  const [raw] = N.fromGapDown({ strong: [GRML_ROW] });
  assert.equal(raw.planInvalidReason, 'invalid_target_geometry');
  const { signal } = D.makeSignal(raw);
  assert.equal(signal.entry, 9.6);
  assert.equal(signal.stop, 16.95);
  assert.equal(signal.target, null, 'null must not become 0');
  assert.equal(signal.rr, null);
  assert.equal(signal.planInvalidReason, 'invalid_target_geometry');
});

test('fromGapDown: a legacy payload that still carries the penny clamp is caught as invalid geometry', () => {
  const legacy = { ...GRML_ROW, plan: { trigger: 9.6, stop: 16.95, target: 0.01, rr: 2 } };
  const { signal } = D.makeSignal(N.fromGapDown({ strong: [legacy] })[0]);
  // 0.01 is a positive, correctly ordered price — the level check alone cannot see the clamp.
  // What exposes it is the advertised R:R (2) disagreeing with the levels (1.30).
  assert.equal(signal.planInvalidReason, 'invalid_target_geometry');
  assert.equal(signal.target, null);
  assert.equal(signal.rr, null);
});

const CLEARED_SRC = { source: 'gapdown', tradeEligible: true, reasons: [], sizingWeight: 1, staticStatus: 'production', governance: null };

test('eligibility: invalid geometry is research-only with INVALID_GEOMETRY, separately from NO_BORROW', () => {
  const { signal } = D.makeSignal(N.fromGapDown({ strong: [GRML_ROW] })[0]);
  const el = EL.assessSignal(signal, CLEARED_SRC);
  assert.equal(el.tradeEligible, false);
  assert.equal(el.sizingEligible, false);
  assert.equal(el.signalClass, 'RESEARCH');
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.INVALID_GEOMETRY));
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.NO_BORROW), 'borrow stays its own blocker');
  assert.ok(el.reasons.some(r => /invalid_target_geometry/.test(r)));
});

test('eligibility: side-specific ordering — mis-ordered levels are invalid, valid long and short pass', () => {
  const liq = { dollarVol: 5e8, price: 50 };
  const mk = (side, entry, stop, target) => ({ source: 'coremo', ticker: 'AAA', side, entry, stop, target, liquidity: liq });
  const src = { ...CLEARED_SRC, source: 'coremo' };
  const okLong = EL.assessSignal(mk('long', 50, 47, 56), src);
  assert.equal(okLong.sizingEligible, true);
  assert.ok(!okLong.reasonCodes.includes(EL.REASON_CODE.INVALID_GEOMETRY));
  const okShort = EL.assessSignal(mk('short', 50, 53, 44), src);
  assert.ok(!okShort.reasonCodes.includes(EL.REASON_CODE.INVALID_GEOMETRY));

  for (const bad of [mk('long', 50, 52, 56), mk('long', 50, 47, 49), mk('short', 50, 47, 44), mk('short', 50, 53, 55), mk('short', 9.6, 16.95, -5.1)]) {
    const el = EL.assessSignal(bad, src);
    assert.equal(el.tradeEligible, false, JSON.stringify(bad));
    assert.equal(el.signalClass, 'RESEARCH');
    assert.ok(el.reasonCodes.includes(EL.REASON_CODE.INVALID_GEOMETRY));
  }
});

test('eligibility: a missing level is NO_PLAN (a lead), not invalid geometry — and 0 is not a price', () => {
  const src = { ...CLEARED_SRC, source: 'coremo' };
  for (const target of [null, undefined, 0]) {
    const el = EL.assessSignal({ source: 'coremo', ticker: 'AAA', side: 'long', entry: 50, stop: 47, target, liquidity: { dollarVol: 5e8 } }, src);
    assert.equal(el.tradeEligible, true);
    assert.equal(el.sizingEligible, false);
    assert.ok(el.reasonCodes.includes(EL.REASON_CODE.NO_PLAN));
    assert.ok(!el.reasonCodes.includes(EL.REASON_CODE.INVALID_GEOMETRY));
  }
});

// ── other short plan builders ───────────────────────────────────────────────
function liveSignal(execAtr, { up = false } = {}) {
  const n = 60;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const p = up ? 10 + i * 0.05 : 13 - i * 0.05;
    candles.push({ date: '2026-03-02', open: p + (up ? -0.02 : 0.02), high: p + 0.05, low: p - 0.05, close: p, volume: 1e5 });
  }
  const px = candles[n - 1].close;
  const flat = (v) => new Array(n).fill(v);
  const lines = up ? [px - 0.1, px - 0.2, px - 0.3, px - 0.2] : [px + 0.1, px + 0.2, px + 0.3, px + 0.2];
  const macd = { macdLine: flat(up ? 1 : -1), signalLine: flat(0), histogram: flat(up ? 1 : -1) };
  return buildLiveSignal(candles, flat(lines[0]), flat(lines[1]), flat(lines[2]), flat(lines[3]), flat(up ? 60 : 35), macd, flat(1e5), flat(execAtr), px, { execAtr });
}

test('signal.js: a bearish read whose ATR target is below zero publishes NO levels', () => {
  const s = liveSignal(5);   // px ≈ 10.05, target = px − 12.5 < 0
  assert.equal(s.bullish, false);
  assert.equal(s.levels, null);
  assert.equal(s.levelsInvalidReason, 'invalid_target_geometry');
});

test('signal.js: ordinary bearish and bullish reads keep correctly ordered levels', () => {
  const bear = liveSignal(0.2);
  assert.ok(bear.levels, 'bearish levels published');
  assert.ok(+bear.levels.target < +bear.levels.entry && +bear.levels.entry < +bear.levels.stop);
  assert.ok(+bear.levels.target > 0);
  const bull = liveSignal(0.2, { up: true });
  assert.ok(bull.levels, 'bullish levels published');
  assert.ok(+bull.levels.stop < +bull.levels.entry && +bull.levels.entry < +bull.levels.target);
});

test('stock-setup: a collapsing downtrend whose 2R short target is below zero is not a valid setup', () => {
  const c = [];
  for (let i = 0; i < 240; i++) { const p = 200 - i * 0.2; c.push({ date: `d${i}`, open: p, high: p + 1, low: p - 1, close: p, volume: 1e6 }); }
  // last 20 bars: 150 → 30 (range high ≫ 1.5 × the swing low)
  for (let i = 0; i < 20; i++) { const p = 150 - (i + 1) * 6; c.push({ date: `e${i}`, open: p + 3, high: p + 4, low: p - 1, close: p, volume: 1e6 }); }
  const s = evaluateSetup(c);
  assert.equal(s.direction, 'short');
  assert.equal(s.valid, false);
  assert.equal(s.reason, 'invalid_target_geometry');
  assert.equal(s.target, null);
  assert.equal(s.rr, null);
});

test('stock-setup: an orderly downtrend keeps a valid short with target below trigger', () => {
  const c = [];
  for (let i = 0; i < 260; i++) { const p = 200 - i * 0.3; c.push({ date: `d${i}`, open: p + 0.1, high: p + 0.6, low: p - 0.6, close: p, volume: 1e6 }); }
  const s = evaluateSetup(c);
  assert.equal(s.direction, 'short');
  assert.equal(s.valid, true);
  assert.ok(s.target > 0 && s.target < s.trigger && s.trigger < s.invalidation);
});
