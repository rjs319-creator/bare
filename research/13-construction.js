'use strict';
// Phase-2 step 13 — CONSTRUCTION: turn the one surviving signal into the best
// risk-adjusted, deployable book. (Raw-α ceiling is hit; "better edge" now = better IR.)
//   node research/13-construction.js                    (cached data only)
//
// Monthly-rebalanced long book of the top-quintile 12-1 momentum names, built up in layers
// so each layer's marginal value is visible, all NET of costs and vs the small/mid benchmark:
//   B  benchmark        — equal-weight ALL in-band names (the passive small/mid beta)
//   P1 EW-Q5            — equal-weight top-momentum quintile (the naive strategy)
//   P2 IV-Q5           — inverse-VOL weight Q5 (down-weight high-vol junk; the classic Sharpe lift)
//   P3 IV-Q5 + regime  — cut exposure in risk-off cohorts (proven ~2x IC multiplier)
//   P4 IV-Q5 + regime + crash control — vol-target the book (Barroso/Santa-Clara momentum crash mgmt)
// Metrics: annualized return, vol, Sharpe, max drawdown, and IR vs benchmark.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const HOLD = Number(process.env.HOLD || 21);              // rebalance/hold horizon in trading days (21=monthly, 63=quarterly)
const FWD = HOLD, MOM_LB = 252, MOM_SK = 21, VOL_LB = 63; // 12-1 signal; 63d vol
const PPY = 252 / HOLD;                                    // rebalance periods per year
const STEP = Math.max(1, Math.round(HOLD / 21));           // month-grid stride to hit the cadence
const GRID = pit.monthEnds('2022-02', '2026-04').filter((_, i) => i % STEP === 0);
const MIN_XS = 40, RT_COST = 0.005;                        // 50bps round-trip
const RISKOFF_EXP = 0.34, TARGET_VOL = 0.18, VT_WIN = 6;  // regime dial floor; vol target; trailing months

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function trail(ps, idx, lb, sk = 0) { if (idx - lb < 0 || idx - sk < 0) return null; const a = ps[idx - lb].close, b = ps[idx - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; }
function dailyVol(ps, idx, n) { if (idx - n < 0) return null; const r = []; for (let k = idx - n + 1; k <= idx; k++) { const x = ps[k].close / ps[k - 1].close - 1; if (Number.isFinite(x)) r.push(Math.max(-0.5, Math.min(0.5, x))); } const s = sd(r); return s ? s * Math.sqrt(252) : null; }

function metrics(rets, bench) {
  const n = rets.length; if (n < 6) return null;
  const eq = []; let v = 1; for (const r of rets) { v *= (1 + r); eq.push(v); }
  const annRet = Math.pow(v, PPY / n) - 1, annVol = sd(rets) * Math.sqrt(PPY);
  let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); }
  let ir = null; if (bench) { const act = rets.map((r, i) => r - bench[i]); const te = sd(act) * Math.sqrt(PPY); ir = te ? (mean(act) * PPY) / te : null; }
  return { annRet, annVol, sharpe: annVol ? annRet / annVol : null, mdd, ir };
}

