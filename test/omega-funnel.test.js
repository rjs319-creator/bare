'use strict';
// OMEGA candidate-funnel snapshot tests (Phase 4): within-strategy normalization, complete
// candidate capture (eligible + ineligible), OMEGA selection/rank, deterministic id, and
// fail-closed live-funnel parity assessment.
const { test } = require('node:test');
const assert = require('node:assert');
const OF = require('../lib/omega-funnel');

const today = () => ({
  regime: { riskOn: true },
  freshness: { dataVersion: 'decision-v9' },
  horizons: {
    swing: [
      { ticker: 'AAA', strategyFamily: 'trend', score: 88, rank: 1, sector: 'Technology', horizon: 'swing' },
      { ticker: 'BBB', strategyFamily: 'trend', score: 70, rank: 2, sector: 'Energy', horizon: 'swing' },
      { ticker: 'CCC', strategyFamily: 'event', score: 55, rank: 1, sector: 'Health Care', horizon: 'swing' },
      { ticker: 'DDD', strategyFamily: 'meanReversion', score: 99, rank: 1, sector: 'Utilities', horizon: 'swing' },
    ],
  },
});
const cards = [{ ticker: 'AAA', tier: 'OMEGA_QUALIFIED', score: 66 }, { ticker: 'CCC', tier: 'OMEGA_WATCH', score: 50 }];
const build = () => OF.buildFunnelSnapshot({ date: '2026-07-22', today: today(), omegaCards: cards, meta: { candidateCap: 60, generatedAt: '2026-07-22T20:00:00Z', sourceStrategyVersion: 'decision-v9' } });

test('normalizes source scores WITHIN strategy-and-date (not across unrelated screeners)', () => {
  const cands = [
    { ticker: 'A', sourceStrategy: 'trend', sourceRawScore: 88 },
    { ticker: 'B', sourceStrategy: 'trend', sourceRawScore: 70 },
    { ticker: 'C', sourceStrategy: 'event', sourceRawScore: 55 },   // top of its OWN family despite lower raw
  ];
  const n = OF.normalizeWithinStrategy(cands);
  assert.strictEqual(n[0].sourceRankInStrategy, 1);
  assert.strictEqual(n[1].sourceRankInStrategy, 2);
  assert.strictEqual(n[2].sourceRankInStrategy, 1, 'event C is #1 within event, not compared to trend');
  assert.strictEqual(n[2].sourcePercentileInStrategy, 100, 'sole event name is top percentile of its family');
});

test('captures the COMPLETE candidate set — eligible AND ineligible — with an eligibility flag', () => {
  const s = build();
  assert.strictEqual(s.counts.total, 4);
  const ddd = s.candidates.find(c => c.ticker === 'DDD');
  assert.strictEqual(ddd.eligible, false, 'meanReversion is not a momentum family');
  assert.strictEqual(ddd.selected, false);
  assert.strictEqual(ddd.omegaRank, null, 'an ineligible name is never OMEGA-ranked');
  assert.strictEqual(s.counts.eligible, 3);
});

test('records OMEGA selection + rank per candidate', () => {
  const s = build();
  const aaa = s.candidates.find(c => c.ticker === 'AAA');
  assert.strictEqual(aaa.selected, true);
  assert.strictEqual(aaa.omegaRank, 1);
  assert.strictEqual(aaa.omegaTier, 'OMEGA_QUALIFIED');
  assert.strictEqual(s.counts.ranked, 2);
});

test('per-strategy roster carries counts + version', () => {
  const s = build();
  assert.strictEqual(s.strategies.trend.count, 2);
  assert.strictEqual(s.strategies.trend.version, 'decision-v9');
  assert.strictEqual(s.strategies.meanReversion.eligible, 0);
});

test('snapshot is frozen, valid, prospective, and has a deterministic id', () => {
  const s1 = build(), s2 = build();
  assert.ok(Object.isFrozen(s1));
  assert.strictEqual(OF.validateFunnelSnapshot(s1).valid, true);
  assert.strictEqual(s1.provenance, 'prospective_live');
  assert.strictEqual(s1.snapshotId, s2.snapshotId, 'deterministic id from the candidate set');
});

test('validation rejects a non-prospective or dateless snapshot', () => {
  assert.strictEqual(OF.validateFunnelSnapshot({ schema: 'OmegaFunnelSnapshot', date: '2026-07-22', candidates: [], provenance: 'historical_reconstruction' }).valid, false);
  assert.strictEqual(OF.validateFunnelSnapshot({ schema: 'OmegaFunnelSnapshot', date: 'bad', candidates: [], provenance: 'prospective_live' }).valid, false);
});

test('parity is fail-closed: TRUE only when every cohort date is covered', () => {
  assert.strictEqual(OF.assessFunnelParity(['2026-07-22'], ['2026-07-22']).historicalLiveParity, true);
  const partial = OF.assessFunnelParity(['2026-07-21', '2026-07-22'], ['2026-07-22']);
  assert.strictEqual(partial.historicalLiveParity, false);
  assert.strictEqual(partial.coveragePct, 50);
  assert.strictEqual(OF.assessFunnelParity([], []).historicalLiveParity, false, 'no cohorts ⇒ not parity');
});
