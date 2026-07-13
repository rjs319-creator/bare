'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/evolve-routes');

// A minimal op=today-shaped payload (enriched signals bucketed by decision horizon).
function todayPayload() {
  const mk = (t, horizon, over = {}) => ({
    ticker: t, company: t + ' Inc', horizon, side: 'long',
    sources: over.sources || ['screener', 'ghost'], source: 'screener',
    price: 100, entry: 100, stop: 95, target: 115,
    liquidity: { dollarVol: over.dollarVol ?? 5e7 }, execution: { quality: over.q ?? 1 },
    percentile: 80, state: over.state || 'ready', sector: over.sector || 'Technology',
    evidenceFamilies: ['priceTrend', 'volumeAccum'], evidence: { familyCount: 2 },
    ...over,
  });
  return {
    regime: { riskOn: true, bearish: false },
    horizons: {
      intraday: [mk('FAST1', 'intraday')],
      swing: [mk('SW1', 'swing'), mk('SW2', 'swing', { q: 0.3, dollarVol: 1e5 })],
      position: [mk('POS1', 'position')],
      portfolio: [],
    },
  };
}

test('collectSignals flattens horizons + maps to EVOLVE horizons + attaches slippage', () => {
  const sigs = R.collectSignals(todayPayload());
  assert.strictEqual(sigs.length, 4);
  const sw = sigs.find(s => s.ticker === 'SW1');
  assert.strictEqual(sw.evolveHorizon, 'swing');
  assert.ok(sw.liquidity.slippageEst > 0);
  assert.strictEqual(sigs.find(s => s.ticker === 'FAST1').evolveHorizon, 'fast');
});

test('buildEvolvePayload: cold ledger surfaces no TRADE_CANDIDATE (honest cold-start)', () => {
  const sigs = R.collectSignals(todayPayload());
  const out = R.buildEvolvePayload(sigs, { regime: { riskOn: true }, perf: null, model: null });
  assert.strictEqual(out.counts.trade, 0);         // nothing validated yet
  assert.ok(out.byHorizon.fast && out.byHorizon.swing && out.byHorizon.position);
  assert.ok(out.modelHealth.resolvedSamples === 0);
});

test('buildEvolvePayload: risk-off vetoes longs → all abstain', () => {
  const sigs = R.collectSignals({ ...todayPayload(), regime: { bearish: true, riskOn: false } });
  const out = R.buildEvolvePayload(sigs, { regime: { bearish: true, riskOn: false }, perf: null, model: null });
  assert.strictEqual(out.counts.trade, 0);
  const allCards = [...out.byHorizon.fast, ...out.byHorizon.swing, ...out.byHorizon.position];
  assert.ok(allCards.every(c => c.decision !== 'TRADE_CANDIDATE'));
});

test('buildEvolvePayload: strong ledger in risk-on promotes a TRADE with reasons + why-now', () => {
  const perf = { n: 300, bySpecialist: {
    momentumIgnition: { global: { wins: 150, n: 200 }, byContext: { 'risk-on|large|swing': { wins: 45, n: 60 } } },
    quietAccumulation: { global: { wins: 120, n: 200 }, byContext: { 'risk-on|large|swing': { wins: 40, n: 60 } } },
  } };
  const sigs = R.collectSignals(todayPayload());
  const out = R.buildEvolvePayload(sigs, { regime: { riskOn: true }, regimeVector: { label: 'risk-on', dims: {} }, perf });
  const trade = out.byHorizon.swing.find(c => c.decision === 'TRADE_CANDIDATE');
  assert.ok(trade, 'a trade candidate surfaced');
  assert.ok(trade.reasons.length >= 1 && trade.whyNow.includes('%'));
  assert.ok(trade.primaryRisk && trade.sampleSupport.effN > 0);
});

test('recomputePerf aggregates global + context + drift from resolved labels', () => {
  const resolved = {};
  for (let i = 0; i < 30; i++) {
    resolved['d' + i] = {
      ticker: 'T' + i, predDate: '2026-01-0' + (i % 9 + 1), horizon: 'swing', contextKey: 'risk-on|large|swing',
      specialists: ['momentumIgnition'], contribs: [{ specialist: 'momentumIgnition', p: 0.55 }],
      probability: 0.55, decision: 'TRADE_CANDIDATE', won: i % 3 !== 0, terminalReturn: i % 3 !== 0 ? 0.1 : -0.05,
    };
  }
  const perf = R.recomputePerf(resolved);
  const m = perf.bySpecialist.momentumIgnition;
  assert.strictEqual(m.global.n, 30);
  assert.ok(m.byContext['risk-on|large|swing'].n === 30);
  assert.ok(m.recent && typeof m.recent.hit === 'number');
});

test('regimeSupportFor counts in-regime samples across specialists', () => {
  const perf = { bySpecialist: { a: { byContext: { 'risk-on|large|swing': { n: 20 }, 'risk-off|large|swing': { n: 5 } } } } };
  assert.strictEqual(R.regimeSupportFor(perf, 'risk-on').samples, 20);
  assert.strictEqual(R.regimeSupportFor(perf, 'risk-off').samples, 5);
});

test('etfForSector normalizes GICS names', () => {
  assert.strictEqual(R.etfForSector('Technology'), 'XLK');
  assert.strictEqual(R.etfForSector('Health Care'), 'XLV');
  assert.strictEqual(R.etfForSector('Communication Services'), 'XLC');
  assert.strictEqual(R.etfForSector('Nonsense'), null);
});