(async () => {
  const survivors = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const recs = [];
  for (const s of survivors) { const f = path.join(pit.CACHE, `${s}.json`); if (!fs.existsSync(f)) continue; try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); recs.push({ sym: s, ps: pit.priceSeries(c.price), ss: pit.sharesSeries(c.income) }); } catch {} }
  console.log(`Loaded ${recs.length} names.\n`);

  // per-month: benchmark return, and the Q5 book under EW and IV weights (+ regime flag)
  const M = [];                                          // {ym, regime, bench, ewRet, ewTurn, ivRet, ivTurn}
  let prevEW = new Map(), prevIV = new Map();
  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (r.ps.length < 60 || !r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); if (!pa || pa.stale) continue;
      const sh = pit.asOfShares(r.ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const mom = trail(r.ps, pa.idx, MOM_LB, MOM_SK); if (mom == null) continue;
      const vol = dailyVol(r.ps, pa.idx, VOL_LB); if (vol == null || vol <= 0) continue;
      rows.push({ sym: r.sym, mom, vol, fwd: fr.ret, trailReg: trail(r.ps, pa.idx, FWD) });
    }
    if (rows.length < MIN_XS) continue;
    const regime = (mean(rows.map(r => r.trailReg).filter(x => x != null)) || 0) >= 0 ? 'on' : 'off';
    const bench = mean(rows.map(r => r.fwd));
    const ord = [...rows].sort((a, b) => a.mom - b.mom); const per = Math.floor(ord.length / 5);
    const q5 = ord.slice(4 * per);
    // EW weights
    const ewW = new Map(q5.map(r => [r.sym, 1 / q5.length]));
    // IV weights
    const iv = q5.map(r => 1 / r.vol); const ivSum = iv.reduce((a, b) => a + b, 0);
    const ivW = new Map(q5.map((r, i) => [r.sym, iv[i] / ivSum]));
    const wret = (w) => q5.reduce((s, r) => s + w.get(r.sym) * r.fwd, 0);
    const turnover = (cur, prev) => { const keys = new Set([...cur.keys(), ...prev.keys()]); let t = 0; for (const k of keys) t += Math.abs((cur.get(k) || 0) - (prev.get(k) || 0)); return t / 2; };
    M.push({ ym: new Date(d).toISOString().slice(0, 7), regime, bench, ewRet: wret(ewW), ewTurn: turnover(ewW, prevEW), ivRet: wret(ivW), ivTurn: turnover(ivW, prevIV) });
    prevEW = ewW; prevIV = ivW;
  }

  // assemble net monthly series for each portfolio
  const benchS = M.map(m => m.bench);
  const ewS = M.map(m => m.ewRet - m.ewTurn * RT_COST);
  const ivBase = M.map(m => m.ivRet - m.ivTurn * RT_COST);
  // P3: regime dial (cut exposure off-regime; uninvested fraction earns 0)
  const ivReg = M.map((m, i) => { const e = m.regime === 'on' ? 1 : RISKOFF_EXP; return e * m.ivRet - e * m.ivTurn * RT_COST; });
  // P4: + crash control = vol-target the regime-dialled book using its OWN trailing realized vol
  const ivVT = ivReg.map((_, i) => {
    const m = M[i]; let exp = m.regime === 'on' ? 1 : RISKOFF_EXP;
    if (i >= VT_WIN) { const win = ivReg.slice(i - VT_WIN, i); const rv = sd(win) * Math.sqrt(PPY); if (rv > 0) exp *= Math.min(1, TARGET_VOL / rv); }
    return exp * m.ivRet - exp * m.ivTurn * RT_COST;
  });

  const rows = [['B  benchmark (EW all)', benchS, null], ['P1 EW-Q5', ewS, benchS], ['P2 IV-Q5', ivBase, benchS], ['P3 IV-Q5 + regime', ivReg, benchS], ['P4 IV-Q5 + regime + crash', ivVT, benchS]];
  const p = x => x == null ? '   n/a' : (x * 100).toFixed(1).padStart(5) + '%';
  const f2 = x => x == null ? ' n/a' : x.toFixed(2).padStart(4);
  console.log(`=== CONSTRUCTION LADDER  (${M.length} periods, ${HOLD}d hold ≈ ${HOLD === 21 ? 'monthly' : HOLD === 63 ? 'quarterly' : HOLD + 'd'} rebal, 50bps cost) ===\n`);
  console.log('portfolio                     annRet   annVol  Sharpe   maxDD    IR-vs-bench');
  const out = {};
  for (const [name, s, b] of rows) { const mt = metrics(s, b); if (!mt) continue; out[name.slice(0, 2).trim()] = mt; console.log(`${name.padEnd(28)} ${p(mt.annRet)}  ${p(mt.annVol)}  ${f2(mt.sharpe)}   ${p(mt.mdd)}   ${f2(mt.ir)}`); }
  console.log('\nRegime mix:', M.filter(m => m.regime === 'on').length, 'risk-on /', M.filter(m => m.regime === 'off').length, 'risk-off months');
  console.log('\nREAD: each layer should lift Sharpe / cut maxDD vs the one above. Benchmark Sharpe = the passive');
  console.log('small/mid beta to beat; positive IR = genuine active value. This is the deployable final book.');
  fs.writeFileSync(path.join(DATA, 'construction.json'), JSON.stringify({ generatedAt: new Date().toISOString(), months: M.length, portfolios: out }, null, 0));
})();
