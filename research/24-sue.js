'use strict';
// Step 24 — Time-series SUE (Foster / Bernard-Thomas seasonal-random-walk PEAD).
//   node research/24-sue.js  [limit]
//
// Revives the project's most-promising dead lead (PEAD) for FREE. The old PEAD died
// only because *estimate* history was capped ~12mo. Time-series SUE needs only quarterly
// ACTUALS, which the corrected rig's income cache already holds (~15yr, retained for
// delisted names) → survivorship-safe.
//
// SUE model (standardized unexpected earnings, seasonal random walk with drift):
//   SD_q  = EPS_q - EPS_{q-4}                     (seasonal difference)
//   SUE_q = (SD_q - mean(prev K SDs)) / std(prev K SDs)
// Uses only quarters whose filingDate <= as-of date (PIT report-lag guard; fallback
// fiscal-end + 45d when filingDate absent).
//
// PRE-REGISTERED (3 features + composite bar):
//   F1  standalone SUE  -> fwd 63d rank-IC + decile Q5-Q1 spread
//   F2  SUE x smallcap  -> is it stronger in the lower cap half?
//   F3  SUE persistence -> does same-sign consecutive SUE strengthen the drift?
//   BAR composite-delta: mom(12-1)+fundamentals  vs  +SUE  must beat +0.005 rank-IC
//        (the insider-redundancy bar from the prior edge hunt).
// Also: per-year blocks (2021..2025) for regime robustness; robustness leg on
// netIncome-based SUE (avoids per-share split distortion).

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const LAG = 45 * pit.DAY;
const DRIFT = 63;                                   // forward window (trading days)
const MIN_PRIOR_SD = 6;                             // seasonal diffs needed for a stable sigma
const GRID = pit.monthEnds('2021-07', '2025-09');   // need 63d forward after the last month
const LIMIT = Number(process.argv[2]) || Infinity;

// ---- stats helpers (match 07/14 conventions) ----
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
// z-scored rank within a cross-section (uniform in [-1,1]); used for composites.
function rankNorm(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(vals.length); idx.forEach(([, i], k) => r[i] = vals.length > 1 ? (k / (vals.length - 1)) * 2 - 1 : 0);
  return r;
}
const ratio = (ps, i, lb, sk) => { if (i - lb < 0 || i - sk < 0) return null; const a = ps[i - lb].close, b = ps[i - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; };

// ---- build per-symbol quarterly EPS/NI series with availability date ----
// returns [{eff, eps, ni, rev, period}] sorted by eff (report-available time)
function quarterSeries(income) {
  const rows = (income || []).map(r => {
    const fend = Date.parse(r.date);
    const filed = Date.parse(r.filingDate || r.acceptedDate);
    const eff = Number.isFinite(filed) ? filed : (Number.isFinite(fend) ? fend + LAG : NaN);
    return { eff, fend, eps: Number(r.eps), ni: Number(r.netIncome), rev: Number(r.revenue), period: r.period };
  }).filter(r => Number.isFinite(r.eff) && Number.isFinite(r.fend))
    .sort((a, b) => a.fend - b.fend);
  // de-dupe by fiscal-end (keep last = most complete)
  const seen = new Map(); for (const r of rows) seen.set(r.fend, r);
  return [...seen.values()].sort((a, b) => a.fend - b.fend);
}

// SUE as of `asOf` using `field` (eps|ni). Returns {sue, sameSignPrev} or null.
function sueAsOf(qs, asOf, field) {
  // most recent quarter available (filed) by asOf
  let cur = -1; for (let k = 0; k < qs.length; k++) { if (qs[k].eff <= asOf) cur = k; else break; }
  if (cur < 4) return null;
  const val = q => { const v = q[field]; return Number.isFinite(v) ? v : null; };
  // seasonal differences up to and including the current quarter
  const sds = [];
  for (let k = 4; k <= cur; k++) { const a = val(qs[k]), b = val(qs[k - 4]); if (a != null && b != null) sds.push({ idx: k, sd: a - b }); }
  if (sds.length < MIN_PRIOR_SD + 1) return null;
  const curSd = sds[sds.length - 1]; if (curSd.idx !== cur) return null;      // require the latest quarter to have a seasonal diff
  const prior = sds.slice(Math.max(0, sds.length - 1 - 8), sds.length - 1).map(x => x.sd);   // trailing 8 seasonal diffs
  if (prior.length < MIN_PRIOR_SD) return null;
  const s = sd(prior); if (!(s > 0)) return null;
  const sue = (curSd.sd - mean(prior)) / s;
  // persistence: sign of the previous quarter's SUE (does the surprise direction persist?)
  let prevSue = null;
  if (sds.length >= 2 && cur >= 5) {
    const prSd = sds[sds.length - 2];
    const pr2 = sds.slice(Math.max(0, sds.length - 2 - 8), sds.length - 2).map(x => x.sd);
    const s2 = sd(pr2);
    if (pr2.length >= MIN_PRIOR_SD && s2 > 0) prevSue = (prSd.sd - mean(pr2)) / s2;
  }
  const sameSignPrev = prevSue != null ? (Math.sign(sue) === Math.sign(prevSue) && sue !== 0) : null;
  return { sue: Math.max(-8, Math.min(8, sue)), sameSignPrev, freshDays: Math.round((asOf - qs[cur].eff) / pit.DAY) };
}

// simple fundamentals score = rev YoY growth + eps YoY growth, as-of (the BONUS proxy)
function fundAsOf(qs, asOf) {
  let cur = -1; for (let k = 0; k < qs.length; k++) { if (qs[k].eff <= asOf) cur = k; else break; }
  if (cur < 4) return null;
  const q = qs[cur], p = qs[cur - 4];
  const g = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 0) ? (a - b) / Math.abs(b) : null;
  const rg = g(q.rev, p.rev), eg = g(q.eps, p.eps);
  if (rg == null && eg == null) return null;
  return (rg ?? 0) * 0.5 + Math.max(-2, Math.min(2, eg ?? 0)) * 0.5;
}

