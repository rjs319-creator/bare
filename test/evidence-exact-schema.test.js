'use strict';
// EXACT-PRECISION EVIDENCE SCHEMA (GitHub scan 2026-10-02, proposal #5).
//
// summarizeDateSeries rounded avg/ci95/tCI/bootstrapCI to 2dp and se to 4dp before the
// summary was persisted. pValueOf fell back to those display values on summaries that
// pre-dated avgExact/seExact, and EVERY interval gate (`ci95.lo > 0`, `ci95.hi < 0`) read
// the rounded bounds — a quantisation of 0.01 units on a statistic whose real edges live
// at ~0.003. The summary now carries an `exact` block at full precision, every gate reads
// it, and a summary that can only offer rounded fields says so (`precision: 'rounded'`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ES = require('../lib/evidence-stats');
const M = require('../lib/maturity');
const NL = require('../lib/negative-lanes');
const D = require('../lib/decision');
const { dateLevelNetExcess } = require('../lib/apex-routes');

const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const round = (v, d) => +v.toFixed(d);

// ── the schema ───────────────────────────────────────────────────────────────
test('summarizeDateSeries persists an `exact` block at full precision next to the display fields', () => {
  const vals = series(40, i => 0.0031 + (i % 2 ? 0.0004 : -0.0004) + Math.sin(i / 4) * 0.0002);
  const s = ES.summarizeDateSeries(vals, { horizonBars: 5 });
  assert.equal(s.precision, 'exact');
  const ex = s.exact;
  assert.ok(ex, 'exact block present');
  for (const k of ['avg', 'se', 'sd', 'ess', 'n']) assert.ok(Number.isFinite(ex[k]), `exact.${k}`);
  for (const k of ['ci95', 'tCI', 'bootstrapCI']) {
    assert.ok(ex[k] && Number.isFinite(ex[k].lo) && Number.isFinite(ex[k].hi), `exact.${k}`);
  }
  // The display fields are ROUNDINGS of the exact ones — one population, two precisions.
  assert.equal(s.avg, round(ex.avg, 2));
  assert.equal(s.se, round(ex.se, 4));
  assert.equal(s.sd, round(ex.sd, 2));
  assert.equal(s.ci95.lo, round(ex.ci95.lo, 2));
  assert.equal(s.ci95.hi, round(ex.ci95.hi, 2));
  assert.equal(s.tCI.lo, round(ex.tCI.lo, 2));
  assert.equal(s.bootstrapCI.hi, round(ex.bootstrapCI.hi, 2));
  assert.equal(s.effectiveN, round(ex.ess, 1));
  assert.equal(ex.n, s.n);
  // And the older full-precision copies stay for every consumer that already reads them.
  assert.equal(s.avgExact, ex.avg);
  assert.equal(s.seExact, ex.se);
  // The exact mean is NOT the rounded one here (that is the whole point).
  assert.notEqual(ex.avg, s.avg);
  assert.equal(s.avg, 0, 'a ~0.003 mean rounds to 0.00 for display');
});

test('the summary records the parameters that reproduce it (lags, blockLen, B, seed)', () => {
  const s = ES.summarizeDateSeries(series(40, i => Math.sin(i / 3) + 0.6), { horizonBars: 5 });
  assert.deepEqual(Object.keys(s.params).sort(), ['B', 'blockLen', 'blocks', 'horizonBars', 'lags', 'seed']);
  assert.equal(s.params.horizonBars, 5);
  assert.equal(s.params.lags, 4);
  assert.equal(s.params.blockLen, s.bootstrapCI.blockLen);
});

// ── resolving precision on persisted summaries ───────────────────────────────
test('exactOf: a summary with an exact block resolves at precision "exact"', () => {
  const s = ES.summarizeDateSeries(series(30, i => 0.5 + (i % 3) * 0.1), { horizonBars: 5 });
  const ex = ES.exactOf(s);
  assert.equal(ex.precision, 'exact');
  assert.equal(ex.avg, s.exact.avg);
  assert.deepEqual(ex.ci95, s.exact.ci95);
});

test('exactOf: a legacy summary with only avgExact/seExact resolves at precision "partial"', () => {
  const legacy = { n: 30, avg: 0, se: 0.0018, avgExact: 0.0041, seExact: 0.00181, tCritical: 2.045, effectiveN: 30, ci95: { lo: 0, hi: 0.01 }, bootstrapCI: { lo: 0, hi: 0.01, blockLen: 5 } };
  const ex = ES.exactOf(legacy);
  assert.equal(ex.precision, 'partial');
  assert.equal(ex.avg, 0.0041);
  assert.equal(ex.se, 0.00181);
  assert.equal(ex.ess, 30);
  // The Student-t half is rebuilt exactly; the bootstrap half is still the stored
  // rounding, so the interval is widened by it — a correction may only ever widen.
  assert.ok(Math.abs(ex.tCI.lo - (0.0041 - 2.045 * 0.00181)) < 1e-12);
  assert.ok(ex.ci95.lo <= ex.tCI.lo && ex.ci95.lo <= 0);
});

