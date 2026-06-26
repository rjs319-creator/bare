'use strict';
// Phase-2 step 11 — SECTOR MOMENTUM: capture the premium where step 10 proved it lives.
//   node research/11-sector-momentum.js                 (cached data only)
//
// Steps 07-10 showed STOCK-picking alpha is absent on this tier (PEAD dead, quality
// wrong-sign, residual momentum dead) — the only premium is the systematic BETA + SECTOR
// tilt. So test it directly: each month, aggregate the in-band cross-section into ~11
// sectors, rank sectors by their trailing 12-1 momentum, and ask whether sector momentum
// predicts forward sector returns. Two questions:
//   (1) cross-sectional sector rank-IC (does momentum order the sectors?)
//   (2) does TILTING to top sectors beat STATIC equal-weight-sectors (= the small/mid beta)?
// Sector sleeves => far lower turnover, no survivorship, honest representation of the edge.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const FWD = 63, LB = 252, SK = 21;
const GRID = pit.monthEnds('2022-07', '2026-03');
const MIN_NAMES = 8, MIN_SECTORS = 6, TOPN = 3, RT_COST = 0.005;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const m = mean(a), s = sd(a); return (m != null && s) ? m / s * Math.sqrt(a.length) : null; };
function spearman(xs, ys) {
  const n = xs.length; if (n < 4) return null;
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}
function rawMom(ps, idx) { if (idx - LB < 0) return null; const a = ps[idx - LB].close, b = ps[idx - SK].close; return (a > 0 && b > 0) ? b / a - 1 : null; }

(async () => {
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  const recs = [];
  for (const s of Object.keys(sj)) {
    const f = path.join(pit.CACHE, `${s}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 60) continue;
    recs.push({ sym: s, ps, ss: pit.sharesSeries(c.income), sector: sj[s].sector || 'Unknown' });
  }
  console.log(`Loaded ${recs.length} names.\n`);

  const months = [];                                  // {ym, regime, sectors:{sec:{mom,fwd,n}}, allFwd}
  for (const d of GRID) {
    const bySec = {};                                  // sector -> {mom:[], fwd:[]}
    const allFwd = [], allTrail = [];
    for (const r of recs) {
      if (!r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); if (!pa || pa.stale) continue;
      const sh = pit.asOfShares(r.ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const mom = rawMom(r.ps, pa.idx); if (mom == null) continue;
      const b = bySec[r.sector] || (bySec[r.sector] = { mom: [], fwd: [] });
      b.mom.push(mom); b.fwd.push(fr.ret);
      allFwd.push(fr.ret);
      const t0 = Math.max(0, pa.idx - FWD); allTrail.push(r.ps[pa.idx].close / r.ps[t0].close - 1);
    }
    const sectors = {};
    for (const [sec, b] of Object.entries(bySec)) if (b.mom.length >= MIN_NAMES) sectors[sec] = { mom: mean(b.mom), fwd: mean(b.fwd), n: b.mom.length };
    if (Object.keys(sectors).length < MIN_SECTORS) continue;
    months.push({ ym: new Date(d).toISOString().slice(0, 7), regime: (mean(allTrail) || 0) >= 0 ? 'risk-on' : 'risk-off', sectors, allFwd: mean(allFwd) });
  }

  // (1) cross-sectional sector rank-IC
  const secICs = months.map(m => { const e = Object.values(m.sectors); return spearman(e.map(s => s.mom), e.map(s => s.fwd)); }).filter(x => x != null);

  // (2) tilt to top-N sectors vs static all-sector benchmark; long-short top-bottom
  let lsSpread = [], topExcess = [], bench = [], topSets = [];
  for (const m of months) {
    const ord = Object.entries(m.sectors).sort((a, b) => a[1].mom - b[1].mom);   // ascending momentum
    const bot = ord.slice(0, TOPN), top = ord.slice(-TOPN);
    lsSpread.push({ ym: m.ym, regime: m.regime, v: mean(top.map(s => s[1].fwd)) - mean(bot.map(s => s[1].fwd)) });
    topExcess.push(mean(top.map(s => s[1].fwd)) - m.allFwd);
    bench.push(m.allFwd);
    topSets.push(new Set(top.map(s => s[0])));
  }
  // sector-sleeve turnover on quarterly rebalance
  const rebalIdx = months.map((_, i) => i).filter(i => i % 3 === 0); let turn = [];
  for (let i = 1; i < rebalIdx.length; i++) { const cur = topSets[rebalIdx[i]], prev = topSets[rebalIdx[i - 1]]; let kept = 0; for (const s of cur) if (prev.has(s)) kept++; turn.push(1 - kept / cur.size); }
  const avgTurn = mean(turn);

  const p = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  const f = (x, n = 3) => x == null ? 'n/a' : x.toFixed(n);
  const lsV = lsSpread.map(s => s.v);
  const grossLS = mean(lsV), netLS = grossLS - avgTurn * RT_COST;
  const hit = lsV.filter(v => v > 0).length / lsV.length;

  console.log(`=== SECTOR MOMENTUM  (${months.length} months, ${Object.keys(months.at(-1).sectors).length} sectors latest, top/bot ${TOPN}) ===\n`);
  console.log('(1) does momentum ORDER sectors?');
  console.log(`    cross-sectional sector rank-IC: mean ${f(mean(secICs))}  t ${f(tstat(secICs), 2)}  (n=${secICs.length} months)\n`);
  console.log('(2) TILT (top sectors) vs STATIC equal-weight-sectors (= small/mid beta):');
  console.log(`    benchmark (all sectors) fwd-63d:  ${p(mean(bench))}  → ~${p(mean(bench) * 4)}/yr  (the beta itself)`);
  console.log(`    top-${TOPN} excess over benchmark:    ${p(mean(topExcess))}  → ~${p(mean(topExcess) * 4)}/yr  (rotation alpha over static)`);
  console.log(`    top-bot long-short / 63d:         gross ${p(grossLS)}  net ${p(netLS)}  → ~${p(netLS * 4)}/yr`);
  console.log(`    long-short hit-rate: ${(hit * 100).toFixed(0)}%   sleeve turnover/qtr: ${(avgTurn * 100).toFixed(0)}%   LS t-stat: ${f(tstat(lsV), 2)}`);
  console.log('\n[long-short by regime]');
  for (const rg of ['risk-on', 'risk-off']) { const a = lsSpread.filter(s => s.regime === rg).map(s => s.v); console.log(`    ${rg.padEnd(9)} n=${String(a.length).padStart(2)}  mean ${p(mean(a))}  t ${f(tstat(a), 2)}`); }
  console.log('\nCONTEXT: stock-level raw momentum was net +3.81%/yr at 44% turnover. Sector rotation WINS if');
  console.log('it delivers comparable/better net/yr at far lower turnover OR adds clear alpha over static beta.');
  fs.writeFileSync(path.join(DATA, 'sector-momentum.json'), JSON.stringify({ generatedAt: new Date().toISOString(), months: months.length, secIC: mean(secICs), secIC_t: tstat(secICs), benchYr: mean(bench) * 4, topExcessYr: mean(topExcess) * 4, netLSYr: netLS * 4, hit, turn: avgTurn }, null, 0));
})();
