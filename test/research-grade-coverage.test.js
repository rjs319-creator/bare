'use strict';
// RESEARCH-GRADE COVERAGE FIX tests. The invariants that matter:
//   1. MERGE PROTECTION IS MONOTONE: a re-grade pass that lacks candles for a
//      ticker can never lose that prediction's previously-graded outcome or
//      downgrade a previously-FILLED horizon vector back to `no-candles`.
//   2. A better new grade always WINS the merge (later asOf ⇒ more resolution) —
//      the prior batch only rescues, it never overrides fresh real grading.
//   3. Counts (nGraded/nFilled/resolvedByBar) are recomputed after a merge — a
//      rescued vector must be countable, not a ghost.
//   4. The live-fetch rotation is deterministic per grading day, covers a
//      different window on different days, and never exceeds the cap.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const RG = require('../lib/research-grade-routes');

// ── single-horizon OutcomeBatch fixtures ─────────────────────────────────────
const outcome = (id, fillStatus = 'filled') => ({ predictionId: id, ticker: id, fillStatus, netReturn: 1.2 });
const outcomeBatch = ({ outcomes = [], pending = [], nPredictions = 5 } = {}) => ({
  schema: 'OutcomeBatch', version: 'research-outcome-v1', decisionTs: '2026-07-20',
  gradedAsOf: '2026-08-01', nPredictions,
  nGraded: outcomes.length, nFilled: outcomes.filter(o => o.fillStatus === 'filled').length,
  nUnfilled: outcomes.filter(o => o.fillStatus !== 'filled').length, nPending: pending.length,
  outcomes, pending, invalid: [], mutatesPredictions: false,
});

test('merge rescues a previously-graded outcome that the new pass lost to no-candles', () => {
  const prev = outcomeBatch({ outcomes: [outcome('A'), outcome('B')] });
  const next = outcomeBatch({
    outcomes: [outcome('A')],
    pending: [{ predictionId: 'B', ticker: 'B', reason: 'no-candles' }, { predictionId: 'C', ticker: 'C', reason: 'horizon-not-elapsed:x' }],
  });
  const { batch, keptFromPrior } = RG.mergeOutcomeBatches(prev, next);
  assert.equal(keptFromPrior, 1);
  assert.ok(batch.outcomes.find(o => o.predictionId === 'B'), 'B must be rescued from the prior batch');
  assert.ok(!batch.pending.find(p => p.predictionId === 'B'), 'B must leave pending');
  assert.ok(batch.pending.find(p => p.predictionId === 'C'), 'a genuinely-pending horizon stays pending');
  assert.equal(batch.nGraded, 2);
  assert.equal(batch.nFilled, 2);
});

test('a fresh real grade wins the merge — prior batches rescue, never override', () => {
  const prev = outcomeBatch({ outcomes: [{ ...outcome('A'), netReturn: 0.5 }] });
  const next = outcomeBatch({ outcomes: [{ ...outcome('A'), netReturn: 2.0 }] });
  const { batch, keptFromPrior } = RG.mergeOutcomeBatches(prev, next);
  assert.equal(keptFromPrior, 0);
  assert.equal(batch.outcomes.find(o => o.predictionId === 'A').netReturn, 2.0);
});

test('no prior batch or nothing to rescue → the new batch passes through untouched', () => {
  const next = outcomeBatch({ outcomes: [outcome('A')] });
  assert.equal(RG.mergeOutcomeBatches(null, next).batch, next);
  assert.equal(RG.mergeOutcomeBatches(outcomeBatch({}), next).batch, next);
  // Pending for a NON-candle reason is never rescued — only missing data is protected.
  const prev = outcomeBatch({ outcomes: [outcome('B')] });
  const nextPending = outcomeBatch({ pending: [{ predictionId: 'B', ticker: 'B', reason: 'horizon-not-elapsed:x' }] });
  assert.equal(RG.mergeOutcomeBatches(prev, nextPending).keptFromPrior, 0);
});

// ── multi-horizon batch fixtures ─────────────────────────────────────────────
const vec = (id, fillStatus, rungs) => ({ predictionId: id, ticker: id, fillStatus, horizons: rungs });
const filledVec = id => vec(id, 'filled', [
  { bars: 5, status: 'resolved', netReturn: 1 }, { bars: 21, status: 'pending', reason: 'horizon-not-elapsed:x' },
]);
const noCandlesVec = id => vec(id, 'unfilled', [{ bars: 5, status: 'unfilled', reason: 'no-candles' }, { bars: 21, status: 'unfilled', reason: 'no-candles' }]);
const mhBatch = vectors => ({
  schema: 'MultiHorizonBatch', version: 'research-mh-outcome-v1', decisionTs: '2026-07-20',
  gradedAsOf: '2026-08-01', ladder: [5, 21], nPredictions: vectors.length,
  nFilled: vectors.filter(v => v.fillStatus === 'filled').length,
  nUnfilled: vectors.filter(v => v.fillStatus !== 'filled').length,
  resolvedByBar: {}, vectors, invalid: [], mutatesPredictions: false,
});

test('horizon merge: a filled vector is never downgraded to no-candles, counts recomputed', () => {
  const prev = mhBatch([filledVec('A'), filledVec('B')]);
  const next = mhBatch([filledVec('A'), noCandlesVec('B'), noCandlesVec('C')]);
  const { batch, keptFromPrior } = RG.mergeHorizonBatches(prev, next);
  assert.equal(keptFromPrior, 1);
  const b = batch.vectors.find(v => v.predictionId === 'B');
  assert.equal(b.fillStatus, 'filled', 'B keeps its prior filled vector');
  assert.equal(batch.vectors.find(v => v.predictionId === 'C').fillStatus, 'unfilled', 'C was never graded — stays unfilled');
  assert.equal(batch.nFilled, 2);
  assert.equal(batch.resolvedByBar[5], 2, 'rescued vector counts in resolvedByBar');
  assert.equal(batch.resolvedByBar[21], 0);
});

test('horizon merge: a new FILLED vector always supersedes the prior one', () => {
  const better = vec('A', 'filled', [{ bars: 5, status: 'resolved', netReturn: 9 }, { bars: 21, status: 'resolved', netReturn: 9 }]);
  const { batch, keptFromPrior } = RG.mergeHorizonBatches(mhBatch([filledVec('A')]), mhBatch([better]));
  assert.equal(keptFromPrior, 0);
  assert.equal(batch.vectors[0].horizons[1].status, 'resolved');
});

test('live-fetch rotation: deterministic, capped, day-dependent coverage', () => {
  const misses = Array.from({ length: 10 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const a1 = RG.rotateMisses(misses, '2026-08-02', 4);
  const a2 = RG.rotateMisses(misses, '2026-08-02', 4);
  const b = RG.rotateMisses(misses, '2026-08-03', 4);
  assert.deepEqual(a1, a2, 'same grading day → same window');
  assert.equal(a1.length, 4);
  assert.notDeepEqual(a1, b, 'a different grading day rotates the window');
  assert.deepEqual(RG.rotateMisses(['X', 'Y'], '2026-08-02', 4), ['X', 'Y'], 'under the cap → everything fetches');
});
