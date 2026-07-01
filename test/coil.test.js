'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coilFeatures, scoreCohort, explodeProbability, rankCoil, CALIBRATION, trailingDailyVol, resolveBreak } = require('../lib/coil');

// Build a synthetic candle series. `spec` is an array of {c, h, l, v} (defaults derive h/l from c).
function series(spec) {
  return spec.map((s, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: s.o == null ? s.c : s.o, high: s.h == null ? s.c : s.h,
    low: s.l == null ? s.c : s.l, close: s.c, volume: s.v == null ? 1e6 : s.v,
  }));
}
// A quiet, coiled name: noisy/wide EARLY history, then a tight quiet contraction at the
// end → its current volatility sits in a LOW percentile of its own year.
function coiled(n = 130) {
  const spec = [];
  for (let i = 0; i < n; i++) {
    const late = i > n - 25;
    const wob = late ? 0.4 : 3;              // range contracts late
    const vol = late ? 3e5 : 2e6;            // volume dries up late
    const c = 100 + Math.sin(i / 3) * (late ? 0.3 : 2.5);
    spec.push({ c, h: c + wob, l: c - wob, v: vol });
  }
  return series(spec);
}
// A loud name currently in a volatility EXPANSION (already exploding): quiet early, then
// wide ranges + big daily moves at the end → current volatility in a HIGH percentile.
function loud(n = 130) {
  const spec = [];
  for (let i = 0; i < n; i++) {
    const late = i > n - 20;
    const amp = late ? 6 : 1.0;              // range expands late
    const c = 60 + i * 0.15 + (late ? (i - (n - 20)) * 1.4 : 0) + Math.sin(i / 2) * (late ? 3 : 0.4);
    spec.push({ c, h: c + amp, l: c - amp, v: late ? 8e6 : 1.5e6 });
  }
  return series(spec);
}

test('coilFeatures: returns null without enough history', () => {
  assert.equal(coilFeatures(coiled(40)), null);
  assert.equal(coilFeatures([], 0), null);
});

test('coilFeatures: a coiled name shows low squeeze/vol percentiles vs its own history', () => {
  const f = coilFeatures(coiled());
  assert.ok(f, 'features computed');
  assert.ok(f.bbPctile < 0.3, `bbPctile ${f.bbPctile} should be low (tightest vs own history)`);
  assert.ok(f.hvPctile < 0.3, `hvPctile ${f.hvPctile} should be low (vol compressed vs own year)`);
  assert.ok(f.rangeTight < 0.15, `rangeTight ${f.rangeTight} should be tight`);
  assert.ok(f.atrRatio < 1, `atrRatio ${f.atrRatio} should be <1 (contracting)`);
  assert.ok(Object.isFrozen(f), 'features are immutable');
});

test('coilFeatures: a currently-loud name has HIGH squeeze/vol percentiles (not coiled)', () => {
  const f = coilFeatures(loud());
  assert.ok(f.hvPctile > 0.6, `hvPctile ${f.hvPctile} should be high (vol expanding)`);
});

test('coilFeatures is point-in-time: passing an earlier index ignores later bars', () => {
  const c = coiled();
  const early = coilFeatures(c, 80);
  const late = coilFeatures(c, c.length - 1);
  // late window is the contracted regime → tighter range than the earlier window
  assert.ok(late.rangeTight <= early.rangeTight, 'later (coiled) window is tighter');
});

test('scoreCohort: the coiled name outscores the running name', () => {
  const feats = [coilFeatures(coiled()), coilFeatures(loud())];
  const [coilScore, runScore] = scoreCohort(feats);
  assert.ok(coilScore > runScore, `coiled ${coilScore} should beat running ${runScore}`);
});

test('scoreCohort: does not mutate the input feature objects', () => {
  const f = coilFeatures(coiled());
  const before = JSON.stringify(f);
  scoreCohort([f, coilFeatures(loud())]);
  assert.equal(JSON.stringify(f), before);
});

test('explodeProbability: monotonic across deciles and matches the baked calibration', () => {
  const lo = explodeProbability('small', 0.05);   // decile 1
  const hi = explodeProbability('small', 0.95);   // decile 10
  assert.equal(lo.pct, CALIBRATION.small.p25[0]);
  assert.equal(hi.pct, CALIBRATION.small.p25[9]);
  assert.ok(hi.pct > lo.pct, 'strongest coil decile has a higher break rate');
  assert.ok(hi.lift > 1 && lo.lift < 1, 'top decile lifts above base, bottom below');
  assert.equal(hi.band, 'high');
  assert.equal(lo.band, 'quiet');
});

