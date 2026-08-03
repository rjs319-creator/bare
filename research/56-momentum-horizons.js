'use strict';
// Step 56 — LONGER-HORIZON MOMENTUM DIAGNOSTIC (read-only, EXPLORATORY).
//   node research/56-momentum-horizons.js
//
// Reproduces (or falsifies) the pre-repair read-only diagnostic that found,
// after excluding partial cohorts:
//   21s  IC ≈ 0.0041 (HAC t 0.38, eff N 34)
//   63s  IC ≈ 0.0303 (HAC t 5.67, eff N 18)
//   126s IC ≈ 0.0433 (HAC t 5.88, eff N 12)
//
// THESE ARE NOT PROMOTION EVIDENCE. The longer horizons fail the minimum
// effective-sample requirement (ESS ≥ 30, preferably far more) on a 48-month
// panel with overlapping windows. This script:
//   * evaluates ONLY fully observed cohorts (cohort-eligibility-v3 ledger);
//   * runs both symmetric sensitivity views (all rows / exclude flagged);
//   * tunes nothing, shifts no live weights;
//   * writes an artifact clearly labeled exploratory with the preregistration
//     requirement for any confirmatory follow-up.

const fs = require('fs');
const path = require('path');
const ST = require('../lib/research/stats-v3');
const RQ = require('../lib/rankquality');
const COHORT = require('./lib/cohort');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(DATA, 'momentum-horizons-diagnostic.json');
const HORIZONS = [21, 63, 126];
const MIN_ESS_CONFIRMATORY = 30;

function icSeries(panel, ledger, h, { excludeFlagged = false } = {}) {
  const elig = COHORT.eligibilityMapForHorizon(ledger, h);
  const byDate = new Map();
  for (const ym of panel.months) {
    for (const r of panel.panel[ym]) {
      if (!elig.eligibleDates.has(r.dt)) continue;
      if (!Number.isFinite(r[`f${h}`]) || !Number.isFinite(r.m121)) continue;
      if (excludeFlagged && r[`x${h}`] === 1) continue;
      if (!byDate.has(r.dt)) byDate.set(r.dt, []);
      byDate.get(r.dt).push({ score: r.m121, outcome: r[`f${h}`] });
    }
  }
  const dates = [...byDate.keys()].sort();
  const ics = [];
  for (const d of dates) {
    const items = byDate.get(d);
    if (items.length < 30) continue;   // diagnostic floor: a real cross-section
    const ic = RQ.informationCoefficient(items).ic;
    if (ic != null) ics.push({ date: d, ic, n: items.length });
  }
  const vals = ics.map((x) => x.ic);
  const nw = ST.neweyWest(vals, { horizonBars: h });
  const ess = ST.effectiveSampleSize(vals);
  const ns = ics.map((x) => x.n).sort((a, b) => a - b);
  return {
    horizonSessions: h,
    eligibleDatesEvaluated: ics.length,
    excludedIneligibleDates: [...byDate.keys()].length - ics.length,
    lastFullyObservedCohortDate: elig.lastFullyObservedCohortDate,
    meanIC: vals.length ? +ST.mean(vals).toFixed(4) : null,
    hacT: nw.tstat == null ? null : +nw.tstat.toFixed(2),
    effectiveSampleSize: ess.ess,
    minNamesPerDate: ns[0] ?? null,
    medianNamesPerDate: ns.length ? ns[Math.floor(ns.length / 2)] : null,
    meetsMinimumEffectiveSample: ess.ess != null && ess.ess >= MIN_ESS_CONFIRMATORY,
  };
}

function main() {
  const panel = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features-v3.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort-eligibility-v3.json'), 'utf8'));
  const byHorizon = {};
  for (const h of HORIZONS) {
    byHorizon[h] = {
      includeAll: icSeries(panel, ledger, h),
      excludeUnconfirmedExtremes: icSeries(panel, ledger, h, { excludeFlagged: true }),
    };
  }
  const artifact = {
    schema: 'MomentumHorizonsDiagnostic',
    status: 'EXPLORATORY',
    generatedAt: new Date().toISOString(),
    panelVersion: panel.panelVersion,
    datasetHash: panel.datasetHash,
    ledgerHash: ledger.ledgerHash,
    signal: '12-1 momentum (m121), frozen — no tuning, no threshold search',
    byHorizon,
    disclosures: [
      'NOT promotion evidence: 63s/126s effective sample sizes are far below the 30 minimum; overlapping windows on a 48-month panel cannot support confirmatory inference.',
      'Any confirmatory follow-up requires ONE preregistered fixed study (lib/research/hypothesis-registry) BEFORE inspecting further results, effective N ≥ 30 (preferably far more), cost-net portfolio performance through the execution engine, and prospective confirmation.',
      'No thresholds tuned; no live algorithm weights changed.',
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  for (const h of HORIZONS) {
    const a = byHorizon[h].includeAll, x = byHorizon[h].excludeUnconfirmedExtremes;
    console.log(`${String(h).padStart(3)}s: IC ${a.meanIC} (HAC t ${a.hacT}, ESS ${a.effectiveSampleSize}, dates ${a.eligibleDatesEvaluated}, last ${a.lastFullyObservedCohortDate})`
      + ` | excl-extremes IC ${x.meanIC} (t ${x.hacT})`
      + ` | min-ESS-met: ${a.meetsMinimumEffectiveSample}`);
  }
  console.log(`EXPLORATORY artifact → ${path.relative(process.cwd(), OUT)}`);
}

main();
