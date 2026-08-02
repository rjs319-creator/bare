'use strict';
// Forward-outcome contract (fwd-outcome-v2) tests. The invariant that killed v1:
// "the window ran past the cached series" is NOT the same fact as "the name
// delisted". v2 must separate mature / delisted / pending / unresolved, carry
// full provenance, and FAIL CLOSED (adjustedReturn null) on pending/ambiguous.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pit = require('../research/lib/pit');

const DAY = pit.DAY;
const CUTOFF = pit.DATA_CUTOFF_MS;
const ms = iso => Date.parse(iso + 'T00:00:00Z');

// Build an ascending {ms, close, dollar} series of n daily bars ending at endMs.
function series(endMs, n, close = 10) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ ms: endMs - i * DAY, close, dollar: close * 1e6 });
  return out;
}

// ── mature ────────────────────────────────────────────────────────────────────
test('mature: full horizon observed, adjustedReturn === rawReturn, full provenance', () => {
  const s = series(CUTOFF - 5 * DAY, 100);
  s[60].close = 12;                                   // entry bar
  s[81].close = 15;                                   // exit bar, 21 bars later
  const o = pit.forwardOutcome(s, s[60].ms, 21);
  assert.equal(o.status, 'mature');
  assert.equal(o.horizonBars, 21);
  assert.equal(o.observedBars, 21);
  assert.equal(o.entryIndex, 60);
  assert.equal(o.expectedExitIndex, 81);
  assert.ok(Math.abs(o.rawReturn - (15 / 12 - 1)) < 1e-12);
  assert.equal(o.adjustedReturn, o.rawReturn);
  assert.equal(o.delistingAdjustment, 0);
  assert.equal(o.entryDate, new Date(s[60].ms).toISOString().slice(0, 10));
  assert.equal(o.actualExitDate, o.expectedExitDate);
  assert.equal(o.outcomePolicyVersion, 'fwd-outcome-v2');
  assert.equal(o.dataCutoff, new Date(CUTOFF).toISOString().slice(0, 10));
});

// ── pending: active name, horizon not elapsed ────────────────────────────────
test('pending: series runs to the cutoff — an active name is NOT a delisting', () => {
  const s = series(CUTOFF - 2 * DAY, 200);            // last bar 2d before cutoff → still trading
  const entryMs = s[s.length - 10].ms;                // only 9 forward bars for a 21-bar ask
  const o = pit.forwardOutcome(s, entryMs, 21);
  assert.equal(o.status, 'pending');
  assert.equal(o.reason, 'horizon-not-elapsed');
  assert.equal(o.observedBars, 9);
  assert.equal(o.adjustedReturn, null, 'pending must fail closed as a label');
  assert.equal(o.delistingAdjustment, null);
  assert.ok(Number.isFinite(o.rawReturn), 'partial path is provenance, not a label');
});

// ── delisted: series ends long before the cutoff ─────────────────────────────
test('delisted: stopped trading well before the cutoff → haircut-adjusted return', () => {
  const end = CUTOFF - 400 * DAY;                     // dead a year before cutoff
  const s = series(end, 100);
  const entryMs = s[s.length - 6].ms;                 // 5 observed bars of a 21-bar ask
  s[s.length - 6].close = 10; s[s.length - 1].close = 8;
  const o = pit.forwardOutcome(s, entryMs, 21);
  assert.equal(o.status, 'delisted');
  assert.equal(o.observedBars, 5);
  assert.ok(Math.abs(o.rawReturn - (-0.2)) < 1e-12);
  assert.equal(o.delistingAdjustment, -pit.DELISTING_HAIRCUT);
  assert.ok(Math.abs(o.adjustedReturn - ((1 - 0.2) * (1 - pit.DELISTING_HAIRCUT) - 1)) < 1e-12);
  assert.equal(o.actualExitDate, new Date(end).toISOString().slice(0, 10));
});

// ── unresolved: the ambiguous tail zone ──────────────────────────────────────
test('unresolved: tail age between grace and confirm is ambiguous → fail closed', () => {
  const midZoneDays = (pit.PENDING_GRACE_DAYS + pit.DELIST_CONFIRM_DAYS) / 2;
  const s = series(CUTOFF - midZoneDays * DAY, 100);
  const o = pit.forwardOutcome(s, s[s.length - 5].ms, 21);
  assert.equal(o.status, 'unresolved');
  assert.equal(o.reason, 'stale-tail-ambiguous');
  assert.equal(o.adjustedReturn, null);
});

test('unresolved: stale entry bar / no forward bars / bad input', () => {
  const s = series(CUTOFF - 100 * DAY, 50);
  const stale = pit.forwardOutcome(s, s[s.length - 1].ms + 40 * DAY, 21);
  assert.equal(stale.status, 'unresolved');
  assert.equal(stale.reason, 'stale-entry-bar');

  const noFwd = pit.forwardOutcome(s, s[s.length - 1].ms, 21, { dataCutoffMs: s[s.length - 1].ms });
  assert.equal(noFwd.status, 'unresolved');
  assert.equal(noFwd.reason, 'no-forward-bars');

  assert.equal(pit.forwardOutcome([], ms('2024-01-01'), 21).status, 'unresolved');
  assert.equal(pit.forwardOutcome(null, ms('2024-01-01'), 21).reason, 'invalid-input');
  assert.equal(pit.forwardOutcome(s, s[0].ms - 30 * DAY, 21).reason, 'no-bar-at-or-before-date');
});

// ── the legacy wrapper is now fail-closed ────────────────────────────────────
test('fwdReturn: mature and delisted pass through; pending/unresolved return null', () => {
  const alive = series(CUTOFF - 2 * DAY, 200);
  const mature = pit.fwdReturn(alive, alive[50].ms, 21);
  assert.ok(mature && mature.delistedWithin === false && mature.status === 'mature');
  assert.ok(mature.outcome && mature.outcome.outcomePolicyVersion === 'fwd-outcome-v2');

  // v1 would have returned {ret, delistedWithin:true} here — the poisoned label.
  const pending = pit.fwdReturn(alive, alive[alive.length - 5].ms, 21);
  assert.equal(pending, null, 'active-but-unmatured must NOT masquerade as a delisting');

  const dead = series(CUTOFF - 400 * DAY, 100);
  const del = pit.fwdReturn(dead, dead[dead.length - 6].ms, 21);
  assert.ok(del && del.delistedWithin === true && del.status === 'delisted');
  assert.ok(Number.isFinite(del.ret), 'legacy ret stays the RAW path return');

  const zone = series(CUTOFF - 20 * DAY, 100);
  assert.equal(pit.fwdReturn(zone, zone[zone.length - 5].ms, 21), null, 'ambiguous tail fails closed');
});

test('opts: custom dataCutoff, haircut, and securityMasterVersion ride the provenance', () => {
  const cut = ms('2024-06-03');
  const s = series(ms('2024-01-05'), 80);             // ends ~150d before cut → delisted
  const o = pit.forwardOutcome(s, s[s.length - 4].ms, 21,
    { dataCutoffMs: cut, delistingHaircut: 0.5, securityMasterVersion: 'pit-secmaster-v1' });
  assert.equal(o.status, 'delisted');
  assert.equal(o.delistingAdjustment, -0.5);
  assert.equal(o.dataCutoff, '2024-06-03');
  assert.equal(o.securityMasterVersion, 'pit-secmaster-v1');
});
