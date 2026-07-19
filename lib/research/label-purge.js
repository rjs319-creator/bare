'use strict';
// EXACT LABEL-END PURGE (label-purge-v1)
//
// The purge/embargo in lib/evolve-walkforward.js estimates a label's forward span in CALENDAR
// days via a fixed `CAL_PER_TD = 1.4` multiplier (window+embargo trading days → calendar days).
// Around holidays and long weekends that multiplier is wrong in both directions: it can leave a
// still-open label in the training set (leakage) or drop a cleanly-closed one (needless data
// loss). This module purges by the EXACT date a label resolved (`labelEndDate`, emitted by
// lib/evolve-labels.js tripleBarrier) counted against the real trading-date axis — no multiplier.
//
// Pure & dependency-free. The trading-date axis is just the sorted set of distinct decision
// dates the caller already has, so embargo is measured in real observed trading days.

const LABEL_PURGE_VERSION = 'label-purge-v1';

// Build a { date -> ordinal } index over the sorted distinct trading dates. Ordinal distance
// on this axis IS the trading-day distance, so holidays never distort it.
function buildDateAxis(dates) {
  const uniq = [...new Set((dates || []).filter(Boolean))].sort();
  const index = new Map(uniq.map((d, i) => [d, i]));
  return { dates: uniq, index };
}

// Nearest axis ordinal at-or-after a date (so an off-axis testStartDate still resolves). Returns
// axis.length when the date is beyond the last known trading day.
function ordinalAtOrAfter(axis, date) {
  const exact = axis.index.get(date);
  if (exact !== undefined) return exact;
  const arr = axis.dates;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < date) lo = mid + 1; else hi = mid; }
  return lo;
}

// Keep a training event iff its label FULLY closed at least `embargoBars` trading days before the
// test block opens. Requires a real labelEndDate; an event without one is DROPPED (conservative —
// we never assume a label closed when we can't prove when it did).
//
//   axis          : from buildDateAxis over ALL decision dates in the study
//   testStartDate : first decision date of the test block
//   embargoBars   : extra trading-day buffer beyond the label end (default 3, matching DEFAULT_EMBARGO)
function exactPurgeKeep(event, axis, testStartDate, embargoBars = 3) {
  if (!event || !event.labelEndDate) return false;
  const endOrd = axis.index.get(event.labelEndDate);
  if (endOrd === undefined) return false;                 // label end not on the axis → cannot verify
  const testOrd = ordinalAtOrAfter(axis, testStartDate);
  // strictly before the test block, minus the embargo buffer.
  return endOrd <= testOrd - 1 - embargoBars;
}

// Filter a training set with exact purge. `events` must be strictly-past already (predDate before
// the test block); this removes those whose label still overlaps the boundary.
function exactPurge(events, axis, testStartDate, embargoBars = 3) {
  return (events || []).filter((e) => exactPurgeKeep(e, axis, testStartDate, embargoBars));
}

// Diagnostic: how many events the exact purge keeps vs. the 1.4×-calendar approximation, so the
// fix's impact is measured, not asserted. `approxKeep(event)` is the legacy predicate.
function comparePurge(events, axis, testStartDate, embargoBars, approxKeep) {
  let exactKept = 0, approxKept = 0, leakedByApprox = 0, droppedByApprox = 0;
  for (const e of events || []) {
    const ex = exactPurgeKeep(e, axis, testStartDate, embargoBars);
    const ap = !!approxKeep(e);
    if (ex) exactKept++;
    if (ap) approxKept++;
    if (ap && !ex) leakedByApprox++;   // approximation kept an event that still overlaps → leakage
    if (!ap && ex) droppedByApprox++;  // approximation dropped a cleanly-closed event → data loss
  }
  return { version: LABEL_PURGE_VERSION, n: (events || []).length, exactKept, approxKept, leakedByApprox, droppedByApprox };
}

module.exports = {
  LABEL_PURGE_VERSION,
  buildDateAxis, ordinalAtOrAfter, exactPurgeKeep, exactPurge, comparePurge,
};
