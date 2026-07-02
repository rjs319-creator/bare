'use strict';
// Step 35 — TUNE the timing-light factor weights from outcomes (the self-improvement core).
//   node research/35-timing-tune.js
//
// The shipped weights (rr .32, extension .24, trend .16, rvol .16, trigger .12) are a hand
// guess. This fits weights from the eval data (research/data/timing-rows.json = 23k graded
// intraday moments with factor values + forward return) by WEIGHTING EACH FACTOR BY ITS OWN
// VALIDATED rank-IC — a principled, non-overfit rule (a factor earns weight only in
// proportion to how much it actually predicts a better entry). Compared OUT OF SAMPLE
// (time-split) against the shipped weights. The winning weights become the seed the LIVE
// adaptive tuner (op=timingtune) starts from and keeps refining on the forward ledger.

const fs = require('fs');
const path = require('path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'timing-rows.json'), 'utf8'));
const FK = ['rr', 'extension', 'trend', 'rvol', 'trigger'];
const SHIPPED = { rr: 0.32, extension: 0.24, trend: 0.16, rvol: 0.16, trigger: 0.12 };

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}
// composite = weighted mean of PRESENT factors, renormalized (mirrors lib/timing.js).
function composite(f, W) {
  let num = 0, den = 0;
  for (const k of FK) if (f[k] != null) { num += W[k] * f[k]; den += W[k]; }
  return den > 0 ? num / den : 0.4;
}

rows.sort((a, b) => (a.date < b.date ? -1 : 1));
const cut = Math.floor(rows.length * 0.70);
const tr = rows.slice(0, cut), te = rows.slice(cut);
console.log(`${rows.length} rows | train ${tr.length} (${tr[0].date}..${tr[cut - 1] && tr[cut - 1].date}) | test ${te.length}`);

// per-factor validated IC on TRAIN (only where the factor is present)
console.log(`\nper-factor rank-IC vs forward return (train):`);
const factorIC = {};
for (const k of FK) {
  const sub = tr.filter(r => r.f[k] != null);
  const ic = spearman(sub.map(r => r.f[k]), sub.map(r => r.fwd));
  factorIC[k] = ic || 0;
  console.log(`  ${k.padEnd(10)} IC ${ic == null ? 'n/a' : (ic >= 0 ? '+' : '') + ic.toFixed(4)}  (n=${sub.length}, present ${(100 * sub.length / tr.length).toFixed(0)}%)`);
}

// IC-proportional weights: a factor earns weight ∝ max(0, its train IC). Blend 50/50 with
// the shipped prior so a noisy zero-IC factor isn't fully dropped (shrinkage = robustness).
const posSum = FK.reduce((s, k) => s + Math.max(0, factorIC[k]), 0) || 1;
const fitted = {};
for (const k of FK) {
  const dataW = Math.max(0, factorIC[k]) / posSum;
  fitted[k] = +(0.5 * dataW + 0.5 * SHIPPED[k]).toFixed(3);
}
const fsum = FK.reduce((s, k) => s + fitted[k], 0);
for (const k of FK) fitted[k] = +(fitted[k] / fsum).toFixed(3);

// OOS comparison
const icShipped = spearman(te.map(r => composite(r.f, SHIPPED)), te.map(r => r.fwd));
const icFitted = spearman(te.map(r => composite(r.f, fitted)), te.map(r => r.fwd));
const icGrade = spearman(te.map(r => r.grade), te.map(r => r.fwd));   // the actual shipped 1-10 grade (incl. gates)
console.log(`\nshipped hand-weights: ${JSON.stringify(SHIPPED)}`);
console.log(`fitted (IC-weighted): ${JSON.stringify(fitted)}`);
console.log(`\n=== OUT-OF-SAMPLE composite rank-IC vs forward return ===`);
console.log(`  shipped weights   ${icShipped == null ? 'n/a' : (icShipped >= 0 ? '+' : '') + icShipped.toFixed(4)}`);
console.log(`  fitted weights    ${icFitted == null ? 'n/a' : (icFitted >= 0 ? '+' : '') + icFitted.toFixed(4)}   delta ${((icFitted - icShipped) >= 0 ? '+' : '') + (icFitted - icShipped).toFixed(4)}`);
console.log(`  (full 1-10 grade incl. reality-gates: ${(icGrade >= 0 ? '+' : '') + icGrade.toFixed(4)})`);

// green/amber/red monotonicity under fitted weights (composite → 1-10 like timing.js)
const toGrade = c => Math.max(1, Math.min(10, Math.round(c * 9 + 1)));
const bucket = (rowset, W, lo, hi) => { const s = rowset.filter(r => { const g = toGrade(composite(r.f, W)); return g >= lo && g <= hi; }); return { n: s.length, fwd: mean(s.map(r => r.fwd)) }; };
console.log(`\nOOS mean forward return by grade bucket (fitted weights):`);
for (const [lo, hi, lbl] of [[7, 10, 'green'], [4, 6, 'amber'], [1, 3, 'red']]) { const b = bucket(te, fitted, lo, hi); console.log(`  ${lbl.padEnd(6)} n=${String(b.n).padStart(6)}  fwd ${(b.fwd * 100).toFixed(3)}%`); }

const better = icFitted > icShipped + 0.003;
console.log(`\nVERDICT: ${better ? 'FITTED weights beat shipped OOS → adopt as the new default + seed the live tuner.' : 'fitted ≈ shipped OOS → keep shipped; the factors are already reasonably weighted (tuner stays dormant until the live ledger says otherwise).'}`);
fs.writeFileSync(path.join(__dirname, 'data', 'timing-weights.json'), JSON.stringify({
  factorIC, shipped: SHIPPED, fitted, oos: { icShipped, icFitted, icGrade }, adopt: better,
}, null, 1));
console.log('saved → research/data/timing-weights.json');
