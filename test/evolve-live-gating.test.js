'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');
const R = require('../lib/evolve-routes');

const base = { p: 0.6, payoff: 0.05, effN: 50, threshold: 0.35, regimeVeto: false, dataOk: true, liquidityOk: true, exploreSelected: false };

test('decideState: dsrVeto downgrades a would-be TRADE to WATCH (not ABSTAIN)', () => {
  assert.strictEqual(E.decideState({ ...base }).state, 'TRADE_CANDIDATE');
  const vetoed = E.decideState({ ...base, dsrVeto: true });
  assert.strictEqual(vetoed.state, 'WATCH');
  assert.match(vetoed.reason, /multiple-testing/);
});

test('decideState: regime veto still takes precedence over the dsr gate', () => {
  assert.strictEqual(E.decideState({ ...base, regimeVeto: true, dsrVeto: true }).state, 'ABSTAIN');
});

// A candidate whose specialist/context has ample resolved support and clears the edge.
function tradeReadySigAndCtx(dsrSurvivors) {
  const sig = { ticker: 'AAA', price: 50, horizon: 'swing', evolveHorizon: 'swing', side: 'long',
    sources: ['screener'], liquidity: { dollarVol: 5e7 }, execution: { quality: 1 } };
  const ctx = {
    regime: { riskOn: true, bearish: false, label: 'risk-on' },
    perfBySpecialist: { momentumIgnition: { global: { wins: 72, n: 100 }, byContext: { 'risk-on|large|swing': { wins: 20, n: 25 } }, recent: {} } },
    priorP: 0.4, dsrSurvivors,
  };
  return { sig, ctx };
}

test('scoreCandidate: no survivors list ⇒ gate inactive ⇒ TRADE_CANDIDATE', () => {
  const { sig, ctx } = tradeReadySigAndCtx(null);
  const r = E.scoreCandidate(sig, ctx);
  assert.strictEqual(r.dsrVeto, false);
  assert.strictEqual(r.decision, 'TRADE_CANDIDATE');
});

test('scoreCandidate: empty survivors ⇒ cell not proven ⇒ downgraded to WATCH', () => {
  const { sig, ctx } = tradeReadySigAndCtx([]);
  const r = E.scoreCandidate(sig, ctx);
  assert.strictEqual(r.dsrVeto, true);
  assert.strictEqual(r.decision, 'WATCH');
});

test('scoreCandidate: matching survivor cell ⇒ TRADE_CANDIDATE restored', () => {
  const { sig, ctx } = tradeReadySigAndCtx(['momentumIgnition|risk-on|swing']);
  const r = E.scoreCandidate(sig, ctx);
  assert.strictEqual(r.dsrVeto, false);
  assert.strictEqual(r.decision, 'TRADE_CANDIDATE');
});

test('recomputePerf: overlapping same-ticker labels are uniqueness-down-weighted, and DSR survivors stored', () => {
  const resolved = {};
  for (let i = 0; i < 10; i++) {
    resolved['x' + i] = { ticker: 'AAA', predDate: new Date(2025, 0, 1 + i * 5).toISOString().slice(0, 10),
      horizon: 'position', contextKey: 'risk-on|large|position', barsToBarrier: 63,
      specialists: ['momentumIgnition'], contribs: [{ specialist: 'momentumIgnition', p: 0.5 }],
      won: i % 2 === 0, terminalReturn: i % 2 === 0 ? 0.1 : -0.05, spyRelReturn: i % 2 === 0 ? 0.08 : -0.06 };
  }
  const perf = R.recomputePerf(resolved);
  assert.ok(perf.bySpecialist.momentumIgnition.global.n < 10, 'overlapping labels de-duplicated below raw count');
  assert.ok(perf.bySpecialist.momentumIgnition.global.n > 0, 'still positive');
  assert.ok(Array.isArray(perf.dsrSurvivors), 'carries a DSR survivors list for the live gate');
  assert.ok(perf.dsr && typeof perf.dsr.trials === 'number', 'carries a DSR summary');

  // Unweighted opt-out restores raw integer counts.
  const raw = R.recomputePerf(resolved, { weighted: false });
  assert.strictEqual(raw.bySpecialist.momentumIgnition.global.n, 10);
});
