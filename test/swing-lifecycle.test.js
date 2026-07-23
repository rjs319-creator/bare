'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/swing-lifecycle');
const { makeOrigin } = require('../lib/swing-episode');

const origin = (x = {}) => makeOrigin({ episodeId: 'e', ticker: 'ABC', side: 'long', horizon: 'swing', firstDecisionDate: '2026-07-20', firstSuggestedPrice: 10, originalEntry: 10.5, originalStop: 9.5, originalTargets: [12], originalHoldingWindow: 10, originalScore: 70, ...x });
const filled = { status: 'filled', fillPrice: 10.5, fillDate: '2026-07-21' };

test('stale data → DATA_STALE, retains prior, never a negative judgment (test #4)', () => {
  const r = L.classify(origin(), { fill: { status: 'unfilled' }, barrier: { barrier: 'none' } }, { dataStale: true, priorExecution: 'FILLED' });
  assert.equal(r.lifecycle, 'DATA_STALE');
  assert.equal(r.thesis, 'UNKNOWN_STALE');
  assert.equal(r.outcome, 'UNRESOLVED');
  assert.equal(r.execution, 'FILLED');       // retained
  assert.equal(r.terminal, false);
  assert.ok(r.reasonCodes.includes('DATA_STALE'));
});

test('stop breach → INVALIDATED / LOSS terminal (test #5)', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'stop' } }, {});
  assert.equal(r.lifecycle, 'INVALIDATED');
  assert.equal(r.outcome, 'LOSS');
  assert.equal(r.execution, 'STOPPED');
  assert.equal(r.terminal, true);
  assert.ok(r.reasonCodes.includes('STOP_BREACH'));
});

test('target hit → TARGET_HIT / WIN terminal (test #6)', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'target' } }, {});
  assert.equal(r.lifecycle, 'TARGET_HIT');
  assert.equal(r.outcome, 'WIN');
  assert.equal(r.thesis, 'COMPLETED');
  assert.equal(r.terminal, true);
});

test('trigger not reached within the window → NO_FILL, not a loss (test #7)', () => {
  const r = L.classify(origin(), { fill: { status: 'unfilled' }, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 12 }, { fillDeadline: 10 });
  assert.equal(r.lifecycle, 'NO_FILL');
  assert.equal(r.execution, 'NO_FILL');
  assert.equal(r.outcome, 'NO_FILL');        // explicitly NOT a loss
  assert.equal(r.terminal, true);
  assert.ok(r.reasonCodes.includes('ENTRY_NOT_TRIGGERED'));
});

test('gap-skip → NO_FILL / do-not-chase (execution GAP_SKIP)', () => {
  const r = L.classify(origin(), { fill: { status: 'gap-skip' }, barrier: { barrier: 'none' } }, {});
  assert.equal(r.lifecycle, 'NO_FILL');
  assert.equal(r.execution, 'GAP_SKIP');
  assert.equal(r.action, 'DO_NOT_CHASE');
});

test('profitable but extended pick → EXTENDED / DO_NOT_CHASE, not a fresh entry (test #8)', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 4, consumedPct: 0.9, remainingRewardRisk: 0.4, returnSinceFill: 0.08 }, {});
  assert.equal(r.lifecycle, 'EXTENDED');
  assert.equal(r.action, 'DO_NOT_CHASE');
  assert.equal(r.terminal, false);
  assert.ok(r.reasonCodes.includes('EDGE_CONSUMED') || r.reasonCodes.includes('RISK_REWARD_INADEQUATE'));
});

test('weakening but unbroken thesis stays visible (WEAKENING, not terminal) (test #9)', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 3, scoreDelta: -12, rsSpy10: -0.03, priceVsMa20: -0.2 }, {});
  assert.equal(r.lifecycle, 'WEAKENING');
  assert.equal(r.thesis, 'WEAKENING');
  assert.equal(r.action, 'TIGHTEN_RISK');
  assert.equal(r.terminal, false);
});

test('rank cutoff on a still-valid pick → VALID_BUT_DISPLACED, not failed (test #3)', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 3, scoreDelta: 1, rsSpy10: 0.02, consumedPct: 0.3, remainingRewardRisk: 2 }, { currentRank: 18, originalRank: 7 });
  assert.equal(r.lifecycle, 'VALID_BUT_DISPLACED');
  assert.equal(r.terminal, false);
  assert.ok(r.reasonCodes.includes('RANK_CUTOFF') || r.reasonCodes.includes('STRONGER_CANDIDATES'));
});

test('source no longer selects but thesis intact → VALID_BUT_DISPLACED with SOURCE_DROPPED', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 3, scoreDelta: 0, rsSpy10: 0.01, consumedPct: 0.3, remainingRewardRisk: 2 }, { sourceStillSelects: false });
  assert.equal(r.lifecycle, 'VALID_BUT_DISPLACED');
  assert.ok(r.reasonCodes.includes('SOURCE_DROPPED'));
});

test('healthy filled pick → THESIS_INTACT / HOLD_MANAGE', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 2, scoreDelta: 2, rsSpy10: 0.02, consumedPct: 0.3, remainingRewardRisk: 2.5 }, { sourceStillSelects: true, currentRank: 4, originalRank: 5 });
  assert.equal(r.lifecycle, 'THESIS_INTACT');
  assert.equal(r.action, 'HOLD_MANAGE');
  assert.equal(r.execution, 'FILLED');
});

test('a new enter-now candidate on day 0 → ENTERABLE; a breakout trigger → WAITING_FOR_TRIGGER', () => {
  const enterNow = origin({ originalEntry: 10 });   // trigger not beyond suggested → enter-now
  const rn = L.classify(enterNow, { fill: { status: 'unfilled' }, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 0 }, { isNew: true });
  assert.equal(rn.lifecycle, 'ENTERABLE');
  assert.equal(rn.action, 'ENTER_NOW');
  const rb = L.classify(origin(), { fill: { status: 'unfilled' }, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 0 }, { isNew: true });
  assert.equal(rb.lifecycle, 'WAITING_FOR_TRIGGER');
});

test('strengthening thesis surfaces SCORE_IMPROVED', () => {
  const r = L.classify(origin(), { fill: filled, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 3, scoreDelta: 14, rsSpy10: 0.05, consumedPct: 0.3, remainingRewardRisk: 2.5 }, {});
  assert.equal(r.thesis, 'STRENGTHENING');
  assert.ok(r.reasonCodes.includes('SCORE_IMPROVED'));
});
