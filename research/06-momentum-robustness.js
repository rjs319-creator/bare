'use strict';
// Phase-1 step 06 — is the 12-1 momentum anchor ROBUST, or a one-window mirage?
//   node research/06-momentum-robustness.js              (cached data only)
//
// Splits the cross-sectional 12-1 momentum IC by (a) small-cap regime (cohort
// trailing-return risk-on/off), (b) sequential OOS blocks, (c) calendar year,
// and applies a turnover-based cost haircut to the Q5-Q1 spread. This is the
// make-or-break test the prior arc skipped three times (exits/PEAD/conviction).

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const FWD = 63, LB = 252, SK = 21;
const GRID = pit.monthEnds('2022-07', '2026-03');
const MIN_XS = 40, RT_COST = 0.005;                // 50bps small-cap round-trip per name

function momentum(s, d, lb, sk) { let i = -1; for (let k = 0; k < s.length; k++) { if (s[k].ms <= d) i = k; else break; } if (i - lb < 0 || i - sk < 0) return null; const a = s[i - lb].close, b = s[i - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; }
function trailRet(s, d, n) { let i = -1; for (let k = 0; k < s.length; k++) { if (s[k].ms <= d) i = k; else break; } if (i - n < 0) return null; const a = s[i - n].close; return a > 0 ? s[i].close / a - 1 : null; }
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? num / Math.sqrt(dx * dy) : null; }
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const m = mean(a), s = sd(a); return (m != null && s) ? m / s * Math.sqrt(a.length) : null; };

(async () => {
  const survivors = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const recs = [];
  for (const s of survivors) { const f = path.join(pit.CACHE, `${s}.json`); if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); recs.push({ sym: s, ps: pit.priceSeries(c.price), ss: pit.sharesSeries(c.income) }); } catch {} } }

  const months = [];                                 // {ym, ic, regime, q5set, q5_q1}
  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (r.ps.length < 60 || !r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); const sh = pit.asOfShares(r.ss, d);
      if (!pa || pa.stale || !sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const mom = momentum(r.ps, d, LB, SK); if (mom == null) continue;
      rows.push({ sym: r.sym, mom, fwd: fr.ret, trail: trailRet(r.ps, d, FWD) });
    }
    if (rows.length < MIN_XS) continue;
    const ic = spearman(rows.map(r => r.mom), rows.map(r => r.fwd));
    const regime = (mean(rows.map(r => r.trail).filter(x => x != null)) || 0) >= 0 ? 'risk-on' : 'risk-off';
    const ord = rows.map((r, i) => [r.mom, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    const per = Math.floor(ord.length / 5); const cohortMean = mean(rows.map(r => r.fwd));
    const q5 = ord.slice(4 * per).map(i => rows[i]), q1 = ord.slice(0, per).map(i => rows[i]);
    const q5_q1 = (mean(q5.map(r => r.fwd)) - mean(q1.map(r => r.fwd)));
    months.push({ ym: new Date(d).toISOString().slice(0, 7), ic, regime, q5set: new Set(q5.map(r => r.sym)), q5_q1 });
  }

  const ics = months.map(m => m.ic).filter(x => x != null);
  console.log(`\n12-1 MOMENTUM ROBUSTNESS  (${months.length} months, ${ics.length} with IC)\n`);
  console.log(`OVERALL:  meanIC ${mean(ics).toFixed(3)}  t ${tstat(ics).toFixed(2)}`);

  // (a) regime split
  console.log('\n[by small-cap regime]');
  for (const rg of ['risk-on', 'risk-off']) { const a = months.filter(m => m.regime === rg).map(m => m.ic).filter(x => x != null); console.log(`  ${rg.padEnd(9)} n=${String(a.length).padStart(2)}  meanIC ${mean(a)?.toFixed(3) ?? 'n/a'}  t ${tstat(a)?.toFixed(2) ?? 'n/a'}`); }

  // (b) sequential OOS blocks (robustness — all positive?)
  console.log('\n[sequential blocks — all-positive = robust]');
  const B = 4, sz = Math.ceil(months.length / B);
  for (let b = 0; b < B; b++) { const seg = months.slice(b * sz, (b + 1) * sz); const a = seg.map(m => m.ic).filter(x => x != null); if (a.length) console.log(`  block ${b + 1} (${seg[0].ym}..${seg.at(-1).ym})  meanIC ${mean(a).toFixed(3)}  t ${tstat(a)?.toFixed(2) ?? 'n/a'}`); }

  // (c) turnover + cost haircut on the Q5-Q1 spread (quarterly rebalance ≈ every 3 months)
  let turn = [], rebal = months.filter((_, i) => i % 3 === 0);
  for (let i = 1; i < rebal.length; i++) { const prev = rebal[i - 1].q5set, cur = rebal[i].q5set; let kept = 0; for (const s of cur) if (prev.has(s)) kept++; turn.push(1 - kept / cur.size); }
  const grossQ = mean(months.map(m => m.q5_q1)); const avgTurn = mean(turn);
  const netQ = grossQ - avgTurn * RT_COST;           // cost on the turning fraction, per 63d
  console.log('\n[cost / turnover — quarterly rebalance]');
  console.log(`  gross Q5-Q1 / 63d:   ${(grossQ * 100).toFixed(2)}%`);
  console.log(`  Q5 turnover / quarter: ${(avgTurn * 100).toFixed(0)}%   (cost ${(RT_COST * 100).toFixed(1)}% round-trip)`);
  console.log(`  net Q5-Q1 / 63d:     ${(netQ * 100).toFixed(2)}%   → ~${(netQ * 100 * 4).toFixed(1)}%/yr gross-of-mgmt`);
  console.log('\nVERDICT cues: robust if IC>0 in BOTH regimes AND all sequential blocks positive; deployable if net spread stays clearly >0.');
})();
