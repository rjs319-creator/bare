// Locks the 2026-08-05 portfolio/VRP reframe registrations (PREREGISTRATION-
// COMPOSITE-BOOK-2026-08.md): entries valid, the prospective holdout sealed,
// the book's frozen boundary, and the alphabook summarizer's math.
const test = require('node:test');
const assert = require('node:assert');
const REG = require('../lib/research/hypothesis-registry');
const { BOOK_VERSION, REGISTERED_AFTER, wilsonLo } = require('../lib/alphabook-routes');

test('composite-book-v1 is registered, valid, confirmatory, boundary matches the route', () => {
  const h = REG.find('composite-book-v1');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.stoppingRule, /2027-02-01/);
  assert.match(h.stoppingRule, /≥120/);
  assert.match(h.primaryMetric, /AFTER 2026-08-05/);
  assert.equal(REGISTERED_AFTER, '2026-08-05', 'route boundary must match the registration');
  assert.equal(BOOK_VERSION, 'composite-book-v1');
});

test('vrp-overlay-synthetic is registered, valid, exploratory, with frozen design tokens', () => {
  const h = REG.find('vrp-overlay-synthetic');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'exploratory');
  assert.match(h.stoppingRule, /21-session/);
  assert.match(h.stoppingRule, /30d/);
  assert.match(h.stoppingRule, /no strike\/tenor search/i);
});

test('composite-book-prospective holdout is sealed and untouched', () => {
  const untouched = new Set(REG.untouchedHoldouts().map((x) => x.id));
  assert.ok(untouched.has('composite-book-prospective'));
});

test('wilsonLo: sane bounds (monotone in n at fixed rate, below the point estimate)', () => {
  assert.ok(wilsonLo(6, 10) < 0.6);
  assert.ok(wilsonLo(60, 100) < 0.6);
  assert.ok(wilsonLo(60, 100) > wilsonLo(6, 10), 'more evidence → tighter bound');
  assert.equal(wilsonLo(0, 0), 0);
});
