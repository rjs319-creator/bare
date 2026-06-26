'use strict';
// Phase-2 step 09 — does QUALITY avoid the DELISTING TAIL? The honest test the
// survivor-only step 08 couldn't do. Now that ~6k non-survivors (incl. delisted)
// are cached, build the cross-section WITH delisted names and a delisting penalty.
//   node research/09-quality-tail.js                    (cached data only)
//
// Q1: are delisted names lower quality than survivors? (quality as distress predictor)
// Q2: would screening OUT the bottom quality bucket have avoided the tail losses?

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const DAY = 86400000, LAG = 45 * DAY, FWD = 63, SHUMWAY = 0.30;
const ACTIVE_CUTOFF = Date.UTC(2026, 3, 1);
const GRID = pit.monthEnds('2022-07', '2026-03');
const MIN_XS = 80;

function fundamentalsAsOf(income, dateMs) {
  const rows = (income || []).map(r => ({ ...r, eff: Date.parse(r.filingDate || r.acceptedDate || r.date) + ((r.filingDate || r.acceptedDate) ? 0 : LAG) }))
    .filter(r => Number.isFinite(r.eff) && r.eff <= dateMs).sort((a, b) => b.eff - a.eff);
  if (!rows.length) return null; const cur = rows[0]; if (!(cur.revenue > 0)) return null;
  const yrAgo = rows[3];
  return { netMargin: cur.netIncome / cur.revenue, opMargin: cur.operatingIncome / cur.revenue, profitable: cur.netIncome > 0 ? 1 : 0,
    dilution: (yrAgo && yrAgo.weightedAverageShsOut > 0) ? cur.weightedAverageShsOut / yrAgo.weightedAverageShsOut - 1 : null };
}
// delisting-aware forward return: active+unelapsed → null(skip); delisted → penalty.
function fwd(ps, dateMs, active) {
  const fr = pit.fwdReturn(ps, dateMs, FWD); if (!fr) return null;
  if (fr.delistedWithin && active) return null;
  return fr.delistedWithin ? (1 + fr.ret) * (1 - SHUMWAY) - 1 : fr.ret;
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';

(async () => {
  const files = fs.readdirSync(pit.CACHE).filter(f => f.endsWith('.json'));
  const recs = [];
  for (const f of files) { try { const c = JSON.parse(fs.readFileSync(path.join(pit.CACHE, f), 'utf8')); const ps = pit.priceSeries(c.price); if (ps.length < 60) continue; recs.push({ ps, ss: pit.sharesSeries(c.income), income: c.income, active: ps[ps.length - 1].ms >= ACTIVE_CUTOFF }); } catch {} }
  console.log(`Loaded ${recs.length} cached names (survivors + delisted sample).\n`);

  // accumulate name-months with quality percentile (within month) + fwd + delisted flag
  let survQ = [], delQ = [];                          // quality scores
  const bucketFwd = [[], [], [], []];                 // fwd return by quality quartile (incl. delistings)
  let delInBottomQ = 0, delTotal = 0;
  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (!r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); const sh = pit.asOfShares(r.ss, d);
      if (!pa || pa.stale || !sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = fwd(r.ps, d, r.active); if (fr == null) continue;
      const fund = fundamentalsAsOf(r.income, d); if (!fund) continue;
      rows.push({ fwd: fr, ...fund, active: r.active });
    }
    if (rows.length < MIN_XS) continue;
    // within-month quality percentile
    const pctlOf = (key, sign) => { const vals = rows.map(x => x[key]).filter(v => v != null).sort((a, b) => a - b); return r => { if (r[key] == null) return 0.5; let lo = 0; for (const v of vals) { if (v < r[key]) lo++; else break; } const p = lo / vals.length; return sign < 0 ? 1 - p : p; }; };
    const fnm = pctlOf('netMargin', 1), fop = pctlOf('opMargin', 1), fdil = pctlOf('dilution', -1);
    for (const r of rows) { r.qual = (fnm(r) + fop(r) + fdil(r) + r.profitable) / 4; (r.active ? survQ : delQ).push(r.qual); }
    // quartiles by quality
    const sorted = [...rows].sort((a, b) => a.qual - b.qual); const per = Math.floor(sorted.length / 4);
    sorted.forEach((r, i) => { const q = Math.min(3, Math.floor(i / per)); bucketFwd[q].push(r.fwd); if (!r.active) { delTotal++; if (q === 0) delInBottomQ++; } });
  }

  console.log('=== Q1: quality of survivors vs delisted (in-band name-months) ===');
  console.log(`  survivor mean quality: ${mean(survQ).toFixed(3)}  (n=${survQ.length})`);
  console.log(`  delisted mean quality: ${mean(delQ).toFixed(3)}  (n=${delQ.length})`);
  console.log(`  → delisted names are ${mean(delQ) < mean(survQ) ? 'LOWER' : 'higher'} quality ${mean(survQ) > mean(delQ) ? '(quality IS a distress predictor ✓)' : ''}`);
  console.log(`  delisted name-months in BOTTOM quality quartile: ${delInBottomQ}/${delTotal} (${(100 * delInBottomQ / (delTotal || 1)).toFixed(0)}%)`);

  console.log('\n=== Q2: forward 63d return by quality quartile (delistings included) ===');
  for (let q = 0; q < 4; q++) console.log(`  Q${q + 1} ${q === 0 ? '(worst quality)' : q === 3 ? '(best quality) ' : '              '}  mean fwd ${pct(mean(bucketFwd[q]))}  (n=${bucketFwd[q].length})`);
  console.log(`\n  tail avoided by screening out bottom quality quartile: ${pct(mean(bucketFwd[0]))} → universe ex-Q1`);
  console.log('Interpretation: if Q1 fwd << Q2-4 once delistings count, a quality floor removes the value-destroying tail = real risk edge.');
})();
