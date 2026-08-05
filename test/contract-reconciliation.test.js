'use strict';
// PHASE 7 — every contract must describe what its evaluator actually measures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../lib/strategy-contracts');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const M = require('../lib/maturity');

test('DOWNDAY: the contract metric, the time exit and the primary label are all 3 sessions', () => {
  const c = SC.contractFor('downday');
  assert.equal(c.metric, '3d', 'the graded bucket must be the contract horizon, not 5d');
  assert.equal(c.timeExitSessions, 3);
  assert.match(c.primaryLabel, /@3 sessions/);
  assert.match(c.conditionGate, /red-tape/i);
  assert.match(c.eligibleCohort, /bounce/i);
  assert.equal(c.fillPolicy, 'next-session-open');
  assert.ok(c.benchmark.includes('SPY') && c.benchmark.includes('sector'));
  assert.ok(c.delistingPolicy);
});

test('DOWNDAY: maturity now grades it on the 3-session bucket (no silent horizon substitution)', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'downday');
  const summary = { groups: [{ section: 'DownDay', tier: 'EMERGING', horizons: {
    '3d': { excessN: 30, avgExcess: 0.6, beatMktRate: 55, netExcessN: 30, avgNetExcess: 0.4, netBeatMktRate: 54 },
    '5d': { excessN: 30, avgExcess: 5.0, beatMktRate: 90, netExcessN: 30, avgNetExcess: 4.8, netBeatMktRate: 88 },
  } }] };
  const g = M.gradeStrategy(entry, summary);
  assert.equal(g.stats.metricBasis, 'contract');
  assert.equal(g.stats.excessN, 30);
  assert.equal(g.stats.avgExcess, 0.4, 'the 3-session number, not the flattering 5-day one');
});

