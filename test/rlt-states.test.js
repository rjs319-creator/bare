'use strict';
// RLT state machine + fail-closed probability/actionability policy.
// Guards: no trigger ⇒ never actionable; shadow ⇒ never live; missing/stale
// artifact ⇒ no probability; extension blocks PRIMED; peer-collapse rank rise
// is not treated as leadership; published names never silently vanish.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveInventoryState, deriveEpisodeState, diffStates, STATES, REASON } = require('../lib/rlt-states');
const { decideRlt, ABSTAIN } = require('../lib/rlt-utility');
const { rltGate, validateArtifact, resolveRltMode, LIVE_VERSIONS } = require('../lib/rlt-config');
const { stageACrossSection, fitStageA } = require('../lib/rlt-stage-a');
const { LIFECYCLE } = require('../lib/swing-lifecycle');

const lead = (over = {}) => ({
  pctile: 0.85, pctileUncertainty: 0.03, rankVel3: 0.06, rankVel5: 0.2, rankVel10: 0.3,
  rankAccel: 0.05, aboveMedianStreak: 8, crossHorizonAgreement: 1,
  positiveSectorResidual: true, leaderOnPeerWeaknessOnly: false,
  byHorizon: { 10: { marketResidual: 0.04, sectorResidual: 0.03 } },
  peerGroupSize: 20, ...over,
});
const feats = (setupOver = {}, pathOver = {}) => ({
  setup: {
    pivot: 100, atr: 2, distanceToPivotAtr: 0.5, remainingRR: 2.0,
    consumedRangePosition: 0.5, extensionState: 'normal', ...setupOver,
  },
  path: { smoothness: 0.6, spikeShare: 0.3, ...pathOver },
  turnover: { turnoverAccel: 1.3 },
});

test('inventory states derive along the documented ladder', () => {
  // PRIMED: leader + structure, not near trigger enough for ARMED.
  const primed = deriveInventoryState({ leadership: lead(), features: feats({ distanceToPivotAtr: 3.0 }) });
  assert.equal(primed.state, STATES.PRIMED);
  // ARMED: within proximity of the pivot with participation improving.
  const armed = deriveInventoryState({ leadership: lead(), features: feats({ distanceToPivotAtr: 0.5 }) });
  assert.equal(armed.state, STATES.ARMED);
  // EMERGING_LEADER: upper group + accelerating but not yet an established leader.
  const emerging = deriveInventoryState({
    leadership: lead({ pctile: 0.7, aboveMedianStreak: 2 }), features: feats(),
  });
  assert.equal(emerging.state, STATES.EMERGING_LEADER);
  // DISCOVERED: improving rank + positive residual, evidence early.
  const disc = deriveInventoryState({
    leadership: lead({ pctile: 0.55, rankVel5: 0.16, rankAccel: -0.01, aboveMedianStreak: 1 }),
    features: feats(),
  });
  assert.equal(disc.state, STATES.DISCOVERED);
});

test('an extended or consumed name cannot be PRIMED/ARMED', () => {
  const r = deriveInventoryState({
    leadership: lead(), features: feats({ extensionState: 'extended' }),
  });
  assert.notEqual(r.state, STATES.PRIMED);
  assert.notEqual(r.state, STATES.ARMED);
  assert.ok(r.cautions.includes(REASON.TOO_EXTENDED));
});

test('a rank that rose only because peers collapsed is NOT leadership', () => {
  const r = deriveInventoryState({
    leadership: lead({ leaderOnPeerWeaknessOnly: true }), features: feats(),
  });
  assert.notEqual(r.state, STATES.PRIMED);
  assert.notEqual(r.state, STATES.ARMED);
  assert.notEqual(r.state, STATES.EMERGING_LEADER);
  assert.ok(r.cautions.includes(REASON.PEER_WEAKNESS_ONLY));
});

test('weak sector raises a CAUTION, never an automatic reject', () => {
  const r = deriveInventoryState({
    leadership: lead(), features: feats({ distanceToPivotAtr: 3.0 }),
    sectorState: { state: 'WEAKENING' },
  });
  assert.equal(r.state, STATES.PRIMED, 'exceptional stock in weak sector stays a shadow candidate');
  assert.ok(r.cautions.includes(REASON.SECTOR_HEADWIND));
});

