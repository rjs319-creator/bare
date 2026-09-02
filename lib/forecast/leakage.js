'use strict';
// LEAKAGE GUARDS & POINT-IN-TIME AUDIT (forecast-leakage-v1)
//
// Every check here is a FUNCTION THAT CAN FAIL, not a comment claiming a property. They are run
// by the walk-forward orchestrator on every fold and asserted directly by
// test/forecast-leakage.test.js, including against deliberately-poisoned inputs — a guard that
// has never been shown to reject anything is not a guard.
//
// Checks implemented:
//   maxSourceTs        no feature row may cite a source dated after its own decision date
//   foldOrdering       train ends before test starts, with the full embargo in between
//   noRandomSplit      folds are chronological, non-overlapping and in increasing order
//   purge              no surviving training label overlaps the test block
//   scalerFitWindow    a fitted transform saw no row at or after the evaluation block
//   calibratorSeparation a calibrator never scores rows from its own fitting window
//   stackingProvenance no in-sample base prediction reaches the meta-ranker (delegated to
//                      lib/forecast/crossfit.js assertNoInSampleStacking)
//   entityAliasing     one securityId never appears twice on the same decision date
//   syntheticFutureFeature  an injected future-looking feature MUST be rejected
//
// A check returns { ok, violations, checked }. `runAudit` aggregates and FAILS CLOSED: an audit
// that could not run is not a pass.

const { assertNoInSampleStacking } = require('./crossfit');
const LP = require('../research/label-purge');

const LEAKAGE_VERSION = 'forecast-leakage-v1';

const v = (reason, detail) => ({ reason, ...detail });

/** No feature row may cite a source dated after its own decision date. */
function auditMaxSourceTs(rows, { limit = 20 } = {}) {
  const violations = [];
  for (const r of rows) {
    const src = r.maxSourceDate || (r.pit && r.pit.maxSourceTs) || null;
    if (!src) { if (violations.length < limit) violations.push(v('no maxSourceDate recorded — provenance cannot be proven', { ticker: r.ticker, decisionDate: r.decisionDate })); continue; }
    if (src > r.decisionDate) {
      if (violations.length < limit) violations.push(v('feature cites a source dated after the decision date', { ticker: r.ticker, decisionDate: r.decisionDate, maxSourceDate: src }));
    }
  }
  return { ok: violations.length === 0, violations, checked: rows.length };
}

/** Train must end at least `embargoSessions` sessions before the test block opens. */
function auditFoldOrdering(folds, axis) {
  const violations = [];
  for (const f of folds) {
    if (!(f.trainEnd < f.testStart)) { violations.push(v('train window does not end before the test window', { fold: f.id, trainEnd: f.trainEnd, testStart: f.testStart })); continue; }
    const te = axis.index.get(f.trainEnd);
    const ts = axis.index.get(f.testStart);
    if (te == null || ts == null) { violations.push(v('fold boundary is not on the session axis', { fold: f.id, trainEnd: f.trainEnd, testStart: f.testStart })); continue; }
    const gap = ts - te - 1;
    if (gap < f.embargoSessions) violations.push(v('embargo gap is smaller than declared', { fold: f.id, gap, required: f.embargoSessions }));
  }
  return { ok: violations.length === 0, violations, checked: folds.length };
}

/** Folds must be chronological and non-overlapping — the structural proof of "no random split". */
function auditNoRandomSplit(folds) {
  const violations = [];
  for (let i = 1; i < folds.length; i++) {
    const a = folds[i - 1], b = folds[i];
    if (!(b.testStart > a.testStart)) violations.push(v('fold test blocks are not in increasing chronological order', { previous: a.id, fold: b.id }));
    if (b.testStart <= a.testEnd) violations.push(v('fold test blocks overlap', { previous: a.id, fold: b.id, previousEnd: a.testEnd, start: b.testStart }));
  }
  for (const f of folds) {
    if (f.trainStart > f.trainEnd) violations.push(v('train window is inverted', { fold: f.id }));
  }
  return { ok: violations.length === 0, violations, checked: folds.length };
}

/** No surviving training row's label may still be open at the test boundary. */
function auditPurge(trainRows, axis, testStartDate, embargoSessions, { limit = 20 } = {}) {
  const violations = [];
  for (const r of trainRows) {
    const labelEnd = r.label && r.label.labelEnd;
    if (!labelEnd) { if (violations.length < limit) violations.push(v('training row has no provable labelEnd', { ticker: r.ticker, decisionDate: r.decisionDate })); continue; }
    if (!LP.exactPurgeKeep({ labelEndDate: labelEnd }, axis, testStartDate, embargoSessions)) {
      if (violations.length < limit) violations.push(v('training label overlaps the test block or its embargo', { ticker: r.ticker, decisionDate: r.decisionDate, labelEnd, testStart: testStartDate, embargo: embargoSessions }));
    }
  }
  return { ok: violations.length === 0, violations, checked: trainRows.length };
}

