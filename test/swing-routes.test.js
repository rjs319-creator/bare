'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RT = require('../lib/swing-supervisor-routes');
const SUP = require('../lib/swing-supervisor');
const { isMarketHoliday } = require('../lib/stats');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

test('extractSwingSignals maps an op=today swing signal into the supervisor shape', () => {
  const today = { horizons: { swing: [
    { ticker: 'ABC', side: 'long', source: 'screener', sources: ['screener'], strategyFamily: 'priceTrend', score: 70, rank: 3, entry: 10.5, stop: 9.5, target: 12, price: 10, note: 'breakout', sector: 'Technology' },
    { ticker: 'XYZ', side: 'short', source: 'downday', sources: ['downday'], strategyFamily: 'meanReversion', score: 60, rank: 8, entry: 20, stop: 21, target: 18, price: 20 },
  ] }, horizons_other: 1 };
  const sigs = RT.extractSwingSignals(today);
  assert.equal(sigs.length, 2);
  assert.equal(sigs[0].ticker, 'ABC');
  assert.equal(sigs[0].horizon, 'swing');
  assert.equal(sigs[1].side, 'short');
});

test('toCard exposes BOTH original and current state, the explanation, reasons and freshness (test #26)', () => {
  const sig = { ticker: 'ABC', side: 'long', horizon: 'swing', source: 'screener', sources: ['screener'], strategyFamily: 'priceTrend', score: 72, rank: 5, entry: 10.5, stop: 9.5, target: 12, price: 10, note: 'Base breakout' };
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [sig], priceBundle: { map: { ABC: [bar('2026-07-20', 10, 10.1, 9.9, 10)] }, bench: { SPY: [bar('2026-07-20', 100, 100, 100, 100)] } }, ctx: { date: '2026-07-20', generatedAt: '2026-07-20T21:00:00Z', regime: 'neutral', isHoliday: isMarketHoliday, cooldownSessions: 3 } });
  const card = RT.toCard(d1.episodes[0]);
  // immutable origin
  assert.equal(card.originalStop, 9.5);
  assert.equal(card.originalScore, 72);
  assert.equal(card.originalThesis, 'Base breakout');
  assert.equal(card.firstDecisionDate, '2026-07-20');
  // current assessment
  assert.ok(card.lifecycleState);
  assert.ok(card.thesisState);
  assert.ok(card.actionState);
  assert.ok(card.executionState);
  assert.ok(card.outcomeState);
  assert.ok(Array.isArray(card.reasonCodes));
  assert.ok(typeof card.explanation === 'string' && card.explanation.length > 0);
  assert.ok(card.dataFreshness === 'fresh' || card.dataFreshness === 'stale');
  assert.equal(card.calibrationStatus, 'uncalibrated');   // honesty default
});

test('boardPayload carries the seven-section order, labels, counts and the honesty banner', () => {
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [], priceBundle: { map: {}, bench: {} }, ctx: { date: '2026-07-20', generatedAt: '2026-07-20T21:00:00Z', isHoliday: isMarketHoliday } });
  const payload = RT.boardPayload(d1);
  assert.deepEqual(payload.sectionOrder, ['newCandidates', 'stillValid', 'waitingForTrigger', 'needsAttention', 'noLongerActionable', 'completed', 'archive']);
  assert.equal(payload.sectionLabels.noLongerActionable, 'No Longer Actionable');
  assert.ok(payload.counts);
  assert.match(payload.honesty, /NOT a claim of predictive edge/);
});

test('an empty board is valid — new and actionable sections can be empty', () => {
  const d = SUP.buildSupervisor({ prevEpisodes: [], signals: [], priceBundle: { map: {}, bench: {} }, ctx: { date: '2026-07-20', generatedAt: 'x', isHoliday: isMarketHoliday } });
  const payload = RT.boardPayload(d);
  assert.equal(payload.counts.newCandidates, 0);
  assert.equal(payload.counts.stillValid, 0);
});
