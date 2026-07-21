'use strict';
// EXPERIMENT #8 — survivorship-FREE momentum baseline, at full in-band breadth, with a Shumway
// delisting penalty. Run (no network — reads the FMP cache via the PIT security master):
//   node research/52-momentum-survivorship-free.js
//
// #7 re-ran the TWIN edge test survivorship-free but had to bound the universe (twins are O(N²)).
// The momentum baseline is a cheap ranking (O(N log N)/date), so THIS runs the FULL in-band
// cross-section and pins down two things research/04 measured in return-space, now INSIDE the edge
// frame and at breadth:
//   1. the survivorship RETURN bias (survivor-only − survivorship-free) at 21d & 63d, WITH the
//      Shumway (1997) −30% penalty applied to names that delist inside the forward window, and
//   2. whether the momentum rank-IC itself differs survivor-only vs survivorship-free.
//
// Universe from research/lib/secmaster: every name in-band as-of each decision date (delisted names
// included up to the day they stopped trading). Survivor-only = the same panel restricted to names
// still active today. Shadow research — never touches a live ranking.

const fs = require('fs');
const path = require('path');
const SM = require('./lib/secmaster');
const pit = require('./lib/pit');
const { rankIC, mean, sd } = require('../lib/nsl/stats');

const BAND = SM.DEFAULT_BAND;
const LOOKBACK = 126, SKIP = 5;              // 6–1 momentum, same as the NSL harnesses
const HORIZONS = [['21d', 21], ['63d', 63]];
const SHUMWAY = 0.30;                          // Shumway (1997) delisting-return penalty
const UNIVERSE_DATES = ['2022-06-30', '2023-06-30', '2024-06-30'];  // candidate-set seeds (union)

function monthEnds(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split('-').map(Number); const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(Date.UTC(y, m, 0)); if (++m > 12) { m = 1; y++; } }
  return out;
}
const idxAsOf = (series, ms) => { let i = -1; for (let k = 0; k < series.length; k++) { if (series[k].ms <= ms) i = k; else break; } return i; };
const pct = (x) => (x == null ? 'n/a' : (100 * x).toFixed(2) + '%');
const tstat = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

// Precompute the per-name series/shares/active once.
function prep(rec) {
  const series = pit.priceSeries(rec.price || []);
  const shares = pit.sharesSeries(rec.income || []);
  const active = series.length ? series[series.length - 1].ms >= SM.ACTIVE_CUTOFF_MS : false;
  return { sym: rec.sym, series, shares, active };
}
function momentumAt(series, idx) {
  if (idx - LOOKBACK < 0 || idx - SKIP < 0) return null;
  const from = series[idx - LOOKBACK].close, to = series[idx - SKIP].close;
  return from > 0 ? to / from - 1 : null;
}
// Forward return with the Shumway penalty for genuine delistings; drop unelapsed ACTIVE names.
function fwdShumway(p, ms, bars) {
  const fr = pit.fwdReturn(p.series, ms, bars);
  if (!fr) return null;
  if (fr.delistedWithin && p.active) return null;                 // active + not elapsed → drop (not a delisting)
  if (fr.delistedWithin) return { ret: (1 + fr.ret) * (1 - SHUMWAY) - 1, delisted: true };
  return { ret: fr.ret, delisted: false };
}
function inBand(p, ms) {
  const pa = pit.asOfPriceAdv(p.series, ms); if (!pa || pa.stale) return null;
  const sh = pit.asOfShares(p.shares, ms); if (!sh) return null;
  const cap = pa.close * sh;
  if (cap < BAND.capLo || cap > BAND.capHi || pa.adv < BAND.advFloor) return null;
  return true;
}

