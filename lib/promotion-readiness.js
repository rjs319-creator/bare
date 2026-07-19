// promotion-readiness.js (promo-v1) — the single, machine-checkable "may any learned
// model go live?" gate for the historical-learning stack (ORBIT / ORBIT-ML / Challenger).
//
// Everything upstream already exists and is honest in pieces:
//   • pit-contract.datasetSuitability  → survivorship / PIT / rejected-candidates flags
//   • orbit-controls.runControls       → negative-controls verdict (NO-EDGE / ROBUST / …)
//   • orbit-ml walk-forward            → purged rank-IC + ICIR per horizon
//   • orbit-ml ensemble                → marginal (incremental) contribution
//   • orbit ledger / resolved          → prospective (forward) sample coverage
//
// What was missing is ONE place that FUSES them into a frozen, non-negotiable verdict, so
// nothing can silently promote on survivorship-biased or under-sampled data. This module
// only READS and JUDGES — it never trains, never scores, never touches the live rank. It
// is deliberately conservative: the default answer is NOT READY, and it must be argued up.
//
// It encodes exactly the criteria written in docs/orbit-promotion-policy.md, made testable.

const { datasetSuitability } = require('./pit-contract');

const PROMO_VERSION = 'promo-v1';

// ── Frozen promotion criteria ───────────────────────────────────────────────
// These are thresholds, not knobs to be tuned against a holdout. Changing them to make a
// model "pass" is exactly the manufactured-edge failure the whole stack is built to prevent.
const CRITERIA = Object.freeze({
  minUniqueNames: 100,        // cross-section wide enough that rank-IC means something
  minDecisionDates: 60,       // enough independent-ish decision dates in-sample
  minOuterBlocks: 8,          // nested outer-OOS blocks in the walk-forward
  minRegimes: 2,              // must span ≥2 regimes (survive a 2022-type bear)
  icHurdle: 0.03,             // purged rank-IC must clear this at the primary horizon
  icirHurdle: 0.30,           // …with a stable sign (ICIR), not a lucky single block
  minMarginalDelta: 0,        // learned model must ADD value over the best existing peer
  minProspectiveDates: 20,    // live-forward resolved decision dates before any promotion
  primaryHorizon: 'days21',
});

// Coverage of a set of logged shadow days + resolved outcomes. Answers "how much
// independent, survivorship-safe, prospective sample do we actually have?" — the exact
// question the INSUFFICIENT_DATA branch of the audit must report.
function coverageReport(days = [], resolved = {}, meta = {}) {
  const names = new Set();
  const dates = new Set();
  for (const d of days) {
    for (const p of (d.predictions || d.ranked || [])) {
      if (p && p.ticker) names.add(p.ticker);
    }
    if (d && d.date) dates.add(d.date);
    else if (d && d.asOf) dates.add(d.asOf);
  }
  const resolvedByHorizon = {};
  const resolvedDates = new Set();
  for (const key of Object.keys(resolved)) {
    const r = resolved[key];
    if (!r || !r.horizons) continue;
    let anyResolved = false;
    for (const h of Object.keys(r.horizons)) {
      if (r.horizons[h] && r.horizons[h].resolved) { resolvedByHorizon[h] = (resolvedByHorizon[h] || 0) + 1; anyResolved = true; }
    }
    // A decision date only counts as prospectively confirmed once at least one horizon resolves.
    if (anyResolved && r.decisionTs) resolvedDates.add(String(r.decisionTs).slice(0, 10));
  }
  return {
    version: PROMO_VERSION,
    nUniqueNames: names.size,
    nDecisionDates: dates.size,
    nProspectiveDates: resolvedDates.size,
    resolvedByHorizon,
    hasDelisted: !!meta.hasDelisted,
    hasRejectedCandidates: !!meta.hasRejectedCandidates,
    pointInTimeUniverse: !!meta.pointInTimeUniverse,
  };
}

function pushBlocker(blockers, id, detail) { blockers.push({ id, detail }); }

