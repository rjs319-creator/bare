'use strict';
// LEAKAGE GUARDS. Every check is asserted BOTH ways: it must pass on clean input AND reject a
// deliberately poisoned one. A guard that has never been shown to reject anything is not a guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/forecast/leakage');
const CF = require('../lib/forecast/crossfit');
const CAL = require('../lib/forecast/calibration');
const FOLDS = require('../lib/forecast/folds');
const XS = require('../lib/forecast/xsection');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();
const sessions = Array.from({ length: 400 }, (_, i) => `S${String(i).padStart(4, '0')}`);
const axis = FOLDS.buildAxis(sessions);

test('SYNTHETIC FUTURE FEATURE: the PIT audit must reject a row sourced from the next bar', () => {
  const probe = L.syntheticFutureFeatureProbe(sessions);
  assert.equal(probe.detected, true, probe.reason || 'the audit accepted a future-sourced feature');
  assert.equal(probe.ok, true);
  assert.ok(probe.probeSourceDate > probe.probeDecisionDate);
});

test('maxSourceTs audit passes clean rows and rejects a future-sourced one', () => {
  const clean = [{ ticker: 'A', decisionDate: sessions[10], maxSourceDate: sessions[10] }, { ticker: 'B', decisionDate: sessions[10], maxSourceDate: sessions[9] }];
  assert.equal(L.auditMaxSourceTs(clean).ok, true);

  const poisoned = [...clean, { ticker: 'C', decisionDate: sessions[10], maxSourceDate: sessions[11] }];
  const bad = L.auditMaxSourceTs(poisoned);
  assert.equal(bad.ok, false);
  assert.match(bad.violations[0].reason, /after the decision date/);
});

test('a row with no recorded source date FAILS CLOSED — provenance must be provable', () => {
  const r = L.auditMaxSourceTs([{ ticker: 'A', decisionDate: sessions[10] }]);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /provenance cannot be proven/);
});

test('fold-ordering audit rejects a shrunken embargo', () => {
  const good = [{ id: 'f0', trainEnd: sessions[50], testStart: sessions[63], embargoSessions: 12 }];
  assert.equal(L.auditFoldOrdering(good, axis).ok, true);
  const tight = [{ id: 'f0', trainEnd: sessions[50], testStart: sessions[55], embargoSessions: 12 }];
  const r = L.auditFoldOrdering(tight, axis);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /embargo gap is smaller/);
});

test('fold-ordering audit rejects a train window that runs past the test start', () => {
  const inverted = [{ id: 'f0', trainEnd: sessions[70], testStart: sessions[60], embargoSessions: 1 }];
  const r = L.auditFoldOrdering(inverted, axis);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /does not end before/);
});

test('NO RANDOM SPLIT: out-of-order or overlapping test blocks are rejected', () => {
  const chronological = FOLDS.buildOuterFolds(sessions, cfg);
  assert.equal(L.auditNoRandomSplit(chronological).ok, true);

  const shuffled = [chronological[1], chronological[0]];
  const r = L.auditNoRandomSplit(shuffled);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /increasing chronological order/);

  const overlapping = [
    { id: 'a', trainStart: sessions[0], trainEnd: sessions[50], testStart: sessions[60], testEnd: sessions[90] },
    { id: 'b', trainStart: sessions[0], trainEnd: sessions[60], testStart: sessions[80], testEnd: sessions[110] },
  ];
  assert.equal(L.auditNoRandomSplit(overlapping).ok, false);
});

test('purge audit rejects a training label that overlaps the test block', () => {
  const clean = [{ ticker: 'A', decisionDate: sessions[80], label: { labelEnd: sessions[90] } }];
  assert.equal(L.auditPurge(clean, axis, sessions[100], 5).ok, true);

  const leaky = [...clean, { ticker: 'B', decisionDate: sessions[98], label: { labelEnd: sessions[104] } }];
  const r = L.auditPurge(leaky, axis, sessions[100], 5);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /overlaps the test block/);
});

test('scaler audit rejects a transform fitted at or after the evaluation block', () => {
  const rows = sessions.slice(0, 60).map((d) => ({ decisionDate: d, features: { a: 1, b: 2 } }));
  const good = XS.fitScaler(rows, ['a', 'b'], cfg);
  assert.equal(L.auditScalerFitWindow(good, sessions[80]).ok, true);

  const late = XS.fitScaler(sessions.slice(0, 100).map((d) => ({ decisionDate: d, features: { a: 1, b: 2 } })), ['a', 'b'], cfg);
  const r = L.auditScalerFitWindow(late, sessions[80]);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /at or after the evaluation block/);
  assert.equal(L.auditScalerFitWindow(null, sessions[80]).ok, false, 'a missing scaler fails closed');
});