test('episode-derived states read lifecycleState (the premove defect, fixed)', () => {
  const ep = (lc) => ({ assessment: { lifecycleState: lc } });
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.TARGET_HIT)), STATES.COMPLETED);
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.INVALIDATED)), STATES.INVALIDATED);
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.WEAKENING)), STATES.WEAKENING);
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.NO_FILL)), STATES.EXPIRED);
  // TRIGGERED without positive Stage-B utility stays TRIGGERED, not ACCEPTED.
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.TRIGGERED), null), STATES.TRIGGERED);
  assert.equal(deriveEpisodeState(ep(LIFECYCLE.TRIGGERED),
    { waterfall: { expectedNetUtilityBps: 40 } }), STATES.ACCEPTED);
});

test('NO TRIGGER means NO actionable trade — ever', () => {
  const gate = rltGate({ mode: 'shadow' });
  const d = decideRlt({ state: STATES.ARMED, leadership: lead(), features: feats(), gate });
  assert.equal(d.action, 'ABSTAIN');
  assert.ok(d.abstainReasons.includes(ABSTAIN.NO_TRIGGER));
});

test('SHADOW mode can never produce a live-eligible candidate', () => {
  const gate = rltGate({ mode: 'shadow' });
  assert.equal(gate.mayAffectLive, false);
  const d = decideRlt({
    state: STATES.ACCEPTED, leadership: lead(), features: feats(),
    stageB: { state: 'ACCEPT_CANDIDATE', waterfall: { expectedNetUtilityBps: 60 }, probabilities: { severeLossProbability: 0.05 }, remainingOpportunity: 4 },
    gate,
  });
  assert.equal(d.action, 'ABSTAIN');
  assert.ok(d.abstainReasons.includes(ABSTAIN.SHADOW));
});

test('enforce mode FAILS CLOSED without a valid, version-matched artifact', () => {
  const g1 = rltGate({ mode: 'enforce', artifact: null });
  assert.equal(g1.mayAffectLive, false);
  assert.ok(g1.reasons.some(r => /fail closed/.test(r)));
  // Version mismatch invalidates.
  const badArtifact = {
    kind: 'rlt-model', modelVersion: 'x', featureVersion: 'WRONG',
    labelVersion: LIVE_VERSIONS.labelVersion, executionPolicyVersion: LIVE_VERSIONS.executionPolicyVersion,
    universePolicy: LIVE_VERSIONS.universePolicy, trainedThrough: '2026-01-01', status: 'validated',
  };
  assert.equal(validateArtifact(badArtifact, { kind: 'rlt-model' }).valid, false);
  assert.equal(rltGate({ mode: 'enforce', artifact: badArtifact }).mayAffectLive, false);
  // Configuration alone can never promote: default mode is shadow.
  assert.equal(resolveRltMode(undefined), 'shadow');
  assert.equal(resolveRltMode('garbage'), 'shadow');
});

test('no model / no artifact ⇒ NO numeric probability, ever', () => {
  const rows = stageACrossSection(
    [{ ticker: 'A', features: { pctile: 0.9, rankVel5: 0.2 } },
     { ticker: 'B', features: { pctile: 0.2, rankVel5: -0.1 } }],
    null, rltGate({ mode: 'shadow' }));
  for (const r of rows) {
    assert.equal(r.pTriggerBeforeInvalidation, null);
    assert.ok(['unavailable', 'collecting'].includes(r.calibrationStatus));
    assert.ok(r.transitionRank == null || (r.transitionRank >= 0 && r.transitionRank <= 1));
  }
  // Ranks still order sensibly without a model (fixed deterministic baseline).
  const a = rows.find(r => r.ticker === 'A'), b = rows.find(r => r.ticker === 'B');
  assert.ok(a.transitionRank > b.transitionRank);
});

test('an insufficient training set refuses to fit rather than fabricating', () => {
  const m = fitStageA([{ features: { pctile: 0.5 }, y: 1 }]);
  assert.equal(m.status, 'insufficient-data');
  assert.equal(m.weights, null);
});

test('published names never silently vanish: a drop emits an explicit transition', () => {
  const prev = { AAA: { state: STATES.PRIMED }, BBB: { state: STATES.ARMED } };
  const next = { AAA: { state: STATES.PRIMED, reasonCodes: [] } };   // BBB gone
  const trs = diffStates({ prev, next, session: '2026-07-24', at: 'x' });
  const dropped = trs.find(t => t.ticker === 'BBB');
  assert.ok(dropped, 'the dropped name must emit a transition');
  assert.equal(dropped.newState, 'DROPPED');
  assert.deepEqual([...dropped.reasonCodes], ['NO_LONGER_QUALIFIES']);
  assert.equal(trs.find(t => t.ticker === 'AAA'), undefined, 'unchanged state must not re-emit');
});
