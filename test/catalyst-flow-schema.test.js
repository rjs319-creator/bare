'use strict';
// CATALYST–FLOW SCHEMA — the point-in-time contract. These tests guard the one claim the
// whole experiment rests on: that a feature builder can only ever see what was known at
// the cutoff, and that a vendor revision never rewrites what we recorded earlier.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/catalyst-flow/schema');

const base = {
  symbol: 'abc',
  securityIdAsOf: 'YAHOO:ABC@2024-05-02',
  eventType: 'EARNINGS',
  providerEventTimestamp: '2024-05-01T21:00:00Z',
  firstSeenAt: '2024-05-01T21:05:00Z',
  ingestedAt: '2024-05-01T21:06:00Z',
  featureCutoffTs: '2024-05-02T20:00:00Z',
  decisionDate: '2024-05-02',
  plannedEntryTs: '2024-05-03T13:30:00Z',
  source: 'test-provider',
  rawPayload: { eps: 1.1 },
  pitClass: 'IMMUTABLE_PIT',
};

test('buildEventRow uppercases the symbol and derives a stable eventId from the event, not the payload', () => {
  const a = S.buildEventRow(base);
  const b = S.buildEventRow({ ...base, rawPayload: { eps: 1.2 } });   // vendor revised the figure
  assert.strictEqual(a.symbol, 'ABC');
  assert.strictEqual(a.eventId, b.eventId, 'a revision is the SAME event, not a new one');
  assert.notStrictEqual(a.rawPayloadHash, b.rawPayloadHash, 'but the payload hash must change');
});

test('payloadHash is key-order independent — reordering a vendor object must not look like a revision', () => {
  assert.strictEqual(S.payloadHash({ a: 1, b: 2 }), S.payloadHash({ b: 2, a: 1 }));
});

test('a valid point-in-time row passes', () => {
  const v = S.validateEventRow(S.buildEventRow(base));
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

test('plannedEntryTs at or before the cutoff is REJECTED — entry must follow the freeze', () => {
  const row = S.buildEventRow({ ...base, plannedEntryTs: '2024-05-02T20:00:00Z' });
  const v = S.validateEventRow(row);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /strictly after the feature cutoff/.test(e)));
});

test('a consensus observed AFTER the release cannot be marked IMMUTABLE_PIT', () => {
  const row = S.buildEventRow({
    ...base,
    epsConsensusPreRelease: 1.0,
    epsConsensusAsOfTs: '2024-06-25T00:00:00Z',   // a today-snapshot of an old event
  });
  const v = S.validateEventRow(row);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /observed at\/after the release/.test(e)));
});

test('a consensus with NO observation timestamp is refused — "when did we see it" is not optional', () => {
  const row = S.buildEventRow({ ...base, epsConsensusPreRelease: 1.0, epsConsensusAsOfTs: null });
  const v = S.validateEventRow(row);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /no observation timestamp/.test(e)));
});

test('reconstructed history observed after its own cutoff is a WARNING, not an error — that is what makes it exploratory', () => {
  const recon = S.buildEventRow({
    ...base,
    pitClass: 'RECONSTRUCTED_EXPLORATORY',
    firstSeenAt: '2026-06-25T00:00:00Z',      // the archive was pulled two years later
    ingestedAt: '2026-06-25T00:00:00Z',
  });
  const v = S.validateEventRow(recon);
  assert.strictEqual(v.ok, true, 'exploratory rows are admitted…');
  assert.strictEqual(v.observedAfterCutoff, true, '…but flagged');

  // The same lateness on a row CLAIMING point-in-time provenance is a hard error.
  const lying = S.buildEventRow({ ...base, firstSeenAt: '2026-06-25T00:00:00Z', ingestedAt: '2026-06-25T00:00:00Z' });
  assert.strictEqual(S.validateEventRow(lying).ok, false);
});

test('appendObservation NEVER overwrites — a revision is appended with a supersedes link', () => {
  const v1 = S.buildEventRow(base);
  let ledger = S.appendObservation([], v1);
  const v2 = S.buildEventRow({ ...base, rawPayload: { eps: 1.2 } });
  ledger = S.appendObservation(ledger, v2);

  assert.strictEqual(ledger.length, 2);
  assert.strictEqual(ledger[0].rowHash, v1.rowHash, 'the original observation is untouched');
  assert.strictEqual(ledger[1].revision, 2);
  assert.strictEqual(ledger[1].supersedes, v1.rowHash);
});

test('an identical re-observation is a no-op — nothing new was learned', () => {
  const v1 = S.buildEventRow(base);
  const ledger = S.appendObservation(S.appendObservation([], v1), S.buildEventRow(base));
  assert.strictEqual(ledger.length, 1);
});

test('EVERY row in the chain is independently verifiable — including revisions', () => {
  // Regression: appendObservation rehashed over `{...row, rowHash: undefined}`, which
  // canonicalJson serialised as a `"rowHash":undefined` member that the original object
  // did not have. Revision 1 verified; revision 2 onward did not, so the append-only
  // ledger could not actually be audited — the one thing it exists to allow.
  const strip = (r) => { const { rowHash, ...rest } = r; return rest; };
  let ledger = S.appendObservation([], S.buildEventRow(base));
  ledger = S.appendObservation(ledger, S.buildEventRow({ ...base, rawPayload: { eps: 2 } }));
  ledger = S.appendObservation(ledger, S.buildEventRow({ ...base, rawPayload: { eps: 3 } }));

  assert.strictEqual(ledger.length, 3);
  ledger.forEach((r, i) => {
    assert.strictEqual(r.rowHash, S.payloadHash(strip(r)), `revision ${r.revision} must be recomputable`);
    if (i > 0) assert.strictEqual(r.supersedes, ledger[i - 1].rowHash, `revision ${r.revision} must link to its parent`);
  });
  assert.deepStrictEqual(ledger.map((r) => r.revision), [1, 2, 3]);
});

test('canonicalJson omits undefined members, exactly as JSON.stringify does', () => {
  assert.strictEqual(S.payloadHash({ a: 1 }), S.payloadHash({ a: 1, b: undefined }));
  assert.notStrictEqual(S.payloadHash({ a: 1 }), S.payloadHash({ a: 1, b: null }),
    'an explicit null is data and must still change the hash');
});

test('observationAsOf returns what was known THEN, never a later revision', () => {
  const v1 = S.buildEventRow(base);
  let ledger = S.appendObservation([], v1);
  ledger = S.appendObservation(ledger, S.buildEventRow({
    ...base, rawPayload: { eps: 9.9 }, firstSeenAt: '2024-08-01T00:00:00Z',
  }));

  const early = S.observationAsOf(ledger, v1.eventId, '2024-05-02T20:00:00Z');
  assert.strictEqual(early.revision, 1, 'the May decision cannot see the August revision');

  const late = S.observationAsOf(ledger, v1.eventId, '2024-09-01T00:00:00Z');
  assert.strictEqual(late.revision, 2);

  assert.strictEqual(S.observationAsOf(ledger, v1.eventId, '2024-01-01T00:00:00Z'), null);
});
