'use strict';
// Phase 8 feature families: fail-closed availability, vintage-enforced
// snapshots, mandatory baseline set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/pitdata/v3/features');

test('all eight families exist, each with vintage rule, known limitation and the full baseline set', () => {
  const ids = F.FEATURE_FAMILIES.map((f) => f.id);
  assert.deepEqual(ids, [
    'analyst-estimate-revisions', 'sec-filing-features', 'earnings-surprise-drift',
    'corporate-actions-dilution', 'execution-realism', 'premarket-intraday-bars',
    'sector-peer-residual-strength', 'data-quality-signals',
  ]);
  for (const fam of F.FEATURE_FAMILIES) {
    assert.ok(fam.vintageRule.length > 10, `${fam.id} declares its PIT vintage rule`);
    assert.ok(fam.knownLimitation.length > 10, `${fam.id} declares its limitation`);
    assert.deepEqual(fam.requiredBaselines, F.REQUIRED_BASELINES, `${fam.id} must beat ALL baselines, not a standalone backtest`);
  }
});

test('an unwired family is unavailable — availability is never inferred', () => {
  const s = F.familyStatus('analyst-estimate-revisions', {});
  assert.equal(s.status, 'unavailable');
  assert.match(s.reason, /source-not-wired/);
  const s2 = F.familyStatus('analyst-estimate-revisions', { wired: { 'analyst-estimate-revisions': true } });
  assert.equal(s2.status, 'unavailable');
  assert.match(s2.reason, /probe/);
  assert.equal(F.familyStatus('nonsense', {}).status, 'unknown');
});

test('feature snapshots enforce vintage: future-vintage and unstamped rows are dropped AND counted', () => {
  const out = F.buildFeatureSnapshot({
    familyId: 'analyst-estimate-revisions', asOf: '2026-08-01', knownAt: '2026-08-01',
    rows: [
      { securityId: 'a', vintageTs: '2026-07-15', value: 1 },       // fine
      { securityId: 'b', vintageTs: '2026-08-05', value: 2 },       // future vintage → leak → dropped
      { securityId: 'c', value: 3 },                                 // unstamped → dropped
    ],
    provenance: 'prospective_live',
  });
  assert.equal(out.ok, true);
  assert.equal(out.snapshot.counts.usable, 1);
  assert.equal(out.snapshot.counts.droppedFutureVintage, 1);
  assert.equal(out.snapshot.counts.droppedUnstamped, 1);
  assert.equal(out.snapshot.liveInfluence, false);
  assert.equal(out.snapshot.shadow, true);
  assert.ok(out.snapshot.snapshotId.length === 64, 'content-addressed');
});
