'use strict';
// Step 34 — EVALUATE the entry-timing light (lib/timing.js scoreTiming) against outcomes.
//   node --env-file=research/.env research/34-timing-eval.js [maxSignals]
//
// The timing grade (1-10 🟢/🟡/🔴) claims to mark "a good MOMENT to buy right now". It has
// never been checked. This replays the EXACT shipped scoreTiming over historical 5-min
// intraday: for each day-trade signal, at every intraday bar of the ENTRY session it builds
// the same snapshot the live app builds and grades it, then measures the FORWARD return from
// that bar. Question: does a higher grade actually precede a better entry (higher forward
// return / better trade outcome)? If yes, the grade is worth being accountable for + tuning;
// if not, that's the honest finding.
//
// Reuses lib/timing.js + lib/daytrade.js directly (no re-implementation → no divergence).

const fs = require('fs');
const path = require('path');
const { scoreTiming } = require('../lib/timing');
const dt = require('../lib/daytrade');

const CACHE = path.join(__dirname, 'data', 'cache');       // corrected daily cache (signal source)
const I5 = path.join(__dirname, 'data', 'intra5');         // our 5-min cache for the eval
const KEY = process.env.FMP_API_KEY;
const MAX = Number(process.argv[2]) || 500;
const FWD_BARS = 12;                                        // ~1h forward from the graded bar
fs.mkdirSync(I5, { recursive: true });

async function intraday(sym, day) {
  const f = path.join(I5, `${sym}_${day}.json`);
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  const url = `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${sym}&from=${day}&to=${day}&apikey=${KEY}`;
  let rows = [];
  try { const r = await fetch(url); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) rows = j; } } catch {}
  rows = rows.slice().reverse();                            // FMP returns newest-first → chronological
  fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}

