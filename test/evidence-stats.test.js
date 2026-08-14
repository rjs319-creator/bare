'use strict';
// PHASE 5 — every statistic describes the SAME frozen population, and dependence is
// accounted for rather than assumed away.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ES = require('../lib/evidence-stats');
const M = require('../lib/maturity');
const { dateLevelNetExcess } = require('../lib/apex-routes');

const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('DEDUP: same-day picks become ONE portfolio observation, and the accounting is reported', () => {
  const rows = [
    { date: '2026-01-05', netExc: 2 }, { date: '2026-01-05', netExc: 4 },
    { date: '2026-01-06', netExc: -1 },
    { date: '2026-01-07', netExc: 3 }, { date: '2026-01-07', netExc: 3 }, { date: '2026-01-07', netExc: 0 },
    { date: null, netExc: 99 }, { date: '2026-01-08', netExc: null },
  ];
  const d = ES.dedupeToDateSeries(rows);
  assert.deepEqual(d.dates, ['2026-01-05', '2026-01-06', '2026-01-07']);
  assert.deepEqual(d.series, [3, -1, 2]);
  assert.deepEqual(d.perDateCounts, [2, 1, 3]);
  assert.equal(d.skipped, 2, 'unusable rows are counted, never silently dropped');
});

test('SMALL-SAMPLE SAFETY: the critical value is Student-t, not a flat 1.96', () => {
  assert.equal(ES.tCritical95(1), 12.706);
  assert.equal(ES.tCritical95(5), 2.571);
  assert.equal(ES.tCritical95(20), 2.086);
  assert.equal(ES.tCritical95(1000), 1.96);
  assert.equal(ES.tCritical95(0), 12.706, 'an impossible df fails conservative');
  assert.equal(ES.tCritical95(NaN), 12.706);
});

test('a small sample gets a WIDER interval than the normal approximation would give', () => {
  const vals = [1.2, 0.4, 2.1, -0.3, 1.8, 0.9];
  const s = ES.summarizeDateSeries(vals);
  const normalHalfWidth = 1.96 * s.se;
  const tHalfWidth = (s.tCI.hi - s.tCI.lo) / 2;
  assert.ok(tHalfWidth > normalHalfWidth, 'the t interval must be wider at n=6');
});

test('the reported CI is the WIDER of the t and bootstrap intervals (a correction may only widen a gate)', () => {
  const vals = series(40, i => Math.sin(i / 3) + 0.6);
  const s = ES.summarizeDateSeries(vals, { horizonBars: 5 });
  assert.ok(s.bootstrapCI, 'the bootstrap must run at this sample size');
  assert.ok(s.ci95.lo <= s.tCI.lo + 1e-9 && s.ci95.lo <= s.bootstrapCI.lo + 1e-9);
  assert.ok(s.ci95.hi >= s.tCI.hi - 1e-9 && s.ci95.hi >= s.bootstrapCI.hi - 1e-9);
  assert.match(s.ciBasis, /widest/);
});

test('the bootstrap is DETERMINISTIC (a gate must be reproducible from the artifact)', () => {
  const vals = series(50, i => ((i * 37) % 11) / 10 - 0.3);
  const a = ES.summarizeDateSeries(vals, { seed: 42 });
  const b = ES.summarizeDateSeries(vals, { seed: 42 });
  assert.deepEqual(a.bootstrapCI, b.bootstrapCI);
  const c = ES.summarizeDateSeries(vals, { seed: 7 });
  assert.ok(c.bootstrapCI);
});

test('EFFECTIVE sample size collapses under strong autocorrelation, and never exceeds n', () => {
  const independent = series(60, i => ((i * 7919) % 100) / 50 - 1);
  const persistent = series(60, i => Math.cos(i / 12));   // slow, highly autocorrelated
  const a = ES.summarizeDateSeries(independent);
  const b = ES.summarizeDateSeries(persistent);
  assert.ok(a.effectiveN <= a.n && b.effectiveN <= b.n);
  assert.ok(b.effectiveN < a.effectiveN, 'a persistent series carries less independent information');
});