test('exactOf: a summary with only display fields is flagged precision "rounded" — the degradation is visible', () => {
  const ex = ES.exactOf({ n: 30, avg: 0, se: 0.0018, effectiveN: 30, ci95: { lo: 0, hi: 0.01 } });
  assert.equal(ex.precision, 'rounded');
  assert.equal(ex.avg, 0);
  assert.deepEqual(ex.ci95, { lo: 0, hi: 0.01 });
  assert.equal(ES.exactOf(null), null);
  assert.equal(ES.precisionOf({ avg: 1, se: 1 }), 'rounded');
});

test('exactOf trusts a migrated summary\'s own precision flag over the presence of an exact block', () => {
  const migrated = { n: 10, avg: 0.5, se: 0.2, ci95: { lo: 0.1, hi: 0.9 }, exact: { avg: 0.5, se: 0.2, ci95: { lo: 0.1, hi: 0.9 }, ess: 10, n: 10 }, precision: 'rounded' };
  assert.equal(ES.exactOf(migrated).precision, 'rounded');
});

// ── p-values ─────────────────────────────────────────────────────────────────
test('REGRESSION: exact p ≈ 0.03 where the rounded fields would say p = 1 — pValueOf reads exact', () => {
  // mean 0.004, se 0.0018, 40 effective dates: t = 2.22 at df 39 → two-sided p ≈ 0.032.
  // The display mean rounds to 0.00 → t = 0 → p = 1.
  const persisted = {
    n: 40, avg: 0, sd: 0.01, se: 0.0018, effectiveN: 40, ci95: { lo: 0, hi: 0.01 },
    exact: { avg: 0.004, se: 0.0018, sd: 0.0114, ci95: { lo: 0.00036, hi: 0.00764 }, tCI: { lo: 0.00036, hi: 0.00764 }, bootstrapCI: null, ess: 40, n: 40 },
    precision: 'exact',
  };
  const p = ES.pValueOf(persisted);
  assert.ok(p > 0.02 && p < 0.05, `expected ≈0.03, got ${p}`);
  const detail = ES.pValueDetail(persisted);
  assert.equal(detail.precision, 'exact');
  assert.equal(detail.df, 39);
  assert.equal(detail.p, p);
  // The SAME record stripped to its display fields reports p = 1 AND says it is rounded.
  const { exact, precision, ...roundedOnly } = persisted;
  const dr = ES.pValueDetail(roundedOnly);
  assert.equal(dr.precision, 'rounded');
  assert.ok(dr.p > 0.05, `rounded fields cannot resolve the effect (got ${dr.p})`);
});

test('pValueDetail degrades to null (not NaN, not a throw) on an unusable summary', () => {
  assert.deepEqual(ES.pValueDetail(null), { p: null, precision: null, df: null });
  assert.equal(ES.pValueDetail({ avg: 1 }).p, null);
  assert.equal(ES.pValueOf({ avg: 1, se: 0 }), null);
});

test('fdrAdjust carries each item\'s precision through so a rounded p is visible in the family', () => {
  const adj = ES.fdrAdjust([{ id: 'a', p: 0.001, precision: 'exact' }, { id: 'b', p: 0.5, precision: 'rounded' }, { id: 'c', p: 0.2 }]);
  const by = Object.fromEntries(adj.map(r => [r.id, r]));
  assert.equal(by.a.precision, 'exact');
  assert.equal(by.b.precision, 'rounded');
  assert.equal(by.c.precision, null);
  assert.equal(by.a.survives, true);
});

// ── the gates ────────────────────────────────────────────────────────────────
// A healthy per-date series at a tiny scale: every bound rounds to 0.00 for display,
// so the OLD interval gate (`ci95.lo > 0` on the rounded bound) failed a record whose
// interval is cleanly positive. The same shape at a 1-unit scale is the repo's own
// "robust record survives prosecution" fixture.
const TINY_HEALTHY = Array.from({ length: 30 }, (_, i) => (0.6 + (i % 5) * 0.25) / 250);
const rowsOf = (values) => values.map((v, i) => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, netExc: v }));
const trackWith = (dateNet) => ({
  excessN: 60, avgExcess: 2.6, beatMktRate: 38,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 36,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 40,
  dates: 30, dateNet,
});
const PASSING = { fillVerified: true, noHistoryRate: 0 };

test('dateLevelNetExcess forwards the exact block and precision into the persisted dateNet', () => {
  const dn = dateLevelNetExcess(rowsOf(TINY_HEALTHY), { horizonBars: 5 });
  assert.equal(dn.precision, 'exact');
  assert.ok(dn.exact && Number.isFinite(dn.exact.avg) && dn.exact.ci95);
  assert.equal(dn.ci95.lo, 0, 'the display bound is quantised to 0.00 at this scale');
  assert.ok(dn.exact.ci95.lo > 0, 'the exact bound is clear of zero');
});

