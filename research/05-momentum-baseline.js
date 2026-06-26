'use strict';
// Phase-1 step 05 — MOMENTUM RE-BASELINE on the clean PIT small/mid panel.
//   node research/05-momentum-baseline.js              (no key needed — cached data only)
//
// For each month-end, build the in-band cross-section and measure whether price
// momentum predicts forward 63-day returns: cross-sectional rank-IC (Spearman),
// IC t-stat, and quintile spread (excess vs the month's cohort = survivorship-
// and beta-neutral at the cohort level). Signals: 12-1 / 6-1 / 3-1 momentum.
//
// CAVEAT: survivor-only panel (delisted names are still being pulled separately);
// the just-measured survivorship bias is modest, so this is a fair baseline.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const FWD = 63;                                    // forward horizon (3 months)
const GRID = pit.monthEnds('2022-07', '2026-03');  // need 252d lookback + 63d forward
const MIN_XS = 40;                                  // minimum cross-section size per month
const SIGNALS = { 'mom_12_1': [252, 21], 'mom_6_1': [126, 21], 'mom_3_1': [63, 21] };

function momentum(series, dateMs, lookback, skip) {
  let idx = -1; for (let k = 0; k < series.length; k++) { if (series[k].ms <= dateMs) idx = k; else break; }
  if (idx - lookback < 0 || idx - skip < 0) return null;
  const a = series[idx - lookback].close, b = series[idx - skip].close;
  return (a > 0 && b > 0) ? b / a - 1 : null;
}
function spearman(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys);
  const mx = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - mx; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  const survivors = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const recs = [];
  for (const s of survivors) { const f = path.join(pit.CACHE, `${s}.json`); if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); recs.push({ sym: s, ps: pit.priceSeries(c.price), ss: pit.sharesSeries(c.income) }); } catch {} } }
  console.log(`Loaded ${recs.length} survivor caches. Building monthly cross-sections…\n`);

  const ic = {}; const q = {};                      // per-signal IC list + quintile fwd buckets
  for (const k of Object.keys(SIGNALS)) { ic[k] = []; q[k] = [[], [], [], [], []]; }
  let monthsUsed = 0, xsTotal = 0;

  for (const d of GRID) {
    // cross-section: in-band members with all signals + forward return
    const rows = [];
    for (const r of recs) {
      if (r.ps.length < 60 || !r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); const sh = pit.asOfShares(r.ss, d);
      if (!pa || pa.stale || !sh) continue;
      const cap = pa.close * sh;
      if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD);
      if (!fr || fr.delistedWithin) continue;        // need a full elapsed forward window
      const sig = {}; let okAll = true;
      for (const [k, [lb, sk]] of Object.entries(SIGNALS)) { const m = momentum(r.ps, d, lb, sk); if (m == null) { okAll = false; break; } sig[k] = m; }
      if (!okAll) continue;
      rows.push({ fwd: fr.ret, sig });
    }
    if (rows.length < MIN_XS) continue;
    monthsUsed++; xsTotal += rows.length;
    const cohortMean = mean(rows.map(r => r.fwd));
    for (const k of Object.keys(SIGNALS)) {
      const xs = rows.map(r => r.sig[k]), ys = rows.map(r => r.fwd);
      const s = spearman(xs, ys); if (s != null) ic[k].push(s);
      // quintiles by signal → bucket the EXCESS forward return (vs cohort)
      const order = rows.map((r, i) => [r.sig[k], i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
      const per = Math.floor(order.length / 5); if (per < 1) continue;
      for (let qi = 0; qi < 5; qi++) {
        const lo = qi * per, hi = qi === 4 ? order.length : (qi + 1) * per;
        for (let j = lo; j < hi; j++) q[k][qi].push(rows[order[j]].fwd - cohortMean);
      }
    }
  }

  console.log(`Months used: ${monthsUsed} | avg cross-section: ${Math.round(xsTotal / Math.max(1, monthsUsed))}\n`);
  console.log('signal      meanIC   IC t-stat   Q1excess   Q5excess   Q5-Q1   monotonic');
  for (const k of Object.keys(SIGNALS)) {
    const m = mean(ic[k]), s = sd(ic[k]), t = (m != null && s) ? m / s * Math.sqrt(ic[k].length) : null;
    const qm = q[k].map(b => mean(b) || 0);
    const mono = (qm[0] <= qm[1] && qm[1] <= qm[2] && qm[2] <= qm[3] && qm[3] <= qm[4]) || (qm[0] >= qm[1] && qm[1] >= qm[2] && qm[2] >= qm[3] && qm[3] >= qm[4]);
    const p = x => (x * 100).toFixed(2) + '%';
    console.log(`${k.padEnd(10)}  ${m.toFixed(3).padStart(6)}   ${t.toFixed(2).padStart(7)}    ${p(qm[0]).padStart(7)}   ${p(qm[4]).padStart(7)}   ${p(qm[4] - qm[0]).padStart(6)}   ${mono ? 'yes' : 'no'}`);
  }
  console.log('\nIC>0 = higher momentum → higher forward return. |t|>2 ≈ significant. Q5-Q1 = top-minus-bottom quintile excess (3-mo).');
})();
