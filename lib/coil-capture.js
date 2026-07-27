'use strict';
// COIL OBSERVATION CAPTURE v2 (coil-capture-v2) — Phase 3 of the pre-move
// redesign (docs/premove-transition-v2.md).
//
// The v1 ledger logged only the top-15 small/large picks — so calibration could
// only ever be evaluated on the model's favorite candidates, never against the
// rest of the score distribution, and micro/expanded scopes were invisible.
// v2 keeps the selected rows AND adds a DETERMINISTIC stratified sample across
// all score deciles (the control coverage a reliability curve needs), for every
// scope whose candle cache is available.
//
// Honesty rules:
//   - Coil ranking/scoring is UNTOUCHED (the empirical abnormal-expansion
//     probability and its scope-specific calibration are preserved as-is; the
//     documented inverted Expected-R ranking stays removed).
//   - Scope calibration is never crossed: every row carries its own `calScope`
//     stamp (micro/expanded share 'small' per the existing pooled table — that
//     pooling is the existing convention, recorded, not silently applied).
//   - Sampling is deterministic (rank-position based) — same cohort in, same
//     rows out. No randomness, no clock.
//
// Pure: ranked cohort in, ledger rows out.

const { trailingDailyVol, coilTradePlan } = require('./coil');

const COIL_CAPTURE_VERSION = 'coil-capture-v2';
const SELECT_TOPN = 15;            // the v1 "selected" set (unchanged)
const STRAT_PER_DECILE = 2;        // deterministic controls per score decile

// Mean 20-bar dollar volume from the row's own candles (decision-time data only).
function dollarVol20(candles) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const tail = candles.slice(-20);
  let sum = 0, n = 0;
  for (const c of tail) {
    if (Number.isFinite(c.close) && Number.isFinite(c.volume)) { sum += c.close * c.volume; n++; }
  }
  return n ? Math.round(sum / n) : null;
}

// Build one ledger row from a ranked cohort entry. Returns null when the row
// cannot be honestly captured (no vol / no prob) — fail closed, never imputed.
function captureRow(r, { scope, calScope, cohortCount, sampleKind }) {
  if (!r || !r.prob || !Array.isArray(r.candles)) return null;
  const dailyVol = trailingDailyVol(r.candles);
  if (!(dailyVol > 0)) return null;
  const last = r.candles.length - 1;
  const plan = coilTradePlan(r.candles, last, r.prob.pct);
  const dv = dollarVol20(r.candles);
  return {
    ticker: r.ticker, scope, calScope,
    captureVersion: COIL_CAPTURE_VERSION,
    sampleKind,                                     // 'selected' | 'decile-stratified'
    selected: sampleKind === 'selected',
    decisionPrice: r.feats.price,
    entryPrice: r.feats.price,                      // back-compat alias (v1 resolver reads this)
    dailyVol: +dailyVol.toFixed(6),                 // decision-time vol → reproducible break threshold
    decile: r.prob.decile, band: r.prob.band,
    explodeProbPct: r.prob.pct, majorBreakPct: r.prob.pctMajor,
    squeezePctile: r.feats.bbPctile != null ? +(r.feats.bbPctile * 100).toFixed(0) : null,
    coilScore: Number.isFinite(r.score) ? +r.score.toFixed(2) : null,
    percentile: r.percentile ?? null,
    dollarVol: dv,
    // Trade plan at decision time → the coilbook resolver can grade trigger
    // conversion + target-before-stop + cost-net R, not only the abnormal break.
    plan: plan ? { entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr } : null,
    dataCutoff: r.candles[last] ? r.candles[last].date : null,
    universeSnapshotId: `coil:${scope}#${cohortCount ?? '?'}`,
    missing: [
      ...(plan ? [] : ['plan']),
      ...(dv != null ? [] : ['dollarVol']),
    ],
  };
}

// The day's capture for one scope: top-N selected + a deterministic stratified
// sample of up-to-STRAT_PER_DECILE controls per score decile (evenly spaced by
// rank inside the decile — positions 0 and ⌊n/2⌋ — so reruns are byte-identical).
function buildCoilTickRows({ ranked = [], scope, calScope, cohortCount = null } = {}) {
  const rows = [];
  const taken = new Set();
  for (const r of ranked.slice(0, SELECT_TOPN)) {
    const row = captureRow(r, { scope, calScope, cohortCount, sampleKind: 'selected' });
    if (row) { rows.push(row); taken.add(r.ticker); }
  }
  const byDecile = new Map();
  for (const r of ranked) {
    if (!r || !r.prob || taken.has(r.ticker)) continue;
    const d = r.prob.decile;
    if (!Number.isFinite(d)) continue;
    if (!byDecile.has(d)) byDecile.set(d, []);
    byDecile.get(d).push(r);
  }
  for (const d of [...byDecile.keys()].sort((a, b) => a - b)) {
    const group = byDecile.get(d);                          // already rank-ordered (ranked is)
    const positions = group.length <= STRAT_PER_DECILE
      ? group.map((_, i) => i)
      : [0, Math.floor(group.length / 2)].slice(0, STRAT_PER_DECILE);
    for (const pos of positions) {
      const row = captureRow(group[pos], { scope, calScope, cohortCount, sampleKind: 'decile-stratified' });
      if (row) { rows.push(row); taken.add(group[pos].ticker); }
    }
  }
  return rows;
}

module.exports = { COIL_CAPTURE_VERSION, SELECT_TOPN, STRAT_PER_DECILE, buildCoilTickRows, captureRow, dollarVol20 };