(async () => {
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  let syms = Object.keys(sj); if (LIMIT < syms.length) syms = syms.slice(0, LIMIT);
  console.log(`Time-series SUE over ${syms.length} names, grid ${GRID.length} months (${new Date(GRID[0]).toISOString().slice(0, 7)}..${new Date(GRID.at(-1)).toISOString().slice(0, 7)})…`);

  // gather rows keyed by month for cross-sectional work
  const byMonth = {};                                 // ym -> rows[]
  let scanned = 0;
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 120) continue;
    const ss = pit.sharesSeries(c.income); if (!ss.length) continue;
    const qs = quarterSeries(c.income); if (qs.length < 8) continue;
    if (++scanned % 1500 === 0) process.stdout.write(`  scanned ${scanned}\n`);
    for (const d of GRID) {
      const pa = pit.asOfPriceAdv(ps, d); if (!pa || pa.stale) continue;
      const i = pa.idx, sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const su = sueAsOf(qs, d, 'eps'); if (!su) continue;
      const fwd = pit.fwdReturn(ps, d, DRIFT); if (!fwd) continue;
      const suNi = sueAsOf(qs, d, 'ni');
      const row = {
        s: sym, cap,
        sue: su.sue, sameSignPrev: su.sameSignPrev,
        sueNi: suNi ? suNi.sue : null,
        mom: ratio(ps, i, 252, 21),
        fund: fundAsOf(qs, d),
        fwd: fwd.ret, delisted: fwd.delistedWithin ? 1 : 0,
      };
      const ym = new Date(d).toISOString().slice(0, 7); (byMonth[ym] || (byMonth[ym] = [])).push(row);
    }
  }

  const months = Object.keys(byMonth).sort();
  const all = months.flatMap(m => byMonth[m]);
  console.log(`\n=== Time-series SUE (${all.length} in-band name-months, ${months.length} months, ${scanned} names) ===\n`);

  // ---------- F1: standalone SUE -> fwd 63d ----------
  const R = all.filter(r => Number.isFinite(r.sue) && Number.isFinite(r.fwd));
  const icAll = spearman(R.map(r => r.sue), R.map(r => r.fwd));
  console.log(`F1 standalone SUE -> fwd63 rank-IC (pooled): ${icAll?.toFixed(4)}  (n=${R.length})`);
  // per-month IC (Newey-ish t via month IC dispersion)
  const monthICs = months.map(m => { const rows = byMonth[m].filter(r => Number.isFinite(r.sue) && Number.isFinite(r.fwd)); return rows.length >= 15 ? spearman(rows.map(r => r.sue), rows.map(r => r.fwd)) : null; }).filter(x => x != null);
  const mIC = mean(monthICs), sIC = sd(monthICs);
  const tIC = (mIC != null && sIC > 0) ? mIC / (sIC / Math.sqrt(monthICs.length)) : null;
  console.log(`   monthly-mean IC ${mIC?.toFixed(4)}  t=${tIC?.toFixed(2)}  (${monthICs.length} monthly cross-sections)`);
  // deciles by SUE
  const ord = R.map((r, i) => [r.sue, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]); const per = Math.floor(ord.length / 10);
  const dret = di => mean(ord.slice(di * per, di === 9 ? ord.length : (di + 1) * per).map(i => R[i].fwd));
  console.log(`   decile fwd63:  D1(low SUE) ${pct(dret(0))}   D10(high SUE) ${pct(dret(9))}   D10-D1 ${pct(dret(9) - dret(0))}`);

  // ---------- F2: SUE x smallcap ----------
  const capMed = R.map(r => r.cap).sort((a, b) => a - b)[Math.floor(R.length / 2)];
  const small = R.filter(r => r.cap <= capMed), large = R.filter(r => r.cap > capMed);
  console.log(`\nF2 SUE x cap (median cap $${(capMed / 1e6).toFixed(0)}M):`);
  console.log(`   small-half IC ${spearman(small.map(r => r.sue), small.map(r => r.fwd))?.toFixed(4)} (n=${small.length})   large-half IC ${spearman(large.map(r => r.sue), large.map(r => r.fwd))?.toFixed(4)} (n=${large.length})`);

  // ---------- F3: SUE persistence (same-sign consecutive) ----------
  const persist = R.filter(r => r.sameSignPrev === true), flip = R.filter(r => r.sameSignPrev === false);
  console.log(`\nF3 SUE persistence:`);
  console.log(`   same-sign-as-prev-Q  IC ${spearman(persist.map(r => r.sue), persist.map(r => r.fwd))?.toFixed(4)} (n=${persist.length})   sign-flipped IC ${spearman(flip.map(r => r.sue), flip.map(r => r.fwd))?.toFixed(4)} (n=${flip.length})`);
  // persistent high-SUE (top tercile & same sign) mean fwd
  const hi = r => r.sue > 0.5;
  console.log(`   persistent positive-SUE mean fwd63 ${pct(mean(persist.filter(hi).map(r => r.fwd)))}  vs non-persistent positive ${pct(mean(flip.filter(hi).map(r => r.fwd)))}`);

  // ---------- BAR: composite-delta ----------
  // rank-normalize per month, then pool, so IC of a composite is comparable
  const comp = { base: [], withSue: [], fwd: [] };
  for (const m of months) {
    const rows = byMonth[m].filter(r => Number.isFinite(r.mom) && Number.isFinite(r.fund) && Number.isFinite(r.sue) && Number.isFinite(r.fwd));
    if (rows.length < 15) continue;
    const rm = rankNorm(rows.map(r => r.mom)), rf = rankNorm(rows.map(r => r.fund)), rs = rankNorm(rows.map(r => r.sue));
    rows.forEach((r, i) => {
      const base = rm[i] * 0.6 + rf[i] * 0.4;             // mom + fundamentals anchor
      comp.base.push(base); comp.withSue.push(base * (2 / 3) + rs[i] * (1 / 3)); comp.fwd.push(r.fwd);
    });
  }
  const icBase = spearman(comp.base, comp.fwd), icWith = spearman(comp.withSue, comp.fwd);
  const delta = (icBase != null && icWith != null) ? icWith - icBase : null;
  console.log(`\nBAR composite-delta (n=${comp.fwd.length}):`);
  console.log(`   mom+fund IC ${icBase?.toFixed(4)}   +SUE IC ${icWith?.toFixed(4)}   delta ${delta == null ? 'n/a' : (delta >= 0 ? '+' : '') + delta.toFixed(4)}  (bar +0.0050)`);

  // ---------- per-year robustness ----------
  console.log(`\nper-year SUE IC (regime robustness):`);
  const years = [...new Set(months.map(m => m.slice(0, 4)))].sort();
  for (const y of years) {
    const rows = months.filter(m => m.startsWith(y)).flatMap(m => byMonth[m]).filter(r => Number.isFinite(r.sue) && Number.isFinite(r.fwd));
    console.log(`   ${y}: IC ${rows.length >= 30 ? spearman(rows.map(r => r.sue), rows.map(r => r.fwd))?.toFixed(4) : 'n/a'}  (n=${rows.length})`);
  }

  // ---------- robustness: netIncome-based SUE ----------
  const RN = all.filter(r => Number.isFinite(r.sueNi) && Number.isFinite(r.fwd));
  console.log(`\nrobustness (netIncome-based SUE): IC ${spearman(RN.map(r => r.sueNi), RN.map(r => r.fwd))?.toFixed(4)}  (n=${RN.length})`);

  fs.writeFileSync(path.join(DATA, 'sue.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), n: all.length, months: months.length,
    f1: { icPooled: icAll, icMonthlyMean: mIC, tStat: tIC, decileSpread: dret(9) - dret(0) },
    f2: { smallIC: spearman(small.map(r => r.sue), small.map(r => r.fwd)), largeIC: spearman(large.map(r => r.sue), large.map(r => r.fwd)) },
    bar: { icBase, icWith, delta },
  }, null, 0));
  console.log('\nVERDICT cues: F1 IC>0 with t>=2 & monotone deciles = SUE alive; delta>+0.005 = ADDITIVE (ship-worthy), else redundant/dead.');
})();
