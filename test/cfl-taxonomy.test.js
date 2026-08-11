'use strict';
// CFL TAXONOMY — precedence is the contract: the first firing check wins, so
// two graders can never disagree. These tests pin the precedence order and the
// preventable/unforeseeable boundary.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/cfl/taxonomy');

const bigEpisode = (over = {}) => ({
  gap: { class: 'no-gap', overnightShare: 0.1 }, crossSection: { executable: true }, mfe: 0.3, ...over,
});

test('precedence: universe exclusion beats every other evidence, and is preventable', () => {
  const v = T.attributeMiss({ inUniverse: false, episode: bigEpisode({ gap: { class: 'gap-dominant', overnightShare: 0.9 } }) });
  assert.strictEqual(v.primaryFailure, T.MISS.UNIVERSE_EXCLUSION);
  assert.strictEqual(v.preventable, true);
  assert.ok(v.secondaryFailures.includes(T.MISS.INFORMATION_ARRIVED_AFTER_MOVE));   // evidence preserved as secondary
});

test('insufficient history ⇒ DATA_UNAVAILABLE', () => {
  const v = T.attributeMiss({ inUniverse: true, insufficientHistory: true, episode: bigEpisode() });
  assert.strictEqual(v.primaryFailure, T.MISS.DATA_UNAVAILABLE);
});

test('rejection-code mapping: liquidity floor is a UNIVERSE rule; stale data is a DATA failure; cap is a RANKING failure', () => {
  assert.strictEqual(T.attributeMiss({ inUniverse: true, rejectionCode: 'liquidity', episode: bigEpisode() }).primaryFailure, T.MISS.UNIVERSE_EXCLUSION);
  assert.strictEqual(T.attributeMiss({ inUniverse: true, rejectionCode: 'stale-data', episode: bigEpisode() }).primaryFailure, T.MISS.DATA_STALE_OR_FAILED);
  assert.strictEqual(
    T.attributeMiss({ inUniverse: true, rejectionCode: 'below-selection-cap', episode: bigEpisode(), premoveEvidence: { maxPctile: 0.9, anyCriteria: true } }).primaryFailure,
    T.MISS.RANKING_FAILURE,
  );
  assert.strictEqual(T.attributeMiss({ inUniverse: true, rejectionCode: 'risk-off', episode: bigEpisode() }).primaryFailure, T.MISS.RISK_VETO);
});

test('a generation "miss" with NO pre-move evidence is honestly NO_PREMOVE_EVIDENCE, not a screener failure', () => {
  const v = T.attributeMiss({
    inUniverse: true, rejectionCode: 'no-qualifying-setup', episode: bigEpisode(),
    premoveEvidence: { maxPctile: 0.3, anyCriteria: false },
  });
  assert.strictEqual(v.primaryFailure, T.MISS.NO_PREMOVE_EVIDENCE);
  assert.strictEqual(v.preventable, false);
});

test('generated but seen only after most of the move ⇒ LATE_DETECTION', () => {
  const v = T.attributeMiss({
    inUniverse: true,
    trace: { candidateGenerated: true, detectedBeforeMoveFrac: 0.8, displayHistory: [{ date: 'x' }] },
    episode: bigEpisode(),
  });
  assert.strictEqual(v.primaryFailure, T.MISS.LATE_DETECTION);
});

test('generated in time but this lane has NO alert layer ⇒ ALERT_FAILURE (structural finding)', () => {
  const v = T.attributeMiss({
    inUniverse: true,
    trace: { candidateGenerated: true, detectedBeforeMoveFrac: 0.1, displayHistory: [{ date: 'x' }] },
    episode: bigEpisode(),
    alertLayerExists: false,
  });
  assert.strictEqual(v.primaryFailure, T.MISS.ALERT_FAILURE);
});

test('gap-dominant move with no stage failure ⇒ INFORMATION_ARRIVED_AFTER_MOVE, marked unforeseeable', () => {
  const v = T.attributeMiss({ inUniverse: true, episode: bigEpisode({ gap: { class: 'gap-dominant', overnightShare: 0.95 } }) });
  assert.strictEqual(v.primaryFailure, T.MISS.INFORMATION_ARRIVED_AFTER_MOVE);
  assert.strictEqual(v.preventable, false);
});

test('extreme feature z-score with no stage failure ⇒ OUT_OF_DISTRIBUTION', () => {
  const v = T.attributeMiss({ inUniverse: true, oodZ: 5.5, episode: bigEpisode() });
  assert.strictEqual(v.primaryFailure, T.MISS.OUT_OF_DISTRIBUTION);
});

test('non-executable move ⇒ LIQUIDITY_OR_EXECUTION_FAILURE', () => {
  const v = T.attributeMiss({ inUniverse: true, episode: bigEpisode({ crossSection: { executable: false } }) });
  assert.strictEqual(v.primaryFailure, T.MISS.LIQUIDITY_OR_EXECUTION_FAILURE);
});

// ── duds ──
test('dud: stop hit in 2 sessions ⇒ IMMEDIATE_FAILURE', () => {
  const v = T.classifyDud({ resolved: { outcome: 'LOSS', r: -0.08, hold: 2 }, path: { mfe: 0.01, mae: -0.09 }, pick: { entry: 100, stop: 92, target: 120 } });
  assert.strictEqual(v.primaryFailure, T.DUD.IMMEDIATE_FAILURE);
});

test('dud: adverse excursion 1.5× past the planned stop ⇒ SEVERE_LOSS_MODEL_FAILURE (beats immediate)', () => {
  const v = T.classifyDud({ resolved: { outcome: 'LOSS', r: -0.15, hold: 2 }, path: { mfe: 0.01, mae: -0.15 }, pick: { entry: 100, stop: 92, target: 120 } });
  assert.strictEqual(v.primaryFailure, T.DUD.SEVERE_LOSS_MODEL_FAILURE);
});

test('dud: covered most of the way to target then stopped ⇒ FAILED_BREAKOUT', () => {
  const v = T.classifyDud({ resolved: { outcome: 'LOSS', r: -0.08, hold: 9 }, path: { mfe: 0.15, mae: -0.09 }, pick: { entry: 100, stop: 92, target: 120 } });
  assert.strictEqual(v.primaryFailure, T.DUD.FAILED_BREAKOUT);
});

test('dud: expired flat ⇒ STAGNATION', () => {
  const v = T.classifyDud({ resolved: { outcome: 'EXPIRED', r: 0.01, hold: 63 }, path: { mfe: 0.04, mae: -0.03, closingReturn: 0.01 }, pick: { entry: 100, stop: 92, target: 120 } });
  assert.strictEqual(v.primaryFailure, T.DUD.STAGNATION);
});

test('dud: loss during a broad market slide carries MARKET_REVERSAL', () => {
  const v = T.classifyDud({
    resolved: { outcome: 'LOSS', r: -0.08, hold: 10 }, path: { mfe: 0.02, mae: -0.09 },
    pick: { entry: 100, stop: 92, target: 120 }, context: { spyReturn: -0.08 },
  });
  assert.strictEqual(v.primaryFailure, T.DUD.MARKET_REVERSAL);
});

test('dud: missing candles ⇒ DATA_FAILURE, and a WIN is never a dud', () => {
  assert.strictEqual(T.classifyDud({ context: { dataMissing: true } }).primaryFailure, T.DUD.DATA_FAILURE);
  assert.strictEqual(T.classifyDud({ resolved: { outcome: 'WIN', r: 0.2, hold: 5 }, pick: {} }), null);
});
