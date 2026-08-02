'use strict';
// Canonical decision envelope (Phase 3 of the evidence-based redesign): one five-value
// selectionState vocabulary, strategy identity resolved through the registry, code
// identity + provenance stamped once per snapshot and carried on every row.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ENV = require('../lib/decision-envelope');
const LB = require('../lib/research/live-bridge');

test('SELECTION_STATES is the frozen five-value canonical enum', () => {
  assert.deepEqual([...ENV.SELECTION_STATES], ['selected', 'rejected', 'suppressed', 'unavailable', 'error']);
  assert.ok(Object.isFrozen(ENV.SELECTION_STATES));
});

test('normalizeSelectionState maps every legacy vocabulary onto the enum', () => {
  // Arrange — one representative per legacy family.
  const cases = [
    ['in-inventory', 'selected'], ['shadow', 'selected'],
    ['eligible-not-selected', 'rejected'], ['excluded', 'rejected'],
    ['nearThreshold', 'rejected'], ['prosecutorRejected', 'rejected'],
    ['waitRecommended', 'suppressed'], ['cooldown', 'suppressed'],
    ['no-data', 'unavailable'], ['stale', 'unavailable'],
    ['failed', 'error'],
  ];
  for (const [raw, want] of cases) assert.equal(ENV.normalizeSelectionState(raw), want, raw);
});

test('unknown labels fail CLOSED to error; null stays null', () => {
  assert.equal(ENV.normalizeSelectionState('brand-new-vocab'), 'error');
  assert.equal(ENV.normalizeSelectionState(null), null);
});

test('strategyIdentity resolves scoringVersion from the registry, nulls for unknown ids', () => {
  const known = ENV.strategyIdentity('gapgo');
  assert.equal(known.strategyId, 'gapgo');
  assert.ok(known.strategyVersion, 'registered strategy carries its scoringVersion');
  assert.equal(known.registered, true);

  const unknown = ENV.strategyIdentity('does-not-exist');
  assert.equal(unknown.strategyId, 'does-not-exist');
  assert.equal(unknown.strategyVersion, null);
  assert.equal(unknown.registered, false);
});

test('envelopeContext defaults to prospective_live and never invents code identity', () => {
  const e = ENV.envelopeContext();
  assert.equal(e.envelopeVersion, ENV.ENVELOPE_VERSION);
  assert.equal(e.provenance, 'prospective_live');
  assert.equal(e.calibrationVersion, null);
  // Local/dev has no Vercel env — identity is null, not fabricated.
  if (!process.env.VERCEL_GIT_COMMIT_SHA) assert.equal(e.codeCommit, null);
});

test('buildDecisionSnapshot stamps the envelope on the snapshot and every row', () => {
  // Arrange
  const ranked = [
    { ticker: 'AAA', horizon: 'swing', score: 9, rank: 1, source: 'screener', actionable: true },
    { ticker: 'BBB', horizon: 'swing', score: 2, rank: 2, source: 'ghost', actionable: false, state: 'expired' },
  ];

  // Act
  const snap = LB.buildDecisionSnapshot(ranked, {
    decisionTs: '2026-08-01',
    sessionAxis: ['2026-08-03', '2026-08-04'],
    modelVersion: 'test-v1',
  });

  // Assert — snapshot-level envelope
  assert.equal(snap.version, 'live-bridge-v2');
  assert.equal(snap.envelope.provenance, 'prospective_live');
  // Row-level: canonical selectionState, cohort size, strategy identity via registry.
  const [sel, rej] = snap.predictions;
  assert.equal(sel.selectionState, 'selected');
  assert.equal(rej.selectionState, 'rejected');
  assert.equal(sel.cohortSize, 2);
  assert.equal(sel.strategyId, 'screener');
  assert.ok(sel.strategyVersion, 'strategyVersion resolved from registry');
  assert.equal(sel.symbolAtDecision, 'AAA');
  assert.equal(sel.provenance, 'prospective_live');
  assert.equal(sel.calibrationVersion, null, 'no calibrator exists — null, never invented');
  // The frozen original still validates and the rank-score discipline is intact.
  assert.equal(sel.rawOutputs.scoreKind, 'heuristic-rank');
  assert.ok(Object.isFrozen(sel));
});
