'use strict';
// ATLAS-X MIXED ADJUSTED/RAW BARS (alpha-research pass 3).
//
// lib/atlasx-residual.toBars set `c = adjClose ?? close` while leaving o/h/l RAW, so
// every bar carried a close and a high/low/open from DIFFERENT price series. Yahoo
// adjusts backward, so for any dividend payer adjClose sits below close on every bar
// before the last distribution, by the cumulative dividend factor.
//
// The existing suite could not catch this: test/atlasx-integration.test.js sets
// `adjClose: c`, making adjusted and raw identical in every fixture. These tests
// deliberately make them diverge, and contrast against a faithful re-implementation of
// the old behaviour so the assertions cannot pass vacuously.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/atlasx-residual');

// The OLD toBars, exactly: adjusted close, raw open/high/low.
const legacyToBars = (rows) => rows.map(([date, o, h, l, c, v, adj]) => ({
  date, o, h, l, c: (adj != null && isFinite(adj)) ? Number(adj) : Number(c), v,
}));

// A realistic dividend payer. Raw price rises smoothly, then drops by the dividend on
// the ex-date; Yahoo's backward adjustment scales every PRE-ex bar by (1 - yield) so the
// TOTAL-RETURN series is continuous. Bars are gapless by construction: open == prior close.
function dividendPayer({ n = 10, exIdx = 6, yieldPct = 0.03 } = {}) {
  const rows = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const isEx = i === exIdx;
    const o = isEx ? px * (1 - yieldPct) : px;      // ex-date opens down by the dividend
    const c = o + 0.5;
    const h = Math.max(o, c) + 0.4;
    const l = Math.min(o, c) - 0.4;
    // Backward adjustment: bars strictly BEFORE the ex-date are scaled down.
    const factor = i < exIdx ? (1 - yieldPct) : 1;
    rows.push([`2025-02-${String(i + 1).padStart(2, '0')}`, o, h, l, c, 1e6, +(c * factor).toFixed(6)]);
    px = c;
  }
  return rows;
}

const gapsOf = (bars) => bars.slice(1).map((b, i) => (b.o - bars[i].c) / bars[i].c);
const bodiesOf = (bars) => bars.map(b => (b.c - b.o) / (b.h - b.l));

test('THE BUG: the old basis put close outside its own high/low on most bars', () => {
  const rows = dividendPayer();
  const old = legacyToBars(rows);
  const broken = old.filter(b => !(b.l <= b.c && b.c <= b.h)).length;
  assert.ok(broken > 0, 'fixture must reproduce the defect, or these tests prove nothing');
});

test('THE BUG: the old basis fabricated a gap on every pre-ex-dividend bar', () => {
  const old = legacyToBars(dividendPayer());
  const fabricated = gapsOf(old).filter(g => Math.abs(g) > 0.005).length;
  assert.ok(fabricated >= 5, `old code must show many false gaps, saw ${fabricated}`);
});

test('THE BUG: the old basis read every pre-ex bar as a down-close', () => {
  const old = legacyToBars(dividendPayer());
  const down = bodiesOf(old).filter(x => x < 0).length;
  assert.ok(down >= 5, `old code must invert the body on most bars, saw ${down}`);
});

// ── the fix ──────────────────────────────────────────────────────────────────────

test('close always sits inside its own high/low', () => {
  const bars = R.toBars(dividendPayer());
  for (const b of bars) {
    assert.ok(b.l <= b.c && b.c <= b.h, `${b.date}: close ${b.c} outside [${b.l}, ${b.h}]`);
    assert.ok(b.l <= b.o && b.o <= b.h, `${b.date}: open ${b.o} outside [${b.l}, ${b.h}]`);
  }
});

test('a gapless series stays gapless — no fabricated gap survives', () => {
  const bars = R.toBars(dividendPayer());
  const gaps = gapsOf(bars);
  // The ONE legitimate discontinuity is the ex-date itself; everything else is flat.
  const nonZero = gaps.filter(g => Math.abs(g) > 1e-9);
  assert.ok(nonZero.length <= 1,
    `at most the ex-date may show a step, saw ${nonZero.length}: ${nonZero.map(x => x.toFixed(4))}`);
});

test('bar bodies are no longer systematically negative', () => {
  const bars = R.toBars(dividendPayer());
  const down = bodiesOf(bars).filter(x => x < 0).length;
  assert.equal(down, 0, 'every bar in this fixture closes above its open');
});

test('a uniform adjustment factor produces EXACTLY zero fabricated gaps', () => {
  // No ex-date inside the window: every bar carries the same factor, so scaling must be
  // perfectly gap-neutral.
  const rows = dividendPayer({ n: 8, exIdx: 99 }).map(r => [...r.slice(0, 6), +(r[4] * 0.97).toFixed(6)]);
  const bars = R.toBars(rows);
  for (const g of gapsOf(bars)) assert.ok(Math.abs(g) < 1e-9, `fabricated gap ${g}`);
  assert.equal(bars.basis, 'total-return');
});

// ── one basis per series ─────────────────────────────────────────────────────────

test('partial adjustment coverage falls back to RAW for every bar, never a mid-series switch', () => {
  // The second defect: adjClose missing on some bars (legacy 6-tuples, provider gaps)
  // meant a per-bar fallback, so a return computed across that boundary was a fabricated
  // jump equal to the accumulated adjustment.
  const rows = dividendPayer({ n: 8, exIdx: 99 }).map((r, i) =>
    (i < 4 ? [...r.slice(0, 6), +(r[4] * 0.97).toFixed(6)] : r.slice(0, 6)));
  const bars = R.toBars(rows);
  assert.equal(bars.basis, 'price-return');
  assert.equal(bars.adjustmentCovered, false);
  for (const g of gapsOf(bars)) assert.ok(Math.abs(g) < 1e-9, `mixed-basis jump ${g}`);
});

test('the basis is reported without changing the array shape', () => {
  const bars = R.toBars(dividendPayer());
  assert.equal(bars.basis, 'total-return');
  // Non-enumerable: JSON, spreads and deep-equality see a plain array of bars.
  assert.ok(!Object.keys(bars).includes('basis'));
  assert.ok(!JSON.stringify(bars).includes('total-return'));
});

test('object-shaped rows carrying only adjClose are still accepted', () => {
  // Preserves the old behaviour for that shape rather than dropping the bar.
  const bars = R.toBars([{ date: '2025-03-01', open: 10, high: 11, low: 9, adjClose: 10.5, volume: 5 }]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].c, 10.5);
});
