'use strict';
// op=ghostlog&obsonly=1 is the scheduled form (atlasx chain, step 1). It must write the
// ghostobs/ observation the Pre-Move inventory reads and must NOT write the legacy
// ghost/ ledger: ghost is a RETIRED strategy (registry `rejected`) that accrues no new
// standalone evidence. Without the flag the op keeps its historical full behaviour.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Patch the real store BEFORE apex-routes destructures it at require time.
const store = require('../lib/store');
const writes = { ghost: [], ghostobs: [] };
store.hasStore = () => true;
store.writeGhostDay = async (date, signals) => { writes.ghost.push({ date, signals }); return { url: 'blob://ghost/' + date }; };
// Delegating stub: apex-routes destructures the store at require time, so the failure
// case below swaps the implementation behind this stable function instead.
let obsWrite = async (date, record) => { writes.ghostobs.push({ date, record }); return { url: 'blob://ghostobs/' + date }; };
store.writeGhostObsDay = (date, record) => obsWrite(date, record);
store.readDayCount = async () => -1;

const screenerPayload = (scope) => ({
  ok: true,
  ghost: { regime: 'neutral' },
  scannedCount: 3,
  generatedAt: '2026-10-02T21:00:00Z',
  ghostTop: [
    { ticker: 'AAA', company: 'Aaa Inc', price: 10, scope, ghost: { tier: 'GHOST', score: 84, pillars: {}, strongPillars: 3 }, levels: { entry: 10.2, stop: 9.5 } },
    { ticker: 'BBB', company: 'Bbb Inc', price: 20, scope, ghost: { tier: 'WATCH', score: 55, pillars: {}, strongPillars: 1 } },
  ],
  results: [],
});

const realFetch = global.fetch;
global.fetch = async (url) => {
  const scope = (String(url).match(/scope=(\w+)/) || [])[1] || 'large';
  return { ok: true, status: 200, json: async () => screenerPayload(scope) };
};

const { runGhostLog } = require('../lib/apex-routes');

const fakeRes = () => {
  const out = { statusCode: 200, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return out; },
  };
};

test.after(() => { global.fetch = realFetch; });

test('obsonly=1 writes ghostobs/ and leaves the retired ghost/ ledger untouched', async () => {
  writes.ghost.length = 0; writes.ghostobs.length = 0;
  const res = fakeRes();
  await runGhostLog({ query: { obsonly: '1', force: '1' } }, res);
  assert.equal(res.out.statusCode, 200, JSON.stringify(res.out.body));
  assert.equal(res.out.body.ok, true);
  assert.equal(res.out.body.mode, 'observation-only');
  assert.equal(writes.ghost.length, 0, 'legacy ghost/ ledger must not be written');
  assert.equal(writes.ghostobs.length, 1, 'one ghostobs/<date>.json observation');
  assert.ok(res.out.body.observation, 'observation counts are reported');
  assert.equal(res.out.body.url, null, 'no legacy ledger URL in observation-only mode');
});

test('without the flag the op still writes BOTH ledgers (historical behaviour kept)', async () => {
  writes.ghost.length = 0; writes.ghostobs.length = 0;
  const res = fakeRes();
  await runGhostLog({ query: { force: '1' } }, res);
  assert.equal(res.out.body.ok, true);
  assert.equal(res.out.body.mode, 'full');
  assert.equal(writes.ghost.length, 1);
  assert.equal(writes.ghostobs.length, 1);
  assert.equal(writes.ghost[0].signals.length, 1, 'GHOST/STALKING only — WATCH is noise');
});

test('obsonly=1: an observation write failure FAILS the step instead of reporting ok', async () => {
  const good = obsWrite;
  obsWrite = async () => { throw new Error('blob down'); };
  try {
    const res = fakeRes();
    await runGhostLog({ query: { obsonly: '1', force: '1' } }, res);
    assert.equal(res.out.statusCode, 502);
    assert.equal(res.out.body.ok, false);
    assert.match(res.out.body.observationError, /blob down/);
  } finally { obsWrite = good; }
});