test('explodeProbability: out-of-range input returns null, never a fabricated number', () => {
  assert.equal(explodeProbability('small', null), null);
  assert.equal(explodeProbability('small', NaN), null);
});

test('explodeProbability: large-cap scope uses the large calibration (lower base rate)', () => {
  assert.equal(explodeProbability('large', 0.95).pct, CALIBRATION.large.p25[9]);
  assert.ok(CALIBRATION.large.base25 < CALIBRATION.small.base25);
});

test('rankCoil: returns picks sorted by coil score with a calibrated probability attached', () => {
  const cohort = [
    { ticker: 'QUIET', candles: coiled() },
    { ticker: 'LOUD', candles: loud() },
  ];
  const ranked = rankCoil(cohort, 'small');
  assert.equal(ranked[0].ticker, 'QUIET', 'most-coiled ranked first');
  assert.ok(ranked[0].prob && ranked[0].prob.pct > 0, 'probability attached');
  assert.ok(ranked[0].percentile >= ranked[1].percentile, 'percentile ordering');
});

test('rankCoil: skips names with insufficient history rather than throwing', () => {
  const ranked = rankCoil([{ ticker: 'SHORT', candles: coiled(30) }, { ticker: 'OK', candles: coiled() }], 'small');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].ticker, 'OK');
});

// ── Ledger resolution (self-validation) ──
test('trailingDailyVol: positive for a moving series, null without enough bars', () => {
  const c = coiled();
  assert.ok(trailingDailyVol(c) > 0);
  assert.equal(trailingDailyVol(c, 5), null);
});

test('trailingDailyVol: undefined/null input returns null without throwing (coiltick guard)', () => {
  assert.equal(trailingDailyVol(undefined), null);
  assert.equal(trailingDailyVol(null), null);
  assert.equal(trailingDailyVol([]), null);
});

test('rankCoil: rows carry candles so the ledger tick can compute entry-time vol', () => {
  const ranked = rankCoil([{ ticker: 'OK', candles: coiled() }], 'small');
  assert.ok(Array.isArray(ranked[0].candles), 'candles preserved on ranked row');
  assert.ok(trailingDailyVol(ranked[0].candles) > 0, 'vol computable from the ranked row');
});

test('resolveBreak: a name that jumps far beyond its own vol RESOLVES as a break', () => {
  // flat quiet history (tiny daily vol) then a +40% pop within the horizon.
  const flat = []; for (let i = 0; i < 30; i++) flat.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, close: 100 + (i % 2) * 0.1 });
  const entryDate = flat[flat.length - 1].date;
  const vol = trailingDailyVol(flat);
  const fwd = [...flat];
  for (let k = 1; k <= 10; k++) fwd.push({ date: `2026-03-${String(k).padStart(2, '0')}`, close: 100 + k * 4 }); // ramps to +40%
  const r = resolveBreak(fwd, entryDate, vol);
  assert.ok(r && r.matured, 'matured');
  assert.equal(r.broke, true, 'big abnormal move counts as a break');
  assert.ok(r.mfePct > 30);
});

test('resolveBreak: a name that barely moves does NOT break', () => {
  const flat = []; for (let i = 0; i < 30; i++) flat.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, close: 100 + Math.sin(i) * 2 });
  const entryDate = flat[flat.length - 1].date;
  const vol = trailingDailyVol(flat);
  const fwd = [...flat];
  for (let k = 1; k <= 10; k++) fwd.push({ date: `2026-03-${String(k).padStart(2, '0')}`, close: 100 + Math.sin(30 + k) * 2 }); // stays in its noise band
  const r = resolveBreak(fwd, entryDate, vol);
  assert.ok(r && r.matured);
  assert.equal(r.broke, false, 'a move within its own vol is not a break');
});

test('resolveBreak: returns null until the horizon has fully elapsed', () => {
  const flat = []; for (let i = 0; i < 30; i++) flat.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, close: 100 });
  const entryDate = flat[flat.length - 1].date;
  const fwd = [...flat]; for (let k = 1; k <= 4; k++) fwd.push({ date: `2026-03-0${k}`, close: 105 }); // only 4 fwd bars < 10
  assert.equal(resolveBreak(fwd, entryDate, 0.02), null);
});
