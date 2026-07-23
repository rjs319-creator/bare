'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/swing-episode');

function sampleOrigin() {
  return E.makeOrigin({
    episodeId: 'swing:ABC:long:swing:priceTrend:v1:2026-07-20:g1',
    ticker: 'ABC', side: 'long', horizon: 'swing',
    firstDecisionDate: '2026-07-20', firstSuggestedPrice: 10,
    originalEntry: 10.2, originalStop: 9.5, originalTargets: [11.5, 12.5],
    originalScore: 72, originalTier: 'A', originalSetup: 'breakout',
    originalThesis: 'Base breakout on rising volume', originalRisks: ['earnings in 6d'],
  });
}

test('origin is frozen — attempting to mutate does not change it (test #17)', () => {
  const o = sampleOrigin();
  assert.throws(() => { 'use strict'; o.originalStop = 1; });
  assert.equal(o.originalStop, 9.5);
});

test('makeOrigin defaults side to long and normalizes targets to numbers', () => {
  const o = E.makeOrigin({ episodeId: 'x', ticker: 'ABC', firstDecisionDate: '2026-07-20', originalTargets: [11, 'bad', 12] });
  assert.equal(o.side, 'long');
  assert.deepEqual(o.originalTargets, [11, 12]);
});

test('withAssessment produces a NEW episode and never rewrites the origin', () => {
  const ep0 = E.makeEpisode({ origin: sampleOrigin() });
  const ep1 = E.withAssessment(ep0, E.makeAssessment({ currentPrice: 10.8, lifecycleState: 'THESIS_INTACT' }));
  assert.notEqual(ep0, ep1);
  assert.equal(ep1.origin, ep0.origin);                 // same frozen origin object
  assert.equal(ep1.origin.originalStop, 9.5);           // unchanged
  assert.equal(ep1.assessment.currentPrice, 10.8);
});

test('appendTransition is append-only — prior transitions and origin are preserved (test #17)', () => {
  const ep0 = E.makeEpisode({ origin: sampleOrigin() });
  const t1 = E.makeTransition({ newLifecycle: 'NEW', session: '2026-07-20', reasonCodes: ['THESIS_STILL_INTACT'] });
  const ep1 = E.appendTransition(ep0, t1);
  const t2 = E.makeTransition({ prevLifecycle: 'NEW', newLifecycle: 'WEAKENING', session: '2026-07-22', reasonCodes: ['RS_DETERIORATION'] });
  const ep2 = E.appendTransition(ep1, t2);
  assert.equal(ep2.transitions.length, 2);
  assert.equal(ep2.transitions[0].newLifecycle, 'NEW');    // earlier transition intact
  assert.equal(ep2.transitions[1].newLifecycle, 'WEAKENING');
  assert.equal(ep1.transitions.length, 1);                 // ep1 unchanged by ep2
});

test('management stop is a SEPARATE advisory field — it cannot alter the origin stop (test #18)', () => {
  const ep0 = E.makeEpisode({ origin: sampleOrigin() });
  // A tightened management stop is recorded on the assessment, never on the origin.
  const ep1 = E.withAssessment(ep0, E.makeAssessment({ managementStop: 10.6, currentPrice: 11 }));
  assert.equal(ep1.assessment.managementStop, 10.6);
  assert.equal(ep1.origin.originalStop, 9.5);              // grading level untouched
});

test('terminal flag is derived from the lifecycle state', () => {
  const term = E.makeEpisode({ origin: sampleOrigin(), assessment: E.makeAssessment({ lifecycleState: 'TARGET_HIT' }) });
  const open = E.makeEpisode({ origin: sampleOrigin(), assessment: E.makeAssessment({ lifecycleState: 'THESIS_INTACT' }) });
  assert.equal(term.terminal, true);
  assert.equal(open.terminal, false);
  assert.equal(E.isTerminalLifecycle('EXPIRED'), true);
  assert.equal(E.isTerminalLifecycle('WEAKENING'), false);
});

test('episode carries a slotKey derived from the origin (side-aware)', () => {
  const ep = E.makeEpisode({ origin: sampleOrigin() });
  assert.equal(ep.slotKey, 'ABC|long|swing');
});

test('calibrationStatus defaults to uncalibrated (honesty default)', () => {
  const a = E.makeAssessment({});
  assert.equal(a.calibrationStatus, 'uncalibrated');
});
