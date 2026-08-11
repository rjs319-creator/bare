'use strict';
// PSRL unit tests — continuity formulas, jump classifier, arrows/hysteresis,
// speed states, labels. Deterministic synthetic fixtures, no network.

const test = require('node:test');
const assert = require('node:assert');

const C = require('../lib/psrl/continuity');
const J = require('../lib/psrl/jump');
const A = require('../lib/psrl/arrows');
const L = require('../lib/psrl/leadership');

// ── information discreteness ────────────────────────────────────────────────

test('information discreteness: gradual accumulation gives negative ID and high continuity', () => {
  const rets = [...Array(8).fill(0.01), ...Array(2).fill(-0.01)];
  const d = C.informationDiscreteness(rets);
  assert.strictEqual(d.available, true);
  assert.ok(Math.abs(d.id - (0.2 - 0.8)) < 1e-12, `ID should be -0.6, got ${d.id}`);
  assert.ok(d.continuity > 0.7, 'gradual path scores high continuity');
  assert.strictEqual(d.posDayPct, 0.8);
});

test('information discreteness: negative formation flips the sign convention', () => {
  const rets = [...Array(8).fill(-0.01), ...Array(2).fill(0.01)];
  const d = C.informationDiscreteness(rets);
  assert.ok(d.formationReturn < 0);
  assert.ok(Math.abs(d.id - (-1) * (0.8 - 0.2)) < 1e-12, 'sign(ret) applied');
  assert.strictEqual(d.continuity, null, 'continuity defined only for positive formations');
});

test('information discreteness: too few observations is unavailable, never guessed', () => {
  assert.strictEqual(C.informationDiscreteness([0.01, 0.02]).available, false);
});

// ── efficiency ──────────────────────────────────────────────────────────────

test('efficiency ratio: |net| / gross, with upside-only variant zero on declines', () => {
  const e = C.efficiency([0.01, -0.01, 0.01, -0.01, 0.02]);
  assert.ok(Math.abs(e.efficiency - 0.02 / 0.06) < 1e-12);
  const down = C.efficiency([-0.01, -0.01, -0.01, 0.005, -0.01]);
  assert.strictEqual(down.upsideEfficiency, 0, 'a smooth decline is not rewarded');
  assert.ok(down.efficiency > 0, 'plain efficiency still measures path cleanliness');
});

// ── concentration + gaps ────────────────────────────────────────────────────

test('return concentration: top-1/top-3 shares and safe zero-denominator handling', () => {
  const c = C.concentration([0.05, 0.03, 0.02, 0.01, -0.02, 0.01]);
  const sum = 0.05 + 0.03 + 0.02 + 0.01 + 0.01;
  assert.ok(Math.abs(c.top1Share - 0.05 / sum) < 1e-12);
  assert.ok(Math.abs(c.top3Share - (0.05 + 0.03 + 0.02) / sum) < 1e-12);
  assert.strictEqual(C.concentration([-0.01, -0.02]).available, false, 'no positive returns → unavailable');
});

test('gap stats: overnight gap share of gross movement', () => {
  // bar 2 opens +10% above prior close and closes there → move is all gap.
  const bars = [
    { date: '2025-01-01', o: 100, h: 100.5, l: 99.5, c: 100 },
    { date: '2025-01-02', o: 110, h: 110.5, l: 109.5, c: 110 },
    ...Array.from({ length: 12 }, (_, i) => ({
      date: `2025-01-${String(3 + i).padStart(2, '0')}`, o: 110, h: 110.5, l: 109.5, c: 110,
    })),
  ];
  const g = C.gapStats(bars, 13);
  assert.strictEqual(g.available, true);
  assert.ok(g.gapDependence > 0.9, `gap-driven path must show high gap dependence, got ${g.gapDependence}`);
  assert.ok(g.largestGapContribution > 0.9);
});

// ── robust fit ──────────────────────────────────────────────────────────────

test('robust path fit: clean line fits perfectly; a single outlier cannot break the Theil-Sen slope', () => {
  const clean = C.robustPathFit(Array.from({ length: 30 }, (_, i) => 100 + i));
  assert.ok(clean.olsR2 > 0.999);
  assert.ok(Math.abs(clean.robustSlope - 1 / 114.5) < 1e-3, 'slope normalized by median level');
  const spiked = Array.from({ length: 30 }, (_, i) => 100 + i);
  spiked[15] = 300; // one bad print
  const robust = C.robustPathFit(spiked);
  assert.ok(Math.abs(robust.robustSlope - clean.robustSlope) < 0.002, 'Theil-Sen shrugs off one outlier');
});

// ── jump / plateau classifier ───────────────────────────────────────────────

function mkBars(rets, { start = 100, gapAt = -1, gap = 0 } = {}) {
  const out = []; let c = start;
  const d0 = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < rets.length; i++) {
    const date = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    let o = c; if (i === gapAt) o = c * (1 + gap);
    const nc = c * (1 + rets[i]);
    out.push({ date, o, h: Math.max(o, nc) * 1.002, l: Math.min(o, nc) * 0.998, c: nc, v: nc > o ? 1.5e6 : 1e6 });
    c = nc;
  }
  return out;
}

