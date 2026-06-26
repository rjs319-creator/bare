'use strict';
// Step 15 — exhaustive pure-momentum parameter sweep on the PIT feature panel.
//   node research/15-sweep.js
//
// 8 signals x 3 rebalance x 3 selection x 3 weighting = 216 variants. Each: build the
// long book per rebalance period, net-of-cost periodic returns, vs EW-all benchmark.
// Metrics: annRet/vol/Sharpe/maxDD, IR, turnover, IC+t. Ranked by a composite robustness
// score. Baseline (EW-Q5 12-1 quarterly) is recomputed in the SAME engine for a fair row.
// HALE NOTE: 216 variants on ~15 quarters => brutal multiple testing; deflate everything.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const RT_COST = 0.005;                                // 50bps round-trip incl. slippage cushion

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? num / Math.sqrt(dx * dy) : null; }

const SIGNALS = ['m61', 'm91', 'm121', 'm181', 'm63', 'm93', 'm122', 'ra'];
// Semi-annual DROPPED: ~8 periods on 5y => Sharpe/maxDD uninterpretable. Quarterly phase-averaged.
const REBAL = { monthly: { step: 1, fwd: 'f21', dl: 'd21', ppy: 12, phases: [0] }, quarterly: { step: 3, fwd: 'f63', dl: 'd63', ppy: 4, phases: [0, 1, 2] } };
const SELECT = { q5: 0.2, dec: 0.1, t30: 0.3 };
const WEIGHT = ['ew', 'score', 'invvol'];
const MIN_PERIODS = 12;                               // reject anything thinner than this

// build the long book for one period; returns {ret, weights Map}
function book(rows, sig, frac, wmode) {
  const valid = rows.filter(r => r[sig] != null && (wmode !== 'invvol' || (r.v63 > 0)));
  if (valid.length < 25) return null;
  const ord = [...valid].sort((a, b) => a[sig] - b[sig]);
  const k = Math.max(1, Math.floor(ord.length * frac));
  const sel = ord.slice(ord.length - k);             // top frac by signal
  let w;
  if (wmode === 'ew') w = sel.map(() => 1 / sel.length);
  else if (wmode === 'invvol') { const iv = sel.map(r => 1 / r.v63); const s = iv.reduce((a, b) => a + b, 0); w = iv.map(x => x / s); }
  else { const tot = (k * (k + 1)) / 2; w = sel.map((_, i) => (i + 1) / tot); } // rank-score: higher signal => higher weight
  return { sel, w };
}

// one phase (offset) of a rebalance schedule
function onePhase(panel, months, sig, rb, frac, wmode, offset) {
  const idxs = months.map((_, i) => i).filter(i => i % rb.step === offset);
  const rets = [], bench = [], ics = []; let prevW = new Map(), turns = [];
  for (const mi of idxs) {
    const rows = panel[months[mi]].filter(r => r[rb.fwd] != null && r[rb.dl] === 0); // clean fwd (matches baseline)
    if (rows.length < 40) continue;
    bench.push(mean(rows.map(r => r[rb.fwd])));
    const sv = rows.filter(r => r[sig] != null);
    const ic = spearman(sv.map(r => r[sig]), sv.map(r => r[rb.fwd])); if (ic != null) ics.push(ic);
    const bk = book(rows, sig, frac, wmode); if (!bk) continue;
    const curW = new Map(bk.sel.map((r, i) => [r.s, bk.w[i]]));
    let to = 0; const keys = new Set([...curW.keys(), ...prevW.keys()]); for (const kk of keys) to += Math.abs((curW.get(kk) || 0) - (prevW.get(kk) || 0)); to /= 2; turns.push(to);
    const gross = bk.sel.reduce((s, r, i) => s + bk.w[i] * r[rb.fwd], 0);
    rets.push(gross - to * RT_COST); prevW = curW;
  }
  if (rets.length < MIN_PERIODS) return null;
  let v = 1, eq = []; for (const r of rets) { v *= (1 + r); eq.push(v); }
  const annRet = Math.pow(v, rb.ppy / rets.length) - 1, annVol = sd(rets) * Math.sqrt(rb.ppy);
  let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); }
  const act = rets.map((r, i) => r - bench[i]); const te = sd(act) * Math.sqrt(rb.ppy); const ir = te ? mean(act) * rb.ppy / te : null;
  return { annRet, annVol, sharpe: annVol ? annRet / annVol : null, mdd, ir, turnYr: (mean(turns) || 0) * rb.ppy, icMean: mean(ics), icSd: sd(ics), nIc: ics.length, nP: rets.length };
}

