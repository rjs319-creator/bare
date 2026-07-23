'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../lib/swing-identity');

test('long and short on the same ticker never share a slot key or episode id (test #13)', () => {
  const base = { ticker: 'ABC', horizon: 'swing', strategyFamily: 'priceTrend', strategyVersion: 'v1', firstDecisionDate: '2026-07-20', setupGeneration: 1 };
  assert.notEqual(I.slotKey({ ...base, side: 'long' }), I.slotKey({ ...base, side: 'short' }));
  assert.notEqual(I.episodeId({ ...base, side: 'long' }), I.episodeId({ ...base, side: 'short' }));
});

test('slotKey is stable across a merged-source base change (test #14)', () => {
  // Yesterday the base source was the screener; today it is coil. slotKey ignores source, so the
  // episode is found and continued — no phantom "vanished + new".
  const yesterday = I.slotKey({ ticker: 'ABC', side: 'long', horizon: 'swing' });
  const today = I.slotKey({ ticker: 'abc', side: 'long', horizon: 'swing' });
  assert.equal(yesterday, today);
});

test('episodeId embeds every required identity dimension', () => {
  const id = I.episodeId({ ticker: 'ABC', side: 'long', horizon: 'swing', strategyFamily: 'accumulation', strategyVersion: 'swing-v1', firstDecisionDate: '2026-07-20', setupGeneration: 2 });
  assert.match(id, /ABC/); assert.match(id, /long/); assert.match(id, /swing/);
  assert.match(id, /accumulation/); assert.match(id, /swing-v1/); assert.match(id, /2026-07-20/);
  assert.match(id, /g2$/);
});

test('a new setup generation produces a different episode id (test #15 identity half)', () => {
  const common = { ticker: 'ABC', side: 'long', horizon: 'swing', strategyFamily: 'priceTrend', strategyVersion: 'v1', firstDecisionDate: '2026-07-20' };
  assert.notEqual(I.episodeId({ ...common, setupGeneration: 1 }), I.episodeId({ ...common, setupGeneration: 2 }));
});

test('predictionIdFor gives each contributing source a distinct id under one episode', () => {
  const id = I.episodeId({ ticker: 'ABC', side: 'long', horizon: 'swing', strategyFamily: 'priceTrend', strategyVersion: 'v1', firstDecisionDate: '2026-07-20', setupGeneration: 1 });
  const p1 = I.predictionIdFor(id, 'screener');
  const p2 = I.predictionIdFor(id, 'coil');
  assert.notEqual(p1, p2);
  assert.ok(p1.startsWith(id)); assert.ok(p2.startsWith(id));
});

test('reentry: no prior opens generation 1', () => {
  const d = I.reentryDecision(null, {});
  assert.equal(d.action, 'open-first'); assert.equal(d.setupGeneration, 1);
});

test('reentry: a non-terminal prior continues the same episode', () => {
  const d = I.reentryDecision({ setupGeneration: 1, terminal: false }, {});
  assert.equal(d.action, 'continue'); assert.equal(d.setupGeneration, 1);
});

test('reentry: a terminal prior still within cooldown with no new setup is suppressed, NOT reused (test #16)', () => {
  const prior = { setupGeneration: 1, terminal: true, setupSignature: 'breakout|10|9' };
  const d = I.reentryDecision(prior, { sessionsSincePriorTerminal: 1, cooldownSessions: 3, currentSetupSignature: 'breakout|10|9' });
  assert.equal(d.action, 'suppress');           // does not reopen with the stale origin
  assert.equal(d.setupGeneration, 1);
});

test('reentry: a terminal prior past cooldown opens a NEW generation (test #15)', () => {
  const prior = { setupGeneration: 1, terminal: true };
  const d = I.reentryDecision(prior, { sessionsSincePriorTerminal: 5, cooldownSessions: 3 });
  assert.equal(d.action, 'open-new'); assert.equal(d.setupGeneration, 2); assert.equal(d.reason, 'COOLDOWN_ELAPSED');
});

test('reentry: a genuinely new setup signature opens a new generation even within cooldown (test #15)', () => {
  const prior = { setupGeneration: 1, terminal: true, setupSignature: 'breakout|10|9' };
  const d = I.reentryDecision(prior, { sessionsSincePriorTerminal: 1, cooldownSessions: 3, currentSetupSignature: 'breakout|22|20' });
  assert.equal(d.action, 'open-new'); assert.equal(d.setupGeneration, 2); assert.equal(d.reason, 'NEW_SETUP_GENERATION');
});

test('setupSignature changes when the entry level moves materially', () => {
  const a = I.setupSignature({ setup: 'breakout', entry: 10, stop: 9 });
  const b = I.setupSignature({ setup: 'breakout', entry: 22, stop: 20 });
  assert.notEqual(a, b);
  assert.equal(a, I.setupSignature({ setup: 'breakout', entry: 10, stop: 9 })); // deterministic
});
