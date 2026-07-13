'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');

test('sourceToSpecialists groups correlated sources into distinct specialists', () => {
  // three momentum screeners = ONE specialist, ghost = another.
  const sp = E.sourceToSpecialists(['screener', 'momentum', 'daytrade', 'ghost']);
  assert.deepStrictEqual(sp.sort(), ['momentumIgnition', 'quietAccumulation']);
});

test('breakevenProb: +8/-4 barrier needs P>1/3', () => {
  assert.ok(Math.abs(E.breakevenProb({ up: 0.08, down: 0.04 }) - 1 / 3) < 1e-6);
});

test('pooledRate: tiny context sample stays near prior; large sample earns its rate', () => {
  const tiny = E.pooledRate({ ctxWins: 3, ctxN: 3, globalWins: 3, globalN: 3, priorP: 0.4 });
  assert.ok(tiny.rate < 0.6, 'a 3/3 fluke does not read as ~1.0');
  const big = E.pooledRate({ ctxWins: 160, ctxN: 200, globalWins: 160, globalN: 200, priorP: 0.4 });
  assert.ok(big.rate > 0.7, 'large sample earns its high rate');
});

test('specialistProb cold-start returns prior with zero effective sample', () => {
  const r = E.specialistProb(undefined, 'risk-on|large|swing', { priorP: 0.4 });
  assert.strictEqual(r.cold, true);
  assert.ok(Math.abs(r.p - 0.4) < 0.05);
  assert.strictEqual(r.effN, 0);
});

test('metaWeights normalize to 1 and penalize BROKEN drift', () => {
  const firing = ['momentumIgnition', 'quietAccumulation'];
  const perfById = {
    momentumIgnition: { global: { n: 200 }, recent: { ic: 0.1 } },
    quietAccumulation: { global: { n: 200 }, recent: { ic: 0.1 } },
  };
  const healthy = E.metaWeights(firing, { perfById });
  assert.ok(Math.abs(healthy.reduce((s, w) => s + w.weight, 0) - 1) < 1e-3);
  const broken = E.metaWeights(firing, { perfById, driftById: { quietAccumulation: 'BROKEN' } });
  const q = broken.find(w => w.specialist === 'quietAccumulation');
  const m = broken.find(w => w.specialist === 'momentumIgnition');
  assert.ok(m.weight > q.weight, 'broken specialist down-weighted');
});

test('ensembleProbability: agreement high when specialists concur', () => {
  const contribs = [{ specialist: 'a', p: 0.6, effN: 50 }, { specialist: 'b', p: 0.62, effN: 50 }];
  const weights = [{ specialist: 'a', weight: 0.5 }, { specialist: 'b', weight: 0.5 }];
  const r = E.ensembleProbability(contribs, weights);
  assert.ok(r.p > 0.6 && r.p < 0.62);
  assert.ok(r.agreement > 0.9);
});

test('expectedPayoff nets out costs and uses barrier geometry', () => {
  const p = 0.5;
  const payoff = E.expectedPayoff(p, { up: 0.15, down: 0.07, slippagePct: 0.2 });
  // 0.5*0.15 - 0.5*0.07 - cost = 0.075-0.035-0.004 = 0.036
  assert.ok(payoff > 0.03 && payoff < 0.04);
});

test('adaptiveThreshold tightens in risk-off vs risk-on', () => {
  const b = { up: 0.15, down: 0.07 };
  const on = E.adaptiveThreshold({ regime: { riskOn: true } }, b);
  const off = E.adaptiveThreshold({ regime: { bearish: true, riskOn: false } }, b);
  assert.ok(off > on, 'risk-off demands a bigger edge');
});

test('decideState: regime veto and data failure force ABSTAIN before any trade', () => {
  const base = { p: 0.9, payoff: 0.1, effN: 100, threshold: 0.4, liquidityOk: true, dataOk: true };
  assert.strictEqual(E.decideState({ ...base, regimeVeto: true }).state, 'ABSTAIN');
  assert.strictEqual(E.decideState({ ...base, dataOk: false }).state, 'ABSTAIN');
  assert.strictEqual(E.decideState({ ...base, regimeVeto: false }).state, 'TRADE_CANDIDATE');
});

test('decideState: cold (no sample) name abstains honestly unless explore-selected → PROBE', () => {
  const cold = { p: 0.6, payoff: 0.05, effN: 0, threshold: 0.4, regimeVeto: false, dataOk: true, liquidityOk: true };
  assert.strictEqual(E.decideState({ ...cold, exploreSelected: true }).state, 'PROBE');
  const d = E.decideState({ ...cold, exploreSelected: false });
  assert.strictEqual(d.state, 'ABSTAIN');            // a bare prior is not a track record
  assert.match(d.reason, /no resolved track record/);
});

