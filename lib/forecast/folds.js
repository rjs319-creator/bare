'use strict';
// PURGED WALK-FORWARD FOLDS (forecast-folds-v1)
//
// There are NO random splits anywhere in this system. Every fold is chronological, and every
// training set is purged against the fold that follows it.
//
// PURGE + EMBARGO, stated precisely:
//   A training row may be used for a fold whose test block opens at session `T` only when the
//   row's LABEL fully closed at least `embargo` sessions before `T`:
//        labelEndOrdinal <= ordinal(T) - 1 - embargo
//   The comparison is on LABEL INTERVALS (labelStart..labelEnd), not on row dates, because a
//   10-session label decided 3 sessions before the boundary still overlaps the test block.
//   A row without a provable `labelEnd` is DROPPED — we never assume a label closed.
//
//   The default embargo is max(horizon) + `embargoExtra`, so the longest label in the study
//   cannot straddle the boundary even for the shortest-horizon model.
//
// This module delegates the exact-label-end predicate to lib/research/label-purge.js — the
// repo's existing implementation, with its own tests — rather than growing a second one.

const LP = require('../research/label-purge');

const FOLDS_VERSION = 'forecast-folds-v1';

/** Default embargo in TRADING SESSIONS: the longest label plus a buffer. */
function defaultEmbargo(cfg) {
  if (Number.isFinite(cfg.walkforward.embargoSessions)) return cfg.walkforward.embargoSessions;
  return Math.max(...cfg.horizons) + cfg.walkforward.embargoExtra;
}

/**
 * The embargo expressed in DECISION-DATE units.
 *
 * Folds are built on the decision-date axis, which may be a strided subsample of the trading
 * calendar (a stride of 5 means one decision date per trading week). The embargo is defined in
 * trading sessions, so it must be converted — and always ROUNDED UP, so a strided study is
 * over-purged rather than under-purged. The exact label-end purge still runs on the FULL trading
 * session axis, where it is precise; this conversion only sizes the structural gap between the
 * training and test blocks.
 */
function embargoUnitsFor(cfg, stride = 1) {
  const s = Math.max(1, Math.floor(stride) || 1);
  return Math.ceil(defaultEmbargo(cfg) / s);
}

/**
 * Split the session axis into a development span and a FINAL UNTOUCHED HOLDOUT.
 * The holdout is the last `holdoutFraction` of sessions. Nothing in model selection, tuning,
 * calibration or weighting may see it; it is scored once, at the end, and reported separately.
 */
function splitHoldout(sessions, cfg) {
  const f = cfg.walkforward.holdoutFraction;
  if (!(f > 0 && f < 1) || sessions.length < 200) {
    return { development: sessions.slice(), holdout: [], holdoutViable: false, reason: 'insufficient history for a separate holdout' };
  }
  const cut = Math.floor(sessions.length * (1 - f));
  return { development: sessions.slice(0, cut), holdout: sessions.slice(cut), holdoutViable: true, reason: null };
}

/**
 * Build chronological outer folds over `sessions`.
 * Each fold is { id, scheme, trainStart, trainEnd, embargoSessions, testStart, testEnd,
 *                trainSessions, testSessionsCount }.
 * Expanding: train is everything before the embargo boundary. Rolling: the last
 * `rollingTrainSessions` before it.
 */
