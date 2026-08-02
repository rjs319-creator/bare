'use strict';
// Append-only evidence log + sealed holdouts + append-only decision events.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/research/evidence-log');
const DE = require('../lib/research/decision-events');

function memDeps() {
  const blobs = new Map();
  return {
    blobs,
    readJSON: async (path, fallback = null) => (blobs.has(path) ? blobs.get(path) : fallback),
    writeJSON: async (path, doc) => { blobs.set(path, JSON.parse(JSON.stringify(doc))); },
    now: () => Date.UTC(2026, 7, 2, 12),
  };
}

const evidenceFields = (over = {}) => ({
  hypothesisId: 'momentum-12-1-swing', datasetHash: 'panel-v3:abc', periodStart: '2022-01-01',
  periodEnd: '2026-05-31', horizon: '63d', codeVersion: 'sha:cafe', manifestHash: 'mani:1',
  metrics: { meanIC: 0.01, q: 0.4 }, verdict: 'not-confirmed', mode: 'confirmatory',
  generatedAt: '2026-08-02T00:00:00Z', ...over,
});

test('evidence records are keyed by (hypothesis, dataset, period, horizon, code, manifest) and validated', () => {
  const a = EL.makeEvidenceRecord(evidenceFields());
  assert.equal(a.ok, true);
  const same = EL.makeEvidenceRecord(evidenceFields());
  assert.equal(a.record.recordId, same.record.recordId, 'same evidence key → same id (idempotent)');
  const diff = EL.makeEvidenceRecord(evidenceFields({ codeVersion: 'sha:beef' }));
  assert.notEqual(a.record.recordId, diff.record.recordId, 'any key change → new record');
  const bad = EL.makeEvidenceRecord(evidenceFields({ verdict: 'confirmed!!' }));
  assert.equal(bad.ok, false);
});

test('appendEvidence is append-only: re-append is a recorded no-op and there is NO overwrite parameter', async () => {
  const deps = memDeps();
  const { record } = EL.makeEvidenceRecord(evidenceFields());
  assert.deepEqual(await EL.appendEvidence(deps, record), { written: true, reason: 'appended', recordId: record.recordId });
  const again = await EL.appendEvidence(deps, { ...record, metrics: { tampered: true } });
  assert.equal(again.written, false);
  assert.equal(again.reason, 'already-recorded');
  const stored = deps.blobs.get(EL.recordPath(record.hypothesisId, record.recordId));
  assert.equal(stored.metrics.tampered, undefined, 'the original evidence is untouched');
  assert.equal(EL.appendEvidence.length, 2, 'no third force/overwrite parameter exists');
});

test('deriveStatus is a VIEW over evidence: single pass is never strong validation; two periods earn provisional at most', () => {
  const rec = (over) => EL.makeEvidenceRecord(evidenceFields(over)).record;
  assert.equal(EL.deriveStatus([]).status, 'open');
  assert.equal(EL.deriveStatus([rec({ verdict: 'not-confirmed' })]).status, 'no-edge');
  const onePass = [rec({ verdict: 'pass-provisional' })];
  assert.equal(EL.deriveStatus(onePass).status, 'open', 'one period never confirms');
  const twoPass = [
    rec({ verdict: 'pass-provisional', periodStart: '2022-01-01', periodEnd: '2023-12-31' }),
    rec({ verdict: 'pass-provisional', periodStart: '2024-01-01', periodEnd: '2025-12-31' }),
  ];
  assert.equal(EL.deriveStatus(twoPass).status, 'provisional', 'provisional at MOST — promotion stays a human act');
  const conflicted = [...twoPass, rec({ verdict: 'not-confirmed', periodStart: '2026-01-01', periodEnd: '2026-06-30' })];
  assert.equal(EL.deriveStatus(conflicted).status, 'open');
});

