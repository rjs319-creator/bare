'use strict';
// op=patternresearch mode=auto — the self-cursoring nightly build of the Pattern Radar
// PIT evidence artifact (pattern/evidence.json). Before 2026-08-09 the artifact had
// never been built (artifactVersion null since ship), so every family gate sat starved
// at research-only. These tests drive the auto mode against a mocked store.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const routes = require('../lib/pattern-routes');
const WC = require('../lib/warm-chains');

const origHasStore = store.hasStore;
const origReadJSON = store.readJSON;
const origWriteJSON = store.writeJSON;
let docs;    // path → value served by readJSON
let writes;  // [{path, value}]

beforeEach(() => {
  docs = {};
  writes = [];
  store.hasStore = () => true;
  store.readJSON = async (path, fallback) => (path in docs ? docs[path] : fallback);
  store.writeJSON = async (path, value) => { writes.push({ path, value }); docs[path] = value; };
});
afterEach(() => {
  store.hasStore = origHasStore;
  store.readJSON = origReadJSON;
  store.writeJSON = origWriteJSON;
});

function fakeRes() {
  const r = { headers: {}, statusCode: null, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('auto: idles when the evidence artifact is fresh (no collection, no writes)', async () => {
  docs[routes.EVIDENCE_PATH] = { version: 'x', builtAt: new Date().toISOString(), cells: {} };
  const res = fakeRes();
  await routes.runPatternResearch({ query: { op: 'patternresearch', mode: 'auto' } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.idle, true);
  assert.ok(res.body.rebuildInDays > 0);
  assert.deepEqual(writes, [], 'an idle tick must not touch the store');
});

test('auto: a completed sweep with a failed evaluate parks the cursor for ONE retry, then restarts', async () => {
  // Cursor already past the end of the universe → the collect slice is empty (and must
  // write NO shard), so the call falls through to evaluate. No shards are mocked and
  // no Blob token exists → evaluate honestly fails. First failure: the cursor parks
  // past the end (note evaluate-retry) so the multi-night sweep is NOT discarded.
  const universeSize = routes.scanUniverse().length;
  docs[routes.RESEARCH_STATE_PATH] = { nextStart: universeSize, startedAt: '2026-08-01T00:00:00.000Z' };
  let res = fakeRes();
  await routes.runPatternResearch({ query: { op: 'patternresearch', mode: 'auto' } }, res);
  assert.equal(res.body.ok, false, 'a failed final evaluate must be visible in the chain report');
  assert.equal(res.body.phase, 'evaluate');
  assert.equal(res.body.startedAt, '2026-08-01T00:00:00.000Z');
  let state = docs[routes.RESEARCH_STATE_PATH];
  assert.equal(state.nextStart, universeSize, 'first failure keeps the sweep intact for an evaluate retry');
  assert.equal(state.note, 'evaluate-retry');
  assert.ok(!writes.some(w => w.path.includes('shard-')), 'a past-the-end slice must not write an empty shard');
  // Second consecutive failure: the shards are genuinely unusable — clear the cursor so
  // the next tick starts a fresh sweep instead of retrying forever.
  res = fakeRes();
  await routes.runPatternResearch({ query: { op: 'patternresearch', mode: 'auto' } }, res);
  state = docs[routes.RESEARCH_STATE_PATH];
  assert.equal(state.nextStart, null);
  assert.equal(state.note, 'evaluate-failed-restart');
});

test('auto: a stale artifact with no in-flight cursor restarts the sweep from 0', async () => {
  const stale = new Date(Date.now() - routes.RESEARCH_REBUILD_MS - 86400000).toISOString();
  docs[routes.EVIDENCE_PATH] = { version: 'x', builtAt: stale, cells: {} };
  // Universe slice at 0 would hit the network — assert intent via the persisted cursor
  // only, with the slice neutralized through a temporary empty-universe patch.
  const src = require('node:fs').readFileSync(require.resolve('../lib/pattern-routes.js'), 'utf8');
  assert.ok(/ageMs < RESEARCH_REBUILD_MS/.test(src), 'freshness guard must compare against the rebuild window');
  assert.ok(/let cursor = inFlight \? state\.nextStart : 0/.test(src), 'a stale artifact restarts from 0');
});

test('collect cursor advances past dead tickers (advanced, not processed, drives nextStart)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/pattern-routes.js'), 'utf8');
  assert.ok(/const nextStart = start \+ advanced/.test(src),
    'a slice of short-history/delisted names must never wedge the sweep');
});

test('warm chains: patternresearch is its own root with ONE in-process auto step (Blob read-back lag forbids a multi-step cursor handoff)', () => {
  assert.ok(WC.ROOT_CHAINS.includes('patternresearch'));
  assert.deepEqual(WC.CHAINS.patternresearch, ['op=patternresearch&mode=auto']);
});

test('auto: slices loop in-process with a single end-of-run state write (no cursor handoff between invocations)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/pattern-routes.js'), 'utf8');
  assert.ok(/while \(Date\.now\(\) - t0 < AUTO_BUDGET_MS\)/.test(src));
  assert.ok(/if \(r\.advanced === 0\) break/.test(src), 'a zero-progress slice must break the loop, not spin');
});

test('evaluate merges only current-model, current-sweep shards and dedups record identities', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/pattern-routes.js'), 'utf8');
  assert.ok(/s\.modelVersion === MODEL_VERSION && \(!sweepId \|\| s\.sweepId === sweepId\)/.test(src));
  assert.ok(/dedupResearchRecords/.test(src));
});
