'use strict';
// COHORT-MATURITY CONTRACT (cohort-eligibility-v1)
//
// A decision date enters cross-sectional evaluation ONLY as a whole cohort:
//   1. its required exit session (entry session + horizon sessions on the
//      market calendar) is at or before labelObservationCutoff;
//   2. zero rows are still pending;
//   3. outcome coverage clears the documented minimum (default 95%);
//   4. remaining unresolved rows are disclosed, never silently dropped.
//
// A confirmed delisting is a valid OUTCOME, but an early delisting must never
// make an otherwise-pending cohort eligible — that is outcome-dependent
// selection (the exact defect this module closes: May-2026's 21-session cohort
// entered rank-IC on 3 delistings while 1,704 active names were pending).
//
// Pending rows stay in the stored panel; exclusion happens at the experiment
// boundary by decision DATE, never by deleting observations.
//
// Pure module: no network, no clock, no fs.

const crypto = require('crypto');
const CAL = require('./calendar');

const COHORT_POLICY_VERSION = 'cohort-eligibility-v1';
const DEFAULT_MIN_OUTCOME_COVERAGE = 0.95;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

// Panel row contract per horizon h: s{h} ∈ m/c/p/u/n, f{h} numeric when
// label-ready. computeCohortLedger walks the stored panel and produces the
// per-(decisionDate, horizon) cohort records plus per-horizon eligibility.
function computeCohortLedger({ panelByMonth, calendar, horizons = [21, 63, 126], labelObservationCutoff, minOutcomeCoverage = DEFAULT_MIN_OUTCOME_COVERAGE }) {
  if (!calendar || !calendar.sessions) throw new Error('cohort ledger requires a session calendar');
  if (!labelObservationCutoff) throw new Error('cohort ledger requires labelObservationCutoff');

  // Group rows by decision date once.
  const byDate = new Map();
  for (const ym of Object.keys(panelByMonth || {})) {
    for (const r of panelByMonth[ym] || []) {
      if (!r || !r.dt) continue;
      if (!byDate.has(r.dt)) byDate.set(r.dt, []);
      byDate.get(r.dt).push(r);
    }
  }
  const dates = [...byDate.keys()].sort();

  const byHorizon = {};
  for (const h of horizons) {
    const cohorts = [];
    const ineligibleCounts = { windowNotElapsed: 0, pendingRows: 0, coverageBelowMinimum: 0 };
    let lastEligible = null;
    const eligibleDates = [];
    for (const dt of dates) {
      const rows = byDate.get(dt);
      const w = CAL.cohortWindow(calendar, dt, h);
      const elapsed = !!(w.requiredExitSession && w.requiredExitSession <= labelObservationCutoff);
      let mature = 0, confirmedDelisted = 0, pending = 0, unresolved = 0, noFill = 0, numericLabel = 0;
      for (const r of rows) {
        switch (r[`s${h}`]) {
          case 'm': mature++; break;
          case 'c': confirmedDelisted++; break;
          case 'p': pending++; break;
          case 'n': noFill++; break;
          default: unresolved++; break;
        }
        if (Number.isFinite(r[`f${h}`])) numericLabel++;
      }
      const expectedEligibleRows = rows.length;
      const coverage = expectedEligibleRows ? numericLabel / expectedEligibleRows : 0;
      const reasons = [];
      if (!elapsed) reasons.push('window-not-elapsed');
      if (pending > 0) reasons.push('pending-rows');
      if (elapsed && pending === 0 && coverage < minOutcomeCoverage) reasons.push('coverage-below-minimum');
      const eligible = reasons.length === 0;
      if (!eligible) {
        if (reasons.includes('window-not-elapsed')) ineligibleCounts.windowNotElapsed++;
        if (reasons.includes('pending-rows')) ineligibleCounts.pendingRows++;
        if (reasons.includes('coverage-below-minimum')) ineligibleCounts.coverageBelowMinimum++;
      } else {
        eligibleDates.push(dt);
        if (!lastEligible || dt > lastEligible) lastEligible = dt;
      }
      cohorts.push({
        decisionDate: dt,
        horizonSessions: h,
        entrySession: w.entrySession,
        requiredExitSession: w.requiredExitSession,
        labelObservationCutoff,
        cohortWindowElapsed: elapsed,
        expectedEligibleRows,
        matureRows: mature,
        confirmedDelistedRows: confirmedDelisted,
        pendingRows: pending,
        unresolvedRows: unresolved,
        noFillRows: noFill,
        numericLabelRows: numericLabel,
        outcomeCoverageFraction: +coverage.toFixed(4),
        eligible,
        ineligibleReasons: reasons,
      });
    }
    const eligibleCoverages = cohorts.filter((c) => c.eligible).map((c) => c.outcomeCoverageFraction).sort((a, b) => a - b);
    byHorizon[String(h)] = {
      cohorts,
      eligibleDates,
      lastFullyObservedCohortDate: lastEligible,
      ineligibleCounts,
      eligibleCohorts: eligibleDates.length,
      ineligibleCohorts: cohorts.length - eligibleDates.length,
      minCoverageAmongEligible: eligibleCoverages.length ? eligibleCoverages[0] : null,
      medianCoverageAmongEligible: eligibleCoverages.length ? eligibleCoverages[Math.floor(eligibleCoverages.length / 2)] : null,
    };
  }

  const ledger = {
    schema: 'CohortEligibilityLedger',
    version: COHORT_POLICY_VERSION,
    policy: {
      minOutcomeCoverage,
      basis: 'eligible ⇔ required exit session elapsed within labelObservationCutoff AND pendingRows=0 AND numeric-label coverage ≥ minimum; unresolved rows disclosed',
    },
    calendarVersion: calendar.version,
    calendarHash: calendar.calendarHash,
    labelObservationCutoff,
    horizons: horizons.map(String),
    byHorizon,
  };
  return { ...ledger, ledgerHash: sha256(canonicalJson(ledger)) };
}

// Compact manifest summary (per horizon) — full per-cohort records live in the
// cohort-eligibility artifact, referenced by hash.
function ledgerManifestSummary(ledger) {
  const out = {};
  for (const [h, v] of Object.entries(ledger.byHorizon)) {
    out[h] = {
      eligibleCohorts: v.eligibleCohorts,
      ineligibleCohorts: v.ineligibleCohorts,
      lastFullyObservedCohortDate: v.lastFullyObservedCohortDate,
      minCoverageAmongEligible: v.minCoverageAmongEligible,
      medianCoverageAmongEligible: v.medianCoverageAmongEligible,
    };
  }
  return out;
}

// Verified eligibility map for a horizon: Set of decision dates plus the
// per-date cohort records (for coverage reporting at the experiment boundary).
function eligibilityMapForHorizon(ledger, horizonSessions) {
  const v = ledger && ledger.byHorizon && ledger.byHorizon[String(horizonSessions)];
  if (!v) throw new Error(`cohort ledger has no horizon ${horizonSessions}`);
  return {
    horizonSessions,
    source: `${ledger.version}:${(ledger.ledgerHash || '').slice(0, 16)}`,
    ledgerHash: ledger.ledgerHash || null,
    eligibleDates: new Set(v.eligibleDates),
    recordsByDate: new Map(v.cohorts.map((c) => [c.decisionDate, c])),
    lastFullyObservedCohortDate: v.lastFullyObservedCohortDate,
  };
}

module.exports = {
  COHORT_POLICY_VERSION, DEFAULT_MIN_OUTCOME_COVERAGE,
  computeCohortLedger, ledgerManifestSummary, eligibilityMapForHorizon,
};
