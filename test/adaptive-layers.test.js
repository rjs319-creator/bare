'use strict';
// Five subsystems self-adapt inside production strategies (apex recalibrate,
// timing tune, dualread adapt, evolve strength tilt, alerts-fable). v1 made
// them visible; v2 made them centrally REVOCABLE via a per-layer policy
// (allow/freeze/disable) in governance/adaptive-policy.json; v3 (non-daytrade
// redesign 2026-08) flips the DEFAULT from fail-open 'allow' to fail-closed
// 'freeze': a missing, unreadable, or invalid policy record keeps persisted
// adapted state in force but lets NOTHING NEW be adopted — a storage outage can
// never silently activate a fitted adaptation. Only an explicit valid 'allow'
// grants adoption rights. These tests pin that contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readAdaptiveLayers, policyFor, LAYERS, POLICIES, DEFAULT_POLICY, ADAPTIVE_LAYERS_VERSION } = require('../lib/adaptive-layers');

test('policyFor is fail-CLOSED: absent doc, unknown layer, bad value all resolve to freeze', () => {
  assert.equal(DEFAULT_POLICY, 'freeze');
  assert.equal(policyFor(null, 'apex-recalibrate'), 'freeze');
  assert.equal(policyFor({}, 'apex-recalibrate'), 'freeze');
  assert.equal(policyFor({ layers: {} }, 'timing-tune'), 'freeze');
  assert.equal(policyFor({ layers: { 'timing-tune': 'DESTROY' } }, 'timing-tune'), 'freeze', 'a typo must never escalate to allow');
  assert.equal(policyFor({ layers: { 'not-a-layer': 'disable' } }, 'apex-recalibrate'), 'freeze');
});

test('policyFor honors explicit allow, freeze and disable per layer', () => {
  const doc = { layers: { 'dualread-adapt': 'disable', 'apex-recalibrate': 'freeze', 'timing-tune': 'allow' } };
  assert.equal(policyFor(doc, 'dualread-adapt'), 'disable');
  assert.equal(policyFor(doc, 'apex-recalibrate'), 'freeze');
  assert.equal(policyFor(doc, 'timing-tune'), 'allow', 'an explicit allow is honored');
  assert.equal(policyFor(doc, 'alerts-fable'), 'freeze', 'unset layers fail closed to freeze — allow is never implied');
});

test('the policy vocabulary and layer roster are the pinned five', () => {
  assert.deepEqual([...POLICIES], ['allow', 'freeze', 'disable']);
  assert.deepEqual([...LAYERS].sort(), ['alerts-fable', 'apex-recalibrate', 'dualread-adapt', 'evolve-strength-tilt', 'timing-tune']);
});

// The module reads Blob docs through lib/store.readJSON; without a configured
// store readJSON rejects/short-circuits, so states come back honestly UNKNOWN
// or DORMANT — never ACTIVE — and every policy fails closed to freeze.
test('all five layers are always disclosed with their effective policy; none ACTIVE without evidence', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const report = await readAdaptiveLayers();
  assert.equal(report.version, ADAPTIVE_LAYERS_VERSION);
  assert.equal(report.policyDefault, 'freeze');
  assert.equal(report.layers.length, 5);
  assert.deepEqual(report.layers.map(l => l.layer).sort(), [...LAYERS].sort());
  for (const l of report.layers) {
    assert.ok(['ACTIVE', 'DORMANT', 'UNKNOWN'].includes(l.state), `unexpected state ${l.state}`);
    assert.notEqual(l.state, 'ACTIVE', 'with no store there is no evidence of an active layer');
    assert.equal(l.policy, 'freeze', 'absent policy doc must resolve to freeze (fail-closed) — nothing new may be adopted');
    assert.ok(l.detail, 'every layer must carry a human-readable detail');
  }
});
