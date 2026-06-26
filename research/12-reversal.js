'use strict';
// Phase-2 step 12 — SHORT-TERM REVERSAL: the last free signal our own data flagged.
//   node research/12-reversal.js                        (cached data only)
//
// Step 05 showed 3-1 momentum = -0.011 (i.e. short-term REVERSAL is present). Reversal
// is the classic orthogonal partner to 12-1 momentum — if it survives realistic small-cap
// costs it is a genuine SECOND return source. But reversal is cost-FRAGILE (1-month holding
// => high turnover, partly bid-ask bounce). So the make-or-break is NET of cost, swept.
//
// Signal = NEGATIVE of the trailing 21-day return (low recent return => buy). Forward horizon
// = 21 days (reversal is a short-horizon effect; monthly rebalance). We measure cross-sectional
// rank-IC, regime split, blocks, orthogonality to 12-1, and a gross→50→100bps cost sweep on Q5-Q1.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const FWD = 21, REV_LB = 21, MOM_LB = 252, MOM_SK = 21;   // reversal: 1-mo signal, 1-mo hold
const GRID = pit.monthEnds('2022-02', '2026-04');          // shorter windows => more months usable
const MIN_XS = 40;
const COSTS = [0, 0.005, 0.01];                            // round-trip cost sweep

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
function trail(ps, idx, lb, sk = 0) { if (idx - lb < 0 || idx - sk < 0) return null; const a = ps[idx - lb].close, b = ps[idx - sk].close; return (a > 0 && b > 0) ? b / a - 1 : null; }

(async () => {
  const survivors = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const recs = [];
  for (const s of survivors) { const f = path.join(pit.CACHE, `${s}.json`); if (!fs.existsSync(f)) continue; try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); recs.push({ sym: s, ps: pit.priceSeries(c.price), ss: pit.sharesSeries(c.income) }); } catch {} }
  console.log(`Loaded ${recs.length} names.\n`);

  const months = [];                                   // {ym, regime, ic, corrMom, q5set, q1set, q5_q1}
  for (const d of GRID) {
    const rows = [];
    for (const r of recs) {
      if (r.ps.length < 60 || !r.ss.length) continue;
      const pa = pit.asOfPriceAdv(r.ps, d); if (!pa || pa.stale) continue;
      const sh = pit.asOfShares(r.ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      const fr = pit.fwdReturn(r.ps, d, FWD); if (!fr || fr.delistedWithin) continue;
      const rev = trail(r.ps, pa.idx, REV_LB); if (rev == null) continue;     // recent 21d return
      const mom = trail(r.ps, pa.idx, MOM_LB, MOM_SK);                          // 12-1 for orthogonality
      rows.push({ sym: r.sym, sig: -rev, fwd: fr.ret, mom, trailReg: rev });
    }
    if (rows.length < MIN_XS) continue;
    const ic = spearman(rows.map(r => r.sig), rows.map(r => r.fwd));
    const M = rows.filter(r => r.mom != null);
    const corrMom = M.length > 10 ? spearman(M.map(r => r.sig), M.map(r => r.mom)) : null;
    const ord = rows.map((r, i) => [r.sig, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    const per = Math.floor(ord.length / 5);
    const q1 = ord.slice(0, per).map(i => rows[i]), q5 = ord.slice(4 * per).map(i => rows[i]);
    months.push({ ym: new Date(d).toISOString().slice(0, 7), regime: (mean(rows.map(r => r.trailReg)) || 0) >= 0 ? 'risk-on' : 'risk-off', ic, corrMom, q5set: new Set(q5.map(r => r.sym)), q5_q1: mean(q5.map(r => r.fwd)) - mean(q1.map(r => r.fwd)) });
  }

  const ics = months.map(m => m.ic).filter(x => x != null);
  const f = (x, n = 3) => x == null ? 'n/a' : x.toFixed(n);
  const p = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  console.log(`=== SHORT-TERM REVERSAL  (1-mo signal, ${FWD}d hold, ${months.length} months, monthly rebal) ===\n`);
  console.log(`overall  meanIC ${f(mean(ics))}  t ${f(tstat(ics), 2)}   (IC>0 ⇒ buying recent LOSERS works = reversal)`);
  const corrs = months.map(m => m.corrMom).filter(x => x != null);
  console.log(`orthogonality to 12-1 momentum: mean rank-corr ${f(mean(corrs))}  (negative/near-0 = independent leg ✓)\n`);

  console.log('[by regime]');
  for (const rg of ['risk-on', 'risk-off']) { const a = months.filter(m => m.regime === rg).map(m => m.ic).filter(x => x != null); console.log(`  ${rg.padEnd(9)} n=${String(a.length).padStart(2)}  meanIC ${f(mean(a))}  t ${f(tstat(a), 2)}`); }

  console.log('\n[sequential blocks — all-positive = robust]');
  const B = 4, sz = Math.ceil(months.length / B);
  for (let b = 0; b < B; b++) { const seg = months.slice(b * sz, (b + 1) * sz); const a = seg.map(m => m.ic).filter(x => x != null); if (a.length) console.log(`  block ${b + 1} (${seg[0].ym}..${seg.at(-1).ym})  meanIC ${f(mean(a))}  t ${f(tstat(a), 2)}`); }

  // turnover (monthly rebalance) + COST SWEEP — the make-or-break
  let turn = []; for (let i = 1; i < months.length; i++) { const cur = months[i].q5set, prev = months[i - 1].q5set; let kept = 0; for (const s of cur) if (prev.has(s)) kept++; turn.push(1 - kept / cur.size); }
  const grossM = mean(months.map(m => m.q5_q1)), avgTurn = mean(turn);
  console.log(`\n[cost sweep — Q5-Q1, monthly rebalance, turnover ${(avgTurn * 100).toFixed(0)}%/mo]`);
  console.log(`  gross Q5-Q1 / ${FWD}d: ${p(grossM)}   → ~${p(grossM * 12)}/yr`);
  for (const c of COSTS) { const net = grossM - avgTurn * c; console.log(`  net @ ${(c * 10000).toFixed(0)}bps round-trip: ${p(net).padStart(7)} / mo  → ~${p(net * 12)}/yr  ${net <= 0 ? '✗ dead' : ''}`); }
  console.log('\nVERDICT: reversal is a real 2nd leg ONLY if IC>0 significant, ~orthogonal to momentum, blocks-positive,');
  console.log('AND net stays >0 at 50-100bps. In small caps the cost line usually kills it — that is the honest test.');
  fs.writeFileSync(path.join(DATA, 'reversal.json'), JSON.stringify({ generatedAt: new Date().toISOString(), months: months.length, meanIC: mean(ics), t: tstat(ics), corrMom: mean(corrs), turn: avgTurn, grossMo: grossM, net50: grossM - avgTurn * 0.005, net100: grossM - avgTurn * 0.01 }, null, 0));
})();
