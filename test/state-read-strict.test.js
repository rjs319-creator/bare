'use strict';
// DURABLE STATE — a mutable learner/archive doc is initialised only on VERIFIED absence.
// An unavailable or invalid read aborts the mutation with zero overwrites, and a write
// based on a superseded read cannot clobber a concurrent writer.
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakeBlob } = require('./helpers/fake-blob');

const fake = installFakeBlob();
if (!fake) {
  test('strict state battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}

const STORE = require('../lib/store');
const PATH = STORE.fadeState.path;
const learned = { stocks: { AAPL: { n: 40, mean: 1.2 } }, updatedAt: '2026-10-01T00:00:00Z' };

function reset() {
  fake.docs.clear();
  fake.putCalls.length = 0;
  fake.hooks.beforePut = null;
}
const withBrokenList = async (fn) => {
  const orig = fake.exports.list;
  fake.exports.list = async () => { throw new Error('blob api down'); };
  try { return await fn(); } finally { fake.exports.list = orig; }
};
const withBodyStatus = async (status, fn) => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status, json: async () => ({}) });
  try { return await fn(); } finally { global.fetch = orig; }
};

test('found: the stored state and its etag come back', async () => {
  reset();
  const etag = fake.seed(PATH, learned);
  assert.deepEqual(await STORE.fadeState.read(), { status: 'found', value: learned, etag });
});

test('verified missing: the listing succeeded and the doc is absent — the only case that may initialise', async () => {
  reset();
  const prior = await STORE.fadeState.read();
  assert.deepEqual(prior, { status: 'missing', value: null, etag: null });
  await STORE.fadeState.write({ stocks: {} }, prior);
  assert.deepEqual(fake.read(PATH), { stocks: {} });
  assert.equal(fake.putCalls[0].opts.allowOverwrite, false, 'initialisation is create-only');
});

test('unavailable (listing failure): the read throws and nothing is written', async () => {
  reset();
  fake.seed(PATH, learned);
  await withBrokenList(() => assert.rejects(() => STORE.fadeState.read(), (e) => e.code === 'STORE_READ_UNAVAILABLE' && e.kind === 'unavailable'));
  assert.equal(fake.putCalls.length, 0);
  assert.deepEqual(fake.read(PATH), learned);
});

test('unavailable (body fetch HTTP 503): the read throws rather than reporting "no state"', async () => {
  reset();
  fake.seed(PATH, learned);
  await withBodyStatus(503, () => assert.rejects(() => STORE.fadeState.read(), (e) => e.code === 'STORE_READ_UNAVAILABLE' && /HTTP 503/.test(e.message)));
  assert.equal(fake.putCalls.length, 0);
});

test('invalid: a non-JSON body and a non-object body are both refused', async () => {
  reset();
  fake.docs.set(PATH, { body: '{"stocks": ', etag: fake.mint() });
  await assert.rejects(() => STORE.fadeState.read(), (e) => e.code === 'STORE_READ_INVALID');
  for (const bad of [null, [], 'text', 7]) {
    fake.seed(PATH, bad);
    await assert.rejects(() => STORE.fadeState.read(), (e) => e.code === 'STORE_READ_INVALID', JSON.stringify(bad));
  }
  assert.equal(fake.putCalls.length, 0);
});

test('the legacy readJSON collapses all of the above into its fallback (why the strict read exists)', async () => {
  reset();
  fake.seed(PATH, learned);
  const collapsed = await withBrokenList(() => STORE.readJSON(PATH, null));
  assert.equal(collapsed, null, 'an outage is indistinguishable from "no state" through readJSON');
});

test('version conflict: a write based on a superseded read cannot clobber the newer state', async () => {
  reset();
  fake.seed(PATH, learned);
  const prior = await STORE.fadeState.read();
  const rival = { stocks: { AAPL: { n: 41, mean: 1.3 } }, updatedAt: '2026-10-02T00:00:00Z' };
  fake.hooks.beforePut = async () => { fake.seed(PATH, rival); };   // a concurrent tick lands first
  await assert.rejects(() => STORE.fadeState.write({ stocks: {} }, prior), (e) => e.code === 'CAS_CONFLICT');
  assert.deepEqual(fake.read(PATH), rival, 'the concurrent writer\'s state survives');
});

