'use strict';
// LIVE → RESEARCH BRIDGE tests.
//
// The bridge's whole value is that it is an OBSERVER: it makes the live decision path
// emit the canonical research contract without the contract ever steering the live
// path. Most of these tests are therefore about what the bridge must REFUSE to do —
// fabricate an entry timestamp, dress a rank as a probability, drop rejected names, or
// touch the ranking it reads.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('../lib/research/live-bridge');
const S = require('../lib/research/schemas');
const { rankSignals, makeSignal, MAX_AGE_BARS } = require('../lib/decision');

const AXIS = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20'];
const CTX = {
  decisionTs: '2026-07-17', sessionAxis: AXIS, modelVersion: 'decision-v1',
  featureVersion: 'research-features-v1', universeSnapshotId: 'snap-1', regime: 'risk-on',
};

function sig(over = {}) {
  return {
    id: over.ticker || 'AAA', ticker: over.ticker || 'AAA', horizon: 'swing', side: 'long',
    score: 71, rank: 1, confidence: 60, state: 'detected', actionable: true,
    strategyFamily: 'trend', scope: 'liquid', ...over,
  };
}

// ── invariant 1: observer only ───────────────────────────────────────────────
test('the bridge never mutates the signals it reads', () => {
  const input = sig();
  const before = JSON.stringify(input);
  B.predictionFromSignal(input, CTX);
  assert.equal(JSON.stringify(input), before, 'input signal was mutated');
});

test('THE INVARIANT: ranking is byte-identical whether or not the bridge runs', () => {
  const signals = [
    makeSignal({ id: 'A', ticker: 'A', source: 'screener', horizon: 'swing', side: 'long', rawConfidence: 70, price: 10, entry: 10, stop: 9, target: 13 }),
    makeSignal({ id: 'B', ticker: 'B', source: 'screener', horizon: 'swing', side: 'long', rawConfidence: 55, price: 20, entry: 20, stop: 18, target: 26 }),
  ];
  const rankedBefore = rankSignals(signals, { regime: { riskOn: true } });
  const snapshot = JSON.stringify(rankedBefore);
  B.buildDecisionSnapshot(rankedBefore, CTX);              // run the bridge over it
  const rankedAfter = rankSignals(signals, { regime: { riskOn: true } });
  assert.equal(JSON.stringify(rankedBefore), snapshot, 'bridge mutated the ranked output');
  assert.deepEqual(rankedAfter.map(r => r.rank), rankedBefore.map(r => r.rank));
  assert.deepEqual(rankedAfter.map(r => r.score), rankedBefore.map(r => r.score));
});

test('a snapshot declares it cannot affect the live rank', () => {
  assert.equal(B.buildDecisionSnapshot([sig()], CTX).affectsLiveRank, false);
});

// ── invariant 2: no fabricated entry timing ──────────────────────────────────
test('eligibleEntryTs is the next session STRICTLY after the decision', () => {
  const p = B.predictionFromSignal(sig(), CTX);
  assert.equal(p.decisionTs, '2026-07-17');
  assert.equal(p.eligibleEntryTs, '2026-07-20', 'must skip the weekend to the next real session');
  assert.equal(S.validatePrediction(p).valid, true);
});

test('no session axis ⇒ entry is null and flagged, never guessed', () => {
  const p = B.predictionFromSignal(sig(), { ...CTX, sessionAxis: null });
  assert.equal(p.eligibleEntryTs, null, 'a fabricated date would be look-ahead');
  assert.ok(p.rejectionReasons.includes('entry-session-unknown'));
  const snap = B.buildDecisionSnapshot([sig()], { ...CTX, sessionAxis: null });
  assert.ok(snap.caveats.some(c => c.startsWith('no-session-axis')));
});

test('a decision at/after the last known session yields null, not a rolled-forward date', () => {
  assert.equal(B.nextSessionAfter('2026-07-20', AXIS), null);
  assert.equal(B.nextSessionAfter('2026-99-99', AXIS), null);
});

// ── invariant 3: no fabricated forecasts ─────────────────────────────────────
test('the composite rank is recorded as a rank, never as a probability', () => {
  const p = B.predictionFromSignal(sig({ score: 88 }), CTX);
  assert.equal(p.rawOutputs.compositeScore, 88);
  assert.equal(p.rawOutputs.scoreKind, 'heuristic-rank');
  assert.deepEqual(p.calibratedProbabilities, {}, 'no calibrated probabilities exist for the heuristic');
  assert.equal(p.expectedGrossReturn, null, 'an advertised target level is not an expectation');
  assert.equal(p.expectedNetReturn, null);
});

test('expectedCosts IS populated, because it is genuinely modeled', () => {
  const p = B.predictionFromSignal(sig(), CTX);
  assert.ok(p.expectedCosts > 0);
});

test('a short is priced with borrow, so it costs more than the same long', () => {
  // Regression guard for a real bug caught in review: holdWindow is a human-readable
  // STRING, so reading `.bars` off it silently produced 0 borrow on every short.
  const long = B.predictionFromSignal(sig({ side: 'long', scope: 'micro' }), CTX);
  const short = B.predictionFromSignal(sig({ side: 'short', scope: 'micro' }), CTX);
  assert.ok(short.expectedCosts > long.expectedCosts,
    `short (${short.expectedCosts}) must exceed long (${long.expectedCosts}) via borrow`);
});