test('BLOCK STABILITY: an edge confined to one regime is reported as 1-of-4, not as one average', () => {
  const oneRegime = [...series(20, () => 3), ...series(60, () => -0.05)];
  const s = ES.summarizeDateSeries(oneRegime);
  assert.equal(s.blockStability.blocks, 4);
  assert.equal(s.positiveBlocks, 1);
  const broad = series(80, i => 0.5 + 0.1 * Math.sin(i));
  assert.equal(ES.summarizeDateSeries(broad).positiveBlocks, 4);
});

test('block stability honestly reports "not usable" rather than inventing blocks at tiny n', () => {
  const s = ES.summarizeDateSeries([1, 2, 3, 4, 5]);
  assert.equal(s.blockStability.usable, false);
  assert.equal(s.positiveBlocks, 0);
});

test('FDR across every attempted strategy — a lone nominal winner among many does not survive', () => {
  const attempts = [{ id: 'a', p: 0.04 }, ...series(19, i => ({ id: `x${i}`, p: 0.4 + i * 0.02 }))];
  const adj = ES.fdrAdjust(attempts);
  const a = adj.find(r => r.id === 'a');
  assert.ok(a.q > 0.05, 'p=0.04 out of 20 attempts is not a discovery');
  assert.equal(a.survives, false);
  // a genuinely strong result does survive
  const strong = ES.fdrAdjust([{ id: 's', p: 0.0001 }, ...series(19, i => ({ id: `x${i}`, p: 0.5 }))]);
  assert.equal(strong.find(r => r.id === 's').survives, true);
});

