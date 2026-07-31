'use strict';
// GRIDLOCK schema: validation, canonical dedup, evidence merge. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/gridlock-schema');

function syntheticSource(id, publisher = 'SyntheticWire') {
  return {
    sourceId: id, sourceFamily: 'trusted-news', publisher,
    sourceUrl: `https://example.test/${id}`, publishedAt: '2026-07-01',
    retrievedAt: '2026-07-01', primaryOrSecondary: 'secondary',
    parserVersion: 'test',
  };
}
function syntheticEvent(over = {}) {
  const ev = {
    id: 'gridlock:evt:test1', schemaVersion: S.SCHEMA_VERSION,
    eventType: 'DATA_CENTER_LOAD', title: 'Synthetic campus adds load',
    announcedAt: '2026-07-01', lifecycle: 'NEW', certainty: 'ANNOUNCED',
    isoRegion: 'PJM', demandDeltaMW: 500,
    sourceEvidence: [syntheticSource('s1')], affectedTickers: [],
    unresolvedFields: [], parserVersion: 'test', ...over,
  };
  ev.canonicalEventId = over.canonicalEventId || S.canonicalEventId(ev);
  return ev;
}

test('validateEvent accepts a well-formed event', () => {
  assert.strictEqual(S.validateEvent(syntheticEvent()).ok, true);
});

test('validateEvent fails closed on bad enum, bad numeric and missing evidence', () => {
  assert.strictEqual(S.validateEvent(syntheticEvent({ eventType: 'NOT_A_TYPE' })).ok, false);
  assert.strictEqual(S.validateEvent(syntheticEvent({ demandDeltaMW: 'lots' })).ok, false);
  assert.strictEqual(S.validateEvent(syntheticEvent({ sourceEvidence: [] })).ok, false);
  assert.strictEqual(S.validateEvent(syntheticEvent({ certainty: 'MAYBE' })).ok, false);
  assert.strictEqual(S.validateEvent(syntheticEvent({ extractionConfidence: 2 })).ok, false);
});

test('canonicalEventId collapses restatements of the same project', () => {
  const a = syntheticEvent({ projectName: 'The Riverbend Data Center Campus' });
  const b = syntheticEvent({ projectName: 'Riverbend data-center campus, Phase' });
  assert.strictEqual(S.canonicalEventId(a), S.canonicalEventId(b));
  const c = syntheticEvent({ projectName: 'Totally Different Site' });
  assert.notStrictEqual(S.canonicalEventId(a), S.canonicalEventId(c));
});

test('mergeEvent: five stories become one event with five evidence records', () => {
  let ev = syntheticEvent();
  for (let i = 2; i <= 5; i++) {
    ev = S.mergeEvent(ev, syntheticEvent({ sourceEvidence: [syntheticSource(`s${i}`, `Publisher${i}`)] }));
  }
  assert.strictEqual(ev.sourceEvidence.length, 5);
  assert.strictEqual(ev.independentSourceCount, 5);        // distinct publishers
  // Re-merging the SAME source does not inflate evidence.
  const again = S.mergeEvent(ev, syntheticEvent({ sourceEvidence: [syntheticSource('s1')] }));
  assert.strictEqual(again.sourceEvidence.length, 5);
});

test('mergeEvent: later grounded numbers never overwrite; conflicts recorded', () => {
  const first = syntheticEvent({ demandDeltaMW: 500 });
  const conflicting = syntheticEvent({ demandDeltaMW: 900, sourceEvidence: [syntheticSource('s9', 'Other')] });
  const merged = S.mergeEvent(first, conflicting);
  assert.strictEqual(merged.demandDeltaMW, 500);           // kept, not overwritten
  assert.strictEqual(merged.fieldConflicts.length, 1);
  assert.deepStrictEqual({ kept: merged.fieldConflicts[0].kept, reported: merged.fieldConflicts[0].reported }, { kept: 500, reported: 900 });
});

test('mergeEvent fills nulls and maintains unresolvedFields honestly', () => {
  const sparse = syntheticEvent({ demandDeltaMW: null, capexAmount: null });
  sparse.unresolvedFields = S.NUMERIC_FIELDS.filter(f => sparse[f] == null);
  const richer = syntheticEvent({ demandDeltaMW: 750, sourceEvidence: [syntheticSource('s2', 'B')] });
  const merged = S.mergeEvent(sparse, richer);
  assert.strictEqual(merged.demandDeltaMW, 750);
  assert.ok(!merged.unresolvedFields.includes('demandDeltaMW'));
  assert.ok(merged.unresolvedFields.includes('capexAmount'));
});

test('labeled() enforces provenance labels; SHADOW_FLAGS are frozen weight-0', () => {
  const v = S.labeled(42.5, S.BASIS.OBSERVED);
  assert.deepStrictEqual(v, { value: 42.5, basis: 'observed' });
  assert.strictEqual(S.labeled(NaN, S.BASIS.DERIVED).value, null);
  assert.strictEqual(S.SHADOW_FLAGS.deploymentWeight, 0);
  assert.strictEqual(S.SHADOW_FLAGS.probability, null);
  assert.strictEqual(S.SHADOW_FLAGS.portfolioEligible, false);
  assert.throws(() => { S.SHADOW_FLAGS.deploymentWeight = 1; });
});

test('validateSourceRecord requires provenance fields', () => {
  assert.strictEqual(S.validateSourceRecord(syntheticSource('x')).ok, true);
  assert.strictEqual(S.validateSourceRecord({ sourceId: 'x' }).ok, false);
  assert.strictEqual(S.validateSourceRecord({ ...syntheticSource('x'), sourceFamily: 'blog' }).ok, false);
});
