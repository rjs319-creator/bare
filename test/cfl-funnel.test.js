'use strict';
// CFL FUNNEL — stage aggregation, preventable split, miss→stage mapping.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/cfl/funnel');
const { MISS } = require('../lib/cfl/taxonomy');

const day = (over = {}) => ({
  decisionDate: '2026-06-01',
  replaySummary: { counts: { cohort: 100, selected: 10, nearMiss: 5, rejected: 85 }, regime: { riskOn: true, bearish: false } },
  episodes: [{ matured: true }, { matured: true }, { matured: false }],
  opportunities: 4, captured: 1,
  missed: [
    { attribution: { primaryFailure: MISS.RANKING_FAILURE, preventable: true }, trace: { warningSessions: 6, detectedBeforeMoveFrac: 0.2 } },
    { attribution: { primaryFailure: MISS.CANDIDATE_GENERATION_FAILURE, preventable: true }, trace: { warningSessions: 2, detectedBeforeMoveFrac: 0.6 } },
    { attribution: { primaryFailure: MISS.NO_PREMOVE_EVIDENCE, preventable: false }, trace: null },
  ],
  ...over,
});

test('computeFunnel aggregates stages, categories, and the preventable/unforecastable split', () => {
  const f = F.computeFunnel([day(), day({ decisionDate: '2026-06-08' })]);
  assert.strictEqual(f.days, 2);
  assert.strictEqual(f.stages.eligibleUniverse, 200);
  assert.strictEqual(f.stages.generatedCandidates, 30);
  assert.strictEqual(f.stages.topRanked, 20);
  assert.strictEqual(f.opportunities, 8);
  assert.strictEqual(f.captured, 2);
  assert.strictEqual(f.missByCategory[MISS.RANKING_FAILURE], 2);
  assert.strictEqual(f.missByStage.topRanked, 2);           // ranking failures die at the top-ranked stage
  assert.strictEqual(f.missByStage.generatedCandidates, 2);
  assert.strictEqual(f.missByStage.unforecastable, 2);
  assert.strictEqual(f.preventableSplit.preventable, 4);
  assert.strictEqual(f.preventableSplit.unforecastable, 2);
  assert.ok(Math.abs(f.preventableSplit.preventableShare - 4 / 6) < 1e-3);   // rate() reports 3 decimals
});

test('discovery recall counts opportunities the engine SURFACED even when lost later — separate from end-to-end capture', () => {
  const f = F.computeFunnel([day()]);
  // captured(1) + losses at/after topRanked (ranking failure = 1) = 2 of 4 discovered.
  assert.ok(Math.abs(f.discovery.opportunityRecall - 0.5) < 1e-9);
  assert.ok(Math.abs(f.selection.opportunityCaptureRate - 0.25) < 1e-9);
});

test('warning-time median and detected-before-move fractions come only from traces that exist', () => {
  const f = F.computeFunnel([day()]);
  assert.strictEqual(f.warningTime.n, 2);
  assert.strictEqual(f.warningTime.medianSessions, 6);
  assert.strictEqual(f.detectedBeforeMove['25pct'], 0.5);   // one of two traces detected within 25% of the move
});

test('regime split accumulates capture rates per regime label', () => {
  const f = F.computeFunnel([day(), day({ replaySummary: { ...day().replaySummary, regime: { bearish: true } } })]);
  assert.ok(f.byRegime['risk-on'] && f.byRegime['risk-off']);
  assert.strictEqual(f.byRegime['risk-on'].opportunities, 4);
});

test('empty input yields an honest zero-day report, not a crash', () => {
  const f = F.computeFunnel([]);
  assert.strictEqual(f.days, 0);
  assert.strictEqual(f.warningTime.medianSessions, null);
});
