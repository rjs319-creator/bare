'use strict';
// SHADOW ISOLATION + SECRET HYGIENE — the mandatory acceptance tests that no v3
// component can alter live rank, maturity or allocation, and that secrets can
// never appear in v3 artifacts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const read = (p) => fs.readFileSync(p, 'utf8');

// The live decision surface: ranking, maturity/eligibility, allocation, gates.
const LIVE_DECISION_MODULES = [
  'decision.js', 'maturity.js', 'eligibility.js', 'strategy-gate.js',
  'allocation.js', 'governance.js', 'apex.js', 'screener-core.js',
].map((f) => path.join(LIB, f)).filter((p) => fs.existsSync(p));

test('no live decision module imports ANY pit-data-v3 code (rank/maturity/allocation untouched)', () => {
  assert.ok(LIVE_DECISION_MODULES.length >= 3, 'live modules found');
  for (const p of LIVE_DECISION_MODULES) {
    const src = read(p);
    assert.equal(src.includes('pitdata/v3'), false, `${path.basename(p)} must not import pitdata/v3`);
    assert.equal(src.includes('harness-v3'), false, `${path.basename(p)} must not import harness-v3`);
    assert.equal(src.includes('decision-events'), false, `${path.basename(p)} must not read decision events back`);
  }
});

test('v3 modules never import the live ranking path (observer-only in BOTH directions)', () => {
  const v3dir = path.join(LIB, 'pitdata', 'v3');
  for (const f of fs.readdirSync(v3dir)) {
    const src = read(path.join(v3dir, f));
    for (const banned of ["require('../../decision", "require('../../maturity", "require('../../allocation", "require('../../strategy-gate"]) {
      assert.equal(src.includes(banned), false, `${f} must not import the live path (${banned})`);
    }
  }
});

test('every v3 artifact that could claim safety is structurally pinned false', () => {
  const U = require('../lib/pitdata/v3/universe');
  const REC = require('../lib/pitdata/v3/reconcile');
  const snap = U.buildUniverseSnapshot({ effectiveAt: '2026-08-01', listingShards: {}, marketDataFor: () => null });
  assert.equal(snap.survivorshipSafe, false);
  const report = REC.reconcileV3({ now: Date.UTC(2026, 7, 2) });
  assert.equal(report.survivorshipSafe, false);
  assert.equal(report.consumerSwitchAllowed, false);
  const F = require('../lib/pitdata/v3/features');
  for (const fam of F.FEATURE_FAMILIES) assert.equal(fam.liveInfluence, false, `${fam.id} has no live influence`);
});

test('the pitdata warm chain is shadow-only and the v3 steps ride it (no new live chain)', () => {
  const { CHAINS, ROOT_CHAINS } = require('../lib/warm-chains');
  assert.deepEqual(CHAINS.pitdata, ['op=pitdata&view=collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3collect', 'op=pitdata&view=v3health']);
  assert.ok(ROOT_CHAINS.includes('pitdata'));
  for (const [name, steps] of Object.entries(CHAINS)) {
    if (name === 'pitdata') continue;
    assert.ok(steps.every((s) => !String(s).includes('v3')), `chain '${name}' must not carry v3 steps`);
  }
});

test('mutating v3 routes are privileged; the promotion route requires an explicit approver', () => {
  const src = read(path.join(LIB, 'pitdata-routes.js'));
  const privIdx = src.indexOf('requireTrusted(req, res)');
  for (const view of ['v3probe', 'v3collect', 'v3health', 'v3reconcile', 'v3export', 'v3promote']) {
    const idx = src.indexOf(`view === '${view}'`);
    assert.ok(idx > privIdx, `${view} sits behind requireTrusted`);
  }
  assert.match(src, /approvedBy/);
  assert.match(src, /makePromotionProposal/);
});

test('observation params can never carry a secret; redaction is applied to error paths', () => {
  const S3 = require('../lib/pitdata/v3/schema');
  const obs = S3.makeObservation({
    endpoint: '/stock-list', params: { apikey: 'SECRET-VALUE', page: 1, token: 'ALSO-SECRET' },
    runId: 'r', sequence: 1, date: '2026-08-01', observedAt: 'T', ingestedAt: 'T',
    httpStatus: 200, contentHash: 'h', provenance: 'prospective_live',
  });
  const s = JSON.stringify(obs);
  assert.equal(s.includes('SECRET-VALUE'), false);
  assert.equal(s.includes('ALSO-SECRET'), false);
  assert.equal(obs.params.page, 1, 'non-secret params retained');
  const collectorSrc = read(path.join(LIB, 'pitdata', 'v3', 'collector.js'));
  assert.match(collectorSrc, /redactSecrets/, 'collector redacts error strings');
});

test('data-health readiness is fail-closed and never claims survivorship safety from a report', async () => {
  const { buildDataHealthReport } = require('../lib/data-health');
  const report = await buildDataHealthReport({ now: Date.UTC(2026, 7, 2, 12) });
  assert.ok(report.readiness, 'three-tier readiness present');
  assert.equal(report.readiness.promotionReady, false);
  assert.equal(report.readiness.survivorshipSafe, false);
  assert.ok(report.sections.pitdataV3, 'v3 section incorporated into op=datahealth');
});
