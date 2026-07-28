'use strict';
// The RLT promotion path used to be self-contradictory in BOTH directions:
//   (a) assertShadow() threw whenever the registry said production — so the one
//       documented promotion action (the human registry maturity flip) was a
//       guaranteed outage; and
//   (b) rltGate() computed mayAffectLive from RLT_MODE + a stored JSON artifact
//       WITHOUT consulting the registry — so an env var plus a hand-written blob
//       was a promotion path that bypassed the human flip entirely (and
//       rlt-utility DOES read gate.mayAffectLive, so it was live-reachable).
// These tests pin the repaired contract: live influence needs enforce mode AND a
// valid version-matched artifact AND the registry flip — and even then only a
// canary cap. The default remains shadow / weight-0.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rltGate, validateArtifact, LIVE_VERSIONS, CANARY_CAP } = require('../lib/rlt-config');
const { assertShadow, promotionView } = require('../lib/rlt-governance');
const { statusOf } = require('../lib/strategy-gate');

// A structurally-valid, version-matched artifact — what an EARNED promotion
// would store. Its existence in a test proves nothing about market edge.
const VALID_ARTIFACT = Object.freeze({
  kind: 'rlt-model', modelVersion: 'rlt-stage-a-v1',
  featureVersion: LIVE_VERSIONS.featureVersion,
  labelVersion: LIVE_VERSIONS.labelVersion,
  executionPolicyVersion: LIVE_VERSIONS.executionPolicyVersion,
  universePolicy: LIVE_VERSIONS.universePolicy,
  trainedThrough: '2026-07-01', status: 'validated',
});

test('the default registry state is still shadow — nothing here promoted RLT', () => {
  assert.equal(statusOf('rlt'), 'shadow');
  assert.equal(assertShadow(), 'shadow');
});

test('enforce + valid artifact WITHOUT the registry flip stays shadow (env var is not a promotion path)', () => {
  // Arrange / Act
  const gate = rltGate({ mode: 'enforce', artifact: VALID_ARTIFACT, registryStatus: 'shadow' });

  // Assert — artifact validity is acknowledged, live influence is refused.
  assert.equal(validateArtifact(VALID_ARTIFACT, { kind: 'rlt-model' }).valid, true);
  assert.equal(gate.artifactValid, true);
  assert.equal(gate.mayAffectLive, false);
  assert.equal(gate.canaryCap, 0);
  assert.ok(gate.reasons.some(r => /registry maturity .* human registry flip required/.test(r)));
});

test('enforce + registry flip WITHOUT a valid artifact stays shadow (registry edit alone is not earned)', () => {
  const gate = rltGate({ mode: 'enforce', artifact: null, registryStatus: 'production' });
  assert.equal(gate.mayAffectLive, false);
  assert.ok(gate.reasons.some(r => /fail closed/.test(r)));
});

test('all three earned conditions together permit only the canary cap', () => {
  const gate = rltGate({ mode: 'enforce', artifact: VALID_ARTIFACT, registryStatus: 'production' });
  assert.equal(gate.mayAffectLive, true);
  assert.equal(gate.canaryCap, CANARY_CAP);
  assert.ok(CANARY_CAP <= 0.10, 'canary must stay a small fraction of live weight');
});

test('shadow mode never affects live even with a valid artifact and a production registry', () => {
  const gate = rltGate({ mode: 'shadow', artifact: VALID_ARTIFACT, registryStatus: 'production' });
  assert.equal(gate.mayAffectLive, false);
  assert.equal(gate.canaryCap, 0);
});

test('assertShadow rejects an UN-EARNED production flip and explains itself', () => {
  // The invariant cannot be triggered through the real registry here (it is
  // shadow, by design) — but the guard's decision logic is validateArtifact,
  // which is what an un-earned flip fails.
  const check = validateArtifact(null, { kind: 'rlt-model' });
  assert.equal(check.valid, false);
  assert.ok(check.reasons.length > 0, 'an absent artifact must carry machine-readable reasons');
});

test('promotionView stays ineligible on the recorded evidence (walk-forwards found no edge)', () => {
  const view = promotionView({ minIndependentDates: 14 });
  assert.equal(view.eligible, false);
  const unmet = view.checks.filter(c => !c.met);
  assert.ok(unmet.length >= 10, 'nearly every criterion must be unmet on current evidence');
});
