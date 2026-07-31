'use strict';
// GRIDLOCK end-to-end integration: event ledger → causal classification → tape →
// not-yet-repriced → OMEGA timing → decomposed score → action gate, with the
// candle provider STUBBED (clearly synthetic data, zero network). This is the
// closest offline replica of what op=gridlocktick assembles.
const test = require('node:test');
const assert = require('node:assert');

// Stub ./screener BEFORE gridlock-routes loads it (CommonJS cache injection).
const screenerPath = require.resolve('../lib/screener');
function syntheticCandles(n, drift) {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * drift + Math.sin(i) * 0.4;
    return { date: new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10), open: c * 0.995, high: c * 1.01, low: c * 0.985, close: c, volume: 2e6 + (i % 5) * 3e5 };
  });
}
require.cache[screenerPath] = {
  id: screenerPath, filename: screenerPath, loaded: true,
  exports: {
    fetchDailyHistory: async (ticker) => ({
      candles: syntheticCandles(90, ticker === 'SPY' || ticker === 'XLU' || ticker === 'XLE' || ticker === 'XLI' ? 0.05 : 0.35),
    }),
  },
};
const GL = require('../lib/gridlock-routes');

const EVENTS = {
  'gridlock:CAPACITY_AUCTION:PJM:SYN': {
    id: 'syn1', canonicalEventId: 'gridlock:CAPACITY_AUCTION:PJM:SYN',
    eventType: 'CAPACITY_AUCTION', title: 'Synthetic capacity auction clears at record price',
    announcedAt: syntheticCandles(90, 0)[80].date,   // fresh relative to asOf below
    certainty: 'OPERATING', lifecycle: 'BUILDING', isoRegion: 'PJM',
    demandDeltaMW: null, generationDeltaMW: null, independentSourceCount: 3,
    companies: [], counterparties: [], affectedTickers: [], fieldConflicts: [],
    sourceEvidence: [{ sourceId: 's', sourceFamily: 'iso-market-data', publisher: 'SyntheticISO', stableRef: 'x', retrievedAt: '2026-07-01', primaryOrSecondary: 'primary', parserVersion: 't' }],
  },
};
const CPS = { total: 72, dataQuality: 'good', version: 'gridlock-cps-v1', missing: [] };
const REGIME = { riskOn: true, bearish: false, riskOff: false, label: 'risk-on' };

test('full pipeline produces decomposed, shadow-flagged candidates with OMEGA-sourced timing', async () => {
  const asOf = syntheticCandles(90, 0)[85].date;
  const asm = await GL.assembleCandidates({ events: EVENTS, cps: CPS, regionState: {}, regime: REGIME, today: asOf });
  assert.ok(asm.candidates.length >= 2, 'merchant/IPP beneficiaries expected from a capacity-auction event');
  const c = asm.candidates[0];
  assert.strictEqual(c.shadow, true);
  assert.strictEqual(c.deploymentWeight, 0);
  assert.strictEqual(c.probability, null);
  assert.ok(c.causalChain && c.causalChain.invalidatingEvidence.length >= 3);
  assert.ok(c.score && c.score.components && c.score.weights, 'decomposed score');
  assert.strictEqual(c.score.probability, null);
  assert.ok(c.notYetRepriced, 'NYR attached');
  assert.ok(c.tape && c.tape.coverage, 'tape read from stubbed candles');
  if (c.timing) {
    assert.match(c.timing.source, /omega-swing/);
    assert.ok(c.timing.stop != null && c.timing.target != null, 'levels come from OMEGA');
  }
  assert.ok(c.gate && typeof c.gate.status === 'string', 'gate always explains itself');
  // Rejections are recorded, not discarded.
  assert.ok(Array.isArray(asm.recorded));
  // Fan-out stayed within the declared budgets.
  assert.ok(asm.tapeFetches <= 8 && asm.omegaEvals <= 6);
});

test('candidates for a shadow module never claim eligibility for the live portfolio', async () => {
  const asOf = syntheticCandles(90, 0)[85].date;
  const asm = await GL.assembleCandidates({ events: EVENTS, cps: CPS, regionState: {}, regime: REGIME, today: asOf });
  for (const c of asm.candidates) {
    assert.strictEqual(c.portfolioEligible, false);
    assert.strictEqual(c.affectsLiveRank, false);
    assert.strictEqual(c.governanceStatus, 'paper');
  }
});
