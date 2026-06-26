'use strict';
// Step 20 — do the strong pockets SURVIVE sub-period + bootstrap, or are they recovery-driven?
//   node research/20-concentrated.js
//
// Tests the credible concentrated versions (and a parsimonious combined "stable mid-core")
// vs FULL: full-sample metrics, 3-block sub-period IR/IC stability, and a block-bootstrap
// 95% CI on the full-sample mean quarterly excess (is in-pocket selection skill reliably >0?).
// HALE: a pocket only counts if its edge is positive in ALL sub-periods AND CI excludes 0.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const FRAC = 0.2, FWD = 'f63', DL = 'd63', STEP = 3, PPY = 4, COST = 0.005, MIN_SLICE = 40, MIN_BOOK = 12;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function spearman(xs, ys) { const n = xs.length; if (n < 5) return null; const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rk(xs), ry = rk(ys), m = (n - 1) / 2; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; nu += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? nu / Math.sqrt(dx * dy) : null; }

function bookOf(rows) {
  const ok = rows.filter(r => r[FWD] != null && r[DL] === 0 && r.m121 != null);
  if (ok.length < MIN_SLICE) return null;
  const bs = {}; for (const r of ok) (bs[r.sec] || (bs[r.sec] = [])).push(r.m121);
  const md = {}; for (const s in bs) md[s] = median(bs[s]); const score = r => r.m121 - md[r.sec];
  const ic = spearman(ok.map(score), ok.map(r => r[FWD]));
  const ord = [...ok].sort((a, b) => score(a) - score(b)); const k = Math.max(1, Math.floor(ok.length * FRAC));
  return { sel: ord.slice(ord.length - k), bench: mean(ok.map(r => r[FWD])), ic, book: k };
}
// returns phase-0 paired quarterly excess series + book sizes + ics for one slice over an index list
function excessSeries(panel, months, sliceFn, idxList) {
  const ex = [], ics = [], books = []; let prev = null, rets = [];
  for (const mi of idxList) {
    const b = bookOf(sliceFn(panel[months[mi]])); if (!b || b.book < MIN_BOOK) continue;
    const set = new Set(b.sel.map(r => r.s)); let to = 1; if (prev) { let kept = 0; for (const s of set) if (prev.has(s)) kept++; to = 1 - kept / set.size; }
    const g = mean(b.sel.map(r => r[FWD]));
    ex.push(g - b.bench); rets.push(g - to * COST); if (b.ic != null) ics.push(b.ic); books.push(b.book); prev = set;
  }
  return { ex, ics, books, rets };
}
function fullMetrics(panel, months, sliceFn) {
  const ph = [0, 1, 2].map(o => excessSeries(panel, months, sliceFn, months.map((_, i) => i).filter(i => i % STEP === o))).filter(x => x.rets.length >= 8);
  if (!ph.length) return null;
  const m = arr => { let v = 1, eq = []; for (const r of arr) { v *= 1 + r; eq.push(v); } const annRet = Math.pow(v, PPY / arr.length) - 1, annVol = sd(arr) * Math.sqrt(PPY); let peak = -Infinity, mdd = 0; for (const e of eq) { if (e > peak) peak = e; mdd = Math.min(mdd, e / peak - 1); } return { annRet, sharpe: annVol ? annRet / annVol : null, mdd }; };
  const perf = ph.map(p => m(p.rets)); const irOf = p => { const te = sd(p.ex) * Math.sqrt(PPY); return te ? mean(p.ex) * PPY / te : null; };
  return { annRet: mean(perf.map(x => x.annRet)), sharpe: mean(perf.map(x => x.sharpe)), mdd: mean(perf.map(x => x.mdd)), ir: mean(ph.map(irOf)), ic: mean(ph.map(p => mean(p.ics))), book: mean(ph.map(p => mean(p.books))) };
}

