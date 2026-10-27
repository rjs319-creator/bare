'use strict';
// Regression: op=evolveresolve read the resolved ledger with readJSON(path, {}), so one
// transient Blob read failure rebuilt it as {} and the run then overwrote the WHOLE ledger
// (backfill rows included) with the few predictions it re-resolved.
const test = require('node:test');
const assert = require('node:assert');
const { runEvolveResolve } = require('../lib/evolve-routes');

function fakeRes() {
  const r = { body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.json = (b) => { r.body = b; return r; };
  r.status = () => r;
  return r;
}

test('an unreadable resolved ledger aborts the run and writes nothing', async () => {
  const writes = [];
  const store = {
    hasStore: () => true,
    readAllEvolveDays: async () => [],
    evolveResolvedState: {
      read: async () => { throw new Error('evolve/resolved.json unavailable: HTTP 503'); },
      write: async (next) => { writes.push(next); },
    },
    evolveModelState: { read: async () => ({ status: 'missing', value: null }), write: async (n) => { writes.push(n); } },
    writeEvolvePerf: async (p) => { writes.push(p); },
  };
  const res = fakeRes();
  await runEvolveResolve({ query: {} }, res, { store });
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /nothing written/);
  assert.strictEqual(writes.length, 0);
});

test('a readable ledger is written back guarded against the read it came from', async () => {
  const prior = { status: 'found', value: { 'bf|X': { outcome: 'win' } }, etag: 'e1' };
  const calls = [];
  const store = {
    hasStore: () => true,
    readAllEvolveDays: async () => [],
    evolveResolvedState: { read: async () => prior, write: async (next, p) => { calls.push({ next, p }); } },
    evolveModelState: { read: async () => ({ status: 'missing', value: null }), write: async () => {} },
    writeEvolvePerf: async () => {},
  };
  const res = fakeRes();
  await runEvolveResolve({ query: {} }, res, { store });
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].p, prior);
  assert.deepStrictEqual(calls[0].next, prior.value);
  assert.notStrictEqual(calls[0].next, prior.value, 'the prior read is not mutated');
});