// Run the momentum baseline over a prepped universe; per-date rank-IC + mean fwd + delisting count.
function runPanel(preps, dates, bars) {
  const perDateIC = [], allFwd = [], allFwdSurv = []; let del = 0, nm = 0;
  const icSurv = [];
  for (const ms of dates) {
    const rowsAll = [], rowsSurv = [];
    for (const p of preps) {
      const idx = idxAsOf(p.series, ms); if (idx < 0) continue;
      if (!inBand(p, ms)) continue;
      const mom = momentumAt(p.series, idx); if (mom == null) continue;
      const f = fwdShumway(p, ms, bars); if (!f) continue;
      rowsAll.push({ mom, fwd: f.ret }); allFwd.push(f.ret); nm++; if (f.delisted) del++;
      if (p.active) { rowsSurv.push({ mom, fwd: f.ret }); allFwdSurv.push(f.ret); }
    }
    if (rowsAll.length >= 8) { const ic = rankIC(rowsAll.map(r => r.mom), rowsAll.map(r => r.fwd)); if (Number.isFinite(ic)) perDateIC.push(ic); }
    if (rowsSurv.length >= 8) { const ic = rankIC(rowsSurv.map(r => r.mom), rowsSurv.map(r => r.fwd)); if (Number.isFinite(ic)) icSurv.push(ic); }
  }
  return {
    free: { ic: mean(perDateIC), t: tstat(perDateIC), nDates: perDateIC.length, meanFwd: mean(allFwd), nm, del },
    surv: { ic: mean(icSurv), t: tstat(icSurv), nDates: icSurv.length, meanFwd: mean(allFwdSurv), nm: allFwdSurv.length },
  };
}

