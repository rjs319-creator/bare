'use strict';
// fwd-outcome-v3 — training-boundary assertions and APPEND-INVARIANCE.
//
// The invariance contract: appending future observations to a series can never
// CHANGE the value of an already-mature historical label. (It may only move a
// non-labeled outcome toward resolution, or fail closed on contradiction — a
// label can never silently become a different number.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OV3 = require('../research/lib/outcome-v3');

const DAY = 86400000;
const CUTOFF = Date.UTC(2026, 3, 1);

function series(startMs, n, close = 100, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ ms: startMs + i * DAY, close: typeof close === 'function' ? close(i) : close, ...extra(i) }));
}
const activeSec = { listingId: 'pitv3:tk:live', masterVersion: 'pit-secmaster-v3', status: 'active', observedActiveThrough: CUTOFF };

function delistedSec(date, reasonCategory = null, extraDelisting = {}) {
  return {
    listingId: 'pitv3:tk:dead', masterVersion: 'pit-secmaster-v3', status: 'delisted',
    delisting: {
      date, source: 'fmp-delisted-companies', confirmedAt: '2026-05-01T00:00:00.000Z',
      reason: reasonCategory, reasonCategory, provenance: 'historical_reconstruction', ...extraDelisting,
    },
  };
}

// ── append-invariance ─────────────────────────────────────────────────────────

test('invariance: appending future bars never changes a mature outcome', () => {
  const base = series(CUTOFF - 400 * DAY, 200, (i) => 100 + i);
  const before = OV3.forwardOutcomeV3({ series: base, dateMs: base[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(before.status, 'mature');
  const extended = [...base, ...series(base[199].ms + DAY, 100, (i) => 500 + i)];
  const after = OV3.forwardOutcomeV3({ series: extended, dateMs: base[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.deepEqual(
    { ...after, adjustmentBasis: null },
    { ...before, adjustmentBasis: null },
    'every field of the mature outcome (bar the series-level adjustment audit) is byte-identical after appending future data'
  );
});

test('invariance: a maturing pending outcome resolves to the SAME value a fresh mature computation gives', () => {
  // A pending outcome has trainingLabel null; when the horizon arrives, its
  // resolved label must equal what a from-scratch computation produces (no
  // path-dependence, no partial-return leakage).
  const short = series(CUTOFF - 100 * DAY, 98);
  const pending = OV3.forwardOutcomeV3({ series: short, dateMs: short[80].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.trainingLabel, null);
  const full = [...short, ...series(short[97].ms + DAY, 60, 123)];
  const resolved = OV3.forwardOutcomeV3({ series: full, dateMs: short[80].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF + 80 * DAY } });
  assert.equal(resolved.status, 'mature');
  assert.equal(resolved.trainingLabel, full[80 + 63].close / full[80].close - 1);
});

test('invariance: contradictory appended bars fail CLOSED (label withdrawn, never a different number)', () => {
  // Bars appearing after a confirmed delisting date contradict the master. The
  // outcome must become unresolved (null label) — it must never quietly keep or
  // recompute a label from the contradictory series.
  const ps = series(CUTOFF - 300 * DAY, 200);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const sec = delistedSec(delistDate, 'bankruptcy');
  const before = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: sec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(before.status, 'confirmed_delisted');
  const contradicted = [...ps, ...series(ps[199].ms + 5 * DAY, 30)];
  const after = OV3.forwardOutcomeV3({ series: contradicted, dateMs: ps[150].ms, bars: 63, security: sec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(after.status, 'unresolved');
  assert.match(after.reason, /conflicting-status/);
  assert.equal(after.trainingLabel, null);
});

// ── the truncation-explanation and cutoff guards ──────────────────────────────

test('a confirmed delisting far beyond the last bar does NOT label the stale partial return', () => {
  // Series ends 2026-01 (cache truncation); delisting confirmed 2026-03-20.
  // The ~80-day unobserved gap means the last cached bar is not a terminal
  // observation — fail closed, never confirmed_delisted at a stale price.
  const ps = series(CUTOFF - 300 * DAY, 220);   // last bar ≈ CUTOFF−80d
  const delistDate = new Date(CUTOFF - 12 * DAY).toISOString().slice(0, 10);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[180].ms, bars: 63, security: delistedSec(delistDate, 'bankruptcy'), opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'unresolved');
  assert.equal(o.reason, 'series-ends-before-delisting-data-gap');
  assert.equal(o.trainingLabel, null);
});

test('a delisting confirmed AFTER the data cutoff treats the security as active in-era', () => {
  // Name delisted 2026-07 (after the 2026-04-01 cutoff): during our data era it
  // was listed. A stale tail is then a vendor gap on an active security —
  // unresolved — not a delisting label at the cutoff-era price.
  const ps = series(CUTOFF - 300 * DAY, 200);   // stale tail ≈ CUTOFF−100d
  const o = OV3.forwardOutcomeV3({
    series: ps, dateMs: ps[150].ms, bars: 63,
    security: delistedSec(new Date(CUTOFF + 90 * DAY).toISOString().slice(0, 10), 'bankruptcy'),
    opts: { dataCutoffMs: CUTOFF },
  });
  assert.equal(o.status, 'unresolved');
  assert.equal(o.reason, 'stale-tail-active-security-data-gap');
  assert.equal(o.trainingLabel, null);
});

// ── unknown-reason policy and documented proceeds ─────────────────────────────

test('unknown delisting reason FAILS CLOSED by default: confirmed_delisted with the label withheld', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, null), opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'confirmed_delisted');
  assert.equal(o.labelReady, false, 'an unidentified acquisition must not be haircut; an unidentified bankruptcy must not carry');
  assert.equal(o.trainingLabel, null);
  assert.equal(o.delistingTreatment, 'excluded:unknown-reason');
  assert.throws(() => OV3.assertTrainable(o));
});

test('unknown-reason sensitivity overrides are explicit and disclosed in the treatment string', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const hc = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, null), opts: { dataCutoffMs: CUTOFF, unknownReasonPolicy: 'haircut' } });
  assert.equal(hc.labelReady, true);
  assert.equal(hc.delistingTreatment, 'haircut:unknown-reason-policy-haircut');
  const cr = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, null), opts: { dataCutoffMs: CUTOFF, unknownReasonPolicy: 'carry' } });
  assert.equal(cr.adjustedReturn, cr.rawReturn);
  const bad = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, null), opts: { dataCutoffMs: CUTOFF, unknownReasonPolicy: 'whatever' } });
  assert.equal(bad.status, 'unresolved', 'an invalid policy value fails closed, not open');
});

