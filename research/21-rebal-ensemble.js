'use strict';
// Step 21 — on STABLE-CORE: (A) rebalance frequency x turnover control, (B) cost sensitivity,
// (C) ensemble/core+satellite check.   node research/21-rebal-ensemble.js
//
// Turnover control = rank BUFFER: enter on top-20% score, exit only when a holding drops out
// of the top-40% (hysteresis) — cuts turnover while keeping momentum exposure.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const ENTER = 0.20, HOLD = 0.40, COST = 0.005;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const stableCore = r => { const f = r.filter(x => x.cap >= 800e6 && x.cap < 5e9 && x.sec !== 'Healthcare' && x.v63 != null); const v = f.map(x => x.v63).sort((a, b) => a - b); if (v.length < 30) return []; const hi = v[Math.floor(2 * v.length / 3)]; return f.filter(x => x.v63 < hi); };

// scored pool for a cross-section (sector-neutral 12-1), with fwd field
function scored(rows, fwd, dl) {
  const ok = stableCore(rows).filter(r => r[fwd] != null && r[dl] === 0 && r.m121 != null);
  if (ok.length < 40) return null;
  const bs = {}; for (const r of ok) (bs[r.sec] || (bs[r.sec] = [])).push(r.m121);
  const md = {}; for (const s in bs) md[s] = median(bs[s]);
  return ok.map(r => ({ s: r.s, sc: r.m121 - md[r.sec], fwd: r[fwd] })).sort((a, b) => a.sc - b.sc);
}
function run(panel, months, step, ppy, fwd, dl, buffer, cost, offset) {
  const idx = months.map((_, i) => i).filter(i => i % step === offset);
  const rets = [], ex = []; let held = new Set();
  for (const mi of idx) {
    const pool = scored(panel[months[mi]], fwd, dl); if (!pool) continue;
    const scMap = new Map(pool.map(o => [o.s, o.sc])); const bench = mean(pool.map(o => o.fwd));
    const enterCut = quantile(pool.map(o => o.sc), 1 - ENTER), holdCut = quantile(pool.map(o => o.sc), 1 - HOLD);
    let set;
    if (!buffer) set = new Set(pool.filter(o => o.sc >= enterCut).map(o => o.s));
    else { set = new Set(); for (const s of held) if (scMap.has(s) && scMap.get(s) >= holdCut) set.add(s); for (const o of pool) if (o.sc >= enterCut) set.add(o.s); }
    const sel = pool.filter(o => set.has(o.s)); if (sel.length < 10) continue;
    let to = 1; if (held.size) { let kept = 0; for (const o of sel) if (held.has(o.s)) kept++; to = 1 - kept / sel.length; }
    const g = mean(sel.map(o => o.fwd)); if (g == null || !Number.isFinite(g)) continue;
    rets.push(g - to * cost); ex.push(g - bench - to * cost); held = new Set(sel.map(o => o.s));
  }
  if (rets.length < 8) return null;
  let v = 1, eq = []; for (const r of rets) { v *= 1 + r; eq.push(v); }
  const annRet = v > 0 ? Math.pow(v, ppy / rets.length) - 1 : -1, annVol = sd(rets) * Math.sqrt(ppy);
  let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); }
  const te = sd(ex) * Math.sqrt(ppy);
  // turnover: reconstruct avg one-way
  return { annRet, sharpe: annVol ? annRet / annVol : null, mdd, ir: te ? mean(ex) * ppy / te : null, n: rets.length };
}
function phaseAvg(panel, months, cfg) { const phs = []; for (let o = 0; o < cfg.step; o++) { const r = run(panel, months, cfg.step, cfg.ppy, cfg.fwd, cfg.dl, cfg.buffer, cfg.cost, o); if (r) phs.push(r); } if (!phs.length) return null; const a = k => mean(phs.map(x => x[k])); return { annRet: a('annRet'), sharpe: a('sharpe'), mdd: a('mdd'), ir: a('ir') }; }

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const f = (x, n = 2) => x == null ? '  n/a' : x.toFixed(n).padStart(6);
  const p = x => x == null ? '   n/a' : (x * 100).toFixed(1).padStart(6) + '%';

  console.log('=== (A) STABLE-CORE: rebalance x turnover-control (50bps) ===\n');
  console.log('config                         annRet  Sharpe    IR    maxDD');
  const cfgs = [
    ['monthly,  no buffer', { step: 1, ppy: 12, fwd: 'f21', dl: 'd21', buffer: false, cost: COST }],
    ['monthly,  rank-buffer', { step: 1, ppy: 12, fwd: 'f21', dl: 'd21', buffer: true, cost: COST }],
    ['quarterly, no buffer', { step: 3, ppy: 4, fwd: 'f63', dl: 'd63', buffer: false, cost: COST }],
    ['quarterly, rank-buffer', { step: 3, ppy: 4, fwd: 'f63', dl: 'd63', buffer: true, cost: COST }],
  ];
  for (const [nm, c] of cfgs) { const m = phaseAvg(panel, months, c); console.log(`${nm.padEnd(28)} ${p(m?.annRet)}  ${f(m?.sharpe)}  ${f(m?.ir)}  ${p(m?.mdd)}`); }

  console.log('\n=== (B) COST SENSITIVITY — IR (quarterly, rank-buffer vs none) ===\n');
  console.log('config                  30bps   50bps  100bps');
  for (const buf of [false, true]) { const row = [0.003, 0.005, 0.01].map(c => phaseAvg(panel, months, { step: 3, ppy: 4, fwd: 'f63', dl: 'd63', buffer: buf, cost: c })?.ir); console.log(`quarterly ${buf ? 'buffer ' : 'plain  '}        ${f(row[0])}  ${f(row[1])}  ${f(row[2])}`); }

  console.log('\n=== (C) ENSEMBLE / CORE+SATELLITE notes ===');
  console.log('vol-LOW pocket is ~a SUBSET of STABLE-CORE (ex-high-vol overlaps low-vol) → adding it as a');
  console.log('satellite is redundant, not diversifying. cap-2-5B ⊂ cap-800M-5B. The pockets OVERLAP, so a');
  console.log('parsimonious single STABLE-CORE already captures them. Multi-lookback ensembling tested in');
  console.log('steps 15-16 (m181/m93) FAILED sub-period IC → not added. Conclusion: keep ONE clean rule.');
})();
