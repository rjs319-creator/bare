'use strict';
// EVOLVE — OVERLAPPING-LABEL UNIQUENESS WEIGHTS  (OMEGA Gap B)
//
// Triple-barrier labels overlap in time: a 63-day POSITION label opened on day t shares
// most of its return window with labels opened on t+1 … t+62. Counting each as one
// independent observation inflates the effective sample — shrinkage is then too weak and
// drift/IC significance is overstated. This applies López de Prado's average-uniqueness
// weighting (Advances in Financial ML, ch. 4): each label is weighted by the average, over
// the days it is "open", of 1 / (number of concurrent labels on that day). A label sharing
// its window with many others is down-weighted; a temporally isolated label keeps weight 1.
//
// Concurrency is computed PER (ticker, horizon) series — the temporally autocorrelated set.
// Labels on different tickers, or on the same ticker at different horizons, are separate
// prediction tasks and do not co-event in this sense. Spans are in calendar days
// (predDate → predDate + barsToBarrier·~1.4, or the horizon window when a label timed out),
// matching the calendar-day convention the walk-forward already uses for its purge distance.
//
// Pure + dependency-light (only HORIZON_META for the fallback window). Weights ∈ (0, 1].

const { HORIZON_META } = require('./evolve-labels');

const CAL_PER_TD = 1.4;   // calendar days per trading day (~7/5) — matches evolve-walkforward

const epochDay = (dateStr) => Math.round(new Date(dateStr).getTime() / 86400000);

// A label's active span in calendar days: the bars it took to hit a barrier (path length),
// or the full horizon window when it timed out / bars-to-barrier is unknown.
function spanCalDays(ev) {
  const w = (HORIZON_META[ev.horizon] || HORIZON_META.swing).window;
  const bars = Number.isFinite(ev.barsToBarrier) && ev.barsToBarrier > 0 ? ev.barsToBarrier : w;
  return Math.max(1, Math.round(bars * CAL_PER_TD));
}

// THE LABEL-START FIELD (alpha-research pass 3).
//
// This module keyed exclusively on `ev.predDate`. The EVOLVE live path supplies that, but
// the research harness (lib/research/harness.js) builds rows carrying `decisionTs` — so
// every harness event hit the `!ev.predDate` short-circuit, took weight 1, and the whole
// López de Prado overlap correction became a SILENT NO-OP. Measured on the production
// shape: 2,760 overlapping 21-day swing labels reported effectiveN 2,760
// (uniquenessRatio 1.0) where the true value is ~493 (ratio 0.179) — a 5.6x
// overstatement of independent sample size, feeding every CI, t-stat and deflated
// Sharpe computed from it.
//
// Accepting either field fixes the wiring. `startOf` returning null is now surfaced by
// uniquenessSummary rather than silently scoring 1.0, so a future field rename cannot
// reintroduce the no-op quietly.
const startOf = (ev) => (ev && (ev.predDate || ev.decisionTs)) || null;

// Average-uniqueness weight per event. Returns a Map(eventObject → weight ∈ (0,1]).
// Group by ticker|horizon; within each group, for every label average 1/co-events over the
// days it is open. O(n²·span) per group, but groups are small (one ticker's firings).
function uniquenessWeights(events) {
  const weights = new Map();
  const groups = new Map();
  for (const ev of (events || [])) {
    if (!startOf(ev)) { if (ev) weights.set(ev, 1); continue; }
    const key = `${ev.ticker || '?'}|${ev.horizon || 'swing'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  for (const list of groups.values()) {
    const spans = list.map(ev => { const s = epochDay(startOf(ev)); return { ev, s, e: s + spanCalDays(ev) }; });
    for (const a of spans) {
      let sum = 0, days = 0;
      for (let d = a.s; d <= a.e; d++) {
        let c = 0;
        for (const b of spans) { if (b.s <= d && d <= b.e) c++; }
        if (c > 0) { sum += 1 / c; days++; }
      }
      weights.set(a.ev, days ? +(sum / days).toFixed(4) : 1);
    }
  }
  return weights;
}

// Sample-independence summary: raw count vs Σ weights (the effective, de-duplicated sample),
// and the ratio (1.0 = fully independent; lower = heavier overlap).
function uniquenessSummary(events) {
  const list = events || [];
  const w = uniquenessWeights(list);
  let eff = 0;
  for (const ev of list) eff += (w.get(ev) ?? 1);
  const raw = list.length;
  const undated = list.filter(ev => !startOf(ev)).length;
  // FAIL LOUD when NOTHING is dated. That is the exact shape of the silent no-op this
  // module shipped with: every event scores weight 1, so effectiveN === rawN and the
  // ratio reads a perfect 1.0 — an independence claim that was never measured. A null
  // ratio with `usable:false` cannot be mistaken for "measured, fully independent".
  const measurable = raw > 0 && undated < raw;
  return {
    rawN: raw,
    effectiveN: +eff.toFixed(1),
    uniquenessRatio: (raw && measurable) ? +(eff / raw).toFixed(3) : null,
    undated,
    usable: measurable,
    basis: 'predDate || decisionTs',
  };
}

module.exports = { uniquenessWeights, uniquenessSummary, spanCalDays, CAL_PER_TD };
