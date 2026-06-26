'use strict';
// Resolution harness — proves the outcome-resolution + performance pipeline by logging
// BACKDATED cohorts (where real forward data exists) and resolving them, then running the
// SAME aggregatePerformance() the Core Performance tab uses. The live tab reads 0 resolved
// today only because its cohort is 0 days old — this shows the machinery on real outcomes.
//   node research/23-resolution-harness.js
//
// Each cohort: build the book as-of month T with the live engine, take the real 63-session
// forward return (panel f63) as the realized time-hold return, mark outcomes, aggregate, and
// compare to the equal-weight small/mid universe (the passive benchmark for this sleeve).

const fs = require('fs');
const path = require('path');
const core = require('../lib/stablecore');

const DATA = path.join(__dirname, 'data');
const COHORTS = ['2025-06', '2025-09', '2025-12'];   // quarters with full 63-session forward data
const toFeat = r => ({ symbol: r.s, sector: r.sec, marketCap: r.cap, m121: r.m121, vol63: r.v63, adv20: r.adv, price: 10 });
const qLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${y}Q${Math.floor((m - 1) / 3) + 1}`; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

(async () => {
  const P = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const signals = [], resolved = {};
  const benchByQ = {};
  let held = new Set();

  for (const T of COHORTS) {
    const rows = P.panel[T]; if (!rows) { console.error('missing', T); continue; }
    const fwdOf = new Map(rows.map(r => [r.s, r.f63]));         // real 63-session forward return
    const { book } = core.buildBook(rows.map(toFeat), held);
    const q = qLabel(T);
    let resolvedN = 0;
    for (const x of book) {
      const f = fwdOf.get(x.ticker);
      signals.push({ quarter: q, date: T, ticker: x.ticker });
      if (f != null) { resolved[`${x.ticker}|${T}`] = { outcome: 'EXPIRED', r: f }; resolvedN++; }  // time-hold exit
    }
    // passive benchmark = equal-weight 63-session return of the whole in-band universe that month
    benchByQ[q] = mean(rows.map(r => r.f63).filter(v => v != null));
    held = new Set(book.map(x => x.ticker));
    console.log(`cohort ${T} (${q}): book ${book.length}, resolved ${resolvedN}`);
  }

  // run the ACTUAL tab aggregation on the resolved cohorts
  const perf = core.aggregatePerformance(signals, resolved, null, 63);
  const pct = x => x == null ? '   —' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

  console.log(`\n=== RESOLVED QUARTERLY PERFORMANCE (real forward data) ===\n`);
  console.log('quarter   n   resolved   winRate   strat ret   universe(EW)   excess   status');
  let cumS = 1, cumB = 1;
  for (const q of perf.quarters) {
    const b = benchByQ[q.quarter];
    if (q.meanReturn != null) cumS *= 1 + q.meanReturn;
    if (b != null) cumB *= 1 + b;
    const ex = (q.meanReturn != null && b != null) ? q.meanReturn - b : null;
    console.log(`${q.quarter}   ${String(q.n).padStart(3)}    ${String(q.resolved).padStart(4)}     ${q.winRate == null ? ' — ' : (q.winRate * 100).toFixed(0) + '%'}     ${pct(q.meanReturn).padStart(8)}     ${pct(b).padStart(8)}    ${pct(ex).padStart(7)}   ${q.status}`);
  }
  console.log(`\nCUMULATIVE (realized): strategy ${pct(cumS - 1)}  ·  universe ${pct(cumB - 1)}  ·  excess ${pct((cumS - cumB))}`);
  console.log(`TOTALS: ${perf.totals.signals} signals · ${perf.totals.resolved} resolved · win rate ${(perf.totals.winRate * 100).toFixed(0)}% · mean/trade ${pct(perf.totals.meanReturn)}`);

  const okResolve = perf.totals.resolved > 0, okAgg = perf.quarters.every(q => q.status === 'closed'), okCum = perf.cumulative.strategyReturn != null;
  console.log(`\nVALIDATION: outcomes resolved ${okResolve ? '✅' : '❌'} · quarters aggregated ${okAgg ? '✅' : '❌'} · cumulative computed ${okCum ? '✅' : '❌'}`);
  console.log('(This is the exact aggregatePerformance() the Core Performance tab runs — proving the pipeline on real resolved outcomes.)');
})();
