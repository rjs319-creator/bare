'use strict';
// Step 26 — FINRA short interest as cross-sectional predictor (corrected rig).
//   node research/26-si.js [limit]
//
// (a) At each monthly panel date, join the latest short-interest settlement <= date.
//     Test SI%shares (short shares / PIT shares-out) and days-to-cover (DTC) as fwd63
//     predictors. Prior (Boehmer/Asquith): high short interest is a NEGATIVE predictor.
//     FAILURE MODE (pre-registered): SI ~ MAX/lottery, so partial-IC controlling MAX.
// (b) Squeeze-fuel: among ~gap-up events, does higher prior DTC predict continuation?

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const DRIFT = 63;
const GRID = pit.monthEnds('2021-07', '2025-09');
const LIMIT = Number(process.argv[2]) || Infinity;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
function spearman(xs, ys) {
  const n = xs.length; if (n < 10) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}
const rankArr = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = a.length > 1 ? k / (a.length - 1) : 0.5); return r; };
const ratio = (ps, i, lb, sk) => { if (i - lb < 0 || i - sk < 0) return null; const a = ps[i - lb].close, b = ps[i - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; };
function maxRet(ps, i, n) { if (i - n < 0) return null; let mx = -Infinity; for (let k = i - n + 1; k <= i; k++) { const x = ps[k].close / ps[k - 1].close - 1; if (Number.isFinite(x)) mx = Math.max(mx, x); } return Number.isFinite(mx) ? mx : null; }

(async () => {
  const si = JSON.parse(fs.readFileSync(path.join(DATA, 'short-interest.json'), 'utf8')).byDate;
  const siDates = Object.keys(si).map(d => ({ d, ms: Date.parse(d) })).sort((a, b) => a.ms - b.ms);
  const siAsOf = ms => { let pick = null; for (const s of siDates) { if (s.ms <= ms) pick = s.d; else break; } return pick; };

  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  let syms = Object.keys(sj); if (LIMIT < syms.length) syms = syms.slice(0, LIMIT);

  const byMonth = {};             // ym -> rows[]
  const gapEvents = [];           // {dtc, cont} squeeze test
  let scanned = 0, joined = 0;
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 120) continue;
    const ss = pit.sharesSeries(c.income); if (!ss.length) continue;
    scanned++;
    for (const d of GRID) {
      const pa = pit.asOfPriceAdv(ps, d); if (!pa || pa.stale) continue;
      const i = pa.idx, sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const sd0 = siAsOf(d); if (!sd0) continue;
      const rec = si[sd0][sym]; if (!rec || !(rec.si > 0)) continue;
      const dtc = Number(rec.dtc); const sipct = rec.si / sh;
      if (!Number.isFinite(sipct)) continue;
      const fwd = pit.fwdReturn(ps, d, DRIFT); if (!fwd) continue;
      joined++;
      const ym = new Date(d).toISOString().slice(0, 7);
      (byMonth[ym] || (byMonth[ym] = [])).push({ s: sym, cap, sipct, dtc: Number.isFinite(dtc) ? dtc : null, mom: ratio(ps, i, 252, 21), max21: maxRet(ps, i, 21), fwd: fwd.ret });
    }
    // (b) squeeze: intra-cache spike-ups with prior DTC known → 21d continuation.
    // Guard split-adjustment artifacts: a >25% single-day close move that reverses
    // ~fully next day (|next| within 40% of the spike, opposite sign) is a bogus
    // un-rescaled bar (the CRWD-type artifact). Also winsorize continuation.
    for (let i = 60; i < ps.length - 21; i++) {
      const g = ps[i].close / ps[i - 1].close - 1;
      if (g < 0.07 || g > 0.60) continue;            // ~spike day; drop implausible (likely split)
      const nxt = ps[i + 1] ? ps[i + 1].close / ps[i].close - 1 : 0;
      if (g > 0.25 && nxt < -0.20) continue;         // spike fully reverses next day = split artifact
      const sd0 = siAsOf(ps[i].ms); if (!sd0) continue;
      const rec = si[sd0][sym]; if (!rec || !(rec.dtc > 0)) continue;
      let cont = ps[i + 21].close / ps[i].close - 1;
      if (!Number.isFinite(cont)) continue;
      cont = Math.max(-0.9, Math.min(2.0, cont));    // winsorize (means only; IC is rank-based)
      gapEvents.push({ dtc: Number(rec.dtc), cont });
    }
  }

  const months = Object.keys(byMonth).sort();
  const all = months.flatMap(m => byMonth[m]);
  console.log(`\n=== FINRA short interest (${all.length} joined name-months, ${months.length} months, ${scanned} names, ${joined} joins) ===\n`);

  const R = all.filter(r => Number.isFinite(r.sipct) && Number.isFinite(r.fwd));
  console.log(`(a1) SI%shares -> fwd63 rank-IC: ${spearman(R.map(r => r.sipct), R.map(r => r.fwd))?.toFixed(4)}  (n=${R.length})  [negative = crowded-short underperforms]`);
  const D = all.filter(r => Number.isFinite(r.dtc) && Number.isFinite(r.fwd));
  console.log(`(a2) days-to-cover -> fwd63 rank-IC: ${spearman(D.map(r => r.dtc), D.map(r => r.fwd))?.toFixed(4)}  (n=${D.length})`);
  // monthly-mean IC + t for SI%shares
  const mICs = months.map(m => { const rows = byMonth[m].filter(r => Number.isFinite(r.sipct) && Number.isFinite(r.fwd)); return rows.length >= 15 ? spearman(rows.map(r => r.sipct), rows.map(r => r.fwd)) : null; }).filter(x => x != null);
  const mIC = mean(mICs), t = (mIC != null && sd(mICs) > 0) ? mIC / (sd(mICs) / Math.sqrt(mICs.length)) : null;
  console.log(`     SI%shares monthly-mean IC ${mIC?.toFixed(4)} t=${t?.toFixed(2)} (${mICs.length} months)`);

  // deciles by SI%shares
  const ord = R.map((r, i) => [r.sipct, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]); const per = Math.floor(ord.length / 10);
  const dret = di => mean(ord.slice(di * per, di === 9 ? ord.length : (di + 1) * per).map(i => R[i].fwd));
  console.log(`     decile fwd63: D1(low SI) ${pct(dret(0))}  D10(high SI) ${pct(dret(9))}  D10-D1 ${pct(dret(9) - dret(0))}`);

  // MAX control (partial IC): residualize SI% on MAX per month, then pool
  const resid = { si: [], fwd: [] };
  for (const m of months) {
    const rows = byMonth[m].filter(r => Number.isFinite(r.sipct) && Number.isFinite(r.max21) && Number.isFinite(r.fwd));
    if (rows.length < 20) continue;
    const rsi = rankArr(rows.map(r => r.sipct)), rmx = rankArr(rows.map(r => r.max21));
    // simple OLS slope of rsi on rmx
    const mx = mean(rmx), my = mean(rsi); let num = 0, den = 0;
    for (let k = 0; k < rows.length; k++) { num += (rmx[k] - mx) * (rsi[k] - my); den += (rmx[k] - mx) ** 2; }
    const b = den ? num / den : 0;
    rows.forEach((r, k) => { resid.si.push(rsi[k] - (my + b * (rmx[k] - mx))); resid.fwd.push(r.fwd); });
  }
  const corrSiMax = spearman(R.filter(r => Number.isFinite(r.max21)).map(r => r.sipct), R.filter(r => Number.isFinite(r.max21)).map(r => r.max21));
  console.log(`\n(a3) MAX/lottery control:`);
  console.log(`     corr(SI%shares, MAX_21d) = ${corrSiMax?.toFixed(3)}`);
  console.log(`     SI%shares IC after residualizing on MAX = ${spearman(resid.si, resid.fwd)?.toFixed(4)}  (n=${resid.fwd.length})`);
  console.log(`     MAX_21d standalone IC = ${spearman(R.filter(r => Number.isFinite(r.max21)).map(r => r.max21), R.filter(r => Number.isFinite(r.max21)).map(r => r.fwd))?.toFixed(4)}`);

  // per-year robustness (SI%shares)
  console.log(`\n(a4) per-year SI%shares IC:`);
  for (const y of [...new Set(months.map(m => m.slice(0, 4)))].sort()) {
    const rows = months.filter(m => m.startsWith(y)).flatMap(m => byMonth[m]).filter(r => Number.isFinite(r.sipct) && Number.isFinite(r.fwd));
    console.log(`     ${y}: IC ${rows.length >= 30 ? spearman(rows.map(r => r.sipct), rows.map(r => r.fwd))?.toFixed(4) : 'n/a'} (n=${rows.length})`);
  }

  // (b) squeeze-fuel: DTC quintile among spike days -> 21d continuation
  console.log(`\n(b) squeeze fuel — DTC at spike day -> 21d continuation (${gapEvents.length} spike events):`);
  const g = gapEvents.filter(e => Number.isFinite(e.dtc) && Number.isFinite(e.cont));
  console.log(`     DTC -> continuation rank-IC ${spearman(g.map(e => e.dtc), g.map(e => e.cont))?.toFixed(4)}`);
  const go = g.map((e, i) => [e.dtc, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]); const gp = Math.floor(go.length / 5);
  const gq = qi => mean(go.slice(qi * gp, qi === 4 ? go.length : (qi + 1) * gp).map(i => g[i].cont));
  console.log(`     Q1(low DTC) cont ${pct(gq(0))}   Q5(high DTC) cont ${pct(gq(4))}   Q5-Q1 ${pct(gq(4) - gq(0))}`);

  console.log('\nVERDICT cues: SI%shares IC<0 & sig & survives MAX-residual = real negative predictor; if ~0 after MAX = lottery-redundant. (b) Q5-Q1>0 = squeeze fuel for gap meta-label.');
})();