(async () => {
  const { months, panel } = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const allIdx = months.map((_, i) => i);
  const terc = (rows, key, drop) => { const v = rows.map(r => r[key]).filter(x => x != null).sort((a, b) => a - b); if (v.length < 30) return rows; const hi = v[Math.floor(2 * v.length / 3)]; return drop === 'hi' ? rows.filter(r => r[key] != null && r[key] < hi) : rows; };

  const VERSIONS = [
    ['FULL', r => r],
    ['cap 2-5B', r => r.filter(x => x.cap >= 2e9 && x.cap < 5e9)],
    ['cap 800M-5B', r => r.filter(x => x.cap >= 800e6 && x.cap < 5e9)],
    ['adv 10-30M', r => r.filter(x => x.adv >= 10e6 && x.adv < 30e6)],
    ['vol-LOW', r => { const v = r.map(x => x.v63).filter(x => x != null).sort((a, b) => a - b); if (v.length < 30) return []; const lo = v[Math.floor(v.length / 3)]; return r.filter(x => x.v63 != null && x.v63 <= lo); }],
    // parsimonious combined "stable liquid mid-core": cap 800M-5B, ex-high-vol, ex-Healthcare
    ['STABLE-CORE', r => terc(r.filter(x => x.cap >= 800e6 && x.cap < 5e9 && x.sec !== 'Healthcare'), 'v63', 'hi')],
    // broader: cap 800M-5B + adv>=10M (liquid mid)
    ['LIQ-MID', r => r.filter(x => x.cap >= 800e6 && x.cap < 5e9 && x.adv >= 10e6)],
  ];

  const f = (x, n = 2) => x == null ? '  n/a' : x.toFixed(n).padStart(6);
  const p = x => x == null ? '   n/a' : (x * 100).toFixed(1).padStart(6) + '%';
  const B = 3, blk = Math.ceil(months.length / B), blocks = []; for (let b = 0; b < B; b++) blocks.push(allIdx.slice(b * blk, (b + 1) * blk));

  console.log('=== CONCENTRATED VERSIONS — full-sample + 3-block sub-period stability ===\n');
  console.log('version       annRet  Sharpe    IR    maxDD   IC    book |  B1-IR B2-IR B3-IR  allPos | B1-IC B2-IC B3-IC');
  const keep = [];
  for (const [nm, fn] of VERSIONS) {
    const m = fullMetrics(panel, months, fn); if (!m) { console.log(`${nm.padEnd(13)} (insufficient)`); continue; }
    // sub-period: restrict idx to block
    const subs = blocks.map(bi => { const ph = [0, 1, 2].map(o => excessSeries(panel, months, fn, bi.filter(mi => mi % STEP === o))).filter(x => x.ex.length >= 2); if (!ph.length) return null; const irOf = q => { const te = sd(q.ex) * Math.sqrt(PPY); return te ? mean(q.ex) * PPY / te : null; }; return { ir: mean(ph.map(irOf)), ic: mean(ph.map(q => mean(q.ics))) }; });
    const allPos = subs.every(s => s && s.ir > 0);
    console.log(`${nm.padEnd(13)} ${p(m.annRet)}  ${f(m.sharpe)}  ${f(m.ir)}  ${p(m.mdd)} ${f(m.ic, 3)} ${String(Math.round(m.book)).padStart(4)} | ${subs.map(s => f(s?.ir)).join(' ')}   ${allPos ? 'YES' : 'no '}  | ${subs.map(s => f(s?.ic, 3)).join(' ')}`);
    keep.push({ nm, fn, ...m, allPos });
  }

  // bootstrap CI on full-sample mean quarterly excess (phase-0) for the survivors + FULL
  console.log('\n=== BLOCK-BOOTSTRAP: is in-pocket mean quarterly EXCESS > 0? (phase-0, 5000x, block=2) ===\n');
  for (const k of keep) {
    const s = excessSeries(panel, months, k.fn, allIdx.filter(i => i % STEP === 0)); const d = s.ex; const n = d.length; if (n < 8) { console.log(`${k.nm.padEnd(13)} too few quarters`); continue; }
    const R = 5000, BL = 2, boot = [];
    for (let r = 0; r < R; r++) { let a = [], len = 0; while (len < n) { const st = Math.floor(Math.random() * (n - BL + 1)); for (let j = 0; j < BL && len < n; j++) { a.push(d[st + j]); len++; } } boot.push(mean(a)); }
    boot.sort((x, y) => x - y); const lo = boot[Math.floor(0.025 * R)], hi = boot[Math.floor(0.975 * R)], pPos = boot.filter(v => v > 0).length / R;
    console.log(`${k.nm.padEnd(13)} mean ${p(mean(d))}/q  t ${f(sd(d) ? mean(d) / sd(d) * Math.sqrt(n) : null)}  95%CI [${p(lo)},${p(hi)}]  P(>0) ${(pPos * 100).toFixed(0)}%  ${lo > 0 ? 'EXCLUDES 0 ✓' : 'includes 0'}`);
  }
  console.log('\nHALE: a real pocket = allPos sub-period IR + bootstrap CI excludes 0 + economic sense + non-thin book.');
})();