test('the Scoreboard exposes a 3-session horizon bucket (additively — every legacy key survives)', () => {
  const { summarizeReturns } = require('../lib/apex-routes');
  assert.ok(summarizeReturns([{ ret: 1, mfe: 2 }], { horizonBars: 3 }));
  const src = require('node:fs').readFileSync(require.resolve('../lib/apex-routes.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("const HORIZONS = [["));
  for (const k of ['1d', '3d', '5d', '10d', '20d', '1m', '3m']) assert.ok(line.includes(`'${k}'`), `${k} must exist`);
});

test('GAPGO: the verified lane owns the promotion label, and v1 evidence is never inherited', () => {
  const c = SC.contractFor('gapgo');
  assert.equal(c.verifyVersion, 'gapgo-orb-verify-v2');
  assert.equal(c.eligibleEntrySession, 'next-session');
  assert.match(c.verifiedPrimaryLabel, /same session as the fill/);
  assert.match(c.evidenceInheritance, /NONE/);
  assert.match(c.promotionLane, /not promotion evidence/i);
  assert.match(c.primaryLabel, /PROXY/, 'the legacy ledger label must still say it is a proxy');
  // and it stays research-only
  assert.equal(STRATEGY_REGISTRY.find(e => e.id === 'gapgo').maturity, 'shadow');
});

test('BREAKOUT: only the promotion metric may promote; other horizons are labeled research', () => {
  const c = SC.contractFor('screener');
  assert.equal(c.promotionMetric, '5d');
  assert.equal(c.metric, c.promotionMetric);
  assert.ok(c.researchHorizons.length > 1);
  assert.match(c.role, /candidate-generation|prioritization/i);
  assert.match(c.primaryLabel, /research only/);
});

test('GHOST: promotion is INCREMENTAL over the underlying breakout score, never standalone', () => {
  const c = SC.contractFor('ghost');
  assert.equal(c.incrementalOver, 'screener');
  assert.match(c.role, /overlay/i);
  assert.match(c.primaryLabel, /INCREMENTAL/);
  assert.match(c.primaryLabel, /identical candidate dates/);
});

test('COIL: expansion probability and trade readiness are two models, and only Stage B can promote', () => {
  const c = SC.contractFor('coil');
  assert.equal(c.twoStage.stageA.promotable, false);
  assert.equal(c.twoStage.stageB.promotable, true);
  assert.match(c.twoStage.stageA.display, /NOT a probability of profit/);
  assert.match(c.primaryLabel, /Stage B only/);
});

test('IGNITION: the three lanes are separate identities (only the frozen funnel policy promotes)', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'ignition');
  assert.deepEqual(entry.policyTiers, ['IGNITION']);
  assert.ok(M.EXCLUDED_TIER_PREFIXES.includes('BROAD_'));
  assert.ok(M.EXCLUDED_TIER_PREFIXES.includes('HIST_'));
  // the control tier and the research lanes are excluded from the promoted record
  const summary = { groups: [
    { section: 'Ignition', tier: 'IGNITION', horizons: { '5d': { excessN: 30, avgExcess: 1, beatMktRate: 55 } } },
    { section: 'Ignition', tier: 'WATCH', horizons: { '5d': { excessN: 90, avgExcess: 9, beatMktRate: 95 } } },
    { section: 'Ignition', tier: 'BROAD_IGNITION', horizons: { '5d': { excessN: 90, avgExcess: 9, beatMktRate: 95 } } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['IGNITION']);
  assert.ok(g.stats.excludedTiers.includes('WATCH'));
  assert.ok(g.stats.excludedTiers.includes('BROAD_IGNITION'));
});

test('LEAD-ONLY strategies declare it in the contract, so eligibility can refuse to size them', () => {
  const leadOnly = ['biotech', 'readthrough', 'anomaly', 'secondwave', 'crossasset', 'toneshift', 'tone', 'attention', 'optionsflow'];
  for (const id of leadOnly) {
    assert.equal(SC.contractFor(id).fillPolicy, 'lead-only', `${id} must be lead-only`);
  }
});

test('OPTIONS FLOW: the contract states what the data cannot support and refuses to infer it', () => {
  const lim = SC.contractFor('optionsflow').inferenceLimits;
  assert.ok(lim.cannotInfer.some(x => /opening vs closing/i.test(x)));
  assert.ok(lim.cannotInfer.some(x => /hedge vs directional/i.test(x)));
  assert.ok(lim.cannotInfer.some(x => /bought vs sold/i.test(x)));
  assert.match(lim.rule, /never estimated/);
});

test('PATTERN RADAR now has an outcome contract (it had a section mapping but no contract)', () => {
  const c = SC.contractFor('chartpattern');
  assert.ok(c);
  assert.equal(c.scoringVersion, 'pattern-decision-v2');
  assert.equal(c.fillVerified, false);
  assert.match(c.primaryLabel, /FDR-controlled/);
});

test('every contract scoringVersion still matches its registry entry (identity stays single-sourced)', () => {
  for (const [id, c] of Object.entries(SC.CONTRACTS)) {
    const entry = STRATEGY_REGISTRY.find(e => e.id === id);
    if (!entry) continue;
    assert.equal(c.scoringVersion, entry.scoringVersion, `${id} version drift between registry and contract`);
  }
});

test('fillVerified can only be granted by derived episode evidence, never by the contract flag', () => {
  for (const [id, c] of Object.entries(SC.CONTRACTS)) {
    assert.notEqual(c.fillVerified, true, `${id} declares fillVerified:true — it must be derived from episodes`);
  }
  assert.equal(SC.fillVerifiedFor('screener').fillVerified, false);
  assert.match(SC.fillVerifiedFor('screener').detail, /fails closed/);
  const derived = SC.fillVerifiedFor('screener', { fillVerification: { screener: { fillVerified: true, reason: '60 resolved on verified fills', resolved: 60 } } });
  assert.equal(derived.fillVerified, true);
  assert.equal(derived.basis, 'derived-from-episodes');
});
