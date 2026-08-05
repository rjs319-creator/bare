// Locks the 2026-08-05 congestion follow-up registrations: the exploratory
// gap-continuation interaction pass and the CONFIRMATORY prospective 21s test
// (PREREGISTRATION-CONGESTION-21S-2026-08.md) with its sealed holdout.
const test = require('node:test');
const assert = require('node:assert');
const REG = require('../lib/research/hypothesis-registry');

test('gapgo-congestion-interaction is registered, valid, exploratory, in intraday-gap', () => {
  const h = REG.find('gapgo-congestion-interaction');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'exploratory');
  assert.equal(h.familyId, 'intraday-gap');
});

test('congestion-21s-prospective is registered, valid, confirmatory, with the frozen boundaries', () => {
  const h = REG.find('congestion-21s-prospective');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.stoppingRule, /2027-08-01/);
  assert.match(h.stoppingRule, /≥800/);
  assert.match(h.stoppingRule, /21-session horizon/);
  // The 63s question was asked and FAILED — the prospective test may never re-ask it.
  assert.match(h.stoppingRule, /evaluating any other horizon is prohibited/i);
});

test('the congestion21-prospective holdout is sealed and untouched', () => {
  const untouched = new Set(REG.untouchedHoldouts().map((x) => x.id));
  assert.ok(untouched.has('congestion21-prospective'));
});

test('prospective registration widens the event-drift denominator', () => {
  assert.ok(REG.familyTrials('event-drift') >= 3);
});