// average across all phase offsets (phase-luck control); IC t-stat pooled across phases
function evaluate(panel, months, sig, rbName, frac, wmode) {
  const rb = REBAL[rbName];
  const ph = rb.phases.map(o => onePhase(panel, months, sig, rb, frac, wmode, o)).filter(Boolean);
  if (!ph.length) return null;
  const avg = k => mean(ph.map(x => x[k]));
  const icMean = avg('icMean'), nIc = ph.reduce((s, x) => s + x.nIc, 0), icSdP = mean(ph.map(x => x.icSd));
  const icT = icSdP ? icMean / icSdP * Math.sqrt(nIc / ph.length) : null;   // pooled t on avg per-phase obs
  const sharpe = avg('sharpe'), mdd = avg('mdd'), turnYr = avg('turnYr');
  const crs = (sharpe || 0) * (1 - Math.min(turnYr / 3, 1) * 0.3) * (1 - Math.min(Math.abs(mdd) / 0.4, 1) * 0.3);
  return { annRet: avg('annRet'), annVol: avg('annVol'), sharpe, mdd, ir: avg('ir'), turnYr, icMean, icT, crs, nP: ph[0].nP, nPhase: ph.length };
}

(async () => {
  const P = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const { months, panel } = P;
  const results = [];
  for (const sig of SIGNALS) for (const rb of Object.keys(REBAL)) for (const [sn, frac] of Object.entries(SELECT)) for (const wmode of WEIGHT) {
    const m = evaluate(panel, months, sig, rb, frac, wmode); if (!m) continue;
    results.push({ id: `${sig}/${rb}/${sn}/${wmode}`, sig, rb, sel: sn, w: wmode, ...m });
  }
  results.sort((a, b) => b.crs - a.crs);
  const f = (x, n = 2) => x == null ? 'n/a' : x.toFixed(n);
  const p = x => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
  const baseId = 'm121/quarterly/q5/ew';
  const hdr = 'rank  variant                         annRet  Sharpe   IR    maxDD   turn/yr  IC    ICt   CRS';
  const fmt = (r, i) => `${String(i).padStart(3)}  ${r.id.padEnd(30)} ${p(r.annRet).padStart(6)}  ${f(r.sharpe).padStart(5)}  ${f(r.ir).padStart(5)}  ${p(r.mdd).padStart(6)}  ${p(r.turnYr).padStart(6)}  ${f(r.icMean, 3).padStart(5)} ${f(r.icT).padStart(4)}  ${f(r.crs).padStart(5)}`;
  console.log(`\n=== MOMENTUM SWEEP LEADERBOARD  (${results.length} valid variants, ${months.length} months, 50bps) ===\n`);
  console.log(hdr);
  results.slice(0, 25).forEach((r, i) => console.log(fmt(r, i + 1)));
  const bRank = results.findIndex(r => r.id === baseId);
  console.log('\n--- BASELINE ---');
  console.log(hdr);
  console.log(fmt(results[bRank], bRank + 1));
  fs.writeFileSync(path.join(DATA, 'sweep.json'), JSON.stringify({ generatedAt: new Date().toISOString(), nVariants: results.length, baseId, results }, null, 0));
  console.log(`\nSaved full leaderboard → data/sweep.json. (Deflation + WFO + sub-period come next; these are IN-SAMPLE.)`);
})();
