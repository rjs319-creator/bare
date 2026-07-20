'use strict';
// EXPERIMENT #5 harness tests. The twin engine adds two leakage surfaces beyond momentum/label:
// the analog POOL must contain only outcomes already RESOLVED as-of the decision date (a naive
// `date < asOf` pool would peek at outcomes not yet knowable), and a name must never twin with its
// OWN history (or it predicts itself through autocorrelation). Both are asserted here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/nsl/twin-incremental');

// Weekday-aware series (same generator as #3/#4).
function series(from, n, start = 100, step = 0.2) {
  const out = []; const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const close = start + i * step;
    out.push({ date: d.toISOString().slice(0, 10), open: close, high: close + 0.5, low: close - 0.5, close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const CFG = { lookbackBars: 126, skipBars: 5, horizonBars: 21, minHistory: 200, stride: 5 };

// ── features (PIT) ────────────────────────────────────────────────────────────
test('featuresAt returns null without enough trailing history, finite with it', () => {
  const c = series('2024-01-01', 300, 100, 0.2);
  assert.equal(H.featuresAt(c, c[150].date, CFG), null, '150 bars < 200-session minimum');
  const f = H.featuresAt(c, c[260].date, CFG);
  assert.ok(f && ['mom', 'rev1m', 'vol', 'dist200'].every(k => Number.isFinite(f[k])), 'all four features finite');
});

test('featuresAt uses only bars on/before the decision date', () => {
  const c = series('2024-01-01', 300, 100, 0.2);
  const withFuture = [...c, { date: '2027-12-31', open: 9999, high: 9999, low: 9999, close: 9999 }];
  assert.deepEqual(H.featuresAt(c, c[260].date, CFG), H.featuresAt(withFuture, c[260].date, CFG));
});

// ── library ─────────────────────────────────────────────────────────────────
test('buildStateLibrary emits resolved states carrying a labelEndDate', () => {
  const c = series('2024-01-01', 400, 100, 0.2);
  const lib = H.buildStateLibrary([{ ticker: 'AAA', candles: c }], CFG);
  assert.ok(lib.length > 0);
  assert.ok(lib.every(s => s.labelEndDate && Number.isFinite(s.outcome) && ['mom', 'rev1m', 'vol', 'dist200'].every(k => Number.isFinite(s.features[k]))));
  assert.ok(lib.every(s => s.date < s.labelEndDate), 'a label always ends after its decision date');
});

// ── the leakage guards (pool resolution + self-exclusion) ─────────────────────
const feat = () => ({ mom: 0.1, rev1m: 0.01, vol: 0.02, dist200: 0.05 });
// caliper wide-open + tiny MIN_TWINS so a handcrafted pool is testable; median is what we probe.
const twinConfig = { K: 40, CALIPER_Z: 1e9, MIN_TWINS: 3, OOS_NEAREST_Z: 1e9 };

test('the analog pool excludes outcomes not yet resolved, and the name never twins with itself', () => {
  const candles = series('2024-01-01', 300, 100, 0.2);
  const D = candles[260].date;
  const resolved = [
    { ticker: 'B', date: '2023-06-01', labelEndDate: '2023-07-01', outcome: 0.01, features: feat() },
    { ticker: 'C', date: '2023-06-08', labelEndDate: '2023-07-08', outcome: 0.02, features: feat() },
    { ticker: 'D', date: '2023-06-15', labelEndDate: '2023-07-15', outcome: 0.03, features: feat() },
    { ticker: 'E', date: '2023-06-22', labelEndDate: '2023-07-22', outcome: 0.04, features: feat() },
    { ticker: 'F', date: '2023-06-29', labelEndDate: '2023-07-29', outcome: 0.05, features: feat() },
  ];
  const leaks = [
    // Decided BEFORE D (so a naive date<asOf pool keeps it) but RESOLVES after D → must be invisible.
    { ticker: 'G', date: '2024-12-01', labelEndDate: '2027-01-01', outcome: 9.99, features: feat() },
    // The candidate's OWN prior state, fully resolved → must be self-excluded.
    { ticker: 'AAA', date: '2023-02-01', labelEndDate: '2023-03-01', outcome: -9.99, features: feat() },
  ];
  const td = [{ ticker: 'AAA', candles }];
  const cfg = { ...CFG, twinConfig };

  const clean = H.assembleSamples(td, resolved, [D], cfg);
  const withLeaks = H.assembleSamples(td, [...resolved, ...leaks], [D], cfg);

  assert.equal(clean.samples.length, 1, 'candidate produces one complete sample');
  assert.equal(withLeaks.samples.length, 1);
  // If either leak reached the twins, the extreme ±9.99 outcome would move the median. It must not.
  assert.equal(withLeaks.samples[0].signal, clean.samples[0].signal,
    'a future-resolving analog and the name’s own history must not influence the signal');
});

test('runTwinIncremental returns an evaluation (insufficient on a tiny panel, honestly)', () => {
  const candles = series('2024-01-01', 400, 100, 0.2);
  const r = H.runTwinIncremental([{ ticker: 'AAA', candles }], [candles[260].date], CFG, { minPerDate: 8, minDates: 8 });
  assert.ok(r.evaluation.insufficient, 'one name on one date cannot support a cross-sectional IC');
  assert.equal(typeof r.nSamples, 'number');
  assert.equal(typeof r.librarySize, 'number');
});
