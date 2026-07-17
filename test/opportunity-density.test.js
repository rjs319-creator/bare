'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OD = require('../lib/opportunity-density');

// A minimal enriched-signal shape (as rankSignals produces): needs horizon, state, score,
// evidence.familyCount, expectancyTilt, and either remainingEdge or cost for net edge.
const sig = (over = {}) => ({
  ticker: 'X', horizon: 'swing', state: 'triggered', score: 70,
  evidence: { familyCount: 2 }, expectancyTilt: 1.05,
  cost: { known: true, netMovePct: 8 },
  ...over,
});

test('strong fresh board with edge + good track → normal opportunity, high exposure', () => {
  const board = Array.from({ length: 6 }, (_, i) => sig({ ticker: 'A' + i, cost: { known: true, netMovePct: 9 } }));
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.equal(o.decision, 'normal');
  assert.ok(o.score >= OD.CONFIG.NORMAL_AT);
  assert.equal(o.maxExposurePct, 100);
  assert.ok(o.expectedBestEdgeAfterCostsPct >= 8);
});

test('§6 acceptance: ZERO qualifying names → no-trade regardless of score', () => {
  // Names exist but all have no net edge left (consumed) → nothing qualifies.
  const board = Array.from({ length: 5 }, (_, i) => sig({
    ticker: 'C' + i, remainingEdge: { rated: true, freshness: 'late', netRemainingPct: -1 }, cost: { known: true, netMovePct: -1 },
  }));
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.equal(o.qualifyingCount, 0);
  assert.equal(o.decision, 'no-trade');
  assert.equal(o.maxExposurePct, 0);
});

test('§6 discipline: a BULLISH regime alone does not force a positive recommendation', () => {
  // Risk-on, but the candidates are weak: tiny edge, poor track record, one name only.
  const board = [sig({ ticker: 'W', cost: { known: true, netMovePct: 1 }, expectancyTilt: 0.8, score: 40, evidence: { familyCount: 1 } })];
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.notEqual(o.decision, 'normal', 'weak candidates in a bull tape must not be "normal"');
  assert.ok(o.score < OD.CONFIG.NORMAL_AT);
});

test('risk-off penalizes: same board scores lower and caps exposure vs risk-on', () => {
  const board = Array.from({ length: 6 }, (_, i) => sig({ ticker: 'R' + i, cost: { known: true, netMovePct: 9 } }));
  const on = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  const off = OD.computeOpportunityDensity(board, { regime: { bearish: true, riskOn: false } });
  assert.ok(off.score < on.score, 'risk-off must score lower');
  assert.ok(off.maxExposurePct <= OD.CONFIG.RISK_OFF_CAP);
  assert.equal(off.regimeGate.riskOff, true);
});

test('per-horizon availability reflects qualifying counts', () => {
  const board = [
    sig({ ticker: 'S1', horizon: 'swing' }), sig({ ticker: 'S2', horizon: 'swing' }),
    sig({ ticker: 'I1', horizon: 'intraday' }),
  ];
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.equal(o.byHorizon.swing.availability, 'available'); // 2 qualifying
  assert.equal(o.byHorizon.intraday.availability, 'thin');   // 1
  assert.equal(o.byHorizon.position.availability, 'none');   // 0
});

test('empty board → no-trade, empty reasons handled', () => {
  const o = OD.computeOpportunityDensity([], { regime: {} });
  assert.equal(o.decision, 'no-trade');
  assert.equal(o.qualifyingCount, 0);
  assert.equal(o.activeCount, 0);
  assert.ok(Array.isArray(o.reasons) && o.reasons.length);
});

test('best-pick edge is the TOP-ranked qualifying name, not a moonshot buried down the list', () => {
  // Signals arrive rank-ordered (upstream). The top pick has a modest 5% net move; a far-target
  // moonshot sits lower with 90%. The headline must be the pick you would actually take (5%).
  const board = [
    sig({ ticker: 'TOP', cost: { known: true, netMovePct: 5 } }),
    sig({ ticker: 'MOON', cost: { known: true, netMovePct: 90 } }),
  ];
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.equal(o.expectedBestEdgeAfterCostsPct, 5, 'headline = top-ranked pick edge, not the moonshot');
});

test('netEdgeOf prefers remaining-edge over the cost fallback', () => {
  assert.equal(OD.netEdgeOf(sig({ remainingEdge: { rated: true, netRemainingPct: 3 }, cost: { known: true, netMovePct: 8 } })), 3);
  assert.equal(OD.netEdgeOf(sig({ remainingEdge: null })), 8); // falls back to cost
  assert.equal(OD.netEdgeOf({ }), null); // lead with no levels
});

test('a mediocre-but-real board lands in the middle bands (selective/reduced), not the extremes', () => {
  const board = Array.from({ length: 3 }, (_, i) => sig({ ticker: 'M' + i, cost: { known: true, netMovePct: 4 }, expectancyTilt: 1.0, score: 60, evidence: { familyCount: 1 } }));
  const o = OD.computeOpportunityDensity(board, { regime: { riskOn: true } });
  assert.ok(['selective', 'reduced'].includes(o.decision), `got ${o.decision} (score ${o.score})`);
});
