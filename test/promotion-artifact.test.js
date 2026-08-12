'use strict';
// PHASE 3 — ADVERSARIAL promotion-artifact validation.
//
// Every test here uses an artifact where the FIELD EXISTS and is non-empty, but its VALUE
// says the gate was not passed (or was passed on different evidence, or long ago). Under
// field-presence checking every one of these promoted a model. They must all fail closed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PA = require('../lib/promotion-artifact');
const G = require('../lib/governance');

const NOW = Date.parse('2026-08-04T12:00:00Z');
const IDENTITY = { version: 'x-v1' };
const OK = Object.freeze({
  version: 'x-v1', approve: true, approvedAt: '2026-08-01T00:00:00Z', approvedBy: 'reviewer@example',
  codeCommit: 'abc1234', datasetHash: 'sha256:d', universeHash: 'sha256:u', featureHash: 'sha256:f',
  trainingCutoff: '2026-06-30', foldDefinition: 'purged+embargoed nested walk-forward',
  primaryMetric: 'cost-net date-level excess',
  validationResults: { passed: true, sampleSize: 120, effectiveSampleSize: 34, positiveBlocks: 4, multipleTestingCorrected: true, correctedPValue: 0.01, alpha: 0.05, ci95: { lo: 0.2, hi: 1.4 } },
  costStress: { passed: true, baseNet: 0.9, doubledCostNet: 0.4, stressedCostNet: 0.1 },
  survivorshipStatus: { safe: true },
  calibration: { required: false, passed: true },
  tailRisk: { es95: -4.1 },
  prospectiveEvidence: { passed: true, episodes: 63 },
  limitations: 'single regime cycle', evidenceHash: 'sha256:e', expiresAt: '2026-12-31T00:00:00Z',
  dataQualityBlockers: [],
});
const codes = (art, identity = IDENTITY, opts = {}) => PA.validateArtifact(art, identity, { nowMs: NOW, ...opts }).map(p => p.code);

test('the reference artifact is promotable (the suite is not just rejecting everything)', () => {
  assert.deepEqual(PA.validateArtifact(OK, IDENTITY, { nowMs: NOW }), []);
  assert.equal(PA.isPromotable(OK, IDENTITY, { nowMs: NOW }), true);
});

test('ADVERSARIAL: validationResults.passed === false is a FAILED validation, not a present field', () => {
  const c = codes({ ...OK, validationResults: { ...OK.validationResults, passed: false } });
  assert.ok(c.includes('VALIDATION_FAILED'));
});

test('ADVERSARIAL: costStress.passed === false blocks promotion', () => {
  assert.ok(codes({ ...OK, costStress: { ...OK.costStress, passed: false } }).includes('COST_STRESS_FAILED'));
});

test('ADVERSARIAL: a positive base result that dies at doubled/stressed costs blocks promotion', () => {
  assert.ok(codes({ ...OK, costStress: { passed: true, baseNet: 0.9, doubledCostNet: -0.05, stressedCostNet: -0.6 } }).includes('COST_STRESS_FAILED'));
});

test('ADVERSARIAL: survivorship-unsafe data is a hard blocker regardless of the statistics', () => {
  assert.ok(codes({ ...OK, survivorshipStatus: { safe: false, note: 'delisted names absent' } }).includes('SURVIVORSHIP_UNSAFE'));
});

test('ADVERSARIAL: probabilities displayed without a calibration PASS block promotion', () => {
  assert.ok(codes({ ...OK, calibration: { required: true, passed: false } }, IDENTITY, { requiresProbability: true }).includes('CALIBRATION_FAILED'));
  assert.ok(codes(OK, IDENTITY, { requiresProbability: true }).length === 0, 'a passing calibration satisfies it');
});

