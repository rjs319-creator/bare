'use strict';
// lib/nightly-dispatch.js — warm's direct workflow_dispatch of the nightly-chains matrix.
// Driven with a fetch stub: dormant without the token, exact request shape, never throws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ND = require('../lib/nightly-dispatch');
const { summarizeRun } = require('../lib/health');

const clock = () => { let t = 1000; return () => (t += 250); };

test('dispatchNightlyChains: no token → dormant, no request', async () => {
  const r = await ND.dispatchNightlyChains({ token: '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(r, { attempted: false, status: 'no-token', ok: false });
});

test('dispatchNightlyChains: POSTs {ref:"main"} to the workflow dispatches endpoint with the bearer; 204 = dispatched', async () => {
  const calls = [];
  const r = await ND.dispatchNightlyChains({ token: 'ghp_x', fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 204, text: async () => '' }; }, now: clock() });
  assert.equal(calls[0].url, 'https://api.github.com/repos/rjs319-creator/bare/actions/workflows/nightly-chains.yml/dispatches');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ghp_x');
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github+json');
  assert.ok(calls[0].init.headers['user-agent'], 'GitHub rejects requests without a User-Agent');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
  assert.deepEqual(r, { attempted: true, status: 204, ok: true, ms: 250 });
});

test('dispatchNightlyChains: a non-204 surfaces GitHub\'s message; a transport error is status null — neither throws', async () => {
  const denied = await ND.dispatchNightlyChains({ token: 't', fetchImpl: async () => ({ status: 403, text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token', documentation_url: 'x' }) }), now: clock() });
  assert.equal(denied.attempted, true); assert.equal(denied.status, 403); assert.equal(denied.ok, false); assert.match(denied.error, /not accessible/);
  const notFound = await ND.dispatchNightlyChains({ token: 't', fetchImpl: async () => ({ status: 404, text: async () => 'not json' }), now: clock() });
  assert.equal(notFound.error, 'not json');
  const down = await ND.dispatchNightlyChains({ token: 't', fetchImpl: async () => { throw new Error('ETIMEDOUT'); }, now: clock() });
  assert.deepEqual(down, { attempted: true, status: null, ok: false, ms: 250, error: 'ETIMEDOUT' });
});

test('summarizeRun: the dispatch record reaches the health run and is never graded as a stage', () => {
  const base = { ok: true, at: '2026-10-02T22:00:30Z', warmed: [{ p: '/a', status: 200 }], chains: {}, chainsDispatched: 0, chainsInProcess: false };
  const r = summarizeRun({ ...base, dispatch: { attempted: true, status: 403, ok: false, ms: 300, error: 'Resource not accessible by personal access token' } });
  assert.deepEqual(r.dispatch, { attempted: true, status: 403, ok: false, error: 'Resource not accessible by personal access token' });
  assert.equal(r.ok, true, 'a failed dispatch is reported, not a failed cron stage — the dead-man grades the night');
  assert.equal(r.stageCount, 0); assert.deepEqual(r.failed, []);
  assert.deepEqual(summarizeRun({ ...base, dispatch: { attempted: false, status: 'in-process', ok: false } }).dispatch, { attempted: false, status: 'in-process', ok: false });
  assert.equal(summarizeRun(base).dispatch, null);
});

// ── source pin: warm.js wiring (api/warm.js is a handler; the stub-driven path is the lib) ──
test('warm.js: dispatches the matrix only when in-process chains are off, after the cache warm, and records it', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const warm = fs.readFileSync(path.join(__dirname, '..', 'api', 'warm.js'), 'utf8');
  const warmIdx = warm.indexOf('await Promise.all([worker(), worker(), worker()])');
  const dispIdx = warm.indexOf('dispatchNightlyChains()');
  assert.ok(warmIdx > 0 && dispIdx > warmIdx, 'the dispatch follows the cache warm (ledger snapshots those caches)');
  assert.match(warm, /const dispatch = chainsInProcess \? \{ attempted: false, status: 'in-process', ok: false \} : await dispatchNightlyChains\(\);/);
  assert.match(warm, /\n    dispatch,\n/, 'the record reaches the health run');
});
