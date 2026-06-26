'use strict';
// Phase-2 step 10 — RESIDUAL MOMENTUM: clean the anchor instead of hunting a new factor.
//   node research/10-residual-momentum.js              (cached data only)
//
// Raw 12-1 momentum on this panel is REGIME-FRAGILE (risk-on IC 0.047 / risk-off 0.009)
// because in a small/mid universe it is largely a high-BETA + hot-SECTOR bet that crashes
// risk-off. Residual momentum strips that: per name-month, regress the name's daily returns
// over the 12-1 window on the equal-weight MARKET and its SECTOR returns (OLS, intercept),
// then rank on the residual-vol-scaled cumulative residual (Blitz/Grundy-Martin). The
// hypothesis: residual momentum has a higher, more REGIME-STABLE IC and lower crash risk
// than raw. We run the SAME baseline+robustness battery on raw vs residual, head-to-head.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const FWD = 63, LB = 252, SK = 21;                 // 12-1 window, 3-month forward
const GRID = pit.monthEnds('2022-07', '2026-03');
const MIN_XS = 40, MIN_OBS = 60, RT_COST = 0.005;  // min daily obs for a regression; 50bps round-trip
const CLIP = 0.5;                                   // clip daily returns (split/bad-tick guard)

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const m = mean(a), s = sd(a); return (m != null && s) ? m / s * Math.sqrt(a.length) : null; };
function spearman(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}
// OLS y on [1, x1, x2] via 3x3 normal equations; returns residual array (y - fit).
function residualize(y, x1, x2) {
  const n = y.length; let S = Array.from({ length: 3 }, () => [0, 0, 0]), b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const v = [1, x1[i], x2[i]], yi = y[i];
    for (let r = 0; r < 3; r++) { b[r] += v[r] * yi; for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c]; }
  }
  const beta = solve3(S, b); if (!beta) return null;
  const res = new Array(n);
  for (let i = 0; i < n; i++) res[i] = y[i] - (beta[0] + beta[1] * x1[i] + beta[2] * x2[i]);
  return res;
}
function solve3(A, b) {                              // Gaussian elimination w/ partial pivot
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;[M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

(async () => {
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  const survivors = Object.keys(sj);
  const recs = [];
  for (const s of survivors) {
    const f = path.join(pit.CACHE, `${s}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < LB + FWD) continue;
    const dr = new Array(ps.length).fill(null);       // dr[k] = clipped daily return into bar k
    for (let k = 1; k < ps.length; k++) { const r = ps[k].close / ps[k - 1].close - 1; dr[k] = Math.max(-CLIP, Math.min(CLIP, r)); }
    recs.push({ sym: s, ps, dr, ss: pit.sharesSeries(c.income), sector: sj[s].sector || 'Unknown' });
  }
  console.log(`Loaded ${recs.length} names. Building market + sector daily-return means…`);

  // equal-weight MARKET and per-SECTOR daily mean returns (keyed by bar ms)
  const mkt = new Map(), sec = new Map();             // ms->{s,c} ; sector->(ms->{s,c})
  for (const r of recs) {
    let sm = sec.get(r.sector); if (!sm) { sm = new Map(); sec.set(r.sector, sm); }
    for (let k = 1; k < r.ps.length; k++) {
      const ms = r.ps[k].ms, v = r.dr[k]; if (v == null) continue;
      const a = mkt.get(ms) || { s: 0, c: 0 }; a.s += v; a.c++; mkt.set(ms, a);
      const sb = sm.get(ms) || { s: 0, c: 0 }; sb.s += v; sb.c++; sm.set(ms, sb);
    }
  }
  const mktRet = new Map([...mkt].map(([k, v]) => [k, v.s / v.c]));
  const secRet = new Map([...sec].map(([sk, m]) => [sk, new Map([...m].map(([k, v]) => [k, v.s / v.c]))]));

  function rawMom(ps, idx) { const a = ps[idx - LB].close, b = ps[idx - SK].close; return (a > 0 && b > 0) ? b / a - 1 : null; }
  function residMom(r, idx) {                          // residual-vol-scaled cumulative residual over (idx-LB, idx-SK]
    const sm = secRet.get(r.sector); const y = [], xm = [], xs = [];
    for (let k = idx - LB + 1; k <= idx - SK; k++) {
      const ms = r.ps[k].ms, dv = r.dr[k]; if (dv == null) continue;
      const m = mktRet.get(ms), s = sm && sm.get(ms); if (m == null || s == null) continue;
      y.push(dv); xm.push(m); xs.push(s);
    }
    if (y.length < MIN_OBS) return null;
    const res = residualize(y, xm, xs); if (!res) return null;
    const cum = res.reduce((a, b) => a + b, 0), rv = sd(res);
    return (rv && rv > 0) ? cum / (rv * Math.sqrt(res.length)) : null;
  }

  // build monthly cross-sections with both signals + fwd
  const months = [];
  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (!r.ss.length) continue;
      const idx = pit.asOfPriceAdv(r.ps, d); if (!idx || idx.stale) continue;
      if (idx.idx - LB < 0) continue;
      const sh = pit.asOfShares(r.ss, d); if (!sh) continue;
      const cap = idx.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || idx.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const raw = rawMom(r.ps, idx.idx), res = residMom(r, idx.idx);
      if (raw == null || res == null) continue;
      rows.push({ sym: r.sym, raw, res, fwd: fr.ret, trail: (r.ps[idx.idx].close / r.ps[Math.max(0, idx.idx - FWD)].close - 1) });
    }
    if (rows.length < MIN_XS) continue;
    const cohort = mean(rows.map(r => r.fwd));
    const regime = (mean(rows.map(r => r.trail)) || 0) >= 0 ? 'risk-on' : 'risk-off';
    const pack = key => {
      const ord = rows.map((r, i) => [r[key], i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
      const per = Math.floor(ord.length / 5);
      const q5 = ord.slice(4 * per).map(i => rows[i]), q1 = ord.slice(0, per).map(i => rows[i]);
      return { ic: spearman(rows.map(r => r[key]), rows.map(r => r.fwd)), q5set: new Set(q5.map(r => r.sym)), q5_q1: mean(q5.map(r => r.fwd)) - mean(q1.map(r => r.fwd)) };
    };
    months.push({ ym: new Date(d).toISOString().slice(0, 7), regime, n: rows.length, raw: pack('raw'), res: pack('res') });
  }

  const report = key => {
    const ics = months.map(m => m[key].ic).filter(x => x != null);
    const onA = months.filter(m => m.regime === 'risk-on').map(m => m[key].ic).filter(x => x != null);
    const offA = months.filter(m => m.regime === 'risk-off').map(m => m[key].ic).filter(x => x != null);
    const B = 4, sz = Math.ceil(months.length / B), blocks = [];
    for (let b = 0; b < B; b++) { const a = months.slice(b * sz, (b + 1) * sz).map(m => m[key].ic).filter(x => x != null); if (a.length) blocks.push(mean(a)); }
    const rebal = months.filter((_, i) => i % 3 === 0); let turn = [];
    for (let i = 1; i < rebal.length; i++) { const cur = rebal[i][key].q5set, prev = rebal[i - 1][key].q5set; let kept = 0; for (const s of cur) if (prev.has(s)) kept++; turn.push(1 - kept / cur.size); }
    const grossQ = mean(months.map(m => m[key].q5_q1)), avgTurn = mean(turn), netQ = grossQ - avgTurn * RT_COST;
    return { meanIC: mean(ics), t: tstat(ics), onIC: mean(onA), onT: tstat(onA), offIC: mean(offA), offT: tstat(offA), blocks, allPos: blocks.every(b => b > 0), netQ, netYr: netQ * 4, turn: avgTurn };
  };
  const RAW = report('raw'), RES = report('res');
  const p = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  const f = (x, n = 3) => x == null ? 'n/a' : x.toFixed(n);

  console.log(`\n=== RAW vs RESIDUAL 12-1 MOMENTUM  (${months.length} months, avg XS ${Math.round(mean(months.map(m => m.n)))}) ===\n`);
  console.log('                       RAW           RESIDUAL');
  console.log(`overall  meanIC        ${f(RAW.meanIC).padStart(6)}        ${f(RES.meanIC).padStart(6)}`);
  console.log(`overall  IC t-stat     ${f(RAW.t, 2).padStart(6)}        ${f(RES.t, 2).padStart(6)}`);
  console.log(`risk-on  IC (t)        ${f(RAW.onIC)} (${f(RAW.onT, 1)})    ${f(RES.onIC)} (${f(RES.onT, 1)})`);
  console.log(`risk-off IC (t)        ${f(RAW.offIC)} (${f(RAW.offT, 1)})    ${f(RES.offIC)} (${f(RES.offT, 1)})   ← regime stability test`);
  console.log(`blocks all-positive    ${RAW.allPos ? 'YES' : 'no '}           ${RES.allPos ? 'YES' : 'no '}`);
  console.log(`  block ICs raw  : ${RAW.blocks.map(b => f(b)).join('  ')}`);
  console.log(`  block ICs resid: ${RES.blocks.map(b => f(b)).join('  ')}`);
  console.log(`Q5 turnover/qtr        ${(RAW.turn * 100).toFixed(0)}%           ${(RES.turn * 100).toFixed(0)}%`);
  console.log(`net Q5-Q1 / 63d        ${p(RAW.netQ).padStart(6)}        ${p(RES.netQ).padStart(6)}`);
  console.log(`net ~/yr               ${p(RAW.netYr).padStart(6)}        ${p(RES.netYr).padStart(6)}`);
  console.log('\nVERDICT cues: residual WINS if its risk-off IC is materially > raw (regime-stable),');
  console.log('blocks turn all-positive, and net/yr improves. That = a cleaner, more deployable anchor.');
  fs.writeFileSync(path.join(DATA, 'residual-momentum.json'), JSON.stringify({ generatedAt: new Date().toISOString(), months: months.length, raw: RAW, res: RES }, null, 0));
})();
