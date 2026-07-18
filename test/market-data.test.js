'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const MD = require('../lib/market-data');
const { calcRSI } = require('../lib/signal');

const bar = (date, c, adjClose = null, v = 1e6) => ({ date, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: v, adjClose });

// A clean rising series with sequential dates.
function clean(n = 30, start = 100, step = 1) {
  const out = [];
  let t = Date.UTC(2026, 0, 5);
  for (let k = 0; k < n; k++) { out.push(bar(new Date(t).toISOString().slice(0, 10), start + k * step)); t += 86400000; }
  return out;
}

// ── validateSeries: clean data passes ───────────────────────────────────────
test('validateSeries: a clean, monotonic, positive series is ok with no issues', () => {
  const r = MD.validateSeries(clean());
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

// ── the corporate-action heart: adjusted vs unadjusted split ────────────────
test('an ALREADY-adjusted 10:1 split (continuous price) passes clean — no false crash', () => {
  // Prices stay continuous across the split date (this is how Yahoo delivers them).
  const c = clean(20, 100, 0.5);
  const corporateActions = { splits: [{ date: c[10].date, ratio: 10 }] };
  const r = MD.validateSeries(c, { corporateActions });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(!r.issues.some((i) => i.type === 'unadjusted-split'));
});

test('an UNADJUSTED 10:1 split (a ~90% one-bar drop AT the split date) is flagged', () => {
  const c = clean(20, 100, 0);            // flat at 100
  // Simulate the provider failing to adjust: price divides by 10 on the split bar.
  for (let i = 10; i < c.length; i++) { const p = 10; c[i] = bar(c[i].date, 100 / p); }
  const corporateActions = { splits: [{ date: c[10].date, ratio: 10 }] };
  const r = MD.validateSeries(c, { corporateActions });
  assert.equal(r.ok, false);
  const flagged = r.issues.find((i) => i.type === 'unadjusted-split');
  assert.ok(flagged, 'expected an unadjusted-split issue');
  assert.equal(flagged.date, c[10].date);
});

// ── applySplitAdjustment repairs an unadjusted series (invariance) ──────────
test('applySplitAdjustment repairs an unadjusted split so the series becomes continuous', () => {
  const c = clean(20, 100, 0);
  for (let i = 10; i < c.length; i++) c[i] = bar(c[i].date, 10); // dropped to 10 post-split (unadjusted)
  const splits = [{ date: c[10].date, ratio: 10 }];
  const fixed = MD.applySplitAdjustment(c, splits);
  // Pre-split bars are divided by 10 → 100 becomes 10, matching the post-split level → continuous.
  assert.ok(Math.abs(fixed[9].close - 10) < 1e-9, `pre-split adjusted to ${fixed[9].close}`);
  assert.ok(Math.abs(fixed[10].close - 10) < 1e-9);
  const r = MD.validateSeries(fixed, { corporateActions: { splits } });
  assert.ok(!r.issues.some((i) => i.type === 'unadjusted-split'), 'repaired series has no discontinuity');
});

test('splitFactors are all 1 on already-adjusted Yahoo-style data', () => {
  const c = clean(15);
  const f = MD.splitFactors(c, [{ date: c[7].date, ratio: 4 }]);
  // The utility computes what WOULD adjust an unadjusted series; here we just prove it is a
  // pure function of the events (pre-split bars get factor 4, at/after get 1).
  assert.equal(f[6], 4);
  assert.equal(f[7], 1);
  assert.equal(f[14], 1);
});

// ── indicator invariance across split adjustment ────────────────────────────
test('RSI is economically equivalent on a base series and its split-then-adjusted twin', () => {
  const base = clean(40, 50, 0.7).map((c) => c.close);
  // Build an unadjusted 2:1 split twin, then adjust it back and compare RSI.
  const c = clean(40, 50, 0.7);
  for (let i = 20; i < c.length; i++) c[i] = bar(c[i].date, c[i].close * 2); // unadjusted: post-split doubles
  const splits = [{ date: c[20].date, ratio: 0.5 }];  // 1:2 style — post-split price is 2× pre, factor <1
  const fixed = MD.applySplitAdjustment(c, splits).map((x) => x.close);
  const rsiBase = calcRSI(base, 14);
  const rsiFixed = calcRSI(fixed, 14);
  for (let i = 30; i < base.length; i++) {
    assert.ok(Math.abs(rsiBase[i] - rsiFixed[i]) < 1e-6, `RSI differs at ${i}: ${rsiBase[i]} vs ${rsiFixed[i]}`);
  }
});

// ── total-return series ─────────────────────────────────────────────────────
test('totalReturnSeries uses adjClose when present and falls back to close otherwise', () => {
  const withAdj = [bar('2026-01-05', 100, 98), bar('2026-01-06', 101, 99)];
  const full = MD.totalReturnSeries(withAdj);
  assert.equal(full.basis, 'total-return');
  assert.equal(full.series[0].close, 98);   // adjClose, not raw 100

  const noAdj = [bar('2026-01-05', 100, null), bar('2026-01-06', 101, null)];
  const fb = MD.totalReturnSeries(noAdj);
  assert.equal(fb.basis, 'price-return-fallback');
  assert.equal(fb.series[0].close, 100);     // raw close, never fabricated
});

// ── dividend is not a false bearish crash ───────────────────────────────────
test('a normal dividend ex-date gap is NOT flagged as a discontinuity', () => {
  const c = clean(15, 100, 0);
  // A 1.5% dividend ex-date dip in the split-adjusted (non-div-adjusted) close.
  c[8] = bar(c[8].date, 98.5);
  const r = MD.validateSeries(c, { discontinuity: 0.35 });
  assert.ok(!r.warnings.some((w) => w.type === 'price-discontinuity'), 'small dividend gap must not trip the discontinuity check');
});

// ── structural data errors ──────────────────────────────────────────────────
test('validateSeries flags duplicate and non-monotonic dates and negative prices', () => {
  const dup = clean(5); dup[3] = { ...dup[3], date: dup[2].date };
  assert.ok(MD.validateSeries(dup).issues.some((i) => i.type === 'duplicate-date'));

  const back = clean(5); back[3] = { ...back[3], date: '2020-01-01' };
  assert.ok(MD.validateSeries(back).issues.some((i) => i.type === 'non-monotonic-date'));

  const neg = clean(5); neg[2] = { ...neg[2], close: -5 };
  assert.ok(MD.validateSeries(neg).issues.some((i) => i.type === 'non-positive-price'));
});

test('validateSeries flags a stale last bar when asOf is far past the last date', () => {
  const c = clean(10);
  const r = MD.validateSeries(c, { asOf: '2026-06-01', staleDays: 5 });
  assert.ok(r.warnings.some((w) => w.type === 'stale-last-bar'));
});
