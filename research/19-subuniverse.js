'use strict';
// Step 19 — WHERE does 12-1 (sector-neutral) momentum concentrate? Slice the universe and
// measure the book within each slice.  node research/19-subuniverse.js
//
// Slices: market-cap bands, ADV bands, sectors, within-month vol tercile, name-level trend
// (12-1>0), recent-return half. Each: quarterly EW top-quintile, SECTOR-NEUTRAL score,
// phase-averaged, 50bps, vs the SLICE'S OWN benchmark (so IR = selection skill inside the
// slice, not the slice's beta — slice beta reported separately). HALE: small slices => tiny
// books => noisy; min-size guards + flags; treat every slice as a fresh multiple test.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const FRAC = 0.2, FWD = 'f63', DL = 'd63', STEP = 3, PPY = 4, COST = 0.005;
const MIN_SLICE = 50, MIN_BOOK = 12;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rk(xs), ry = rk(ys), m = (n - 1) / 2; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; nu += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? nu / Math.sqrt(dx * dy) : null; }

// within-slice sector-neutral 12-1 book for one cross-section (rows already sliced)
function bookOf(rows) {
  const ok = rows.filter(r => r[FWD] != null && r[DL] === 0 && r.m121 != null);
  if (ok.length < MIN_SLICE) return null;
  const bs = {}; for (const r of ok) (bs[r.sec] || (bs[r.sec] = [])).push(r.m121);
  const md = {}; for (const s in bs) md[s] = median(bs[s]);
  const score = r => r.m121 - md[r.sec];
  const ic = spearman(ok.map(score), ok.map(r => r[FWD]));
  const ord = [...ok].sort((a, b) => score(a) - score(b)); const k = Math.max(1, Math.floor(ok.length * FRAC));
  const sel = ord.slice(ord.length - k);
  return { ret: mean(sel.map(r => r[FWD])), bench: mean(ok.map(r => r[FWD])), ic, set: new Set(sel.map(r => r.s)), book: sel.length, pool: ok.length };
}
function phaseSeries(panel, months, sliceFn, offset) {
  const idx = months.map((_, i) => i).filter(i => i % STEP === offset);
  const rets = [], excess = [], turns = [], ics = [], books = [], pools = [], benchs = []; let prev = null;
  for (const mi of idx) {
    const b = bookOf(sliceFn(panel[months[mi]])); if (!b || b.book < MIN_BOOK) continue;
    let to = 1; if (prev) { let kept = 0; for (const s of b.set) if (prev.has(s)) kept++; to = 1 - kept / b.set.size; }
    rets.push(b.ret - to * COST); excess.push(b.ret - b.bench); turns.push(to); if (b.ic != null) ics.push(b.ic); books.push(b.book); pools.push(b.pool); benchs.push(b.bench); prev = b.set;
  }
  if (rets.length < 8) return null;
  let v = 1, eq = []; for (const r of rets) { v *= 1 + r; eq.push(v); }
  const annRet = Math.pow(v, PPY / rets.length) - 1, annVol = sd(rets) * Math.sqrt(PPY);
  let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); }
  const te = sd(excess) * Math.sqrt(PPY);
  let bv = 1; for (const x of benchs) bv *= 1 + x; const benchAnn = Math.pow(bv, PPY / benchs.length) - 1;
  return { annRet, sharpe: annVol ? annRet / annVol : null, mdd, ir: te ? mean(excess) * PPY / te : null, turnYr: mean(turns) * PPY, win: excess.filter(e => e > 0).length / excess.length, icMean: mean(ics), book: mean(books), pool: mean(pools), benchAnn, nP: rets.length };
}
function evalSlice(panel, months, sliceFn) {
  const ph = [0, 1, 2].map(o => phaseSeries(panel, months, sliceFn, o)).filter(Boolean);
  if (!ph.length) return null; const a = k => mean(ph.map(x => x[k]));
  return { annRet: a('annRet'), sharpe: a('sharpe'), mdd: a('mdd'), ir: a('ir'), turnYr: a('turnYr'), win: a('win'), icMean: a('icMean'), book: a('book'), pool: a('pool'), benchAnn: a('benchAnn') };
}

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  // within-month tercile helper
  const tercile = (rows, key, which) => { const vals = rows.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b); if (vals.length < 30) return []; const lo = vals[Math.floor(vals.length / 3)], hi = vals[Math.floor(2 * vals.length / 3)]; return rows.filter(r => r[key] != null && (which === 'lo' ? r[key] <= lo : which === 'hi' ? r[key] >= hi : r[key] > lo && r[key] < hi)); };
  const half = (rows, key, top) => { const vals = rows.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b); if (vals.length < 30) return []; const med = vals[Math.floor(vals.length / 2)]; return rows.filter(r => r[key] != null && (top ? r[key] >= med : r[key] < med)); };

  const SLICES = [
    ['FULL (all)', r => r],
    ['cap 300-800M', r => r.filter(x => x.cap >= 300e6 && x.cap < 800e6)],
    ['cap 800M-2B', r => r.filter(x => x.cap >= 800e6 && x.cap < 2e9)],
    ['cap 2-5B', r => r.filter(x => x.cap >= 2e9 && x.cap < 5e9)],
    ['cap 5-10B', r => r.filter(x => x.cap >= 5e9 && x.cap <= 10e9)],
    ['adv 3-10M', r => r.filter(x => x.adv >= 3e6 && x.adv < 10e6)],
    ['adv 10-30M', r => r.filter(x => x.adv >= 10e6 && x.adv < 30e6)],
    ['adv 30M+', r => r.filter(x => x.adv >= 30e6)],
    ['sec Healthcare', r => r.filter(x => x.sec === 'Healthcare')],
    ['sec Technology', r => r.filter(x => x.sec === 'Technology')],
    ['sec Industrials', r => r.filter(x => x.sec === 'Industrials')],
    ['sec ConsumerCyc', r => r.filter(x => x.sec === 'Consumer Cyclical')],
    ['sec Financials', r => r.filter(x => x.sec === 'Financial Services')],
    ['sec Energy', r => r.filter(x => x.sec === 'Energy')],
    ['vol LOW tercile', r => tercile(r, 'v63', 'lo')],
    ['vol MID tercile', r => tercile(r, 'v63', 'mid')],
    ['vol HIGH tercile', r => tercile(r, 'v63', 'hi')],
    ['trend UP (12-1>0)', r => r.filter(x => x.m121 != null && x.m121 > 0)],
    ['trend DOWN (12-1<=0)', r => r.filter(x => x.m121 != null && x.m121 <= 0)],
    ['recent-1mo WINNERS', r => half(r, 'r21', true)],
    ['recent-1mo LOSERS', r => half(r, 'r21', false)],
  ];

  const f = (x, n = 2) => x == null ? '  n/a' : x.toFixed(n).padStart(6);
  const p = x => x == null ? '   n/a' : (x * 100).toFixed(1).padStart(6) + '%';
  console.log('=== SUB-UNIVERSE ANALYSIS — sector-neutral 12-1, quarterly EW-Q5, phase-avg, 50bps ===');
  console.log('(IR = selection skill vs the slice\'s OWN benchmark; bench = slice passive return)\n');
  console.log('slice                   annRet  Sharpe    IR    maxDD   turn/yr  win%   IC    book  pool   bench   flag');
  const rows = [];
  for (const [nm, fn] of SLICES) {
    const m = evalSlice(panel, months, fn); if (!m) { console.log(`${nm.padEnd(22)}  (insufficient periods/size)`); continue; }
    rows.push({ nm, ...m });
    const flag = m.book < 20 ? 'THIN' : '';
    console.log(`${nm.padEnd(22)} ${p(m.annRet)}  ${f(m.sharpe)}  ${f(m.ir)}  ${p(m.mdd)}  ${p(m.turnYr)}  ${(m.win * 100).toFixed(0).padStart(3)}  ${f(m.icMean, 3)}  ${String(Math.round(m.book)).padStart(4)} ${String(Math.round(m.pool)).padStart(5)}  ${p(m.benchAnn)}  ${flag}`);
  }
  const full = rows.find(r => r.nm.startsWith('FULL'));
  console.log(`\nFULL-universe reference: IR ${f(full.ir)}  Sharpe ${f(full.sharpe)}  book ${Math.round(full.book)}`);
  console.log('Top slices by IR:'); rows.filter(r => !r.nm.startsWith('FULL')).sort((a, b) => b.ir - a.ir).slice(0, 5).forEach(r => console.log(`  ${r.nm.padEnd(22)} IR ${f(r.ir)} Sharpe ${f(r.sharpe)} book ${Math.round(r.book)} ${r.book < 20 ? '(THIN—suspect)' : ''}`));
  fs.writeFileSync(path.join(DATA, 'subuniverse.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 0));
  console.log('\nHALE: any THIN-book slice IR is noise until proven on sub-periods. Real pockets = decent book + economic sense + stable.');
})();
