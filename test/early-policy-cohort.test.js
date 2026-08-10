'use strict';
// Early-policy-cohort pass (2026-08-09) — the screener's promoted claim narrows to the
// one cohort its own resolved record and a production-parity replay support:
//   • Live ledger (5d cost-net vs SPY): Early:large +0.62% (n=24/16 dates) while
//     Breakout:large −2.66% (n=67), Setup:large −0.20% (n=89) and every small-scope
//     cell ≤−2% — the pooled record graded the whole section 'disabled'.
//   • Replay (research/74-early-cohort-replay.js, 2,000 names / 195 sessions
//     2022-2026): Setup −0.38%/5d (HAC t −3.89), Breakout −0.31%/5d (t −2.07);
//     Early−Setup +0.34% (t 2.77, 4/4 blocks). Early ABSOLUTE ≈0 — the narrowing
//     removes proven-negative lanes; it never pre-proves the Early cohort.
// Mechanism under test: gradeStrategy's policyScopes filter (new) + the screener
// registry cohort. Excluded tiers/scopes stay reportable as controls.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../lib/maturity');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

const H = (over = {}) => ({ excessN: 60, avgExcess: 2, beatMktRate: 60, netExcessN: 60, avgNetExcess: 1.8, netBeatMktRate: 58, dates: 25, ...over });

test('screener registry: policy cohort is Early:large alone', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'screener');
  assert.deepEqual(entry.policyTiers, ['Early']);
  assert.deepEqual(entry.policyScopes, ['large']);
});

test('screener grades on Early:large only — Breakout/Setup and other scopes are excluded controls', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'screener');
  const summary = { groups: [
    { section: 'screener', tier: 'Early', scope: 'large', horizons: { '5d': H() } },
    { section: 'screener', tier: 'Early', scope: 'small', horizons: { '5d': H({ avgNetExcess: -9 }) } },
    { section: 'screener', tier: 'Setup', scope: 'large', horizons: { '5d': H({ avgNetExcess: -9 }) } },
    { section: 'screener', tier: 'Breakout', scope: 'large', horizons: { '5d': H({ avgNetExcess: -9 }) } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['Early']);
  assert.ok(g.stats.avgExcess > 0, 'only the positive policy cell pools — the proven-negative lanes no longer poison the grade');
  assert.deepEqual([...g.stats.excludedTiers].sort(), ['Breakout', 'Early@small', 'Setup']);
});

test('policyScopes absent → all scopes pool exactly as before (no behavior change for other strategies)', () => {
  const entry = { id: 'x', label: 'X', kind: 'signal', section: 'S', horizon: 'swing', core: true, scoringVersion: 'x-v1', policyTiers: ['A'] };
  const summary = { groups: [
    { section: 'S', tier: 'A', scope: 'large', horizons: { '5d': H() } },
    { section: 'S', tier: 'A', scope: 'small', horizons: { '5d': H() } },
    { section: 'S', tier: 'B', scope: 'large', horizons: { '5d': H() } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['A', 'A']);
  assert.equal(g.stats.excessN, 120, 'both scopes of the policy tier pool when no policyScopes is declared');
  assert.deepEqual(g.stats.excludedTiers, ['B']);
});

test('a scope-less group never slips into a scope-restricted policy cohort (fail closed)', () => {
  const entry = { id: 'y', label: 'Y', kind: 'signal', section: 'S', horizon: 'swing', core: true, scoringVersion: 'y-v1', policyTiers: ['A'], policyScopes: ['large'] };
  const summary = { groups: [
    { section: 'S', tier: 'A', scope: null, horizons: { '5d': H() } },
    { section: 'S', tier: 'A', scope: 'large', horizons: { '5d': H() } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.equal(g.stats.excessN, 60, 'only the scope-stamped group pools');
});