test('holding period comes from the live horizon map, not a hardcoded guess', () => {
  const swing = B.predictionFromSignal(sig({ side: 'short', horizon: 'swing', scope: 'micro' }), CTX);
  const position = B.predictionFromSignal(sig({ side: 'short', horizon: 'position', scope: 'micro' }), CTX);
  assert.ok(MAX_AGE_BARS.position > MAX_AGE_BARS.swing);
  assert.ok(position.expectedCosts > swing.expectedCosts, 'longer horizon accrues more borrow');
});

// ── invariant 4: full candidate set (selection-bias trap) ────────────────────
test('rejected candidates are emitted WITH their reason, not dropped', () => {
  const snap = B.buildDecisionSnapshot([
    sig({ ticker: 'GOOD' }),
    sig({ ticker: 'OLD', actionable: false, state: 'expired' }),
  ], CTX);
  assert.equal(snap.nPredictions, 2);
  assert.equal(snap.nSelected, 1);
  assert.equal(snap.nRejected, 1);
  const rej = snap.predictions.find(p => p.ticker === 'OLD');
  assert.equal(rej.state, 'rejected');
  assert.ok(rej.rejectionReasons.includes('lifecycle-expired'));
});

test('a selected-only cross-section is flagged as a selection-bias risk', () => {
  const snap = B.buildDecisionSnapshot([sig(), sig({ ticker: 'BBB' })], CTX);
  assert.equal(snap.nRejected, 0);
  assert.ok(snap.caveats.some(c => c.startsWith('partial-universe')),
    'training only on names the old model liked is the trap this flag exists to surface');
});

test('the bridge can never mark a prediction eligible for capital', () => {
  const states = B.buildDecisionSnapshot([
    sig(), sig({ ticker: 'X', actionable: false, state: 'invalidated' }),
  ], CTX).predictions.map(p => p.state);
  assert.deepEqual([...new Set(states)].sort(), ['rejected', 'shadow']);
  assert.ok(!states.includes('eligible'));
});

// ── forward session axis ────────────────────────────────────────────────────
test('forwardSessionAxis skips weekends', () => {
  // 2026-07-17 is a Friday → next session is Monday the 20th.
  assert.equal(B.forwardSessionAxis('2026-07-17', { n: 1 })[0], '2026-07-20');
});

test('forwardSessionAxis skips holidays when given the predicate', () => {
  const { isMarketHoliday } = require('../lib/stats');
  // 2026-07-03 is the observed Independence Day holiday (a Friday).
  const naive = B.forwardSessionAxis('2026-07-02', { n: 1 })[0];
  const aware = B.forwardSessionAxis('2026-07-02', { n: 1, isHoliday: isMarketHoliday })[0];
  assert.equal(naive, '2026-07-03', 'weekday roll alone lands ON the holiday');
  assert.equal(aware, '2026-07-06', 'holiday-aware axis moves to the next real session');
});

test('forwardSessionAxis returns null on unusable input rather than a bogus date', () => {
  assert.equal(B.forwardSessionAxis(null), null);
  assert.equal(B.forwardSessionAxis('not-a-date'), null);
});

test('an approximate axis is declared as such in the snapshot caveats', () => {
  const snap = B.buildDecisionSnapshot([sig()], { ...CTX, sessionAxisKind: 'approximate' });
  assert.ok(snap.caveats.some(c => c.startsWith('session-axis-approximate')));
  const exact = B.buildDecisionSnapshot([sig()], { ...CTX, sessionAxisKind: 'exact' });
  assert.ok(!exact.caveats.some(c => c.startsWith('session-axis-approximate')));
});

// ── plumbing ────────────────────────────────────────────────────────────────
test('prediction ids are deterministic and distinguish side', () => {
  const a = B.predictionFromSignal(sig(), CTX);
  const b = B.predictionFromSignal(sig(), CTX);
  const s = B.predictionFromSignal(sig({ side: 'short' }), CTX);
  assert.equal(a.predictionId, b.predictionId, 're-emitting must be idempotent');
  assert.notEqual(a.predictionId, s.predictionId, 'a long and a short are different decisions');
});

test('every emitted prediction passes the schema validator', () => {
  const snap = B.buildDecisionSnapshot([
    sig(), sig({ ticker: 'B', side: 'short' }), sig({ ticker: 'C', actionable: false, state: 'expired' }),
  ], CTX);
  assert.deepEqual(snap.invalid, [], `invalid predictions emitted: ${JSON.stringify(snap.invalid)}`);
});

test('predictions are frozen — a stored decision cannot be rewritten later', () => {
  const p = B.predictionFromSignal(sig(), CTX);
  assert.throws(() => { 'use strict'; p.rawOutputs.compositeScore = 999; }, TypeError);
  assert.throws(() => { 'use strict'; p.decisionTs = '2030-01-01'; }, TypeError);
});

test('an empty cross-section yields a terminal snapshot, not a crash', () => {
  const snap = B.buildDecisionSnapshot([], CTX);
  assert.equal(snap.nPredictions, 0);
  assert.deepEqual(snap.invalid, []);
});