test('a calibrator may not score rows from inside its own fitting window', () => {
  const pairs = sessions.slice(0, 60).flatMap((d) => Array.from({ length: 20 }, (_, i) => ({ x: i / 20, y: i % 2, date: d })));
  const cal = CAL.fit(pairs, cfg, { sourceEvaluationType: 'cross-fitted', label: 'test' });
  assert.equal(cal.status, CAL.STATUS.CALIBRATED);

  const later = [{ decisionDate: sessions[80] }];
  assert.equal(L.auditCalibratorSeparation(cal, later).ok, true);

  const inside = [{ decisionDate: sessions[30] }];
  const r = L.auditCalibratorSeparation(cal, inside);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /inside its own fitting window/);
});

test('a calibrator that hides its provenance is rejected', () => {
  const pairs = sessions.slice(0, 60).flatMap((d) => Array.from({ length: 20 }, (_, i) => ({ x: i / 20, y: i % 2, date: d })));
  const cal = CAL.fit(pairs, cfg, {});     // no sourceEvaluationType
  const r = L.auditCalibratorSeparation(cal, [{ decisionDate: sessions[80] }]);
  assert.equal(r.ok, false);
  assert.match(r.violations.map((x) => x.reason).join(' '), /cross-fitted or validation/);
});

test('IN-SAMPLE STACKING is rejected: a base model that saw the frame\'s own date', () => {
  const clean = [
    { rowKey: 'A|S0100', decisionDate: 'S0100', evaluationType: CF.EVAL.CROSS_FITTED, producedByModelTrainedThrough: 'S0090' },
    { rowKey: 'B|S0101', decisionDate: 'S0101', evaluationType: CF.EVAL.CROSS_FITTED, producedByModelTrainedThrough: 'S0090' },
  ];
  assert.equal(CF.assertNoInSampleStacking(clean).ok, true);

  const poisoned = [...clean, { rowKey: 'C|S0100', decisionDate: 'S0100', evaluationType: CF.EVAL.CROSS_FITTED, producedByModelTrainedThrough: 'S0100' }];
  const r = CF.assertNoInSampleStacking(poisoned);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /reaches the frame's own decision date/);

  const explicit = [{ rowKey: 'D|S0100', decisionDate: 'S0100', evaluationType: CF.EVAL.IN_SAMPLE, producedByModelTrainedThrough: 'S0090' }];
  assert.equal(CF.assertNoInSampleStacking(explicit).ok, false, 'an explicitly in-sample frame is always rejected');

  const unprovable = [{ rowKey: 'E|S0100', decisionDate: 'S0100', evaluationType: CF.EVAL.CROSS_FITTED, producedByModelTrainedThrough: null }];
  assert.equal(CF.assertNoInSampleStacking(unprovable).ok, false, 'a frame with no recorded cutoff fails closed');
});

test('the meta-ranker REFUSES to train on in-sample stacking frames', () => {
  const META = require('../lib/forecast/meta-ranker');
  const poisoned = [{ rowKey: 'A|S0100', ticker: 'A', decisionDate: 'S0100', horizon: 5, evaluationType: CF.EVAL.CROSS_FITTED, producedByModelTrainedThrough: 'S0100', features: { a: 1 }, base: {}, label: { residualReturn: 0.01 } }];
  const r = META.fitAndScore({ trainFrames: poisoned, predictFrames: poisoned, baseNames: ['ridge'], featureKeys: ['a'], cfg, caps: { components: { lightgbm: { available: false, reason: 'test' } } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /refusing to train the meta-ranker/);
});

test('entity aliasing: one security may not appear twice on a decision date', () => {
  const clean = [{ securityId: 'X', decisionDate: 'S0100' }, { securityId: 'Y', decisionDate: 'S0100' }];
  assert.equal(L.auditEntityAliasing(clean).ok, true);
  const dupe = [...clean, { securityId: 'X', decisionDate: 'S0100' }];
  const r = L.auditEntityAliasing(dupe);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /twice on one decision date/);
});

test('runAudit FAILS CLOSED when it cannot verify something', () => {
  const empty = L.runAudit({ folds: [], axis: null, trainRows: [], testRows: [], scaler: null, sessions: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.failedChecks.includes('foldOrdering'));
  assert.ok(empty.failedChecks.includes('purge'));
  assert.ok(empty.failedChecks.includes('scalerFitWindow'));
  assert.ok(empty.failedChecks.includes('syntheticFutureFeature'), 'without a session axis the probe itself cannot run — that is a failure, not a pass');
});

test('runAudit passes on a clean, correctly purged fold', () => {
  const fold = FOLDS.buildOuterFolds(sessions, cfg)[0];
  const trainRows = sessions.slice(0, sessions.indexOf(fold.trainEnd) + 1).map((d) => ({
    ticker: 'A', securityId: `A|${d}`, decisionDate: d, maxSourceDate: d,
    label: { labelEnd: d },
  }));
  const testRows = [{ ticker: 'A', securityId: 'A|test', decisionDate: fold.testStart, maxSourceDate: fold.testStart }];
  const scaler = XS.fitScaler(trainRows.map((r) => ({ ...r, features: { a: 1, b: 2 } })), ['a', 'b'], cfg);
  const audit = L.runAudit({ folds: [fold], axis, trainRows, testRows, scaler, sessions });
  assert.equal(audit.ok, true, `unexpected failures: ${audit.failedChecks.join(', ')}`);
});