/** A fitted transform must not have seen any row at or after the evaluation block's start. */
function auditScalerFitWindow(scaler, evaluationStartDate) {
  const violations = [];
  if (!scaler) return { ok: false, violations: [v('no scaler supplied — a globally fitted transform cannot be ruled out', {})], checked: 0 };
  if (!scaler.fittedThroughDate) violations.push(v('scaler does not record its fitting window', {}));
  else if (scaler.fittedThroughDate >= evaluationStartDate) violations.push(v('scaler was fitted on rows at or after the evaluation block', { fittedThrough: scaler.fittedThroughDate, evaluationStart: evaluationStartDate }));
  return { ok: violations.length === 0, violations, checked: 1 };
}

/** A calibrator must never score rows drawn from its own fitting window. */
function auditCalibratorSeparation(calibrator, scoredRows) {
  const violations = [];
  if (!calibrator) return { ok: true, violations, checked: 0 };
  if (calibrator.status === 'calibrated' && !calibrator.fittedThroughDate) {
    violations.push(v('calibrator claims to be calibrated but records no fitting window', { label: calibrator.label }));
  }
  if (calibrator.sourceEvaluationType === 'unknown') {
    violations.push(v('calibrator does not record whether it was fitted on cross-fitted or validation predictions', { label: calibrator.label }));
  }
  for (const r of scoredRows) {
    if (calibrator.fittedThroughDate && r.decisionDate <= calibrator.fittedThroughDate) {
      violations.push(v('calibrator is scoring a row from inside its own fitting window', { label: calibrator.label, decisionDate: r.decisionDate, fittedThrough: calibrator.fittedThroughDate }));
      break;
    }
  }
  return { ok: violations.length === 0, violations, checked: scoredRows.length };
}

/** One security may appear at most once per decision date — guards duplicate/aliased listings. */
function auditEntityAliasing(rows) {
  const seen = new Set();
  const violations = [];
  for (const r of rows) {
    const key = `${r.securityId || r.ticker}|${r.decisionDate}`;
    if (seen.has(key)) violations.push(v('the same security appears twice on one decision date', { securityId: r.securityId || r.ticker, decisionDate: r.decisionDate }));
    seen.add(key);
  }
  return { ok: violations.length === 0, violations, checked: rows.length };
}

/**
 * SYNTHETIC FUTURE-FEATURE PROBE. Injects a feature row whose maxSourceDate is the NEXT
 * session and asserts the PIT audit rejects it. If this probe ever "passes" (i.e. the audit
 * accepts the poisoned row), the audit itself is broken and the run must fail.
 */
function syntheticFutureFeatureProbe(sessions) {
  if (!sessions || sessions.length < 2) return { ok: false, detected: false, reason: 'not enough sessions to build the probe' };
  const decisionDate = sessions[sessions.length - 2];
  const future = sessions[sessions.length - 1];
  const poisoned = [{ ticker: '__PROBE__', decisionDate, maxSourceDate: future, features: { peek: 1 } }];
  const audit = auditMaxSourceTs(poisoned);
  return { ok: !audit.ok, detected: !audit.ok, probeDecisionDate: decisionDate, probeSourceDate: future, reason: audit.ok ? 'the PIT audit ACCEPTED a feature sourced from a future bar — the audit is broken' : null };
}

/**
 * Run the whole audit for one fold. FAILS CLOSED: any check that could not run counts as a
 * failure, and the report lists every failing check by name.
 */
function runAudit({ folds, axis, trainRows, testRows, scaler, calibrators = {}, stackingFrames = [], sessions = [] }) {
  const checks = {};
  checks.noRandomSplit = auditNoRandomSplit(folds || []);
  checks.foldOrdering = axis ? auditFoldOrdering(folds || [], axis) : { ok: false, violations: [v('no session axis supplied', {})], checked: 0 };
  checks.maxSourceTsTrain = auditMaxSourceTs(trainRows || []);
  checks.maxSourceTsTest = auditMaxSourceTs(testRows || []);
  checks.entityAliasing = auditEntityAliasing([...(trainRows || []), ...(testRows || [])]);
  checks.syntheticFutureFeature = syntheticFutureFeatureProbe(sessions);
  if (folds && folds.length && axis) {
    const last = folds[folds.length - 1];
    checks.purge = auditPurge(trainRows || [], axis, last.testStart, last.embargoSessions);
    checks.scalerFitWindow = auditScalerFitWindow(scaler, last.testStart);
  } else {
    checks.purge = { ok: false, violations: [v('no folds/axis supplied — purge could not be verified', {})], checked: 0 };
    checks.scalerFitWindow = { ok: false, violations: [v('no folds supplied — scaler window could not be verified', {})], checked: 0 };
  }
  for (const [name, cal] of Object.entries(calibrators)) {
    checks[`calibratorSeparation:${name}`] = auditCalibratorSeparation(cal, testRows || []);
  }
  checks.stackingProvenance = stackingFrames.length
    ? assertNoInSampleStacking(stackingFrames)
    : { ok: true, violations: [], checked: 0, note: 'no stacking frames supplied' };

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  return Object.freeze({
    schema: 'ForecastLeakageAudit', version: LEAKAGE_VERSION,
    ok: failed.length === 0,
    failedChecks: Object.freeze(failed),
    checks: Object.freeze(checks),
  });
}

module.exports = {
  LEAKAGE_VERSION, auditMaxSourceTs, auditFoldOrdering, auditNoRandomSplit, auditPurge,
  auditScalerFitWindow, auditCalibratorSeparation, auditEntityAliasing,
  syntheticFutureFeatureProbe, runAudit,
};