test('decideState: promising WITH some sample but below promotion bar → WATCH', () => {
  // effN between watchMinEffN(5) and minEffSample(12): real but insufficient sample.
  const d = E.decideState({ p: 0.6, payoff: 0.05, effN: 8, threshold: 0.4, regimeVeto: false, dataOk: true, liquidityOk: true, exploreSelected: false });
  assert.strictEqual(d.state, 'WATCH');
});

test('fitCalibrator returns null when thin; monotone map when enough', () => {
  assert.strictEqual(E.fitCalibrator([{ p: 0.5, won: true }]), null);
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push({ p: (i % 10) / 10, won: (i % 10) / 10 > Math.random() });
  const cal = E.fitCalibrator(rows);
  assert.ok(cal && cal.table.length === 5);
  for (let i = 1; i < cal.table.length; i++) assert.ok(cal.table[i] >= cal.table[i - 1], 'monotone');
});

test('applyCalibrator interpolates and is identity when no calibrator', () => {
  assert.strictEqual(E.applyCalibrator(null, 0.5), 0.5);
  const cal = { edges: [0.1, 0.3, 0.5, 0.7, 0.9], table: [0.2, 0.3, 0.5, 0.6, 0.8] };
  const out = E.applyCalibrator(cal, 0.4);
  assert.ok(out >= 0.3 && out <= 0.5);
});

// ── Integration: scoreCandidate + buildEvolve ────────────────────────────────
function sig(over = {}) {
  return {
    ticker: over.ticker || 'AAA', horizon: over.horizon || 'swing', side: over.side || 'long',
    sources: over.sources || ['screener', 'ghost'], price: over.price ?? 100,
    liquidity: over.liquidity || { dollarVol: 5e7, slippageEst: 0.1 },
    execution: over.execution || { quality: 1 }, percentile: over.percentile ?? 80,
    state: over.state || 'ready', ...over,
  };
}

test('scoreCandidate: cold ledger + neutral regime → not a TRADE (honest cold-start)', () => {
  const r = E.scoreCandidate(sig(), { regime: { label: 'neutral', riskOn: false, bearish: false }, priorP: 0.4,
    barriersByHorizon: { swing: { up: 0.15, down: 0.07, window: 21 } } });
  assert.notStrictEqual(r.decision, 'TRADE_CANDIDATE');   // no evidence yet → never a validated trade
  assert.ok(['WATCH', 'ABSTAIN'].includes(r.decision));
});

test('scoreCandidate: risk-off vetoes a long to ABSTAIN even with strong ledger', () => {
  const perf = { momentumIgnition: { global: { wins: 160, n: 200 }, byContext: { 'risk-off|large|swing': { wins: 40, n: 50 } } } };
  const r = E.scoreCandidate(sig({ sources: ['screener'] }), {
    regime: { label: 'risk-off', riskOn: false, bearish: true }, perfBySpecialist: perf,
    barriersByHorizon: { swing: { up: 0.15, down: 0.07, window: 21 } } });
  assert.strictEqual(r.decision, 'ABSTAIN');
  assert.ok(r.regimeVeto);
});

test('scoreCandidate: strong ledger in supportive regime → TRADE_CANDIDATE with calibrated edge', () => {
  const perf = { momentumIgnition: {
    global: { wins: 150, n: 200 },
    byContext: { 'risk-on|large|swing': { wins: 45, n: 60 } } } };
  const r = E.scoreCandidate(sig({ sources: ['screener'] }), {
    regime: { label: 'risk-on', riskOn: true, bearish: false }, perfBySpecialist: perf, priorP: 0.4,
    barriersByHorizon: { swing: { up: 0.15, down: 0.07, window: 21 } }, regimeSupport: 0.8 });
  assert.strictEqual(r.decision, 'TRADE_CANDIDATE');
  assert.ok(r.probability > r.breakeven);
  assert.ok(r.edge > 0 && r.expectedPayoff > 0);
});

test('buildEvolve: caps PROBE share and reports abstentions; may surface zero trades', () => {
  const signals = Array.from({ length: 10 }, (_, i) => sig({ ticker: 'T' + i, execution: { quality: 0.3 } })); // illiquid
  const out = E.buildEvolve(signals, { regime: { label: 'neutral' },
    barriersByHorizon: { swing: { up: 0.15, down: 0.07, window: 21 } } });
  assert.ok(out.counts.probe <= Math.ceil(10 * E.GUARDRAILS.maxProbeShare) + 1);
  assert.ok(Array.isArray(out.byHorizon.swing));
  assert.ok('abstained' in out.counts);
});
