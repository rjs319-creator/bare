'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/governance');

const graded = (over = {}) => ({
  id: 'x', label: 'X', section: 'X', horizon: 'swing', kind: 'signal', core: false,
  grade: 'experimental', stats: { excessN: 0, avgExcess: null, beatMktRate: null, beatLo: null },
  ...over,
});

// gov-v2 (non-daytrade redesign 2026-08): an earned Validated grade is necessary but
// NOT sufficient for Production — the final step is a reviewable, version-matched
// promotion artifact. Without one the strategy holds at paper/probation (fail closed).
// gov-v2.1: the artifact must carry the COMPLETE docs/model-promotion-policy.md schema
// (dataset/universe/feature hashes, folds, predeclared metric, validation results, cost
// stress, survivorship/PIT status, calibration, tail risk, prospective evidence,
// limitations, approver identity, evidence hash, expiry) — { approve, version } alone
// was a rubber stamp, not a reviewable promotion record.
const NOW = Date.parse('2026-08-04T12:00:00Z');
const FULL_ARTIFACT = Object.freeze({
  version: 'x-v1', approve: true, approvedAt: '2026-08-01T00:00:00Z', approvedBy: 'reviewer@example',
  codeCommit: 'abc1234', datasetHash: 'sha256:d', universeHash: 'sha256:u', featureHash: 'sha256:f',
  trainingCutoff: '2026-06-30', foldDefinition: 'nested chrono walk-forward, purged+embargoed',
  primaryMetric: 'cost-net date-level excess CI > 0', validationResults: { ci95: [0.2, 1.4] },
  costStress: 'survives 2x spread', survivorshipStatus: 'PIT universe, delistings included',
  calibration: 'n/a (ranking objective)', tailRisk: 'ES95 -4.1%', prospectiveEvidence: '63 live sessions',
  limitations: 'single regime cycle', evidenceHash: 'sha256:e', expiresAt: '2026-12-31T00:00:00Z',
});

test('validated + full sample WITHOUT a promotion artifact → paper (fail closed), never production', () => {
  const r = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null);
  assert.equal(r.status, 'paper');
  assert.equal(r.weight, 0);
  assert.equal(r.awaitingPromotionArtifact, true);
  assert.match(r.reason, /promotion artifact/i);
});

test('validated + full sample + COMPLETE version-matched approved artifact → Production at 100% weight', () => {
  const r = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, FULL_ARTIFACT, { nowMs: NOW });
  assert.equal(r.status, 'production');
  assert.equal(r.weight, 1);
});

test('a version-MISMATCHED or unapproved artifact cannot promote (fail closed)', () => {
  const stale = G.governStrategy(graded({ grade: 'validated', version: 'x-v2', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, FULL_ARTIFACT, { nowMs: NOW });
  assert.notEqual(stale.status, 'production');
  const unapproved = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, { ...FULL_ARTIFACT, approve: false }, { nowMs: NOW });
  assert.notEqual(unapproved.status, 'production');
});

test('gov-v2.1: the old minimal { approve, version } artifact is a rubber stamp and fails closed with every gap listed', () => {
  const r = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, { version: 'x-v1', approve: true, approvedAt: '2026-08-01' }, { nowMs: NOW });
  assert.notEqual(r.status, 'production');
  assert.ok(Array.isArray(r.artifactProblems) && r.artifactProblems.length >= 10, 'every missing schema field is a listed problem');
});

test('gov-v2.1: an EXPIRED or REVOKED artifact cannot promote', () => {
  const expired = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, { ...FULL_ARTIFACT, expiresAt: '2026-08-01T00:00:00Z' }, { nowMs: NOW });
  assert.notEqual(expired.status, 'production');
  assert.match(expired.reason, /EXPIRED/);
  const revoked = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, { ...FULL_ARTIFACT, revoked: true }, { nowMs: NOW });
  assert.notEqual(revoked.status, 'production');
  assert.match(revoked.reason, /REVOKED/);
});

test('gov-v2.1: an artifact judged on DIFFERENT Scoreboard evidence cannot promote (evidence-hash match required)', () => {
  const r = G.governStrategy(graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, FULL_ARTIFACT, { nowMs: NOW, evidenceHash: 'sha256:CURRENT-DIFFERS' });
  assert.notEqual(r.status, 'production');
  assert.match(r.reason, /evidenceHash/);
});

test('gov-v2.1: a malformed artifacts doc (no strategies map) is rejected, not coerced into an id→artifact map', () => {
  const classified = { generatedAt: 't', strategies: [graded({ id: 'a', grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } })] };
  // gov-v2 would have treated this WHOLE doc as the map and found `a`.
  const out = G.governRegistry(classified, new Map(), { a: FULL_ARTIFACT }, { nowMs: NOW });
  assert.equal(out.counts.production, 0, 'artifacts outside doc.strategies must not be honored');
});