test('ADVERSARIAL: missing prospective validation blocks promotion (retrospective evidence alone cannot promote)', () => {
  assert.ok(codes({ ...OK, prospectiveEvidence: { passed: false } }).includes('NO_PROSPECTIVE_EVIDENCE'));
  assert.ok(codes({ ...OK, prospectiveEvidence: { passed: true, episodes: 4 } }).includes('PROSPECTIVE_TOO_THIN'));
});

test('ADVERSARIAL: thin samples — raw, EFFECTIVE and block-stability floors are all enforced', () => {
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, sampleSize: 12 } }).includes('SAMPLE_TOO_SMALL'));
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, effectiveSampleSize: 3 } }).includes('EFFECTIVE_SAMPLE_TOO_SMALL'));
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, positiveBlocks: 1 } }).includes('BLOCK_STABILITY_FAILED'));
});

test('ADVERSARIAL: an uncorrected or non-significant result cannot promote', () => {
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, multipleTestingCorrected: false } }).includes('NO_MULTIPLE_TESTING_CORRECTION'));
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, correctedPValue: 0.31 } }).includes('NOT_SIGNIFICANT'));
  assert.ok(codes({ ...OK, validationResults: { ...OK.validationResults, ci95: { lo: -0.4, hi: 1.1 } } }).includes('CI_INCLUDES_ZERO'));
});

test('ADVERSARIAL: `approve` must be the BOOLEAN true — truthy strings are not approvals', () => {
  for (const v of ['true', 1, 'yes', {}]) {
    assert.ok(codes({ ...OK, approve: v }).includes('NOT_APPROVED'), `approve=${JSON.stringify(v)} must fail`);
  }
});

test('ADVERSARIAL: every identity axis must match — label/execution/benchmark versions too', () => {
  const identity = { version: 'x-v1', labelVersion: 'fwd-outcome-v2', executionPolicyVersion: 'exec-v1', benchmarkVersion: 'bench-v1' };
  // an artifact that never states them cannot prove it is about this experiment
  assert.ok(codes(OK, identity).includes('IDENTITY_UNSTATED'));
  const stated = { ...OK, labelVersion: 'fwd-outcome-v2', executionPolicyVersion: 'exec-v1', benchmarkVersion: 'bench-v1' };
  assert.deepEqual(codes(stated, identity), []);
  assert.ok(codes({ ...stated, labelVersion: 'proxy-close-v1' }, identity).includes('IDENTITY_MISMATCH'),
    'evidence earned on a PROXY label cannot approve an executable-label strategy');
});

test('ADVERSARIAL: stale, expired, out-of-order and unparseable timestamps all fail closed', () => {
  assert.ok(codes({ ...OK, expiresAt: '2026-08-01T00:00:00Z' }).includes('EXPIRED'));
  assert.ok(codes({ ...OK, approvedAt: '2025-01-01T00:00:00Z' }).includes('STALE_APPROVAL'));
  assert.ok(codes({ ...OK, approvedAt: 'last tuesday' }).includes('BAD_TIMESTAMP'));
  assert.ok(codes({ ...OK, trainingCutoff: '2026-08-03' }).includes('BAD_WINDOW'),
    'a training cutoff AFTER approval means the evaluation was not out-of-sample');
});

test('ADVERSARIAL: an unresolved data-quality blocker vetoes an otherwise perfect artifact', () => {
  const c = codes({ ...OK, dataQualityBlockers: [{ id: 'PIT_UNPROVEN', resolved: false }] });
  assert.ok(c.includes('DATA_QUALITY_BLOCKER'));
  assert.deepEqual(codes({ ...OK, dataQualityBlockers: [{ id: 'PIT_UNPROVEN', resolved: true }] }), []);
});

test('ADVERSARIAL: an approval judged on other evidence cannot be resurrected by a fresh write', () => {
  assert.ok(codes(OK, IDENTITY, { evidenceHash: 'sha256:SOMETHING-ELSE' }).includes('EVIDENCE_HASH_MISMATCH'));
});

