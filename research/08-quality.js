'use strict';
// Phase-2 step 08 — QUALITY/DISTRESS filter + the momentum×quality INTERACTION.
//   node research/08-quality.js                         (cached data only)
//
// PIT quality from the latest FILED quarter: profitability (net/op margin),
// and share dilution (YoY share-count growth — cash-burn financing = the small-cap
// distress tell). Tests (a) does quality predict forward returns, and (b) the
// agreement test: within high-momentum names, does high quality beat low quality?
// If yes, "momentum confirmed by quality" is a real combination edge, not additive noise.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const DAY = 86400000, LAG = 45 * DAY, FWD = 63;
const GRID = pit.monthEnds('2022-07', '2026-03');
const MIN_XS = 60;

function fundamentalsAsOf(income, dateMs) {
  const rows = (income || []).map(r => ({ ...r, eff: Date.parse(r.filingDate || r.acceptedDate || r.date) + ((r.filingDate || r.acceptedDate) ? 0 : LAG) }))
    .filter(r => Number.isFinite(r.eff) && r.eff <= dateMs).sort((a, b) => b.eff - a.eff);
  if (!rows.length) return null;
  const cur = rows[0]; if (!(cur.revenue > 0)) return null;
  const yrAgo = rows[3];                              // ~4 quarters back in the filed set
  return {
    netMargin: cur.netIncome / cur.revenue,
    opMargin: cur.operatingIncome / cur.revenue,
    profitable: cur.netIncome > 0 ? 1 : 0,
    dilution: (yrAgo && yrAgo.weightedAverageShsOut > 0) ? cur.weightedAverageShsOut / yrAgo.weightedAverageShsOut - 1 : null,
  };
}
function mom(s, ms) { let i = -1; for (let k = 0; k < s.length; k++) { if (s[k].ms <= ms) i = k; else break; } if (i - 252 < 0 || i - 21 < 0) return null; const a = s[i - 252].close, b = s[i - 21].close; return (a > 0 && b > 0) ? b / a - 1 : null; }
function spearman(xs, ys) { const n = xs.length; if (n < 10) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? num / Math.sqrt(dx * dy) : null; }
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tert = (v, lo, hi) => v <= lo ? 0 : v >= hi ? 2 : 1;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';

(async () => {
  const syms = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const recs = [];
  for (const s of syms) { const f = path.join(pit.CACHE, `${s}.json`); if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); recs.push({ ps: pit.priceSeries(c.price), income: c.income }); } catch {} } }

  const qIC = [];                                    // monthly IC(quality, fwd)
  const grid = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => []));  // [momTert][qualTert] -> fwd
  let monthsUsed = 0;

  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (r.ps.length < 60) continue;
      const pa = pit.asOfPriceAdv(r.ps, d), ss = pit.sharesSeries(r.income); if (!pa || pa.stale || !ss.length) continue;
      const sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const m = mom(r.ps, d); const fund = fundamentalsAsOf(r.income, d);
      if (m == null || !fund) continue;
      // quality composite = profitability + low-dilution (cross-sectional rank later)
      rows.push({ m, fwd: fr.ret, netMargin: fund.netMargin, opMargin: fund.opMargin, profitable: fund.profitable, dilution: fund.dilution });
    }
    if (rows.length < MIN_XS) continue;
    monthsUsed++;
    // within-month quality score = avg of percentile(netMargin↑), percentile(opMargin↑), percentile(-dilution↑), profitable
    const pctlOf = (key, sign) => { const vals = rows.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b); return r => { if (r[key] == null) return 0.5; let lo = 0; for (const v of vals) { if (v < r[key]) lo++; else break; } return sign * (lo / vals.length) + (sign < 0 ? 1 : 0); }; };
    const fnm = pctlOf('netMargin', 1), fop = pctlOf('opMargin', 1), fdil = pctlOf('dilution', -1);
    for (const r of rows) r.qual = (fnm(r) + fop(r) + fdil(r) + r.profitable) / 4;
    const ic = spearman(rows.map(r => r.qual), rows.map(r => r.fwd)); if (ic != null) qIC.push(ic);
    // momentum × quality double-sort terciles
    const ms = rows.map(r => r.m).sort((a, b) => a - b), qs = rows.map(r => r.qual).sort((a, b) => a - b);
    const mLo = quantile(ms, 1 / 3), mHi = quantile(ms, 2 / 3), qLo = quantile(qs, 1 / 3), qHi = quantile(qs, 2 / 3);
    const cohort = mean(rows.map(r => r.fwd));
    for (const r of rows) grid[tert(r.m, mLo, mHi)][tert(r.qual, qLo, qHi)].push(r.fwd - cohort);
  }

  console.log(`\n=== QUALITY + MOMENTUM×QUALITY  (${monthsUsed} months) ===\n`);
  const t = (mean(qIC) != null && sd(qIC)) ? mean(qIC) / sd(qIC) * Math.sqrt(qIC.length) : null;
  console.log(`quality → fwd 63d:  IC ${mean(qIC).toFixed(3)}  t ${t.toFixed(2)}\n`);
  console.log('excess fwd-63d by [momentum tercile][quality tercile]  (cohort-demeaned):');
  console.log('              qual-Lo   qual-Mid  qual-Hi');
  for (let mi = 2; mi >= 0; mi--) console.log(`  mom-${['Lo', 'Mid', 'Hi'][mi]}      ` + [0, 1, 2].map(qi => pct(mean(grid[mi][qi])).padStart(8)).join('  '));
  const hiHi = mean(grid[2][2]), hiLo = mean(grid[2][0]);
  console.log(`\nAGREEMENT TEST: high-mom × high-qual ${pct(hiHi)}  vs  high-mom × low-qual ${pct(hiLo)}  → quality adds ${pct(hiHi - hiLo)} within winners`);
  console.log('Interpretation: if hi-mom×hi-qual >> hi-mom×lo-qual, quality filters junk momentum = a real combination edge.');
})();
