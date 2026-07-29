'use strict';
// Five subsystems self-adapt inside production strategies (apex recalibrate,
// timing tune, dualread adapt, evolve strength tilt, alerts-fable). v1 made
// them visible; v2 makes them centrally REVOCABLE via a per-layer policy
// (allow/freeze/disable) in governance/adaptive-policy.json. These tests pin
// the contract: default allow (absent doc = today's behavior, fail-open by
// design), bad values never escalate, disclosure always lists all five layers
// with their effective policy, and no layer is ACTIVE without evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readAdaptiveLayers, policyFor, LAYERS, POLICIES, ADAPTIVE_LAYERS_VERSION } = require('../lib/adaptive-layers');

test('policyFor is fail-open: absent doc, unknown layer, bad value all resolve to allow', () => {
  assert.equal(policyFor(null, 'apex-recalibrate'), 'allow');
  assert.equal(policyFor({}, 'apex-recalibrate'), 'allow');
  assert.equal(policyFor({ layers: {} }, 'timing-tune'), 'allow');
  assert.equal(policyFor({ layers: { 'timing-tune': 'DESTROY' } }, 'timing-tune'), 'allow');
  assert.equal(policyFor({ layers: { 'not-a-layer': 'disable' } }, 'apex-recalibrate'), 'allow');
});

test('policyFor honors explicit freeze and disable per layer', () => {
  const doc = { layers: { 'dualread-adapt': 'disable', 'apex-recalibrate': 'freeze' } };
  assert.equal(policyFor(doc, 'dualread-adapt'), 'disable');
  assert.equal(policyFor(doc, 'apex-recalibrate'), 'freeze');
  assert.equal(policyFor(doc, 'timing-tune'), 'allow', 'unset layers stay allow');
});

test('the policy vocabulary and layer roster are the pinned five', () => {
  assert.deepEqual([...POLICIES], ['allow', 'freeze', 'disable']);
  assert.deepEqual([...LAYERS].sort(), ['alerts-fable', 'apex-recalibrate', 'dualread-adapt', 'evolve-strength-tilt', 'timing-tune']);
});

// The module reads Blob docs through lib/store.readJSON; without a configured
// store readJSON rejects/short-circuits, so states come back honestly UNKNOWN
// or DORMANT — never ACTIVE — and every policy defaults to allow.
test('all five layers are always disclosed with their effective policy; none ACTIVE without evidence', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const report = await readAdaptiveLayers();
  assert.equal(report.version, ADAPTIVE_LAYERS_VERSION);
  assert.equal(report.layers.length, 5);
  assert.deepEqual(report.layers.map(l => l.layer).sort(), [...LAYERS].sort());
  for (const l of report.layers) {
    assert.ok(['ACTIVE', 'DORMANT', 'UNKNOWN'].includes(l.state), `unexpected state ${l.state}`);
    assert.notEqual(l.state, 'ACTIVE', 'with no store there is no evidence of an active layer');
    assert.equal(l.policy, 'allow', 'absent policy doc must resolve to allow (fail-open)');
    assert.ok(l.detail, 'every layer must carry a human-readable detail');
  }
});
