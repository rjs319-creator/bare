'use strict';
// Step 18 — full validation of the survivors (sectneu, ra+sect) vs base 12-1.
//   node research/18-validation.js
//
// (1) head-to-head: IR/Sharpe/maxDD/turnover, full sample (phase-averaged)
// (2) regime stress: bear block B1 (2022) + risk-on/off split
// (3) cost sensitivity: 30/50/100 bps
// (4) BLOCK-BOOTSTRAP on the PAIRED quarterly excess-return difference (ra+sect − base):
//     is the improvement distinguishable from zero? (the make-or-break on ~16 quarters)
// (5) deflated significance + capacity note.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const FRAC = 0.2, FWD = 'f63', DL = 'd63', STEP = 3, PPY = 4;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function selectSet(name, rows) {
  const ok = rows.filter(r => r[FWD] != null && r[DL] === 0 && r.m121 != null);
  if (ok.length < 50) return null;
  let pool = ok, scoreOf;
  if (name === 'base') scoreOf = r => r.m121;
  else if (name === 'sectneu') { const bs = {}; for (const r of ok) (bs[r.sec] || (bs[r.sec] = [])).push(r.m121); const md = {}; for (const s in bs) md[s] = median(bs[s]); scoreOf = r => r.m121 - md[r.sec]; }
  else if (name === 'ra+sect') { pool = ok.filter(r => r.ra != null); if (pool.length < 50) return null; const bs = {}; for (const r of pool) (bs[r.sec] || (bs[r.sec] = [])).push(r.ra); const md = {}; for (const s in bs) md[s] = median(bs[s]); scoreOf = r => r.ra - md[r.sec]; }
  const ord = [...pool].sort((a, b) => scoreOf(a) - scoreOf(b)); const k = Math.max(1, Math.floor(ord.length * FRAC));
  const sel = ord.slice(ord.length - k);
  return { sel, k, bench: mean(pool.map(r => r[FWD])), advMin: Math.min(...sel.map(r => r.adv)) };
}
// per-phase quarterly record: returns {gross[], excess[], turn[], bench[], regime[], k[]}
function record(panel, months, name, offset) {
  const idx = months.map((_, i) => i).filter(i => i % STEP === offset);
  const out = { gross: [], excess: [], turn: [], k: [], regime: [] }; let prev = null;
  for (const mi of idx) {
    const s = selectSet(name, panel[months[mi]]); if (!s) continue;
    const g = mean(s.sel.map(r => r[FWD]));
    let to = 1; if (prev) { let kept = 0; const cur = new Set(s.sel.map(r => r.s)); for (const x of cur) if (prev.has(x)) kept++; to = 1 - kept / cur.size; }
    out.gross.push(g); out.excess.push(g - s.bench); out.turn.push(to); out.k.push(s.k); out.regime.push(s.bench >= 0 ? 'on' : 'off');
    prev = new Set(s.sel.map(r => r.s));
  }
  return out;
}
function perf(gross, turn, cost) {
  const net = gross.map((g, i) => g - turn[i] * cost);
  let v = 1, eq = []; for (const r of net) { v *= 1 + r; eq.push(v); }
  const annRet = Math.pow(v, PPY / net.length) - 1, annVol = sd(net) * Math.sqrt(PPY);
  let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); }
  return { annRet, sharpe: annVol ? annRet / annVol : null, mdd, turnYr: mean(turn) * PPY };
}
function irOf(excess) { const te = sd(excess) * Math.sqrt(PPY); return te ? mean(excess) * PPY / te : null; }

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const NAMES = ['base', 'sectneu', 'ra+sect'];
  const recs = {}; for (const nm of NAMES) recs[nm] = [0, 1, 2].map(o => record(panel, months, nm, o));
  const f = (x, n = 2) => x == null ? ' n/a' : x.toFixed(n).padStart(6);
  const p = x => x == null ? '   n/a' : (x * 100).toFixed(1).padStart(6) + '%';

  // (1) head-to-head, phase-averaged, 50bps
  console.log('=== (1) HEAD-TO-HEAD  (quarterly, phase-avg, 50bps) ===\n');
  console.log('strategy   annRet  Sharpe  maxDD   turn/yr   IR     avg#names');
  for (const nm of NAMES) {
    const ph = recs[nm].map(r => ({ ...perf(r.gross, r.turn, 0.005), ir: irOf(r.excess), k: mean(r.k) }));
    const a = k => mean(ph.map(x => x[k]));
    console.log(`${nm.padEnd(9)} ${p(a('annRet'))}  ${f(a('sharpe'))}  ${p(a('mdd'))}  ${p(a('turnYr'))}  ${f(a('ir'))}   ${Math.round(a('k'))}`);
  }

  // (2) regime stress — bear block + risk-on/off (phase-0)
  console.log('\n=== (2) REGIME STRESS (phase-0 quarters) ===\n');
  const bearEnd = months.findIndex(m => m >= '2023-10');
  console.log('strategy   bear-22/23 excess/q   risk-on excess/q   risk-off excess/q');
  for (const nm of NAMES) {
    const r = recs[nm][0]; const idx0 = months.map((_, i) => i).filter(i => i % STEP === 0).filter(mi => panel[months[mi]]);
    // align excess to quarter month labels:
    const qmonths = months.map((_, i) => i).filter(i => i % STEP === 0);
    const lbls = []; { let prev = null; for (const mi of qmonths) { const s = selectSet(nm, panel[months[mi]]); if (!s) continue; lbls.push(months[mi]); } }
    const bear = [], on = [], off = [];
    r.excess.forEach((e, i) => { const ym = lbls[i]; if (ym && ym < '2023-10') bear.push(e); r.regime[i] === 'on' ? on.push(e) : off.push(e); });
    console.log(`${nm.padEnd(9)} ${p(mean(bear))} (n${bear.length})       ${p(mean(on))} (n${on.length})      ${p(mean(off))} (n${off.length})`);
  }

  // (3) cost sensitivity
  console.log('\n=== (3) COST SENSITIVITY — IR, phase-avg ===\n');
  console.log('strategy    30bps   50bps  100bps');
  for (const nm of NAMES) {
    const row = [0.003, 0.005, 0.01].map(c => mean(recs[nm].map(r => { const net = r.gross.map((g, i) => g - r.turn[i] * c); const ex = r.excess.map((e, i) => e - r.turn[i] * c); return irOf(ex); })));
    console.log(`${nm.padEnd(9)}  ${f(row[0])}  ${f(row[1])}  ${f(row[2])}`);
  }

  // (4) BLOCK BOOTSTRAP on paired excess difference (ra+sect − base), phase-0, 50bps net
  console.log('\n=== (4) BLOCK-BOOTSTRAP: is (ra+sect − base) excess > 0? ===\n');
  const exNet = nm => { const r = recs[nm][0]; return r.excess.map((e, i) => e - r.turn[i] * 0.005); };
  const b = exNet('base'), x = exNet('ra+sect'); const n = Math.min(b.length, x.length);
  const diff = []; for (let i = 0; i < n; i++) diff.push(x[i] - b[i]);
  const BL = 2, R = 5000; const boot = [];
  for (let r = 0; r < R; r++) { let s = [], len = 0; while (len < n) { const st = Math.floor(Math.random() * (n - BL + 1)); for (let j = 0; j < BL && len < n; j++) { s.push(diff[st + j]); len++; } } boot.push(mean(s)); }
  boot.sort((a, c) => a - c);
  const lo = boot[Math.floor(0.025 * R)], hi = boot[Math.floor(0.975 * R)], pPos = boot.filter(v => v > 0).length / R;
  console.log(`paired diff/qtr: mean ${p(mean(diff))}  t ${f(sd(diff) ? mean(diff) / sd(diff) * Math.sqrt(n) : null)}  (n=${n} quarters)`);
  console.log(`block-bootstrap 95% CI of mean diff/qtr: [${p(lo)}, ${p(hi)}]   P(diff>0)=${(pPos * 100).toFixed(0)}%`);
  console.log(`${lo > 0 ? 'CI EXCLUDES 0 → improvement is real' : 'CI INCLUDES 0 → improvement NOT distinguishable from noise'}`);

  // (5) deflation
  console.log('\n=== (5) DEFLATION / SIGNIFICANCE ===');
  console.log('variants searched ≈ 216 (sweep) + 8 (overlays) = 224. Bonferroni α: need t ≈', (2.8).toFixed(1), 'for 5% family-wise.');
  console.log('Best signal IC t-stat in sweep was ~1.7 (12-1≈1.3). NONE survive Bonferroni. The case for the');
  console.log('survivors rests on ECONOMIC PRIOR + SUB-PERIOD STABILITY, not on raw significance — state this plainly.');
})();
