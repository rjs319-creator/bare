'use strict';
// fwd-outcome-v3 fixture battery: confirmed delisting, unconfirmed stale
// history, acquisition, symbol change, split-adjustment basis, pending outcome,
// conflicting status, no_fill.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OV3 = require('../research/lib/outcome-v3');
const SM3 = require('../research/16-secmaster-v3');

const DAY = 86400000;
const CUTOFF = Date.UTC(2026, 3, 1);

function series(startMs, n, close = 100, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ ms: startMs + i * DAY, close, ...extra(i) }));
}
const activeSec = { listingId: 'pitv3:tk:live', masterVersion: 'pit-secmaster-v3', status: 'active', observedActiveThrough: CUTOFF };

function delistedSec(date, reasonCategory = null) {
  return {
    listingId: 'pitv3:tk:dead', masterVersion: 'pit-secmaster-v3', status: 'delisted',
    delisting: {
      date, source: 'fmp-delisted-companies', confirmedAt: '2026-05-01T00:00:00.000Z',
      reason: reasonCategory, reasonCategory, provenance: 'historical_reconstruction',
    },
  };
}

test('fixture: mature outcome — full horizon observed, label-ready, raw==adjusted', () => {
  const ps = series(CUTOFF - 300 * DAY, 250);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[100].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'mature');
  assert.equal(o.labelReady, true);
  assert.equal(o.adjustedReturn, o.rawReturn);
  assert.equal(o.outcomePolicyVersion, 'fwd-outcome-v3');
  assert.equal(o.intervalSemantics, 'half-open [effectiveFrom, effectiveTo)');
});

test('fixture: confirmed bankruptcy delisting inside the horizon → confirmed_delisted with the configured haircut', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);         // stops trading ~100d before cutoff
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, 'bankruptcy'), opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'confirmed_delisted');
  assert.equal(o.labelReady, true);
  assert.equal(o.delistingTreatment, 'haircut:bankruptcy');
  assert.ok(Math.abs(o.adjustedReturn - ((1 + o.rawReturn) * 0.7 - 1)) < 1e-12);
  assert.equal(o.confirmation.source, 'fmp-delisted-companies');
  assert.ok(o.terminalObservation.close > 0);
});

test('fixture: ACQUISITION delisting carries the terminal value — NO bankruptcy-like haircut', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, 'acquisition'), opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'confirmed_delisted');
  assert.equal(o.delistingTreatment, 'carry:acquisition');
  assert.equal(o.delistingAdjustment, 0);
  assert.equal(o.adjustedReturn, o.rawReturn);
});

test('fixture: mergers and renames are carry-treated too', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);
  const delistDate = new Date(ps[199].ms + DAY).toISOString().slice(0, 10);
  for (const cat of ['merger', 'rename', 'exchange-move']) {
    const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: delistedSec(delistDate, cat), opts: { dataCutoffMs: CUTOFF } });
    assert.equal(o.delistingAdjustment, 0, cat);
  }
});

test('fixture: unconfirmed stale history is UNRESOLVED with null labels (never delisted, never haircut)', () => {
  const ps = series(CUTOFF - 300 * DAY, 200);         // stale tail, no master record
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[150].ms, bars: 63, security: null, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'unresolved');
  assert.equal(o.reason, 'unknown-identity-fails-closed');
  assert.equal(o.trainingLabel, null);
  const o2 = OV3.forwardOutcomeV3({
    series: ps, dateMs: ps[150].ms, bars: 63,
    security: { listingId: 'x', masterVersion: 'v3', status: 'delisted', delisting: { date: '2026-01-01' } },   // INCOMPLETE confirmation
    opts: { dataCutoffMs: CUTOFF },
  });
  assert.equal(o2.status, 'unresolved', 'incomplete confirmation (no source/timestamp) fails closed');
});

test('fixture: pending outcome — active security, horizon not elapsed, null label', () => {
  const ps = series(CUTOFF - 100 * DAY, 98);          // fresh tail (2d before cutoff)
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[80].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'pending');
  assert.equal(o.labelReady, false);
  assert.equal(o.trainingLabel, null);
  assert.ok(o.rawReturn != null, 'partial path recorded for provenance, never as a label');
});

test('fixture: conflicting status — bars AFTER the confirmed delisting date fail closed', () => {
  const ps = series(CUTOFF - 300 * DAY, 250);
  const o = OV3.forwardOutcomeV3({
    series: ps, dateMs: ps[100].ms, bars: 200,
    security: delistedSec(new Date(ps[120].ms).toISOString().slice(0, 10), 'bankruptcy'),
    opts: { dataCutoffMs: CUTOFF },
  });
  assert.equal(o.status, 'unresolved');
  assert.match(o.reason, /conflicting-status/);
});

