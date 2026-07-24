'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyArchetype } = require('../lib/biotech-archetypes');
const { ARCHETYPES: A, CAPITAL_STATES: S } = require('../lib/biotech-config');

test('post-catalyst continuation: verified event just out, gap retained, fresh', () => {
  const { archetype } = classifyArchetype({
    features: { event: { sessionsSince: 3, gapRetain1: 1.0, holdsEventLow: true }, higherHigh: true },
    event: { eventType: 'TRIAL_READOUT', verified: true }, timing: 'Behind',
  });
  assert.equal(archetype, A.POST_CATALYST);
});

test('pre-event run-up: dated future binary with room to exit before → PRE_EVENT', () => {
  const { archetype, reasons } = classifyArchetype({
    features: {}, event: { eventType: 'PDUFA' }, timing: 'Ahead', daysToBinary: 12,
  });
  assert.equal(archetype, A.PRE_EVENT);
  assert.ok(/exit before/i.test(reasons[0]));
});

test('binary watch: unresolved binary inside the holding period (too close to exit before)', () => {
  const { archetype } = classifyArchetype({
    features: {}, event: { eventType: 'FDA_DECISION' }, timing: 'Ahead', daysToBinary: 1,
  });
  assert.equal(archetype, A.BINARY_WATCH);
});

test('M&A target is routed to special situations, not normal swing', () => {
  const { archetype } = classifyArchetype({ features: {}, aiClass: 'MA' });
  assert.equal(archetype, A.BINARY_WATCH);
});

test('financing-overhang relief: completed offering, price holding', () => {
  const { archetype } = classifyArchetype({
    features: { event: { holdsEventLow: true } },
    capital: { state: S.COMPLETED_FINANCING_RELIEF }, timing: 'Behind',
  });
  assert.equal(archetype, A.FINANCING_RELIEF);
});

test('buyable post-event pullback: orderly dip off the post-event high, event low holding', () => {
  const { archetype } = classifyArchetype({
    features: { event: { sessionsSince: 6, pullbackDepthPct: -12, holdsEventLow: true }, higherLow: true, volDryUp: 0.8 },
    event: { eventType: 'TRIAL_READOUT', verified: true }, timing: 'Behind',
  });
  assert.equal(archetype, A.POST_EVENT_PULLBACK);
});

test('catalyst-base breakout: older catalyst + constructive base', () => {
  const { archetype } = classifyArchetype({
    features: { event: { sessionsSince: 20, gapRetain1: 1.0 }, volContraction: 0.7 },
    event: { eventType: 'TRIAL_READOUT', verified: true }, timing: 'Behind',
  });
  assert.equal(archetype, A.CATALYST_BASE);
});

test('sympathy: AI-named mechanistic read-through', () => {
  const { archetype } = classifyArchetype({ features: {}, aiClass: 'SYMPATHY' });
  assert.equal(archetype, A.SYMPATHY);
});

test('unclassified: no defensible structure or evidence', () => {
  const { archetype } = classifyArchetype({ features: { ret5: 2 } });
  assert.equal(archetype, A.UNCLASSIFIED);
});
