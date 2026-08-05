'use strict';
// PHASE 13 — the safe learning loop. Automatic demotion is allowed; automatic promotion is
// structurally impossible.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CC = require('../lib/champion-challenger');

const NOW = Date.parse('2026-08-05T12:00:00Z');
const WINDOW = {
  calibrationError: 0.04, rankIC: 0.03, costNetUtilityPct: 0.8, namesScored: 900,
  turnover: 0.35, missingnessRate: 0.05, regimePositive: { riskOn: true, neutral: true, riskOff: false },
};
const GOOD_ARTIFACT = {
  version: 'ch-v1', approve: true, approvedAt: '2026-08-01T00:00:00Z', approvedBy: 'reviewer',
  codeCommit: 'abc', datasetHash: 'd', universeHash: 'u', featureHash: 'f',
  trainingCutoff: '2026-06-01', foldDefinition: 'purged walk-forward', primaryMetric: 'cost-net excess',
  validationResults: { passed: true, sampleSize: 120, effectiveSampleSize: 30, positiveBlocks: 4, multipleTestingCorrected: true, correctedPValue: 0.01, alpha: 0.05, ci95: { lo: 0.2, hi: 1.1 } },
  costStress: { passed: true, doubledCostNet: 0.3, stressedCostNet: 0.1 },
  survivorshipStatus: { safe: true }, calibration: { passed: true }, tailRisk: { es95: -3 },
  prospectiveEvidence: { passed: true, episodes: 40 }, limitations: 'one cycle',
  evidenceHash: 'e', expiresAt: '2026-12-01T00:00:00Z', dataQualityBlockers: [],
};
const beats = { dates: 60, championUtility: 0.4, challengerUtility: 1.1, ci95: { lo: 0.2, hi: 1.2 } };

test('a healthy champion is HELD and explicitly frozen', () => {
  const d = CC.decide({ champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: WINDOW }, nowMs: NOW });
  assert.equal(d.champion.decision, CC.DECISION.HOLD);
  assert.equal(d.champion.frozen, true);
  assert.equal(d.champion.drift.drifted, false);
});

test('DRIFT on any monitored axis triggers AUTOMATIC demotion (safety needs no approval)', () => {
  const axes = {
    calibration: { calibrationError: 0.2 },
    rankIC: { rankIC: -0.05 },
    costNetUtility: { costNetUtilityPct: -1.5 },
    coverage: { namesScored: 300 },
    turnover: { turnover: 0.99 },
    missingness: { missingnessRate: 0.4 },
    regimeStability: { regimePositive: { riskOn: true, neutral: false, riskOff: false } },
  };
  for (const [axis, patch] of Object.entries(axes)) {
    const d = CC.decide({ champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: { ...WINDOW, ...patch } }, nowMs: NOW });
    assert.equal(d.champion.decision, CC.DECISION.AUTO_DEMOTE, `${axis} must demote`);
    assert.ok(d.champion.drift.breaches.some(b => b.id === axis), `${axis} must be the named breach`);
  }
});

test('an UNMEASURABLE champion fails closed (drift unprovable ⇒ demote)', () => {
  const d = CC.decide({ champion: { id: 'prod', version: 'v1', referenceWindow: null, currentWindow: WINDOW }, nowMs: NOW });
  assert.equal(d.champion.decision, CC.DECISION.AUTO_DEMOTE);
  assert.equal(d.champion.drift.measurable, false);
});

test('a missing METRIC is a breach, not a pass', () => {
  const d = CC.evaluateDrift({ ...WINDOW, rankIC: null }, WINDOW);
  assert.equal(d.drifted, true);
  assert.ok(d.breaches.some(b => b.id === 'rankIC'));
});

test('AUTOMATIC PROMOTION IS IMPOSSIBLE: the best possible challenger still needs a human', () => {
  const d = CC.decide({
    champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: WINDOW },
    challengers: [{ id: 'ch', version: 'ch-v1', paired: beats, prospective: true, artifact: GOOD_ARTIFACT }],
    nowMs: NOW,
  });
  assert.equal(d.challengers[0].decision, CC.DECISION.REQUIRES_HUMAN_APPROVAL);
  assert.equal(d.autoPromotionPossible, false);
  assert.match(d.policy, /structurally impossible/);
  // and there is no code path that returns a PROMOTE decision
  assert.ok(!Object.values(CC.DECISION).includes('PROMOTE'));
});

test('a challenger that only wins RETROSPECTIVELY cannot promote (same-period re-scoring is not evidence)', () => {
  const d = CC.decide({
    champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: WINDOW },
    challengers: [{ id: 'ch', version: 'ch-v1', paired: beats, prospective: false, artifact: GOOD_ARTIFACT }],
    nowMs: NOW,
  });
  assert.equal(d.challengers[0].decision, CC.DECISION.REJECT_CHALLENGER);
  assert.match(d.challengers[0].reason, /RETROSPECTIVELY/);
});

test('a winning prospective challenger with a BAD artifact is blocked with the specific gaps', () => {
  const d = CC.decide({
    champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: WINDOW },
    challengers: [{ id: 'ch', version: 'ch-v1', paired: beats, prospective: true, artifact: { ...GOOD_ARTIFACT, costStress: { passed: false } } }],
    nowMs: NOW,
  });
  assert.equal(d.challengers[0].decision, CC.DECISION.REQUIRES_HUMAN_APPROVAL);
  assert.ok(d.challengers[0].artifactProblems.some(p => p.includes('COST_STRESS_FAILED')));
});

test('a challenger whose edge interval includes zero is rejected and RETAINED as a negative control', () => {
  const d = CC.decide({
    champion: { id: 'prod', version: 'v1', referenceWindow: WINDOW, currentWindow: WINDOW },
    challengers: [{ id: 'ch', version: 'ch-v1', paired: { ...beats, ci95: { lo: -0.4, hi: 1.9 } }, prospective: true, artifact: GOOD_ARTIFACT }],
    nowMs: NOW,
  });
  assert.equal(d.challengers[0].decision, CC.DECISION.REJECT_CHALLENGER);
  assert.equal(d.challengers[0].retainedAsNegativeControl, true);
  assert.match(d.challengers[0].reason, /negative control/);
});

test('weight changes are versioned, inert and exactly reversible', () => {
  const p = CC.proposeWeightChange({ strategyId: 'screener', from: { mom: 0.4, vol: 0.2 }, to: { mom: 0.5, vol: 0.2 }, reason: 'walk-forward suggestion', proposedBy: 'research', nowMs: NOW });
  assert.equal(p.applied, false);
  assert.deepEqual(p.changes, [{ key: 'mom', from: 0.4, to: 0.5 }]);
  assert.deepEqual(p.revert.to, { mom: 0.4, vol: 0.2 });
  assert.match(p.note, /not mutated/);
  assert.ok(p.proposalId.includes('screener@'));
});

test('drift limits are disclosed constants, not a fitted model', () => {
  for (const k of ['calibrationErrorIncrease', 'rankICDrop', 'costNetUtilityDrop', 'coverageDropPct', 'turnoverIncrease', 'missingnessIncrease', 'minPositiveRegimes']) {
    assert.ok(Number.isFinite(CC.DRIFT_LIMITS[k]), `${k} must be a disclosed number`);
  }
  assert.ok(Object.isFrozen(CC.DRIFT_LIMITS));
});
