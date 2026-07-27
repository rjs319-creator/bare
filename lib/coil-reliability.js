'use strict';
// COIL RELIABILITY REPORTS (coil-reliability-v1) — Phase 3 of the pre-move
// redesign. Extends the coilbook's predicted-vs-realized abnormal-break read
// with the full two-stage reliability battery the redesign requires:
//
//   - predicted vs realized abnormal-expansion rate (by band AND by scope —
//     scope calibrations are never pooled across cap bands);
//   - trigger conversion (did the breakout plan's entry ever fill?);
//   - target-before-stop conditional on an executable fill;
//   - cost-net expected R (liquidity-tier costs, not the flat 20 bps);
//   - selected vs decile-stratified control comparison;
//   - chronological stability (first half vs second half of the ledger).
//
// Trigger/fill/target-stop resolution REUSES lead-time v2's censor-aware
// engine (lib/leadtime2.episodeLeadTime) at the Coil horizon — one execution
// semantics for the whole pre-move pipeline (gap-through at the worse open,
// gap-beyond-max-entry = no fill, same-bar ambiguity = stop, censored ≠ failed).
//
// Pure: ledger rows + candle map in, report out.

const coil = require('./coil');
const LT2 = require('./leadtime2');

const COIL_RELIABILITY_VERSION = 'coil-reliability-v1';

// Cost tier per ledger scope. `expanded` is the free full-market universe —
// overwhelmingly small/micro names — so it is charged the small-cap tier
// (recorded here; never silently the cheapest).
const SCOPE_TIER = Object.freeze({ large: 'liquid', small: 'small', micro: 'micro', expanded: 'small', biotech: 'biotech' });

const rate = (k, n) => (n > 0 ? +(100 * k / n).toFixed(1) : null);
const mean = (arr) => {
  const a = arr.filter(Number.isFinite);
  return a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null;
};

// Resolve one ledger row's two-stage outcome. `broke` (abnormal expansion) uses
// coil.resolveBreak (matured-window censoring built in); the executable stage
// uses LT2 at the Coil horizon. Rows without a plan resolve only stage one.
function resolveRow(row, candles) {
  if (!candles) return { ...row, break: null, exec: null };
  const brk = coil.resolveBreak(candles, row.date, row.dailyVol);   // null = not matured (censored)
  let exec = null;
  if (row.plan && row.plan.entry > 0 && row.plan.stop > 0) {
    const lt = LT2.episodeLeadTime(
      { date: row.date, ticker: row.ticker, entry: row.plan.entry, stop: row.plan.stop, target: row.plan.target },
      candles,
      { tier: SCOPE_TIER[row.scope] || 'small', cfg: { HORIZONS: [coil.COIL_HORIZON] } },
    );
    exec = lt.skipped ? { skipped: lt.skipped } : lt.horizons[coil.COIL_HORIZON];
  }
  return { ...row, break: brk, exec };
}

function summarizeGroup(rows) {
  const withBreak = rows.filter(r => r.break);                       // matured stage-one windows only
  const brokeN = withBreak.filter(r => r.break.broke).length;
  const execRows = rows.map(r => r.exec).filter(h => h && h.outcome && h.outcome !== 'censored');
  const triggered = execRows.filter(h => ['trigger-no-fill', 'target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome));
  const filled = execRows.filter(h => ['target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome));
  const tbs = filled.filter(h => h.outcome === 'target-before-stop');
  return {
    n: rows.length,
    breakMatured: withBreak.length,
    predictedBreakPct: withBreak.length ? +(withBreak.reduce((s, r) => s + (r.explodeProbPct || 0), 0) / withBreak.length).toFixed(1) : null,
    realizedBreakPct: rate(brokeN, withBreak.length),
    execResolved: execRows.length,
    triggerConversionPct: rate(triggered.length, execRows.length),
    fillPct: rate(filled.length, triggered.length),
    targetBeforeStopGivenFillPct: rate(tbs.length, filled.length),
    meanNetR: mean(filled.map(h => h.netR)),
    medianNetR: LT2.median(filled.map(h => h.netR)),
  };
}

// rows: flattened coil ledger picks [{...row, date}]. histMap: Map<ticker, candles>.
function buildCoilReliability(rows, histMap) {
  const resolved = rows.map(r => resolveRow(r, histMap.get ? histMap.get(r.ticker) : histMap[r.ticker]));

  const byScope = {};
  for (const scope of [...new Set(resolved.map(r => r.scope).filter(Boolean))].sort()) {
    byScope[scope] = summarizeGroup(resolved.filter(r => r.scope === scope));
  }
  const bands = [...new Set(resolved.map(r => r.band).filter(Boolean))];
  const byBand = {};
  for (const b of ['high', 'elevated', 'normal', 'quiet'].filter(x => bands.includes(x))) {
    byBand[b] = summarizeGroup(resolved.filter(r => r.band === b));
  }

  // Selected vs stratified controls: the counterfactual read the v1 top-15-only
  // ledger could never produce. Rows without a sampleKind are legacy v1 selected.
  const selected = resolved.filter(r => r.selected !== false);
  const controls = resolved.filter(r => r.selected === false);

  // Chronological stability: first half vs second half by ledger date.
  const dates = [...new Set(resolved.map(r => r.date).filter(Boolean))].sort();
  const midDate = dates.length >= 2 ? dates[Math.floor(dates.length / 2)] : null;
  const chronological = midDate ? {
    splitDate: midDate,
    firstHalf: summarizeGroup(resolved.filter(r => r.date < midDate)),
    secondHalf: summarizeGroup(resolved.filter(r => r.date >= midDate)),
  } : null;

  return {
    version: COIL_RELIABILITY_VERSION,
    horizonSessions: coil.COIL_HORIZON,
    overall: summarizeGroup(resolved),
    byScope, byBand,
    selectedVsControls: controls.length ? { selected: summarizeGroup(selected), controls: summarizeGroup(controls) } : null,
    chronological,
    note: 'Two-stage reliability: P(abnormal expansion) stays strictly separate from trigger conversion, target-before-stop-given-fill and cost-net R. Censored/unmatured windows are excluded from every rate. Scope calibrations are reported per cap band, never pooled.',
  };
}

module.exports = { COIL_RELIABILITY_VERSION, SCOPE_TIER, buildCoilReliability, resolveRow, summarizeGroup };