test('sealed holdouts: register before open; opening is one-way and a second open is refused', async () => {
  const deps = memDeps();
  assert.equal((await EL.openHoldout(deps, { id: 'h1', openedAt: '2026-08-02', openedBy: 'ravi' })).ok, false, 'unregistered cannot open');
  assert.equal((await EL.registerHoldout(deps, { id: 'h1', description: '2026H2 era', periodStart: '2026-07-01', periodEnd: '2026-12-31', sealedAt: '2026-08-02' })).ok, true);
  assert.equal((await EL.registerHoldout(deps, { id: 'h1', periodStart: 'x', periodEnd: 'y', sealedAt: 'z' })).ok, false, 'no re-registration');
  assert.equal((await EL.untouchedHoldouts(deps)).length, 1);
  const open = await EL.openHoldout(deps, { id: 'h1', openedAt: '2026-09-01', openedBy: 'ravi' });
  assert.equal(open.ok, true);
  const again = await EL.openHoldout(deps, { id: 'h1', openedAt: '2026-09-02', openedBy: 'ravi' });
  assert.equal(again.ok, false);
  assert.match(again.error, /never untouched again/);
  assert.equal((await EL.untouchedHoldouts(deps)).length, 0);
});

// ── decision events ───────────────────────────────────────────────────────────
const eventFields = (over = {}) => ({
  securityId: 'pitv3:tk:abc', symbolAtDecision: 'AAPL',
  decisionTs: '2026-08-02T13:31:00.000Z', dataCutoffTs: '2026-08-02T13:30:00.000Z',
  strategyId: 'screener', scoringVersion: 'screener-v1', featureSchemaVersion: 'f1',
  universeSnapshotId: 'snap1', selectionState: 'excluded',
  exclusionReasons: ['ranked-out'], rank: 12, cohortSize: 200,
  codeCommit: 'cafe', provenance: 'prospective_live', ...over,
});

test('decision events normalize legacy selection vocabulary and force affectsLiveRank=false', () => {
  const e = DE.makeDecisionEvent(eventFields());
  assert.equal(e.selectionState, 'rejected', "'excluded' normalized to the canonical enum");
  assert.equal(e.affectsLiveRank, false);
  assert.equal(Object.isFrozen(e), true);
  const weird = DE.makeDecisionEvent(eventFields({ selectionState: 'totally-new-state' }));
  assert.equal(weird.selectionState, 'error', 'unknown vocabulary fails closed');
});

test('idempotency key is deterministic; intraday decision times create DISTINCT events on the same day', () => {
  const a = DE.makeDecisionEvent(eventFields());
  const b = DE.makeDecisionEvent(eventFields());
  assert.equal(a.eventId, b.eventId);
  const later = DE.makeDecisionEvent(eventFields({ decisionTs: '2026-08-02T19:45:00.000Z' }));
  assert.notEqual(a.eventId, later.eventId, 'a second intraday pass is its own event, not an overwrite');
});

test('append is write-once with NO force parameter; a recorded decision is never rewritable', async () => {
  const deps = memDeps();
  const e = DE.makeDecisionEvent(eventFields());
  assert.equal((await DE.appendDecisionEvent(deps, e)).written, true);
  const tampered = DE.makeDecisionEvent(eventFields({ rank: 1 }));   // same key → same id
  const again = await DE.appendDecisionEvent(deps, tampered);
  assert.equal(again.written, false);
  assert.equal(again.reason, 'already-recorded');
  const stored = deps.blobs.get(DE.eventPath(e));
  assert.equal(stored.rank, 12, 'original decision preserved after the outcome would be known');
  assert.equal(DE.appendDecisionEvent.length, 2, 'no force parameter exists in the signature');
  const day = await DE.loadDecisionEvents(deps, '2026-08-02');
  assert.equal(day.length, 1);
});

test('bare-ticker securityId is accepted but flagged; missing identity fields become caveats, never defaults', () => {
  const e = DE.makeDecisionEvent(eventFields({ securityId: 'AAPL', universeSnapshotId: null, dataCutoffTs: null }));
  assert.ok(e.caveats.some((c) => c.startsWith('security-id-is-bare-ticker')));
  assert.ok(e.caveats.includes('universe-snapshot-unpinned'));
  assert.ok(e.caveats.includes('data-cutoff-missing'));
});

test('the legacy write-once decision store still refuses silent overwrite (escape hatch documented as isolated)', async () => {
  const RS = require('../lib/research/store');
  // hasStore() is false in tests (no blob token) — the guard shape is what we pin:
  const src = require('fs').readFileSync(require.resolve('../lib/research/store.js'), 'utf8');
  assert.match(src, /if \(!force\)/, 'force remains an explicit, named, non-default escape');
  assert.match(src, /already-recorded/);
  assert.equal(typeof RS.saveDecisionSnapshot, 'function');
});