// The frozen gate. Returns a conservative { ready:false } unless EVERY criterion is met on
// survivorship-safe, adequately-sampled, prospectively-confirmed, incrementally-valuable,
// control-clean data. `status` classifies WHY it is not ready (maps to the audit taxonomy).
function promotionReadiness(input = {}) {
  const {
    researchValidity = {},   // { survivorshipSafe, pointInTimeSafe, ... } from the backfill
    coverage = {},           // coverageReport(...)
    walkforward = {},        // { days5:{purgedIC,icir,nOuter,nRegimes}, days21:{...}, ... }
    marginalDelta = null,    // leave-one-out incremental rank-IC (null = untested)
    controls = {},           // orbit-controls.runControls verdict object
    prospectiveHealth = null, // 'HEALTHY' | 'DEGRADING' | … from the live monitor
  } = input;

  const blockers = [];

  // 1. Survivorship / PIT — a hard, metrics-independent block (policy §1).
  const suit = datasetSuitability({
    hasDelisted: coverage.hasDelisted,
    hasRejectedCandidates: coverage.hasRejectedCandidates,
    pointInTimeUniverse: coverage.pointInTimeUniverse,
  });
  const survivorshipSafe = suit.survivorshipSafe && researchValidity.survivorshipSafe !== false && researchValidity.pointInTimeSafe !== false;
  if (!survivorshipSafe) pushBlocker(blockers, 'survivorship-unsafe', suit.reasons.length ? suit.reasons.join('; ') : 'backfill flagged survivorshipSafe/pointInTimeSafe=false');

  // 2. In-sample coverage adequacy.
  if ((coverage.nUniqueNames || 0) < CRITERIA.minUniqueNames) pushBlocker(blockers, 'too-few-names', `${coverage.nUniqueNames || 0} unique names < ${CRITERIA.minUniqueNames}`);
  if ((coverage.nDecisionDates || 0) < CRITERIA.minDecisionDates) pushBlocker(blockers, 'too-few-dates', `${coverage.nDecisionDates || 0} decision dates < ${CRITERIA.minDecisionDates}`);

  // 3. Nested outer-OOS edge at the primary horizon (policy §2).
  const wf = walkforward[CRITERIA.primaryHorizon] || null;
  if (!wf || wf.purgedIC == null) {
    pushBlocker(blockers, 'no-walkforward', `no purged walk-forward at ${CRITERIA.primaryHorizon}`);
  } else {
    if (wf.purgedIC < CRITERIA.icHurdle) pushBlocker(blockers, 'ic-below-hurdle', `purged IC ${(+wf.purgedIC).toFixed(4)} < ${CRITERIA.icHurdle}`);
    if (wf.icir != null && Math.abs(wf.icir) < CRITERIA.icirHurdle) pushBlocker(blockers, 'icir-below-hurdle', `ICIR ${(+wf.icir).toFixed(3)} < ${CRITERIA.icirHurdle}`);
    if ((wf.nOuter || 0) < CRITERIA.minOuterBlocks) pushBlocker(blockers, 'too-few-outer-blocks', `${wf.nOuter || 0} outer blocks < ${CRITERIA.minOuterBlocks}`);
    if (wf.nRegimes != null && wf.nRegimes < CRITERIA.minRegimes) pushBlocker(blockers, 'too-few-regimes', `${wf.nRegimes} regimes < ${CRITERIA.minRegimes}`);
  }

  // 4. Incremental value — must beat the best existing peer, not just be non-zero.
  if (marginalDelta == null) pushBlocker(blockers, 'incremental-untested', 'marginal ensemble contribution not measured');
  else if (marginalDelta <= CRITERIA.minMarginalDelta) pushBlocker(blockers, 'no-incremental-value', `marginalDelta ${(+marginalDelta).toFixed(4)} ≤ ${CRITERIA.minMarginalDelta}`);

  // 5. Negative-controls clean (policy §7).
  if (controls.verdict && controls.verdict !== 'ROBUST') pushBlocker(blockers, 'controls-not-robust', `controls verdict ${controls.verdict}: ${controls.reason || ''}`.trim());
  else if (!controls.verdict) pushBlocker(blockers, 'controls-not-run', 'negative-controls battery not run');

  // 6. Prospective (live-forward) confirmation (policy §5).
  if ((coverage.nProspectiveDates || 0) < CRITERIA.minProspectiveDates) pushBlocker(blockers, 'insufficient-prospective', `${coverage.nProspectiveDates || 0} forward-resolved decision dates < ${CRITERIA.minProspectiveDates}`);
  // Only a genuinely degraded live monitor blocks; INSUFFICIENT_DATA is already covered above.
  if (prospectiveHealth === 'DEGRADING' || prospectiveHealth === 'BROKEN') pushBlocker(blockers, 'prospective-unhealthy', `live monitor status ${prospectiveHealth}`);

  const ready = blockers.length === 0;
  const status = classify(ready, blockers, controls);

  return {
    version: PROMO_VERSION,
    ready,
    status,
    affectsLiveRank: false,   // this module can never itself activate a model
    blockers,
    criteria: CRITERIA,
    suitability: suit,
    note: ready
      ? 'All frozen promotion criteria met. Promotion still requires an explicit human governance action; this gate only certifies eligibility.'
      : `NOT READY — ${blockers.length} blocker(s). ${statusNote(status)}`,
  };
}

// Map the blocker set to the audit's failure taxonomy (most fundamental first).
function classify(ready, blockers, controls) {
  if (ready) return 'PROMOTABLE';
  const ids = new Set(blockers.map(b => b.id));
  if (ids.has('survivorship-unsafe') || ids.has('too-few-names') || ids.has('too-few-dates') || ids.has('no-walkforward')) return 'INSUFFICIENT_DATA';
  if (controls && controls.verdict === 'FAIL-LEAKAGE') return 'INVALID_EVALUATION';
  if (ids.has('ic-below-hurdle') || ids.has('icir-below-hurdle') || (controls && controls.verdict === 'NO-EDGE')) return 'NO_EDGE';
  if (ids.has('no-incremental-value') || ids.has('incremental-untested')) return 'NO_INCREMENTAL_VALUE';
  if (ids.has('insufficient-prospective') || ids.has('prospective-unhealthy')) return 'AWAITING_PROSPECTIVE';
  return 'NOT_READY';
}

function statusNote(status) {
  switch (status) {
    case 'INSUFFICIENT_DATA': return 'Data is survivorship-biased, not point-in-time, or under-sampled — no edge conclusion is certifiable and promotion is blocked outright.';
    case 'INVALID_EVALUATION': return 'A negative control detected leakage — results are contaminated and must be discarded and re-run.';
    case 'NO_EDGE': return 'Evaluation is clean but there is no positive out-of-sample rank-IC to promote.';
    case 'NO_INCREMENTAL_VALUE': return 'The learned model does not add value over existing algorithms.';
    case 'AWAITING_PROSPECTIVE': return 'In-sample criteria met but live-forward shadow confirmation is not yet sufficient.';
    default: return 'One or more frozen criteria are unmet.';
  }
}

module.exports = { PROMO_VERSION, CRITERIA, coverageReport, promotionReadiness };
