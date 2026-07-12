'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/maturity');

// ── gradeTrack: earns its grade from the resolved benchmark record ───────────
test('gradeTrack: no resolved picks → experimental (accruing)', () => {
  const g = M.gradeTrack({ excessN: 0, avgExcess: null, beatMktRate: null });
  assert.equal(g.grade, 'experimental');
});

test('gradeTrack: significant positive over big sample → validated', () => {
  // 40 resolved, beats 70% (28/40) → Wilson lo > 50%, avg excess positive.
  const g = M.gradeTrack({ excessN: 40, avgExcess: 2.4, beatMktRate: 70 });
  assert.equal(g.grade, 'validated');
  assert.ok(g.stats.beatLo > 50);
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

test('gradeStrategy: overlay graduates out of the lab once Validated', () => {
  const entry = { id: 'events', label: 'CERN', kind: 'signal', section: 'CERN', horizon: 'position', core: false };
  const summary = { groups: [{ section: 'CERN', tier: 'FORCED_DOWNGRADE', horizons: { '1m': { excessN: 40, avgExcess: 3, beatMktRate: 72 } } }] };
  const g = M.gradeStrategy(entry, summary);
  assert.equal(g.grade, 'validated');
  assert.equal(g.inLab, false);
});

// ── classifyStrategies: sort + tally + lab list ──────────────────────────────
test('classifyStrategies: sorts strongest-first with a per-grade tally', () => {
  const registry = [
    { id: 'a', label: 'A', kind: 'signal', section: 'A', horizon: 'swing', core: false }, // experimental → lab
    { id: 'b', label: 'B', kind: 'signal', section: 'B', horizon: 'swing', core: true },  // validated
    { id: 'c', label: 'C', kind: 'informational' },                                        // informational
  ];
  const summary = { generatedAt: 'x', groups: [{ section: 'B', tier: 'T', horizons: { '5d': { excessN: 30, avgExcess: 2, beatMktRate: 70 } } }] };
  const out = M.classifyStrategies(summary, registry);
  assert.equal(out.strategies[0].id, 'b'); // validated ranks first
  assert.equal(out.counts.validated, 1);
  assert.equal(out.counts.experimental, 1);
  assert.deepEqual(out.lab, ['a']);
});