function buildOuterFolds(sessions, cfg, { stride = 1 } = {}) {
  const wf = cfg.walkforward;
  const embargo = embargoUnitsFor(cfg, stride);
  const embargoSessions = defaultEmbargo(cfg);
  const step = Number.isFinite(wf.stepSessions) && wf.stepSessions > 0 ? wf.stepSessions : wf.testSessions;
  const folds = [];

  let testStartIdx = wf.minTrainSessions + embargo;
  let id = 0;
  while (testStartIdx + wf.testSessions <= sessions.length) {
    const testEndIdx = testStartIdx + wf.testSessions - 1;
    const trainEndIdx = testStartIdx - embargo - 1;
    if (trainEndIdx < wf.minTrainSessions - 1) { testStartIdx += step; continue; }
    const trainStartIdx = wf.scheme === 'rolling'
      ? Math.max(0, trainEndIdx - wf.rollingTrainSessions + 1)
      : 0;
    folds.push(Object.freeze({
      id: `fold${id++}`,
      scheme: wf.scheme,
      trainStart: sessions[trainStartIdx], trainEnd: sessions[trainEndIdx],
      testStart: sessions[testStartIdx], testEnd: sessions[testEndIdx],
      embargoSessions,                 // trading sessions — what the exact purge uses
      embargoUnits: embargo,           // decision-date steps — the structural gap between blocks
      decisionDateStride: stride,
      trainSessions: trainEndIdx - trainStartIdx + 1,
      testSessionsCount: testEndIdx - testStartIdx + 1,
    }));
    testStartIdx += step;
  }
  return folds;
}

/**
 * Chronological INNER folds inside one outer training window, used to produce the cross-fitted
 * base predictions the meta-ranker and the calibrators are allowed to learn from.
 *
 * Each inner fold trains strictly before its own validation segment and applies the same
 * purge/embargo rule at the inner boundary, so an inner training label can never overlap the
 * inner validation block either.
 */
function buildInnerFolds(trainSessions, cfg, { stride = 1 } = {}) {
  const wf = cfg.walkforward;
  const k = Math.max(2, wf.innerFolds);
  const embargoSessions = defaultEmbargo(cfg) + wf.innerEmbargoExtra;
  const embargo = Math.ceil(embargoSessions / Math.max(1, Math.floor(stride) || 1));
  const n = trainSessions.length;
  // Reserve enough history for the first inner training window.
  const minInnerTrain = Math.max(60, Math.floor(n / (k + 1)));
  const segment = Math.floor((n - minInnerTrain) / k);
  if (segment < 5) return [];

  const folds = [];
  for (let i = 0; i < k; i++) {
    const valStartIdx = minInnerTrain + i * segment;
    const valEndIdx = (i === k - 1) ? n - 1 : Math.min(n - 1, valStartIdx + segment - 1);
    const trainEndIdx = valStartIdx - embargo - 1;
    if (trainEndIdx < 30 || valStartIdx > valEndIdx) continue;
    folds.push(Object.freeze({
      id: `inner${i}`,
      trainStart: trainSessions[0], trainEnd: trainSessions[trainEndIdx],
      validStart: trainSessions[valStartIdx], validEnd: trainSessions[valEndIdx],
      embargoSessions, embargoUnits: embargo, decisionDateStride: stride,
      trainSessions: trainEndIdx + 1,
      validSessions: valEndIdx - valStartIdx + 1,
    }));
  }
  return folds;
}

/** Build the trading-session ordinal axis the purge measures against. */
const buildAxis = (sessions) => LP.buildDateAxis(sessions);

/**
 * Purge training rows against a test block opening at `testStartDate`.
 * Rows must carry `label.labelEnd`; those that do not are dropped and COUNTED.
 * Returns { kept, dropped: { noLabelEnd, overlapping } }.
 */
function purgeTrainingRows(rows, axis, testStartDate, embargoSessions) {
  const kept = [];
  const dropped = { noLabelEnd: 0, overlapping: 0 };
  for (const r of rows) {
    const labelEnd = r && r.label && r.label.labelEnd;
    if (!labelEnd) { dropped.noLabelEnd++; continue; }
    if (LP.exactPurgeKeep({ labelEndDate: labelEnd }, axis, testStartDate, embargoSessions)) kept.push(r);
    else dropped.overlapping++;
  }
  return { kept, dropped };
}

/** Rows whose decision date falls in [start, end] inclusive. */
const rowsInRange = (rows, start, end) => rows.filter((r) => r.decisionDate >= start && r.decisionDate <= end);

module.exports = {
  FOLDS_VERSION, defaultEmbargo, embargoUnitsFor, splitHoldout, buildOuterFolds, buildInnerFolds,
  buildAxis, purgeTrainingRows, rowsInRange,
};
