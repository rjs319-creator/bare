'use strict';
// Step 17 — Step-3 additions: max 6 economically-motivated overlays on the 12-1 book.
//   node research/17-additions.js
//
// Each overlay has a hypothesis. Tested quarterly EW-Q5, phase-averaged, full-sample IR/Sharpe
// AND 3-block sub-period IC/IR. KEPT only if it improves the composite AND stays IC-positive in
// ALL sub-periods (no recovery-only mirage). Then the best survivor is hybridized with `ra`.
//
// Overlays:
//  base   : rank m121 (the prior)                                   [control]
//  ra     : rank m121/vol  (vol-scaled momentum)                    H: tames crash-prone hi-vol winners
//  sectneu: rank m121 minus sector-median m121                      H: strip sector bets, stabilize
//  revflt : rank m121, EXCLUDE names with r21 in top 20% (blow-off) H: avoid 1-mo reversal of spikers
//  volconf: rank m121, REQUIRE vs>=1 (rising participation)         H: volume-confirmed trends persist
//  ipoflt : rank m121, EXCLUDE ipo<365d (unseasoned)                H: unseasoned names = noise/IPO churn
//  accel  : rank avg(rankpctl m121, rankpctl acc)                   H: improving momentum > stale momentum
//  ra+sect: hybrid of the two strongest survivors

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const RT_COST = 0.005, FRAC = 0.2, FWD = 'f63', DL = 'd63', STEP = 3, PPY = 4;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rk(xs), ry = rk(ys), m = (n - 1) / 2; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; nu += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? nu / Math.sqrt(dx * dy) : null; }
const pctl = arr => { const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k / (arr.length - 1)); return r; };

// recipe: (rows) -> {sym, score} list over eligible rows (already fwd/dl-filtered)
function recipe(name, rows) {
  const ok = rows.filter(r => r[FWD] != null && r[DL] === 0 && r.m121 != null);
  if (ok.length < 50) return null;
  let pool = ok, scoreOf;
  if (name === 'base') scoreOf = r => r.m121;
  else if (name === 'ra') { pool = ok.filter(r => r.ra != null); scoreOf = r => r.ra; }
  else if (name === 'sectneu') { const bySec = {}; for (const r of ok) (bySec[r.sec] || (bySec[r.sec] = [])).push(r.m121); const med = {}; for (const s in bySec) med[s] = median(bySec[s]); scoreOf = r => r.m121 - med[r.sec]; }
  else if (name === 'revflt') { const r21 = ok.map(r => r.r21 == null ? -Infinity : r.r21); const pr = pctl(r21); pool = ok.filter((r, i) => pr[i] <= 0.8); scoreOf = r => r.m121; }
  else if (name === 'volconf') { pool = ok.filter(r => r.vs != null && r.vs >= 1); scoreOf = r => r.m121; }
  else if (name === 'ipoflt') { pool = ok.filter(r => r.ipo >= 365); scoreOf = r => r.m121; }
  else if (name === 'accel') { const A = ok.filter(r => r.acc != null); if (A.length < 50) return null; const pm = pctl(A.map(r => r.m121)), pa = pctl(A.map(r => r.acc)); pool = A; const sc = new Map(A.map((r, i) => [r.s, (pm[i] + pa[i]) / 2])); scoreOf = r => sc.get(r.s); }
  else if (name === 'ra+sect') { const RA = ok.filter(r => r.ra != null); if (RA.length < 50) return null; const bySec = {}; for (const r of RA) (bySec[r.sec] || (bySec[r.sec] = [])).push(r.ra); const med = {}; for (const s in bySec) med[s] = median(bySec[s]); pool = RA; scoreOf = r => r.ra - med[r.sec]; }
  if (pool.length < 40) return null;
  return { pool, scoreOf };
}
function periodEval(name, rows) {
  const rc = recipe(name, rows); if (!rc) return null;
  const { pool, scoreOf } = rc;
  const ic = spearman(pool.map(scoreOf), pool.map(r => r[FWD]));
  const ord = [...pool].sort((a, b) => scoreOf(a) - scoreOf(b)); const k = Math.max(1, Math.floor(ord.length * FRAC));
  const sel = ord.slice(ord.length - k);
  return { ret: mean(sel.map(r => r[FWD])), bench: mean(pool.map(r => r[FWD])), ic, set: new Set(sel.map(r => r.s)) };
}
function series(panel, months, name, idxList) {
  const rets = [], act = [], ics = []; let prev = null;
  for (const mi of idxList) { const e = periodEval(name, panel[months[mi]]); if (!e) continue; if (e.ic != null) ics.push(e.ic); let to = 1; if (prev) { let kept = 0; for (const s of e.set) if (prev.has(s)) kept++; to = 1 - kept / e.set.size; } rets.push(e.ret - to * RT_COST); act.push(e.ret - e.bench); prev = e.set; }
  if (rets.length < 4) return null;
  let v = 1; for (const r of rets) v *= 1 + r; const annRet = Math.pow(v, PPY / rets.length) - 1; const te = sd(act) * Math.sqrt(PPY);
  return { annRet, sharpe: sd(rets) ? annRet / (sd(rets) * Math.sqrt(PPY)) : null, ir: te ? mean(act) * PPY / te : null, icMean: mean(ics), turnYr: null, n: rets.length };
}
function phaseAvg(panel, months, name, idxPool) { const phs = [0, 1, 2].map(o => series(panel, months, name, idxPool.filter(mi => mi % STEP === o))).filter(Boolean); if (!phs.length) return null; const a = k => mean(phs.map(x => x[k])); return { annRet: a('annRet'), sharpe: a('sharpe'), ir: a('ir'), icMean: a('icMean') }; }

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const allIdx = months.map((_, i) => i);
  const B = 3, blk = Math.ceil(months.length / B), blocks = []; for (let b = 0; b < B; b++) blocks.push(allIdx.slice(b * blk, (b + 1) * blk));
  const NAMES = ['base', 'ra', 'sectneu', 'revflt', 'volconf', 'ipoflt', 'accel', 'ra+sect'];
  const f = (x, n = 2) => x == null ? ' n/a' : x.toFixed(n).padStart(5);
  const p = x => x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%';

  console.log('=== STEP 3 ADDITIONS — quarterly EW-Q5, phase-avg; full-sample + 3-block sub-period ===\n');
  console.log('overlay    fullIR fullShrp fullIC   B1-IC  B2-IC  B3-IC   allPosIC   vsBase(IR)');
  const baseFull = phaseAvg(panel, months, 'base', allIdx);
  for (const nm of NAMES) {
    const full = phaseAvg(panel, months, nm, allIdx); if (!full) { console.log(`${nm.padEnd(9)}  (insufficient)`); continue; }
    const bIC = blocks.map(bi => { const fa = phaseAvg(panel, months, nm, bi); return fa ? fa.icMean : null; });
    const allPos = bIC.every(c => c != null && c > 0);
    const dIR = full.ir != null && baseFull.ir != null ? full.ir - baseFull.ir : null;
    console.log(`${nm.padEnd(9)}  ${f(full.ir)}   ${f(full.sharpe)}  ${f(full.icMean, 3)}   ${bIC.map(c => f(c, 3)).join('  ')}   ${allPos ? 'YES' : 'no '}      ${dIR == null ? 'n/a' : (dIR >= 0 ? '+' : '') + f(dIR)}`);
  }
  console.log('\nACCEPT bar: beat base IR/Sharpe by a meaningful margin AND IC>0 in ALL 3 blocks. Be ruthless —');
  console.log('on ~16 quarters a +0.05 IR bump is noise. Economic rationale must hold, not just the number.');
})();