// Generate momentum_liquid day-trade signals (ticker/date/levels) from the corrected cache.
function buildSignals() {
  const sigs = [];
  const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.json'));
  for (const f of files) {
    let c; try { c = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch { continue; }
    const p = (c.price || []).filter(b => b.close && b.volume != null && b.open);
    if (p.length < 40) continue;
    const cl = p.map(b => b.close), vol = p.map(b => b.volume), dts = p.map(b => b.date);
    for (let i = 25; i < p.length - 1; i++) {
      if (dts[i] < '2024-01-01' || dts[i] > '2025-12-15') continue;   // window with FMP 5min + fwd day
      const prev = cl[i - 1]; if (!(prev > 0)) continue;
      const pct = (cl[i] - prev) / prev * 100;
      const av = mean(vol.slice(i - 20, i)); const relv = av > 0 ? vol[i] / av : 0;
      const dvol = mean(p.slice(i - 20, i).map(b => b.close * b.volume));
      if (!(cl[i] >= 5 && cl[i] <= 50 && av >= 1e6 && dvol >= 1e7 && relv >= 1.5 && pct >= 5)) continue;
      if (Math.abs(pct) > 25 && relv < 2) continue;                  // split-artifact guard
      const slice = p.slice(0, i + 1);
      const lv = dt.tradeLevels(slice, { stopAtrMult: 2.5, useLowFloor: false });
      const orb = dt.orbLevels(slice);
      if (!lv) continue;
      sigs.push({ sym: c.sym || f.slice(0, -5), sigDate: dts[i], entryDate: dts[i + 1],
        stop: lv.stop, target: lv.target, trigger: orb ? orb.trigger : lv.entry, avgVol: av });
    }
  }
  return sigs;
}

(async () => {
  if (!KEY) { console.error('run with node --env-file=research/.env'); process.exit(1); }
  let sigs = buildSignals();
  console.log(`generated ${sigs.length} momentum_liquid signals (2024–2025)`);
  const step = Math.max(1, Math.floor(sigs.length / MAX));
  sigs = sigs.filter((_, i) => i % step === 0).slice(0, MAX);
  console.log(`evaluating ${sigs.length} (stride ${step}); replaying scoreTiming per intraday bar…`);

  const rows = [];   // {grade, fwd, hitHigh}
  let done = 0;
  for (const s of sigs) {
    const bars = await intraday(s.sym, s.entryDate);
    if (!bars || bars.length < 20) continue;
    if (++done % 100 === 0) process.stdout.write(`  ${done}/${sigs.length}\n`);
    let cumPV = 0, cumV = 0, hi = -Infinity, lo = Infinity;
    const closes = bars.map(b => b.close);
    const dayHighFull = Math.max(...bars.map(b => b.high));
    for (let i = 0; i < bars.length - FWD_BARS; i++) {
      const b = bars[i];
      hi = Math.max(hi, b.high); lo = Math.min(lo, b.low);
      cumPV += ((b.high + b.low + b.close) / 3) * (b.volume || 0); cumV += b.volume || 0;
      if (i < 4) continue;                                         // need a few bars for vwap/range
      const elapsedFrac = Math.max(0.05, Math.min(1, (i + 1) / 78));
      const snapshot = {
        price: b.close, dayOpen: bars[0].open, dayHigh: hi, dayLow: lo,
        prevClose: bars[0].open,                                    // proxy (no prior close in this fetch)
        vwap: cumV > 0 ? cumPV / cumV : b.close,
        rvol: s.avgVol > 0 ? cumV / (s.avgVol * elapsedFrac) : null,
        marketState: 'REGULAR',
      };
      const g = scoreTiming(snapshot, { stop: s.stop, target: s.target, trigger: s.trigger, avgVol: s.avgVol });
      if (g.score == null) continue;
      const fwd = closes[i + FWD_BARS] / b.close - 1;              // forward ~1h return from this moment
      rows.push({ grade: g.score, fwd, hitHigh: b.close >= dayHighFull * 0.999 ? 1 : 0,
        f: g.factors, date: s.entryDate });                        // factor values → for the weight tuner (step 35)
    }
  }
  console.log(`\n=== ${rows.length} graded intraday moments ===`);
  const g = rows.map(r => r.grade), fwd = rows.map(r => r.fwd);
  const ic = spearman(g, fwd);
  console.log(`grade → forward-${FWD_BARS*5}min return  rank-IC: ${ic == null ? 'n/a' : ic.toFixed(4)}`);
  console.log(`\nmean forward return by grade bucket:`);
  const bucket = (lo, hi, lbl) => { const sub = rows.filter(r => r.grade >= lo && r.grade <= hi); if (sub.length) console.log(`  ${lbl.padEnd(14)} n=${String(sub.length).padStart(6)}  fwd ${(mean(sub.map(r => r.fwd)) * 100).toFixed(3)}%  (avg grade ${mean(sub.map(r => r.grade)).toFixed(1)})`); };
  bucket(7, 10, '🟢 green 7-10'); bucket(4, 6, '🟡 amber 4-6'); bucket(1, 3, '🔴 red 1-3');
  console.log(`\nby individual grade:`);
  for (let s = 10; s >= 1; s--) { const sub = rows.filter(r => r.grade === s); if (sub.length >= 20) console.log(`  grade ${String(s).padStart(2)}: n=${String(sub.length).padStart(6)}  fwd ${(mean(sub.map(r => r.fwd)) * 100).toFixed(3)}%`); }
  const green = rows.filter(r => r.grade >= 7), red = rows.filter(r => r.grade <= 3);
  const spread = mean(green.map(r => r.fwd)) - mean(red.map(r => r.fwd));
  console.log(`\ngreen − red forward-return spread: ${(spread * 100).toFixed(3)}%  (green n=${green.length}, red n=${red.length})`);
  console.log(`VERDICT: grade is predictive if IC>0 AND green>amber>red monotone AND green−red spread>0.`);
  fs.writeFileSync(path.join(__dirname, 'data', 'timing-eval.json'), JSON.stringify({
    n: rows.length, ic, greenRedSpread: spread,
    byBucket: { green: mean(green.map(r => r.fwd)), amber: mean(rows.filter(r => r.grade >= 4 && r.grade <= 6).map(r => r.fwd)), red: mean(red.map(r => r.fwd)) },
  }, null, 1));
  // full per-moment factor rows for the weight tuner (step 35)
  fs.writeFileSync(path.join(__dirname, 'data', 'timing-rows.json'), JSON.stringify(rows));
  console.log(`saved ${rows.length} factor rows → research/data/timing-rows.json`);
})();
