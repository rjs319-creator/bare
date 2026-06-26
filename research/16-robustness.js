'use strict';
// Step 16 — the make-or-break rigor on the sweep's challengers vs the 12-1 prior.
//   node research/16-robustness.js
//
// (A) SUB-PERIOD stability: split the 48 months into 3 blocks; does each candidate's edge
//     persist in ALL blocks, or is it concentrated in the 2023-25 recovery?
// (B) PURGED WALK-FORWARD: an ADAPTIVE optimizer that each quarter picks the best lookback
//     on the (embargoed) past must BEAT static 12-1 out-of-sample — else the sweep is just
//     overfitting and we keep the prior. This is the honest "does optimization add value" test.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const RT_COST = 0.005, FRAC = 0.2, FWD = 'f63', DL = 'd63', STEP = 3, PPY = 4, EMBARGO = 3;
const CANDS = ['m61', 'm91', 'm121', 'm181', 'm63', 'm93', 'm122', 'ra'];

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rk(xs), ry = rk(ys), m = (n - 1) / 2; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; nu += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? nu / Math.sqrt(dx * dy) : null; }

// EW top-quintile long-only return for one cross-section + the IC
function periodLong(rows, sig) {
  const v = rows.filter(r => r[sig] != null && r[FWD] != null && r[DL] === 0);
  if (v.length < 40) return null;
  const ic = spearman(v.map(r => r[sig]), v.map(r => r[FWD]));
  const ord = [...v].sort((a, b) => a[sig] - b[sig]); const k = Math.max(1, Math.floor(ord.length * FRAC));
  const sel = ord.slice(ord.length - k);
  return { ret: mean(sel.map(r => r[FWD])), bench: mean(v.map(r => r[FWD])), ic, set: new Set(sel.map(r => r.s)) };
}
// quarterly series for a fixed signal over a set of month-indices, phase-averaged, net of cost
function quarterly(panel, months, sig, idxList) {
  const rets = [], act = [], ics = []; let prev = null;
  for (const mi of idxList) { const pl = periodLong(panel[months[mi]], sig); if (!pl) { continue; } if (pl.ic != null) ics.push(pl.ic); let to = 1; if (prev) { let kept = 0; for (const s of pl.set) if (prev.has(s)) kept++; to = 1 - kept / pl.set.size; } rets.push(pl.ret - to * RT_COST); act.push(pl.ret - pl.bench); prev = pl.set; }
  if (rets.length < 4) return null;
  let v = 1; for (const r of rets) v *= 1 + r;
  const annRet = Math.pow(v, PPY / rets.length) - 1; const te = sd(act) * Math.sqrt(PPY);
  return { annRet, sharpe: sd(rets) ? annRet / (sd(rets) * Math.sqrt(PPY)) : null, ir: te ? mean(act) * PPY / te : null, icMean: mean(ics), n: rets.length };
}

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const allIdx = months.map((_, i) => i);
  const f = (x, n = 2) => x == null ? ' n/a' : x.toFixed(n).padStart(5);
  const p = x => x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%';

  // ---------- (A) SUB-PERIOD STABILITY ----------
  console.log('=== (A) SUB-PERIOD STABILITY — quarterly EW-Q5, phase-averaged, 3 blocks ===\n');
  const B = 3, blk = Math.ceil(months.length / B);
  const blocks = []; for (let b = 0; b < B; b++) blocks.push(allIdx.slice(b * blk, (b + 1) * blk));
  console.log(`blocks: ${blocks.map((bi, i) => `B${i + 1} ${months[bi[0]]}..${months[bi.at(-1)]}`).join('   ')}\n`);
  console.log('signal   ' + blocks.map((_, i) => `B${i + 1}-IR  B${i + 1}-IC `).join(' ') + '  allPosIR');
  for (const sig of CANDS) {
    const cells = blocks.map(bi => { const phs = [0, 1, 2].map(o => quarterly(panel, months, sig, bi.filter(mi => mi % STEP === o))).filter(Boolean); return phs.length ? { ir: mean(phs.map(x => x.ir)), ic: mean(phs.map(x => x.icMean)) } : null; });
    const allPos = cells.every(c => c && c.ir > 0);
    console.log(`${sig.padEnd(7)} ` + cells.map(c => `${f(c?.ir)} ${f(c?.ic, 3)}`).join('  ') + `   ${allPos ? 'YES' : 'no'}`);
  }

  // ---------- (B) PURGED WALK-FORWARD: adaptive pick vs static 12-1 ----------
  console.log('\n=== (B) PURGED WALK-FORWARD — adaptive best-lookback vs static 12-1 (OOS) ===\n');
  const qIdx = allIdx.filter(i => i % STEP === 0);          // phase-0 quarterly grid
  const TRAIN_MIN = 8;                                       // need >=8 quarters of history to pick
  const adaptRets = [], staticRets = [], picks = [];
  for (let qi = 0; qi < qIdx.length; qi++) {
    const mi = qIdx[qi];
    const trainMonths = allIdx.filter(j => j <= mi - EMBARGO);   // embargo: drop the overlapping run-up
    if (qi < TRAIN_MIN) continue;
    // pick the lookback with the best historical IC on embargoed training months
    let best = null, bestIc = -Infinity;
    for (const sig of CANDS) { const ics = trainMonths.map(j => { const pl = periodLong(panel[months[j]], sig); return pl ? pl.ic : null; }).filter(x => x != null); const m = mean(ics); if (m != null && m > bestIc) { bestIc = m; best = sig; } }
    const oosAdapt = periodLong(panel[months[mi]], best), oosStatic = periodLong(panel[months[mi]], 'm121');
    if (!oosAdapt || !oosStatic) continue;
    adaptRets.push(oosAdapt.ret - oosAdapt.bench); staticRets.push(oosStatic.ret - oosStatic.bench); picks.push(best);
  }
  const summ = (a) => ({ mean: mean(a), t: sd(a) ? mean(a) / sd(a) * Math.sqrt(a.length) : null, n: a.length });
  const A = summ(adaptRets), S = summ(staticRets);
  console.log(`OOS quarters: ${A.n}   (train>=${TRAIN_MIN} quarters, ${EMBARGO}-month embargo)`);
  console.log(`adaptive (pick best IC):  mean excess/qtr ${p(A.mean)}   t ${f(A.t)}`);
  console.log(`static 12-1:              mean excess/qtr ${p(S.mean)}   t ${f(S.t)}`);
  console.log(`adaptive − static:        ${p(A.mean - S.mean)} /qtr  → optimization ${A.mean > S.mean ? 'ADDS' : 'DESTROYS'} value OOS`);
  console.log(`picks over time: ${picks.join(' ')}`);
  console.log('\nHALE READ: if adaptive does NOT beat static 12-1 OOS, the sweep winners are overfit —');
  console.log('keep the prior-backed 12-1. If sub-period IR is positive in ALL blocks only for 12-1, that confirms it.');
})();