test('REGRESSION: the Validated interval gate reads the exact bound, not the display rounding', () => {
  const dn = dateLevelNetExcess(rowsOf(TINY_HEALTHY), { horizonBars: 5 });
  const g = M.gradeTrack(trackWith(dn), PASSING);
  assert.equal(g.grade, 'validated', g.reason);
  assert.equal(g.stats.precision, 'exact');
  // The identical record with its exact block stripped (a legacy row) still fails the
  // gate — and now says why: it could only be read at rounded precision.
  const { exact, precision, avgExact, seExact, ...legacy } = dn;
  const gl = M.gradeTrack(trackWith(legacy), PASSING);
  assert.equal(gl.grade, 'promising');
  assert.match(gl.reason, /does not exclude zero/);
  assert.equal(gl.stats.precision, 'rounded');
});

test('REGRESSION: the Disabled (significantly negative) gate reads the exact upper bound', () => {
  const dn = dateLevelNetExcess(rowsOf(TINY_HEALTHY.map(v => -v)), { horizonBars: 5 });
  assert.equal(dn.ci95.hi, -0, 'display upper bound rounds to zero → the old gate `hi < 0` was false');
  assert.ok(dn.exact.ci95.hi < 0);
  const g = M.gradeTrack({ ...trackWith(dn), avgExcess: 0.1, avgNetExcess: 0.1 }, PASSING);
  assert.equal(g.grade, 'disabled', g.reason);
  assert.match(g.reason, /significantly NEGATIVE/);
});

test('FDR demote family reads the exact p and reports each strategy\'s precision', () => {
  const dn = dateLevelNetExcess(rowsOf(TINY_HEALTHY), { horizonBars: 5 });
  const strategies = [
    { id: 'tiny', grade: 'validated', reason: 'x', core: true, stats: { dateNet: dn } },
    { id: 'legacy', grade: 'promising', reason: 'y', core: true, stats: { dateNet: { n: 30, avg: 0, se: 0.002, effectiveN: 30, ci95: { lo: 0, hi: 0.01 } } } },
  ];
  M.applyFdrAcrossStrategies(strategies);
  assert.equal(strategies[0].fdr.precision, 'exact');
  assert.ok(strategies[0].fdr.p < 0.01, 'exact p resolves the tiny-scale effect');
  assert.equal(strategies[1].fdr.precision, 'rounded');
  assert.equal(strategies[1].fdr.p, 1, 'a rounded-only legacy row cannot resolve its effect, and is labelled');
});

test('negative lanes gate on the exact interval but keep the display bounds for the UI', () => {
  const neg = dateLevelNetExcess(rowsOf(TINY_HEALTHY.map(v => -v)), { horizonBars: 5 });
  const adj = dateLevelNetExcess(rowsOf(TINY_HEALTHY.map(v => -v * 1.1)), { horizonBars: 3 });
  const group = { section: 'Ghost', tier: 'GHOST', scope: 'large', horizons: {
    '5d': { avgNetExcess: -0.01, netExcessN: 60, dateNet: neg },
    '3d': { avgNetExcess: -0.01, netExcessN: 60, dateNet: adj },
  } };
  const lanes = NL.negativeLanes({ groups: [group] });
  assert.equal(lanes.length, 1, 'the exact upper bound is below zero → lane qualifies');
  assert.deepEqual(lanes[0].ci95, { lo: neg.ci95.lo, hi: neg.ci95.hi }, 'display bounds are the rounded ones the renderer prints');
  assert.equal(lanes[0].precision, 'exact');
  // Stripped to display fields, the same record cannot qualify (hi rounds to 0).
  const strip = (d) => { const { exact, precision, avgExact, seExact, ...rest } = d; return rest; };
  const legacyGroup = { ...group, horizons: { '5d': { ...group.horizons['5d'], dateNet: strip(neg) }, '3d': { ...group.horizons['3d'], dateNet: strip(adj) } } };
  assert.equal(NL.negativeLanes({ groups: [legacyGroup] }).length, 0);
});

test('expectancy tilt gates on the exact interval and formats its reason at display precision', () => {
  const dn = dateLevelNetExcess(rowsOf(TINY_HEALTHY), { horizonBars: 5 });
  const summary = { groups: [{ section: 'Ghost', tier: 'GHOST', horizons: { '1m': { avgExcess: 4, winRate: 60, n: 40, dateNet: dn } } }] };
  const e = D.expectancyFor('Ghost', 'GHOST', 'position', summary);
  assert.ok(e.dateCiLo > 0, 'exact lower bound forwarded');
  assert.equal(e.dateCiPrecision, 'exact');
  const t = D.expectancyTilt(e);
  assert.ok(t.tilt > 1, `a significantly positive record tilts up (got ${JSON.stringify(t)})`);
  assert.doesNotMatch(t.reason, /\d\.\d{5,}/, 'reasons print display precision, not 15-digit floats');
});