test('dateLevelNetExcess exposes ONE population plus its dependence diagnostics', () => {
  const rows = series(60, i => ({ date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`, netExc: 0.8 + Math.sin(i / 5) }));
  const dn = dateLevelNetExcess(rows, { horizonBars: 5 });
  assert.equal(dn.n, 60);
  assert.equal(dn.observations, 60);
  assert.ok(Number.isFinite(dn.effectiveN) && dn.effectiveN <= dn.n);
  assert.ok(dn.bootstrapCI);
  assert.ok(dn.blockStability.usable);
  assert.match(dn.basis, /one observation per decision date/);
});

test('ADVERSARIAL: a flattering POOLED summary cannot promote when the true date series is negative', () => {
  // Pooled pick-level fields look excellent (the old gate's inputs) but the selected
  // policy's own per-date portfolio series is negative and wide.
  const track = {
    excessN: 200, avgExcess: 4.5, beatMktRate: 71, dates: 45,
    netExcessN: 200, avgNetExcess: 3.9, netBeatMktRate: 68,
    secExcN: 200, avgSecExcess: 2.5, beatSecRate: 65,
    dateNet: { n: 45, avg: -0.6, sd: 3.1, ci95: { lo: -1.9, hi: 0.7 }, effectiveN: 30, positiveBlocks: 2, blockStability: { blocks: 4, positive: 2, means: [-1, 0.4, -0.9, 0.2], usable: true } },
  };
  const g = M.gradeTrack(track, { fillVerified: true });
  assert.notEqual(g.grade, 'validated');
  assert.match(g.reason, /does not exclude zero/);
});

test('ADVERSARIAL: enough raw dates but too few EFFECTIVE dates cannot promote', () => {
  const track = {
    excessN: 120, avgExcess: 2, beatMktRate: 58, dates: 30,
    netExcessN: 120, avgNetExcess: 1.6, netBeatMktRate: 56,
    secExcN: 120, avgSecExcess: 1.1, beatSecRate: 55,
    dateNet: { n: 30, avg: 1.5, sd: 2, ci95: { lo: 0.4, hi: 2.6 }, effectiveN: 5, positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1, 1, 1, 1], usable: true } },
  };
  const g = M.gradeTrack(track, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /EFFECTIVE independent dates/);
});

test('ADVERSARIAL: an edge confined to one chronological block cannot promote', () => {
  const track = {
    excessN: 120, avgExcess: 2, beatMktRate: 58, dates: 30,
    netExcessN: 120, avgNetExcess: 1.6, netBeatMktRate: 56,
    secExcN: 120, avgSecExcess: 1.1, beatSecRate: 55,
    dateNet: { n: 30, avg: 1.5, sd: 2, ci95: { lo: 0.4, hi: 2.6 }, effectiveN: 25, positiveBlocks: 1, blockStability: { blocks: 4, positive: 1, means: [6, -0.4, -0.2, -0.3], usable: true } },
  };
  const g = M.gradeTrack(track, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /chronological blocks/);
});

test('an evidence record with no independence diagnostics at all fails CLOSED', () => {
  const track = {
    excessN: 120, avgExcess: 2, beatMktRate: 58, dates: 30,
    netExcessN: 120, avgNetExcess: 1.6, netBeatMktRate: 56,
    secExcN: 120, avgSecExcess: 1.1, beatSecRate: 55,
    dateNet: { n: 30, avg: 1.5, sd: 2, ci95: { lo: 0.4, hi: 2.6 } },   // legacy shape
  };
  const g = M.gradeTrack(track, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /Effective sample size unavailable/);
});

test('every governed (registered, sectioned) signal strategy declares a frozen policy cohort', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const missing = STRATEGY_REGISTRY
    .filter(e => e.kind === 'signal' && e.section && e.core && e.id !== 'daytrade')
    .filter(e => !Array.isArray(e.policyTiers) || !e.policyTiers.length)
    .map(e => e.id);
  assert.deepEqual(missing, [], 'a core sectioned strategy without policyTiers pools control cohorts into its promotion record');
});

// 🚨 Regression: summarizeDateSeries rounds avg to 2dp for DISPLAY, but pValueOf used the
// rounded fields — a genuine ~0.003/cohort effect computed t from 0.00 and reported p≈1.
// The summary must carry full-precision avgExact/seExact and pValueOf must prefer them.
test('pValueOf resolves a small-magnitude (sub-0.01) mean instead of rounding it to zero', () => {
  // 40 cohorts, mean ≈ +0.003, tiny dispersion — an unambiguous nonzero effect.
  const series = Array.from({ length: 40 }, (_, i) => 0.003 + (i % 2 ? 0.0004 : -0.0004));
  const s = ES.summarizeDateSeries(series, { B: 200 });
  assert.ok(s, 'summary must resolve');
  assert.ok(Number.isFinite(s.avgExact) && Math.abs(s.avgExact - 0.003) < 1e-6,
    'summary must carry the full-precision mean');
  assert.ok(Number.isFinite(s.seExact) && s.seExact > 0, 'summary must carry the full-precision SE');
  const p = ES.pValueOf(s);
  assert.ok(Number.isFinite(p), 'p-value must resolve');
  assert.ok(p < 0.05, `a clear nonzero effect must not report p≈1 (got ${p})`);
});

test('pValueOf still resolves on a legacy persisted summary (rounded fields only)', () => {
  const p = ES.pValueOf({ avg: 1.5, se: 0.4 });
  assert.ok(Number.isFinite(p) && p < 0.05, 'legacy summaries without exact fields must keep working');
});

test('pValueOf uses Student-t at df = effectiveN − 1, not the normal CDF', () => {
  // t = 2.2 at effectiveN 12 → df 11: exact two-sided t p ≈ 0.050; the old normal
  // CDF gave ≈ 0.028 — anti-conservative p's feeding the BH demote family.
  const p = ES.pValueOf({ avgExact: 2.2, seExact: 1, effectiveN: 12 });
  assert.ok(Math.abs(p - 0.0501) < 0.005, `expected ≈0.050, got ${p}`);
  // Without effectiveN (legacy persisted summary) the normal CDF is retained.
  const pLegacy = ES.pValueOf({ avg: 2.2, se: 1 });
  assert.ok(Math.abs(pLegacy - 0.0278) < 0.005, `legacy path stays normal-CDF, got ${pLegacy}`);
});
