'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/algo-health');

// Build a resolved OOS series with `nDates` distinct decision dates, `k` of them beating
// the market (excess +2) and the rest losing (excess `lossExcess`). Dates are zero-padded
// so they sort correctly and windowing takes the true most-recent slice.
function series(nDates, k, lossExcess = -1, perDate = 1) {
  const rows = [];
  for (let i = 0; i < nDates; i++) {
    const date = `d${String(i).padStart(4, '0')}`;
    const excess = i < k ? 2 : lossExcess; // sorted; recency handled by window slices
    for (let j = 0; j < perDate; j++) rows.push({ date, excess });
  }
  return rows;
}

// ── summarize: effective N counts DISTINCT dates, never raw picks ────────────
test('summarize: effN is distinct dates, not row count (overlap not independent)', () => {
  const rows = series(10, 7, -1, 3); // 10 dates × 3 picks each = 30 rows
  const s = H.summarize(rows);
  assert.equal(s.n, 30);
  assert.equal(s.effN, 10);
  assert.ok(s.ready); // 10 >= MIN_EFF_N (8)
});

test('summarize: CI is taken over the effective (date) sample, not inflated rows', () => {
  const wide = H.summarize(series(10, 7, -1, 1)); // 10 dates
  const many = H.summarize(series(10, 7, -1, 5)); // same 10 dates, 5x rows
  // Same independent evidence ⇒ (near) same interval width despite 5x the rows.
  assert.ok(Math.abs((wide.ci.hi - wide.ci.lo) - (many.ci.hi - many.ci.lo)) < 0.02);
});

// ── classifyAlgo: the seven-state ladder ─────────────────────────────────────
test('UNKNOWN when independent evidence is below the gate', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(5, 4) }); // 5 dates < 8
  assert.equal(r.health, 'UNKNOWN');
  assert.equal(r.effectiveSampleSize, 5);
});

test('STRONG when long-term interval clears breakeven over a large sample', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(30, 21), calibration: { brier: 0.15, slope: 1 } });
  assert.equal(r.health, 'STRONG');
  assert.ok(r.ci.lo > 0.5);
  assert.equal(r.drift, 'stable');
});

test('BROKEN when long-term edge is negative with interval below breakeven', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(30, 6, -2) });
  assert.equal(r.health, 'BROKEN');
});

test('BROKEN on calibration failure even with positive returns', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(30, 21), calibration: { brier: 0.7, slope: 2 } });
  assert.equal(r.health, 'BROKEN');
});

test('INCOMPATIBLE when it worked historically but the current regime does not match', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(30, 21), regimeCompatibility: 0.2 });
  assert.equal(r.health, 'INCOMPATIBLE');
});

test('SUPPORTED when positive long-term but not strong enough for STRONG', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(20, 13) }); // ci.lo ~0.47 (<0.5)
  assert.equal(r.health, 'SUPPORTED');
});

test('WATCH when the interval straddles breakeven', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(15, 9) }); // positive avg, ci.lo < 0.45
  assert.equal(r.health, 'WATCH');
});

// ── drift: DEGRADING requires the recent window to fall clearly below a good record ──
test('DEGRADING when recent window is bad while supplied long-term record is good', () => {
  const longTerm = { effN: 200, avgExcess: 1.5, beatRate: 0.62, ci: { lo: 0.56, hi: 0.68 }, ready: true };
  const recentBad = series(60, 15, -2); // last 60 dates, 25% beat, negative
  const r = H.classifyAlgo({ id: 'x', series: recentBad, longTerm });
  assert.equal(r.drift, 'degrading');
  assert.equal(r.health, 'DEGRADING');
});

test('a short losing streak inside a good long record does NOT trip DEGRADING', () => {
  // Long-term good; recent window is only mildly soft (still not clearly below breakeven).
  const longTerm = { effN: 200, avgExcess: 1.5, beatRate: 0.62, ci: { lo: 0.56, hi: 0.68 }, ready: true };
  const recentSoft = series(60, 33); // 55% beat — above breakeven-ish, not "bad"
  const r = H.classifyAlgo({ id: 'x', series: recentSoft, longTerm });
  assert.notEqual(r.drift, 'degrading');
  assert.notEqual(r.health, 'DEGRADING');
});

// ── limitations are surfaced, never hidden ───────────────────────────────────
test('unmeasured inputs are recorded as explicit limitations', () => {
  const r = H.classifyAlgo({ id: 'x', series: series(30, 21) });
  assert.ok(r.limitations.includes('calibration unmeasured'));
  assert.ok(r.limitations.includes('regime compatibility unmeasured'));
  assert.ok(r.limitations.includes('independence unmeasured'));
});

// ── determinism ──────────────────────────────────────────────────────────────
test('classifyAlgo is deterministic (no clock / no randomness)', () => {
  const a = H.classifyAlgo({ id: 'x', series: series(30, 21) });
  const b = H.classifyAlgo({ id: 'x', series: series(30, 21) });
  assert.deepEqual(a, b);
});
