'use strict';
// Tech Operational Evidence — the declared experiment and its honest scorecard.
//
// Hypothesis (prespecified): among developer-led technology companies with a verified
// product-to-ticker mapping, unexpected product-adoption acceleration (positive
// operational surprise) predicts net sector-neutral returns over the following
// 5 and 10 sessions.
//
// Declared family for FDR: scored arms (npm, github, sec) × horizons {5, 10} on the
// positive-surprise cohort — 6 tests. 1-session results are descriptive only.
//
// State ladder (one-directional honesty):
//   INSUFFICIENT_DATA — nothing collected / nothing eligible; the reason is stated.
//   COLLECTING        — events accruing but below the prespecified sample floor.
//   NULL              — sample floor reached AND the gate fails. Only reachable with data.
//   PROMISING_RESEARCH— every prespecified gate condition passes.
//   VALIDATED         — RESERVED for docs/model-promotion-policy.md on an untouched
//                       subsequent sample; never auto-assigned by this module.

const ES = require('../evidence-stats');
const SCHEMA = require('./schema');

const EXPERIMENT_VERSION = 'techev-experiment-v1';
const EXPERIMENT_ID = 'techev-adoption-2026-08';

// Prespecified gate — declared before any data accrued (2026-08-15). Do not loosen.
const GATE = Object.freeze({
  minResolvedEvents: 100,
  minResolvedDates: 40,
  ciLowerAboveZero: true,
  minPositiveBlocks: 3, // of 4 chronological folds
  fdrAlpha: 0.10,
  outlierTrim: 5,       // result must stay positive after removing the 5 largest wins
});

const HORIZON_IDX = { 1: 0, 5: 1, 10: 2 };

function armRows(rows, arm, { direction = 'positive' } = {}) {
  return rows.filter((r) => r.arm === arm && (!direction || r.dir === direction));
}