test('governance rejects every adversarial artifact end-to-end (no promotion reaches production)', () => {
  const graded = { id: 'x', label: 'X', grade: 'validated', version: 'x-v1', stats: { excessN: 60, avgExcess: 3, beatMktRate: 62, beatLo: 55 } };
  const bad = [
    { ...OK, validationResults: { ...OK.validationResults, passed: false } },
    { ...OK, costStress: { ...OK.costStress, passed: false } },
    { ...OK, survivorshipStatus: { safe: false } },
    { ...OK, prospectiveEvidence: { passed: false } },
    { ...OK, approve: 'true' },
  ];
  for (const art of bad) {
    const r = G.governStrategy(graded, null, art, { nowMs: NOW });
    assert.notEqual(r.status, 'production');
    assert.equal(r.awaitingPromotionArtifact, true);
    assert.ok(r.artifactFindings.length > 0);
  }
});

test('LIFECYCLE CLASSES stay separable: static production is LEGACY_OPERATIONAL, not validation', () => {
  const promising = { grade: 'promising' };
  assert.equal(PA.lifecycleClassOf(promising, null, IDENTITY, { staticStatus: 'production', nowMs: NOW }), PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL);
  assert.equal(PA.lifecycleClassOf(promising, null, IDENTITY, { staticStatus: 'shadow', nowMs: NOW }), PA.LIFECYCLE_CLASS.RESEARCH_PROMISING);
  assert.equal(PA.lifecycleClassOf({ grade: 'validated' }, OK, IDENTITY, { staticStatus: 'production', nowMs: NOW }), PA.LIFECYCLE_CLASS.VALIDATED_EXECUTABLE);
  // a validated grade with a FAILING artifact is still only legacy-operational
  assert.equal(PA.lifecycleClassOf({ grade: 'validated' }, { ...OK, costStress: { passed: false } }, IDENTITY, { staticStatus: 'production', nowMs: NOW }), PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL);
});

test('GRANDFATHER EXPIRY: reduce-only lapses to paper by itself when the window runs out', () => {
  const graded = { id: 'x', label: 'X', grade: 'promising', version: 'x-v1', stats: { excessN: 30, avgExcess: 1, beatMktRate: 52, beatLo: 44 } };
  const inWindow = G.governStrategy(graded, { status: 'production', version: 'x-v1', grandfatheredSince: '2026-07-15T00:00:00Z' }, null, { nowMs: NOW });
  assert.equal(inWindow.status, 'reduce-only');
  assert.equal(inWindow.newPositions, false);
  const lapsed = G.governStrategy(graded, { status: 'reduce-only', version: 'x-v1', grandfatheredSince: '2026-01-01T00:00:00Z' }, null, { nowMs: NOW });
  assert.equal(lapsed.status, 'paper');
  assert.equal(lapsed.grandfatherExpired, true);
  assert.match(lapsed.reason, /lapsed to paper automatically/);
});

test('a reduce-only strategy cannot ORIGINATE a position through eligibility', () => {
  const EL = require('../lib/eligibility');
  const gov = {
    savedAt: '2026-08-04T00:00:00Z', scoreboardGeneratedAt: '2026-08-03T22:00:00Z',
    strategies: [{ id: 'screener', status: 'reduce-only', weight: 0.25, version: 'screener-v2', newPositions: false, grandfathered: true, grandfatherExpiresAt: '2026-10-01T00:00:00Z' }],
  };
  const g = EL.gateSignals([{ source: 'screener', ticker: 'AAA', side: 'long', entry: 10, stop: 9, target: 12, liquidity: { dollarVol: 5e7 } }],
    { governance: gov, nowMs: NOW });
  assert.equal(g.perSource.screener.tradeEligible, false);
  assert.equal(g.annotated[0].eligibility.signalClass, 'RESEARCH');
  assert.match(g.perSource.screener.reasons.join(' '), /REDUCE-ONLY/);
});