test('create race: two initialisers of a missing doc — the second is refused, not last-writer-wins', async () => {
  reset();
  const prior = await STORE.fadeState.read();
  fake.hooks.beforePut = async () => { fake.seed(PATH, learned); };
  await assert.rejects(() => STORE.fadeState.write({ stocks: {} }, prior), (e) => e.code === 'CAS_CONFLICT');
  assert.deepEqual(fake.read(PATH), learned);
});

test('writeGuarded refuses to run without the read it supersedes', async () => {
  reset();
  await assert.rejects(() => STORE.writeGuarded(PATH, {}, null), TypeError);
  await assert.rejects(() => STORE.writeGuarded(PATH, {}, { status: 'unconfigured' }), TypeError);
  assert.equal(fake.putCalls.length, 0);
});

// ── The call sites: an outage aborts the tick before ANY write ───────────────

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

test('op=cerntick: an unavailable archive read aborts the tick — the archive is not replaced by a fresh one', async () => {
  reset();
  const archive = { events: [{ id: 'e1' }], ledger: { e1: { n: 3 } } };
  fake.seed(STORE.cernState.path, archive);
  const { runCernTickOp } = require('../lib/capture-routes');
  const res = fakeRes();
  await withBrokenList(() => runCernTickOp({ query: {}, headers: {} }, res));
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /unavailable/);
  assert.equal(fake.putCalls.length, 0);
  assert.deepEqual(fake.read(STORE.cernState.path), archive);
});

test('op=adaptivepolicy set: an unavailable policy read cannot silently lift another layer\'s freeze', async () => {
  reset();
  const AL = require('../lib/adaptive-layers');
  const [frozen, other] = AL.LAYERS;
  const policy = { version: AL.ADAPTIVE_LAYERS_VERSION, layers: { [frozen]: 'freeze' }, history: [] };
  fake.seed(AL.POLICY_DOC, policy);
  const { runAdaptivePolicy } = require('../lib/maturity-routes');
  const prev = { s: process.env.CRON_SECRET };
  process.env.CRON_SECRET = 'k';
  try {
    const req = { query: { set: `${other}:${AL.POLICIES.find(p => p !== 'allow')}` }, headers: { authorization: 'Bearer k' } };
    await withBrokenList(() => assert.rejects(() => runAdaptivePolicy(req, fakeRes()), /blob api down/));
    assert.equal(fake.putCalls.length, 0);
    assert.deepEqual(fake.read(AL.POLICY_DOC), policy);
    // Healthy store: the same request merges into the stored policy and keeps the freeze.
    await runAdaptivePolicy(req, fakeRes());
    assert.equal(fake.read(AL.POLICY_DOC).layers[frozen], 'freeze');
    assert.ok(fake.read(AL.POLICY_DOC).layers[other]);
  } finally { if (prev.s === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev.s; }
});

test('every learner tick reads strictly and writes guarded (no readX()→writeX() blind overwrite left)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screener-routes.js'), 'utf8');
  for (const [state, legacyRead, legacyWrite] of [
    ['fadeState', 'readFade', 'writeFade'], ['trendEngState', 'readTrendEng', 'writeTrendEng'],
    ['daytradeEngState', 'readDaytradeEng', 'writeDaytradeEng'], ['confluenceEngState', 'readConfluenceEng', 'writeConfluenceEng'],
  ]) {
    assert.match(src, new RegExp(`await ${state}\\.read\\(\\)`), `${state} strict read`);
    assert.match(src, new RegExp(`await ${state}\\.write\\(fe\\.serialize\\(state\\), \\w+Prior\\)`), `${state} guarded write`);
    // The only remaining unguarded writer is the privileged, deliberate re-seed (fadeseed).
    const blind = [...src.matchAll(new RegExp(`await ${legacyWrite}\\(fe\\.serialize\\(state\\)\\)`, 'g'))].length;
    assert.equal(blind, legacyWrite === 'writeFade' ? 1 : 0, `${legacyWrite} blind writes`);
    assert.ok(src.includes(legacyRead), 'read-only callers keep the lenient reader');
  }
});
