'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/maturity');

// ── gradeTrack: earns its grade from the resolved benchmark record ───────────
test('gradeTrack: no resolved picks → experimental (accruing)', () => {
  const g = M.gradeTrack({ excessN: 0, avgExcess: null, beatMktRate: null });
  assert.equal(g.grade, 'experimental');
});

// maturity-v2: Validated is the promotion grade and carries the full gate stack —
// cost-net + sector control (fail closed) + ≥50 episodes + ≥20 KNOWN dates +
// date-level portfolio CI clear of zero + fill-VERIFIED grading pipeline.
const FULL_TRACK = Object.freeze({
  excessN: 60, avgExcess: 2.6, beatMktRate: 72,
  netExcessN: 60, avgNetExcess: 2.4, netBeatMktRate: 70,
  secExcN: 60, avgSecExcess: 1.8, beatSecRate: 62,
  dates: 30,
  dateNet: { n: 30, avg: 1.2, sd: 2.0, ci95: { lo: 0.4, hi: 2.0 }, effectiveN: 22, positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1.1, 1.3, 1.0, 1.4], usable: true } },
});

test('gradeTrack: full gate stack + verified fills → validated', () => {
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: true });
  assert.equal(g.grade, 'validated');
  assert.ok(g.stats.beatLo > 50);
  assert.equal(g.stats.basis, 'net');
});

test('gradeTrack: each missing promotion gate fails CLOSED to promising with its reason', () => {
  // no sector record at all → the sector control can no longer pass open
  let g = M.gradeTrack({ ...FULL_TRACK, secExcN: 0, avgSecExcess: null, beatSecRate: null }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /sector-relative record/i);
  // under 50 resolved episodes
  g = M.gradeTrack({ ...FULL_TRACK, excessN: 40, netExcessN: 40 }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /≥50/);
  // independent decision dates unknown (raw-pick fallback no longer promotes)
  g = M.gradeTrack({ ...FULL_TRACK, dates: null }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /dates are UNKNOWN/i);
  // date-level portfolio evidence missing
  g = M.gradeTrack({ ...FULL_TRACK, dateNet: null }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /date-level/i);
  // date-level CI includes zero
  g = M.gradeTrack({ ...FULL_TRACK, dateNet: { n: 30, avg: 0.4, sd: 3, ci95: { lo: -0.2, hi: 1.0 } } }, { fillVerified: true });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /does not exclude zero/i);
  // proxy (fill-unverified) grading pipeline — the default — can never promote
  g = M.gradeTrack({ ...FULL_TRACK });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /proxy/i);
});

test('gradeTrack: a gross-only record can NEVER earn validated (fail closed on basis)', () => {
  // Same strength, but no net channel → the ceiling is promising, with an explicit reason.
  const g = M.gradeTrack({ excessN: 40, avgExcess: 2.4, beatMktRate: 70 });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /cost-net|net-of-cost/i);
  assert.equal(g.stats.basis, 'gross');
});

test('gradeTrack: significant negative over big sample → disabled', () => {
  const g = M.gradeTrack({ excessN: 40, avgExcess: -2.1, beatMktRate: 30 });
  assert.equal(g.grade, 'disabled');
  assert.ok(g.stats.beatHi < 50);
});

test('gradeTrack: positive but small/insignificant → promising', () => {
  // 12 resolved, 58% beat → positive point estimate, Wilson lo ≤ 50%.
  const g = M.gradeTrack({ excessN: 12, avgExcess: 1.1, beatMktRate: 58 });
  assert.equal(g.grade, 'promising');
  assert.ok(g.stats.beatLo <= 50);
});

test('gradeTrack: too few resolved → experimental even if positive', () => {
  const g = M.gradeTrack({ excessN: 4, avgExcess: 3.0, beatMktRate: 75 });
  assert.equal(g.grade, 'experimental');
});

test('gradeTrack: big sample, positive avg but coin-flip beat-rate → not validated', () => {
  // avg excess positive (a few big winners) but only 50% beat and not significant.
  const g = M.gradeTrack({ excessN: 30, avgExcess: 0.4, beatMktRate: 50 });
  assert.notEqual(g.grade, 'validated');
  assert.notEqual(g.grade, 'disabled');
});

test('gradeTrack: beats SPY but NOT its sector → promising, not validated (sector control)', () => {
  // Strong vs market, but the sector ran even harder → the edge is sector beta.
  const g = M.gradeTrack({ excessN: 40, avgExcess: 2.4, beatMktRate: 70, secExcN: 40, avgSecExcess: -1.5, beatSecRate: 40 });
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /sector beta/);
  assert.equal(g.stats.baselines.sector.avgExcess, -1.5);
});

test('gradeTrack: beats BOTH market and sector (all other gates met) → validated', () => {
  const g = M.gradeTrack({ ...FULL_TRACK }, { fillVerified: true });
  assert.equal(g.grade, 'validated');
  assert.match(g.reason, /its sector/);
  assert.match(g.reason, /verified executable fills/);
});