test('documented acquisition proceeds override the generic treatment (terminal value, not last print)', () => {
  const ps = series(CUTOFF - 300 * DAY, 200, 100);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const o = OV3.forwardOutcomeV3({
    series: ps, dateMs: ps[150].ms, bars: 63,
    security: delistedSec(delistDate, 'acquisition', { terminalValue: 125 }),
    opts: { dataCutoffMs: CUTOFF },
  });
  assert.equal(o.status, 'confirmed_delisted');
  assert.equal(o.delistingTreatment, 'proceeds:acquisition');
  assert.equal(o.trainingLabel, 0.25, 'label = documented per-share proceeds / entry price − 1');
});

// ── assertTrainable: the training-boundary guard ──────────────────────────────

test('assertTrainable admits only mature and confirmed_delisted label-ready outcomes', () => {
  const ps = series(CUTOFF - 400 * DAY, 300);
  const mature = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(OV3.assertTrainable(mature), mature.trainingLabel);

  const fresh = series(CUTOFF - 100 * DAY, 98);
  const pending = OV3.forwardOutcomeV3({ series: fresh, dateMs: fresh[80].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.throws(() => OV3.assertTrainable(pending), /pending/);

  const unresolved = OV3.forwardOutcomeV3({ series: series(CUTOFF - 300 * DAY, 200), dateMs: CUTOFF - 150 * DAY, bars: 63, security: null, opts: { dataCutoffMs: CUTOFF } });
  assert.throws(() => OV3.assertTrainable(unresolved), /unresolved/);

  const noFill = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF, entryFilled: false } });
  assert.throws(() => OV3.assertTrainable(noFill), /no_fill/);

  assert.throws(() => OV3.assertTrainable(null));
  assert.throws(() => OV3.assertTrainable({ status: 'mature', labelReady: true, trainingLabel: NaN }), /non-finite/);
});
