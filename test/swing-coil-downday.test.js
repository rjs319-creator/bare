'use strict';
// Strategy-specific requirements: Coil no-fill vs break states (spec #21) and Down-Day regime
// retention (a specialized-regime source stops running, but the published episode must be retained
// and re-evaluated, not erased).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SUP = require('../lib/swing-supervisor');
const L = require('../lib/swing-lifecycle');
const { makeOrigin } = require('../lib/swing-episode');
const { isMarketHoliday } = require('../lib/stats');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const coilOrigin = () => makeOrigin({ episodeId: 'c', ticker: 'COIL', side: 'long', horizon: 'swing', strategyFamily: 'volatility', firstDecisionDate: '2026-07-20', firstSuggestedPrice: 10, originalEntry: 10.6, originalStop: 9.6, originalTargets: [12], originalHoldingWindow: 5 });

test('Coil: still coiled (trigger not yet fired, within window) → WAITING_FOR_TRIGGER (test #21)', () => {
  const r = L.classify(coilOrigin(), { fill: { status: 'unfilled' }, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 2 }, { fillDeadline: 5 });
  assert.equal(r.lifecycle, 'WAITING_FOR_TRIGGER');
});

test('Coil: failed to trigger within the window → NO_FILL, distinct from a break (test #21)', () => {
  const r = L.classify(coilOrigin(), { fill: { status: 'unfilled' }, barrier: { barrier: 'none' }, sessionsSinceSuggestion: 6 }, { fillDeadline: 5 });
  assert.equal(r.lifecycle, 'NO_FILL');
  assert.equal(r.outcome, 'NO_FILL');
});

test('Coil: broke upward to target vs broke down to stop are distinct terminal states (test #21)', () => {
  const up = L.classify(coilOrigin(), { fill: { status: 'filled', fillDate: '2026-07-21', fillPrice: 10.6 }, barrier: { barrier: 'target' } }, {});
  const down = L.classify(coilOrigin(), { fill: { status: 'filled', fillDate: '2026-07-21', fillPrice: 10.6 }, barrier: { barrier: 'stop' } }, {});
  assert.equal(up.lifecycle, 'TARGET_HIT');
  assert.equal(down.lifecycle, 'INVALIDATED');
  assert.notEqual(up.lifecycle, down.lifecycle);
});

test('Down-Day: when the risk-off regime flips off and the source stops running, the episode is RETAINED and re-evaluated, not erased', () => {
  const ddSig = { ticker: 'DD', side: 'long', horizon: 'swing', source: 'downday', sources: ['downday'], strategyFamily: 'meanReversion', score: 60, rank: 4, entry: 10.2, stop: 9.6, target: 11.5, price: 10, note: 'red-tape reversion bounce' };
  const riskOff = { date: '2026-07-20', generatedAt: '2026-07-20T21:00:00Z', regime: 'Risk-off', regimeRiskOff: true, isHoliday: isMarketHoliday, cooldownSessions: 3 };
  const d1 = SUP.buildSupervisor({ prevEpisodes: [], signals: [ddSig], priceBundle: { map: { DD: [bar('2026-07-20', 10, 10.1, 9.9, 10)] }, bench: { SPY: [bar('2026-07-20', 100, 100, 100, 100)] } }, ctx: riskOff });
  // Regime turns constructive; the Down-Day source no longer runs, so DD is absent from signals.
  const ddCandles = [bar('2026-07-20', 10, 10.1, 9.9, 10), bar('2026-07-21', 10.2, 10.5, 10.1, 10.4), bar('2026-07-22', 10.4, 10.7, 10.3, 10.6)];
  const spy = ['2026-07-20', '2026-07-21', '2026-07-22'].map(x => bar(x, 100, 100, 100, 100));
  const d2 = SUP.buildSupervisor({ prevEpisodes: d1.episodes, signals: [], priceBundle: { map: { DD: ddCandles }, bench: { SPY: spy } }, ctx: { date: '2026-07-22', generatedAt: '2026-07-22T21:00:00Z', regime: 'Risk-on', regimeRiskOff: false, isHoliday: isMarketHoliday, cooldownSessions: 3 } });
  assert.equal(d2.episodes.length, 1);                        // retained, not erased
  const ep = d2.episodes[0];
  assert.equal(ep.assessment.sourceStillSelects, false);
  assert.ok(!ep.terminal);                                    // still open, being re-evaluated
  assert.ok(ep.assessment.explanation && ep.assessment.explanation.length > 0);
});