// ── poolSectionTrack: excessN-weighted pooling across tiers ───────────────────
test('poolSectionTrack: pools tiers by excessN at the intended horizon', () => {
  const groups = [
    { tier: 'A', horizons: { '5d': { excessN: 10, avgExcess: 2, beatMktRate: 60 } } },
    { tier: 'B', horizons: { '5d': { excessN: 30, avgExcess: -1, beatMktRate: 40 } } },
  ];
  const pooled = M.poolSectionTrack(groups, 'swing'); // swing → 5d metric
  assert.equal(pooled.excessN, 40);
  // weighted avg = (2*10 + -1*30)/40 = -0.25
  assert.equal(pooled.avgExcess, -0.25);
  // beat wins = round(.6*10)+round(.4*30) = 6+12 = 18 → 45%
  assert.equal(pooled.beatMktRate, 45);
});

test('poolSectionTrack: carries the largest-dates tier\'s dateNet block (conservative, labeled)', () => {
  const groups = [
    { tier: 'A', horizons: { '5d': { excessN: 10, avgExcess: 2, beatMktRate: 60, dates: 5, dateNet: { n: 5, avg: 1, sd: 1, ci95: { lo: 0.1, hi: 1.9 } } } } },
    { tier: 'B', horizons: { '5d': { excessN: 30, avgExcess: 1, beatMktRate: 55, dates: 25, dateNet: { n: 25, avg: 0.8, sd: 2, ci95: { lo: 0.1, hi: 1.5 } } } } },
  ];
  const pooled = M.poolSectionTrack(groups, 'swing');
  assert.equal(pooled.dateNet.n, 25);
  assert.match(pooled.dateNet.poolingBasis, /largest-dates-tier/);
});

test('poolSectionTrack: no benchmarked picks → null stats', () => {
  const pooled = M.poolSectionTrack([{ tier: 'A', horizons: { '5d': { excessN: 0 } } }], 'swing');
  assert.equal(pooled.excessN, 0);
  assert.equal(pooled.avgExcess, null);
});

// ── gradeStrategy: informational + lab routing ───────────────────────────────
test('gradeStrategy: informational entry is never graded or lab-routed', () => {
  const g = M.gradeStrategy({ id: 'sectors', label: 'Sectors', kind: 'informational' }, { groups: [] });
  assert.equal(g.grade, 'informational');
  assert.equal(g.inLab, false);
});

test('gradeStrategy: non-core unproven overlay routes to the Research Lab', () => {
  const entry = { id: 'events', label: 'CERN', kind: 'signal', section: 'CERN', horizon: 'position', core: false };
  const g = M.gradeStrategy(entry, { groups: [] }); // no data → experimental
  assert.equal(g.grade, 'experimental');
  assert.equal(g.inLab, true);
});

test('gradeStrategy: core backbone stays out of the lab even when unproven', () => {
  const entry = { id: 'screener', label: 'Breakout', kind: 'signal', section: 'screener', horizon: 'swing', core: true };
  const g = M.gradeStrategy(entry, { groups: [] });
  assert.equal(g.inLab, false);
});

test('gradeStrategy: a stellar record on a fill-UNVERIFIED pipeline caps at promising and stays in the lab', () => {
  // maturity-v2: every current contract is fillVerified:false (the grading pipelines
  // are close-to-close proxies), so even a record clearing every statistical bar
  // cannot reach Validated — graduation now requires an executable-fill pipeline.
  const entry = { id: 'events', label: 'CERN', kind: 'signal', section: 'CERN', horizon: 'position', core: false };
  const summary = { groups: [{ section: 'CERN', tier: 'FORCED_DOWNGRADE', horizons: { '1m': {
    excessN: 60, avgExcess: 3, beatMktRate: 72, netExcessN: 60, avgNetExcess: 2.7, netBeatMktRate: 70,
    secExcN: 60, avgSecExcess: 1.5, beatSecRate: 60, dates: 30,
    dateNet: { n: 30, avg: 1.1, sd: 2.0, ci95: { lo: 0.3, hi: 1.9 }, effectiveN: 21, positiveBlocks: 4, blockStability: { blocks: 4, positive: 4, means: [1, 1.2, 0.9, 1.3], usable: true } },
  } } }] };
  const g = M.gradeStrategy(entry, summary);
  assert.equal(g.grade, 'promising');
  assert.match(g.reason, /proxy/i);
  assert.equal(g.inLab, true, 'proxy-graded overlays stay in the Research Lab');
});

// ── classifyStrategies: sort + tally + lab list ──────────────────────────────
test('classifyStrategies: sorts strongest-first with a per-grade tally', () => {
  const registry = [
    { id: 'a', label: 'A', kind: 'signal', section: 'A', horizon: 'swing', core: false }, // experimental → lab
    { id: 'b', label: 'B', kind: 'signal', section: 'B', horizon: 'swing', core: true },  // validated
    { id: 'c', label: 'C', kind: 'informational' },                                        // informational
  ];
  const summary = { generatedAt: 'x', groups: [{ section: 'B', tier: 'T', horizons: { '5d': { excessN: 30, avgExcess: 2, beatMktRate: 70, netExcessN: 30, avgNetExcess: 1.7, netBeatMktRate: 67 } } }] };
  const out = M.classifyStrategies(summary, registry);
  assert.equal(out.strategies[0].id, 'b'); // promising (v2: proxy pipeline caps below validated) still ranks first
  assert.equal(out.counts.validated, 0);
  assert.equal(out.counts.promising, 1);
  assert.equal(out.counts.experimental, 1);
  assert.deepEqual(out.lab, ['a']); // b is core:true — backbone screeners never route to the lab
});