test('fixture: no_fill — executable outcome whose entry never filled', () => {
  const ps = series(CUTOFF - 300 * DAY, 250);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[100].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF, entryFilled: false } });
  assert.equal(o.status, 'no_fill');
  assert.equal(o.trainingLabel, null);
});

test('fixture: split — adjustment basis validated, not assumed from the vendor close', () => {
  const raw = series(CUTOFF - 300 * DAY, 250, 100, (i) => (i >= 100
    ? { close: 50, adjClose: 50, adjFactor: 1 }        // post 2:1 split
    : { close: 100, adjClose: 50, adjFactor: 0.5 }));  // pre-split bars carry the factor
  const o = OV3.forwardOutcomeV3({ series: raw, dateMs: raw[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.adjustmentBasis.basis, 'raw+adjusted-preserved');
  const broken = series(CUTOFF - 300 * DAY, 250, 100, () => ({ adjClose: 999, adjFactor: 0.5 }));
  const o2 = OV3.forwardOutcomeV3({ series: broken, dateMs: broken[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o2.adjustmentBasis.basis, 'adjustment-inconsistent');
  const bare = series(CUTOFF - 300 * DAY, 250);
  const o3 = OV3.forwardOutcomeV3({ series: bare, dateMs: bare[50].ms, bars: 63, security: activeSec, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o3.adjustmentBasis.basis, 'unverified-vendor-close', 'vendor close is never silently trusted as adjusted');
});

test('fixture: symbol change — the master maps the outcome to the STABLE listing id, not the ticker', () => {
  // secmaster-v3 built from a v3 shard where AAA→ZZZ renamed: both symbols map to ONE listingId.
  const listing = {
    listingId: 'pitv3:tk:renamed', identityConfidence: 'medium',
    identity: { ipoDate: '2015-01-01' },
    aliases: [
      { value: 'AAA', effectiveFrom: '2015-01-01', effectiveTo: '2024-01-15', knownAt: '2026-01-01', provenance: 'historical_reconstruction' },
      { value: 'ZZZ', effectiveFrom: '2024-01-15', knownAt: '2026-01-01', provenance: 'historical_reconstruction' },
    ],
    status: [{ value: 'active', effectiveFrom: '2015-01-01', knownAt: '2026-01-01T00:00:00.000Z', provenance: 'historical_reconstruction' }],
  };
  const records = SM3.recordsFromV3Shards({ A: { listings: { 'pitv3:tk:renamed': listing } } });
  assert.equal(records.AAA.listingId, 'pitv3:tk:renamed');
  assert.equal(records.ZZZ.listingId, 'pitv3:tk:renamed');
  assert.equal(records.AAA.status, 'active', 'a rename is NOT a delisting');
  const ps = series(CUTOFF - 100 * DAY, 98);
  const o = OV3.forwardOutcomeV3({ series: ps, dateMs: ps[80].ms, bars: 63, security: { ...records.ZZZ, observedActiveThrough: CUTOFF }, opts: { dataCutoffMs: CUTOFF } });
  assert.equal(o.status, 'pending', 'renamed name is pending, never haircut');
  assert.equal(o.listingId, 'pitv3:tk:renamed');
});

test('secmaster-v3 builder: only confirmed delistings become status delisted; ticker conflicts fail closed', () => {
  const shards = {
    D: { listings: {
      dead: { listingId: 'dead', identityConfidence: 'low', identity: {},
        aliases: [{ value: 'DD' }],
        status: [{ value: 'delisted', effectiveFrom: '2020-01-01', knownAt: '2026-01-01', confirmation: { source: 'fmp-delisted-companies', recordedAt: '2026-01-01' }, provenance: 'historical_reconstruction' }] },
      ghost: { listingId: 'ghost', identityConfidence: 'low', identity: {},
        aliases: [{ value: 'GG' }], status: [] },
      reuse: { listingId: 'reuse', identityConfidence: 'low', identity: {},
        aliases: [{ value: 'DD' }],
        status: [{ value: 'active', effectiveFrom: '2023-01-01', knownAt: '2026-01-01T00:00:00.000Z', provenance: 'prospective_live' }] },
    } },
  };
  const records = SM3.recordsFromV3Shards(shards);
  assert.equal(records.DD.status, 'unknown', 'two listings claim DD → conflict fails closed');
  assert.equal(records.DD.conflict, true);
  assert.deepEqual(records.DD.candidates.sort(), ['dead', 'reuse']);
  assert.equal(records.GG.status, 'unknown', 'no status intervals → unknown, not active');
});
