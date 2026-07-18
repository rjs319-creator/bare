'use strict';
// VERTICAL-SLICE VALIDATION RUNNER  (research)
//
// Exercises the full research contract end-to-end and writes docs/validation-output.json:
//   synthetic candles → next-open fill (lib/execution-policy) → triple-barrier label
//   (lib/evolve-labels, with exact labelEndDate) → continuous features (lib/research/features)
//   → purged group-aware ranker comparison (lib/research/harness) → ExperimentManifest.
//
// IMPORTANT HONESTY NOTE. The dataset here is SYNTHETIC and DETERMINISTIC. A weak momentum signal
// is deliberately PLANTED so the harness has something to detect — this validates that the PLUMBING
// is causally correct (purge works, parity holds, the random control scores ~0 while a real signal
// scores positive), and is NOT evidence of market alpha. Every result is stamped
// researchValidity.productionGrade=false, survivorshipSafe=false. Real historical data is never
// invented here (Operating rule 8).

const fs = require('fs');
const path = require('path');
const { planFill, POLICIES } = require('../lib/execution-policy');
const L = require('../lib/evolve-labels');
const { computeFeatureVector } = require('../lib/research/features');
const { ALL_RANKERS } = require('../lib/research/baseline-ranker');
const { runExperiment } = require('../lib/research/harness');

// ── deterministic RNG ──
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ── trading-day calendar (skip weekends) ──
function tradingDates(startISO, n) {
  const out = []; const d = new Date(startISO + 'T00:00:00Z');
  while (out.length < n) { const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// ── synthetic price path with PLANTED weak momentum persistence ──
function makeSeries(dates, rnd, { drift = 0.0002, phi = 0.06, vol = 0.015 } = {}) {
  const candles = []; let close = 50 + rnd() * 50;
  const rets = [];
  for (let i = 0; i < dates.length; i++) {
    // trailing 21-day momentum (normalized) feeds forward return → momentum persists (the signal).
    let mom21 = 0;
    if (i >= 21) mom21 = (close - candles[i - 21].close) / candles[i - 21].close;
    const r = drift + phi * Math.tanh(mom21 * 5) * 0.02 + vol * gauss(rnd);
    const prev = close; close = Math.max(1, prev * (1 + r)); rets.push(r);
    const openG = prev * (1 + 0.3 * vol * gauss(rnd));
    const hi = Math.max(openG, close) * (1 + Math.abs(0.4 * vol * gauss(rnd)));
    const lo = Math.min(openG, close) * (1 - Math.abs(0.4 * vol * gauss(rnd)));
    const volume = Math.round(1e6 * (1 + 0.5 * Math.abs(gauss(rnd))));
    candles.push({ date: dates[i], open: +openG.toFixed(4), high: +hi.toFixed(4), low: +lo.toFixed(4), close: +close.toFixed(4), volume });
  }
  return candles;
}

function simpleHash(obj) {
  const s = JSON.stringify(obj); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function main() {
  const SEED = 42, M = 40, T = 500, STEP = 5, HORIZON = 'swing';
  const rnd = lcg(SEED);
  const dates = tradingDates('2019-01-02', T);

  // Benchmark (SPY-like) and its close map.
  const spy = makeSeries(dates, lcg(SEED ^ 0x5a5a), { drift: 0.0003, phi: 0.0, vol: 0.009 });
  const spyCloses = {}; spy.forEach((c) => { spyCloses[c.date] = c.close; });

  const events = [];
  for (let m = 0; m < M; m++) {
    const candles = makeSeries(dates, lcg(SEED + 1 + m), { drift: 0.0002 + (rnd() - 0.5) * 0.0002, phi: 0.06, vol: 0.012 + rnd() * 0.01 });
    const securityId = `SYN${String(m).padStart(3, '0')}`;
    for (let i = 80; i <= T - 80; i += STEP) {
      const decisionTs = candles[i].date;
      // Next-open fill (never the same close) → the label's entry price.
      const fill = planFill(candles, decisionTs, { policy: POLICIES.NEXT_OPEN, side: 'long', tier: 'liquid' });
      if (!fill.filled) continue;
      const label = L.tripleBarrier(L.sliceForward(candles, decisionTs, L.HORIZON_META[HORIZON].window + 5), fill.fillPrice, L.barriersFor(HORIZON, {}));
      if (!label.resolved) continue;
      const feats = computeFeatureVector(candles, i, { benchCloses: spyCloses });
      // Outcome = market-residual terminal return (strip the benchmark move over the same window).
      const spyRet = L.benchmarkReturn(L.sliceForward(spy, decisionTs, L.HORIZON_META[HORIZON].window + 5), L.HORIZON_META[HORIZON].window);
      const outcome = spyRet == null ? label.terminalReturn : label.terminalReturn - spyRet;
      // A deliberately NOISY "production composite" baseline: weak proxy + noise.
      const prodScore = (feats.values.ret5 || 0) * 40 + gauss(rnd) * 5;
      events.push({
        securityId, ticker: securityId, decisionTs, labelEndDate: label.labelEndDate, horizon: HORIZON,
        features: feats.values, outcome: +outcome.toFixed(6), won: label.won, profitable: label.profitable,
        score: +prodScore.toFixed(4),
      });
    }
  }

  const datasetHash = simpleHash(events.map((e) => [e.securityId, e.decisionTs, e.outcome]));
  const out = runExperiment(events, ALL_RANKERS, { folds: 6, embargo: 3, rankerOpts: { lambda: 0.1 } }, {
    experimentId: 'vslice-synthetic-v1',
    experimentFamilyId: 'quant-redesign-vertical-slice',
    datasetHash,
    universePolicy: 'SYNTHETIC deterministic (no real securities)',
    relatedExperimentsAttempted: ALL_RANKERS.length,
    primaryMetric: 'mean-daily-rank-IC (OOS, purged)',
    survivorshipSafe: false,
    survivorshipReason: 'synthetic dataset; also the repo has no PIT constituents (see docs/quant-system-audit.md P0-1)',
    seed: SEED, generatedAt: new Date().toISOString(),
  });

  const payload = {
    __README__: 'SYNTHETIC contract self-test. A weak momentum signal is PLANTED, so positive IC here'
      + ' validates the harness plumbing (purge/parity/discrimination), NOT market alpha. Not production-grade.',
    events: events.length, securities: M, decisionDates: [...new Set(events.map((e) => e.decisionTs))].length,
    ...out,
  };
  const dst = path.join(__dirname, '..', 'docs', 'validation-output.json');
  fs.writeFileSync(dst, JSON.stringify(payload, null, 2));
  console.log('wrote', dst);
  console.log('champion:', JSON.stringify(out.champion));
  console.log('verdict:', out.verdict);
  for (const [k, v] of Object.entries(out.result.perRanker)) console.log(`  ${k.padEnd(24)} meanIC=${v.meanIC}  ci90=${JSON.stringify(v.ci90)}  dates=${v.dates}`);
  console.log('purge exact-vs-1.4x:', JSON.stringify(out.result.purge.vs14xApprox));
}

main();