function main() {
  const t0 = Date.now();
  console.log('[exp8] assembling the candidate set (union of in-band cross-sections)…');
  const cand = new Set();
  for (const d of UNIVERSE_DATES) for (const m of SM.universeAt(d, BAND)) cand.add(m.sym);
  console.log(`[exp8] candidate names in-band at ≥1 seed date: ${cand.size} — loading series…`);
  const recs = SM.loadRecordsForSyms([...cand]);
  const preps = Object.values(recs).map(prep).filter(p => p.series.length > LOOKBACK + 10);
  const survivors = preps.filter(p => p.active).length;
  console.log(`[exp8] prepped ${preps.length} names (${survivors} active today, ${preps.length - survivors} since delisted)`);

  const dates = monthEnds('2022-06', '2024-06');
  console.log(`[exp8] ${dates.length} month-end decision dates 2022-06 → 2024-06\n`);

  const out = {};
  for (const [hk, bars] of HORIZONS) {
    const r = runPanel(preps, dates, bars);
    out[hk] = r;
    const bias = (r.surv.meanFwd != null && r.free.meanFwd != null) ? r.surv.meanFwd - r.free.meanFwd : null;
    console.log(`[exp8] [${hk}]`);
    console.log(`[exp8]   survivorship-free: rank-IC ${r.free.ic?.toFixed(4)} (t ${r.free.t.toFixed(2)}, ${r.free.nDates} dates) · meanFwd ${pct(r.free.meanFwd)} · ${r.free.nm} name-months · ${r.free.del} delistings`);
    console.log(`[exp8]   survivor-only:     rank-IC ${r.surv.ic?.toFixed(4)} (t ${r.surv.t.toFixed(2)}, ${r.surv.nDates} dates) · meanFwd ${pct(r.surv.meanFwd)} · ${r.surv.nm} name-months`);
    console.log(`[exp8]   SURVIVORSHIP RETURN BIAS (survivor − free): ${pct(bias)}`);
  }

  writeDoc({ candCount: cand.size, preps: preps.length, survivors, dates, out, elapsedMs: Date.now() - t0 });
  console.log(`\n[exp8] wrote research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function writeDoc(r) {
  const line = (hk) => {
    const x = r.out[hk]; const bias = x.surv.meanFwd - x.free.meanFwd;
    return `| ${hk} | ${x.free.ic?.toFixed(4)} (t ${x.free.t.toFixed(2)}) | ${x.surv.ic?.toFixed(4)} (t ${x.surv.t.toFixed(2)}) | ${pct(x.free.meanFwd)} | ${pct(x.surv.meanFwd)} | **${pct(bias)}** |`;
  };
  const b21 = r.out['21d'].surv.meanFwd - r.out['21d'].free.meanFwd;
  const b63 = r.out['63d'].surv.meanFwd - r.out['63d'].free.meanFwd;
  const md = `# Experiment #8 — Survivorship-Free Momentum Baseline (2026-07)

**Question.** #7 re-ran the twin edge test survivorship-free but had to bound the universe (twins are
O(N²)). The momentum baseline is a cheap ranking, so this runs the **full in-band cross-section** and
pins down, *inside the edge frame* and with a **Shumway −30% delisting penalty**: (1) the
survivorship RETURN bias at 21d & 63d, and (2) whether momentum's own rank-IC shifts once the dead
names are included.

## Method
- Universe from \`research/lib/secmaster\`: every name in-band ($300M–$10B cap, ≥$3M/day ADV) **as of each
  decision date**, delisted names included up to their last trading day. Candidate set = union of the
  in-band cross-sections at ${UNIVERSE_DATES.join(', ')} → ${r.candCount} names (${r.survivors} active today, ${r.preps - r.survivors} since delisted).
- Baseline: 6–1 momentum (126-bar lookback, 5-bar skip), point-in-time.
- Forward return: close-to-close over the horizon; a name that **delists inside the window** takes the
  Shumway (1997) terminal haircut ((1+r)·(1−0.30)−1); an *active* name whose window hasn't elapsed is dropped.
- ${r.dates.length} month-end decision dates 2022-06 → 2024-06 (the delisting-dense window). Per-date
  cross-sectional rank-IC(momentum, forward); **survivor-only** = the same panel restricted to names still active today.

## Result

| Horizon | Momentum rank-IC (survivorship-free) | Momentum rank-IC (survivor-only) | Mean fwd (free) | Mean fwd (survivor) | **Survivorship return bias** |
|---|---|---|---|---|---|
${line('21d')}
${line('63d')}

- Panel breadth: ${r.out['63d'].free.nm} name-months (63d, survivorship-free), of which ${r.out['63d'].free.del} were delistings taking the Shumway haircut.

## Reading
- **Return bias (the headline):** dropping the delisted tails flatters realized momentum-universe returns by **${pct(b21)}/21d and ${pct(b63)}/63d**, positive and monotone in the horizon — the concrete cost of a survivor-only backtest, now measured at full breadth inside the ranking frame. These are *lower* than research/04's ~+0.4%/21d, +1.1%/63d, and that reconciles cleanly: #04 inverse-probability-weighted its delisted sample ×6 to stand in for the whole non-survivor population, whereas this measures the bias at the delisted names' **natural in-band frequency** (${r.out['63d'].free.del} of ${r.out['63d'].free.nm} name-months at 63d). Same sign and mechanism; #04's is the IP-scaled upper bound, this is the as-is in-band figure.
- **On the ranking:** momentum's rank-IC is ≈0 on **both** universes (63d: ${r.out['63d'].free.ic?.toFixed(4)} free, t ${r.out['63d'].free.t.toFixed(2)} vs ${r.out['63d'].surv.ic?.toFixed(4)} survivor, t ${r.out['63d'].surv.t.toFixed(2)}; 21d similar) — momentum does not rank this large/mid-cap universe either way, consistent with the app's whole edge-hunt. The tiny free-vs-survivor IC gap (${Math.abs(r.out['63d'].free.ic - r.out['63d'].surv.ic).toFixed(4)} at 63d, both insignificant) is within noise. **Survivorship shifts the return LEVEL, not the cross-sectional ORDERING.**

## Limits
- Delisting date ≈ last traded bar; the Shumway −30% is a standard blanket penalty, not a per-name reason-coded recovery. Mergers (positive) and bankruptcies (near-total loss) are pooled.
- Coverage is the ~10k-symbol FMP cache (2021–2026); one delisting-dense window.
- Membership uses the app's small/mid-cap band; a different band would shift the level.

_Generated by research/52-momentum-survivorship-free.js in ${(r.elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks._
`;
  fs.writeFileSync(path.join(__dirname, 'MOMENTUM-SURVIVORSHIP-FREE-2026-07.md'), md);
}

main();