test('jump classifier: steady advance vs dead plateau vs constructive hold', () => {
  const n = 70;
  const steady = mkBars(Array(n).fill(0.003));
  const s = J.classifyPath({ bars: steady, window: 63 });
  assert.strictEqual(s.state, 'STEADY_ADVANCE');

  // one +18% day, then 39 sessions drifting down with falling lows → dead.
  const dead = mkBars(Array.from({ length: n }, (_, i) => (i === n - 40 ? 0.18 : i > n - 40 ? -0.0008 : 0.0002)), { gapAt: n - 40, gap: 0.17 });
  const d = J.classifyPath({ bars: dead, window: 63 });
  assert.strictEqual(d.state, 'JUMP_PLATEAU');
  assert.ok(d.reasonCodes.includes('ELAPSED_TIME_SUFFICIENT'));
  assert.ok(d.jump.top1Share > 0.45);

  // same jump but retained with RISING lows → constructive, never "dead".
  const hold = mkBars(Array.from({ length: n }, (_, i) => (i === n - 40 ? 0.18 : i > n - 40 ? 0.0003 : 0.0002)), { gapAt: n - 40, gap: 0.17 });
  const h = J.classifyPath({ bars: hold, window: 63 });
  assert.ok(h.state === 'JUMP_HOLDING' || h.state === 'JUMP_CONTINUING',
    `constructive consolidation must not be dead, got ${h.state}`);
  assert.notStrictEqual(h.state, 'JUMP_PLATEAU');
});

test('jump classifier: too-early post-jump window never calls PLATEAU', () => {
  const n = 70;
  const early = mkBars(Array.from({ length: n }, (_, i) => (i === n - 3 ? 0.18 : 0.0002)), { gapAt: n - 3, gap: 0.17 });
  const e = J.classifyPath({ bars: early, window: 63 });
  assert.notStrictEqual(e.state, 'JUMP_PLATEAU', 'insufficient elapsed time');
});

// ── arrows + hysteresis ─────────────────────────────────────────────────────

test('hysteresis: ordinary upgrade needs two consecutive qualifying closes', () => {
  let st = { level: 'FLAT', upStreak: 0, downStreak: 0 };
  st = A.applyArrowHysteresis('UP', st);
  assert.strictEqual(st.level, 'FLAT', 'first qualifying close: no change yet');
  st = A.applyArrowHysteresis('UP', st);
  assert.strictEqual(st.level, 'UP', 'second consecutive close: upgrade');
});

test('hysteresis: ordinary downgrade needs two weak observations; hard break is immediate', () => {
  let st = { level: 'UP', upStreak: 0, downStreak: 0 };
  st = A.applyArrowHysteresis('FLAT', st);
  assert.strictEqual(st.level, 'UP', 'one weak session does not downgrade');
  st = A.applyArrowHysteresis('FLAT', st);
  assert.strictEqual(st.level, 'FLAT');
  const broken = A.applyArrowHysteresis('DOWN2', { level: 'UP2', upStreak: 0, downStreak: 0 });
  assert.strictEqual(broken.level, 'DOWN2', 'hard invalidation downgrades immediately');
});

test('trajectory arrow requires a material score change', () => {
  assert.strictEqual(A.trajectoryRaw({ combined: 62, prevCombined: 60 }), 'FLAT');
  assert.strictEqual(A.trajectoryRaw({ combined: 70, prevCombined: 60 }), 'UP');
  assert.strictEqual(A.trajectoryRaw({ combined: 50, prevCombined: 60 }), 'DOWN');
  assert.strictEqual(A.trajectoryRaw({ combined: 70, prevCombined: 60, alert: true }), 'ALERT');
});

// ── speed states ────────────────────────────────────────────────────────────

test('speed states: slow-up + fast-down reads as deterioration warning', () => {
  const f = (slope) => ({ available: true, slope, fit: 0.8, accel: 0, maxDrawdown: -0.05, distFromHigh: -0.02, posDayPct: 0.6 });
  const byHorizon = { 5: f(-0.002), 10: f(-0.002), 21: f(0.001), 63: f(0.002), 126: f(0.002) };
  const s = L.speedStates(byHorizon);
  assert.strictEqual(s.fast.direction, 'DOWN');
  assert.strictEqual(s.slow.direction, 'UP');
  assert.strictEqual(s.interpretation, 'DETERIORATION_WARNING');
});

// ── labels (PIT composition) ────────────────────────────────────────────────

test('labels: pending window is right-censored, resolved window carries residual + exec fills', () => {
  const { labelDecision } = require('../lib/psrl/labels');
  const candles = mkBars(Array(40).fill(0.002)).map((b) => ({ date: b.date, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  const spy = mkBars(Array(40).fill(0.001)).map((b) => ({ date: b.date, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  const early = labelDecision({ candles, spyCandles: spy, decisionDate: candles[10].date });
  assert.strictEqual(early.available, true);
  assert.strictEqual(early.windows.h5.residual.resolved, true, '5-session window elapsed');
  assert.ok(Number.isFinite(early.windows.h5.residual.residualReturn));
  assert.strictEqual(early.windows.h63.residual.pending, true, '63-session window not elapsed');
  assert.strictEqual(early.rightCensored, true, 'unresolved longest window ⇒ censored, not failed');
  assert.strictEqual(early.windows.h5.exec.entryBasis, 'next-session-open', 'no same-bar fills');
});