function meanOf(vals) {
  const clean = vals.filter(Number.isFinite);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function trimmedMean(vals, trim) {
  const clean = vals.filter(Number.isFinite);
  if (clean.length <= trim) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return meanOf(sorted.slice(0, sorted.length - trim));
}

// Core per-arm×horizon evaluation. Values are FRACTIONS end to end; only the display
// layer converts to percent. Gates read avgExact/seExact — never the rounded fields.
function evaluateArmHorizon(rows, arm, horizon, { hasAnyObservations = false } = {}) {
  const hIdx = HORIZON_IDX[horizon];
  const cohort = armRows(rows, arm).map((r) => ({ date: r.d, netExc: r.n[hIdx] })).filter((r) => Number.isFinite(r.netExc));
  const negCohort = armRows(rows, arm, { direction: 'negative' }).map((r) => r.n[hIdx]).filter(Number.isFinite);
  const base = {
    v: EXPERIMENT_VERSION, arm, horizon,
    resolvedEvents: cohort.length,
    negativeCohort: { n: negCohort.length, mean: meanOf(negCohort) },
  };
  if (cohort.length === 0) {
    return {
      ...base,
      state: hasAnyObservations ? SCHEMA.ARM_STATES.COLLECTING : SCHEMA.ARM_STATES.INSUFFICIENT_DATA,
      stateReason: hasAnyObservations
        ? 'observations are accruing but no forward event has resolved yet'
        : 'collection has not produced observations for this arm yet',
      summary: null, p: null,
    };
  }
  const deduped = ES.dedupeToDateSeries(cohort, { pickValue: (r) => r.netExc, pickDate: (r) => r.date });
  const summary = ES.summarizeDateSeries(deduped.series, { horizonBars: horizon });
  const p = summary ? ES.pValueOf(summary) : null;
  const avgExact = summary && Number.isFinite(summary.avgExact) ? summary.avgExact : (summary ? summary.avg : null);
  const trimmed = trimmedMean(cohort.map((r) => r.netExc), GATE.outlierTrim);
  const result = {
    ...base,
    resolvedDates: deduped.dates.length,
    meanNetResidual: avgExact,
    medianNetResidual: medianOf(cohort.map((r) => r.netExc)),
    hitRate: cohort.length ? cohort.filter((r) => r.netExc > 0).length / cohort.length : null,
    ci95: summary ? summary.ci95 : null,
    positiveBlocks: summary ? summary.positiveBlocks : null,
    blockStability: summary ? summary.blockStability : null,
    trimmedMean: trimmed,
    rankIC: rankIcOf(rows.filter((r) => r.arm === arm), arm, hIdx),
    p,
    dateRange: deduped.dates.length ? { from: deduped.dates[0], to: deduped.dates[deduped.dates.length - 1] } : null,
    summary,
  };
  if (cohort.length < GATE.minResolvedEvents || deduped.dates.length < GATE.minResolvedDates) {
    return {
      ...result,
      state: SCHEMA.ARM_STATES.COLLECTING,
      stateReason: `${cohort.length}/${GATE.minResolvedEvents} resolved events, ${deduped.dates.length}/${GATE.minResolvedDates} independent dates — below the prespecified floor`,
    };
  }
  // Gate decision happens in evaluateAll after FDR (family-wide q values needed).
  return { ...result, state: null, stateReason: null };
}

// Cross-sectional rank IC: per date with ≥3 same-arm events (any direction),
// Spearman(surprise z, net residual); reported as the mean across such dates.
function rankIcOf(rows, arm, hIdx) {
  const { spearman } = require('../stats');
  const byDate = new Map();
  for (const r of rows) {
    if (r.arm !== arm || !Number.isFinite(r.z) || !Number.isFinite(r.n[hIdx])) continue;
    if (!byDate.has(r.d)) byDate.set(r.d, []);
    byDate.get(r.d).push(r);
  }
  const ics = [];
  for (const dayRows of byDate.values()) {
    if (dayRows.length < 3) continue;
    const ic = spearman(dayRows.map((r) => r.z), dayRows.map((r) => r.n[hIdx]), 3);
    if (Number.isFinite(ic)) ics.push(ic);
  }
  return ics.length ? { meanIC: meanOf(ics), dates: ics.length } : { meanIC: null, dates: 0, note: 'no dates with a ≥3-name cross-section' };
}

function medianOf(vals) {
  const clean = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function gateVerdict(r, fdrEntry) {
  const checks = {
    sampleFloor: r.resolvedEvents >= GATE.minResolvedEvents && r.resolvedDates >= GATE.minResolvedDates,
    meanAboveZero: Number.isFinite(r.meanNetResidual) && r.meanNetResidual > 0,
    ciLowerAboveZero: !!(r.ci95 && Number.isFinite(r.ci95.lo) && r.ci95.lo > 0),
    foldStability: Number.isFinite(r.positiveBlocks) && r.positiveBlocks >= GATE.minPositiveBlocks,
    fdrSurvives: !!(fdrEntry && fdrEntry.survives), // evidence-stats field is `survives`
    outlierRobust: Number.isFinite(r.trimmedMean) && r.trimmedMean > 0,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

// rows: compact resolved rows; observedArms: Set of arms with ANY stored observations.
function evaluateAll(rows, { observedArms = new Set(), trimmedRows = 0 } = {}) {
  const results = [];
  for (const arm of SCHEMA.SCORED_ARMS) {
    for (const horizon of SCHEMA.HORIZONS) {
      results.push(evaluateArmHorizon(rows, arm, horizon, { hasAnyObservations: observedArms.has(arm) }));
    }
  }
  // FDR across the DECLARED family only.
  const family = results.filter((r) => SCHEMA.FAMILY_HORIZONS.includes(r.horizon));
  const fdrItems = family.map((r) => ({ id: `${r.arm}:${r.horizon}`, p: Number.isFinite(r.p) ? r.p : null }));
  const fdr = ES.fdrAdjust(fdrItems, { alpha: GATE.fdrAlpha });
  const fdrById = new Map(fdr.map((f) => [f.id, f]));
  const final = results.map((r) => {
    const inFamily = SCHEMA.FAMILY_HORIZONS.includes(r.horizon);
    const fdrEntry = inFamily ? fdrById.get(`${r.arm}:${r.horizon}`) : null;
    if (r.state) return { ...r, inFamily, q: fdrEntry ? fdrEntry.q : null };
    const verdict = gateVerdict(r, fdrEntry);
    // NULL is only reachable here: sample floor already passed inside evaluateArmHorizon.
    const state = verdict.pass ? SCHEMA.ARM_STATES.PROMISING_RESEARCH : SCHEMA.ARM_STATES.NULL;
    const failed = Object.entries(verdict.checks).filter(([, ok]) => !ok).map(([k]) => k);
    return {
      ...r, inFamily, q: fdrEntry ? fdrEntry.q : null, gate: verdict.checks, state,
      stateReason: verdict.pass
        ? 'all prespecified gate conditions passed — promotion beyond PROMISING_RESEARCH requires the repo promotion policy on an untouched sample'
        : `gate failed: ${failed.join(', ')}`,
    };
  });
  return {
    v: EXPERIMENT_VERSION, experimentId: EXPERIMENT_ID, gate: GATE,
    family: fdrItems.map((f) => f.id),
    arms: final.map(({ summary, ...pub }) => pub), // full summaries are large; keep the projection
    rowsTrimmed: trimmedRows,
    disclosure: 'Research evidence, not a trade recommendation. No source is assumed to provide alpha until this ledger validates it. VALIDATED is reserved for the repository promotion policy.',
  };
}

module.exports = { EXPERIMENT_VERSION, EXPERIMENT_ID, GATE, evaluateArmHorizon, evaluateAll, gateVerdict, trimmedMean, armRows };