test('validated but sample below the verdict gate → paper, never sized', () => {
  const r = G.governStrategy(graded({ grade: 'validated', stats: { excessN: 5, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null);
  assert.equal(r.status, 'paper');
  assert.equal(r.weight, 0);
});

test('proven model whose edge is weakening → Reduced (half size)', () => {
  const prev = { status: 'production', version: null, avgExcess: 4 };
  const now = graded({ grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 1, beatMktRate: 48, beatLo: 42 } });
  const r = G.governStrategy(now, prev, FULL_ARTIFACT, { nowMs: NOW });
  assert.equal(r.status, 'reduced');
  assert.equal(r.weight, 0.5);
});

test('promising fresh model → Paper-only; promising AFTER being live → Probation', () => {
  const fresh = G.governStrategy(graded({ grade: 'promising', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } }), null);
  assert.equal(fresh.status, 'paper');
  const demoted = G.governStrategy(graded({ grade: 'promising', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } }), { status: 'production', version: null });
  assert.equal(demoted.status, 'probation');
  assert.equal(demoted.weight, 0.25);
});

test('disabled grade → Disabled, zero weight', () => {
  const r = G.governStrategy(graded({ grade: 'disabled', stats: { excessN: 30, avgExcess: -3, beatMktRate: 35, beatLo: 25 } }), null);
  assert.equal(r.status, 'disabled');
  assert.equal(r.weight, 0);
});

test('informational / context-only class is never sized', () => {
  const r = G.governStrategy(graded({ kind: 'informational', grade: 'informational' }), null);
  assert.equal(r.status, 'paper');
  assert.equal(r.weight, 0);
});

test('explicit retirement overrides everything (even an approved artifact)', () => {
  const r = G.governStrategy(graded({ retired: true, grade: 'validated', version: 'x-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null, FULL_ARTIFACT, { nowMs: NOW });
  assert.equal(r.status, 'retired');
});

test('VERSION GUARD: a scoring-version change resets a live model to Probation and never merges the old record', () => {
  const prev = { status: 'production', version: 'model-v1', avgExcess: 4 };
  const now = graded({ grade: 'validated', version: 'model-v2', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } });
  const r = G.governStrategy(now, prev);
  assert.equal(r.versionReset, true);
  assert.equal(r.status, 'probation'); // NOT production — the v2 model must re-prove
  assert.match(r.reason, /version changed/i);
});

test('version guard resets a paper model to paper (not upgraded across versions)', () => {
  const prev = { status: 'paper', version: 'model-v1' };
  const now = graded({ grade: 'promising', version: 'model-v2', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } });
  const r = G.governStrategy(now, prev);
  assert.equal(r.versionReset, true);
  assert.equal(r.status, 'paper');
});

test('governRegistry tallies statuses, sorts strongest-first, sums cleared weight', () => {
  const classified = { generatedAt: 't', strategies: [
    graded({ id: 'a', grade: 'validated', version: 'a-v1', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }),
    graded({ id: 'b', grade: 'disabled', stats: { excessN: 30, avgExcess: -3, beatMktRate: 35, beatLo: 25 } }),
    graded({ id: 'c', grade: 'experimental', stats: { excessN: 2, avgExcess: null, beatMktRate: null, beatLo: null } }),
  ] };
  const out = G.governRegistry(classified, new Map(), { strategies: { a: { ...FULL_ARTIFACT, version: 'a-v1' } } }, { nowMs: NOW });
  assert.equal(out.counts.production, 1);
  assert.equal(out.counts.disabled, 1);
  assert.equal(out.counts.paper, 1);
  assert.equal(out.strategies[0].status, 'production'); // strongest first
  assert.equal(out.clearedWeight, 1); // only the production model contributes weight

  // Without the artifacts doc the same registry yields ZERO production clearance.
  const bare = G.governRegistry(classified, new Map());
  assert.equal(bare.counts.production, 0);
  assert.equal(bare.clearedWeight, 0);
});

test('isWeakening needs BOTH a slip and a sub-50 beat bound (one soft quarter does not cut size)', () => {
  assert.equal(G.isWeakening({ excessN: 40, avgExcess: 1, beatLo: 48 }, { avgExcess: 4 }), true);
  assert.equal(G.isWeakening({ excessN: 40, avgExcess: 1, beatLo: 55 }, { avgExcess: 4 }), false); // beat bound still >50
  assert.equal(G.isWeakening({ excessN: 5, avgExcess: -5, beatLo: 10 }, { avgExcess: 4 }), false); // sample too small
});
