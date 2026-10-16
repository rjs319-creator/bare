'use strict';
// Access / durable-state audit (lib/decision-routes runToday):
//   (a) an ANONYMOUS op=today must not forward the service bearer / x-warm to its sub-requests
//       (that reached the screener's trusted warm path: live scan, LLM, cache writes);
//   (b) the immutable origins store is advanced only from a VERIFIED read — an unavailable or
//       invalid read skips the write (never re-initialises and loses firstPrice/bars);
//   (c) the rolling opportunity log is a compare-and-swap update — a failed read cannot
//       replace 180 days with one row.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runToday } = require('../lib/decision-routes');
const { StoreReadError, StoreCasConflictError } = require('../lib/store-cas');

const ORIGINS = 'today/origins.json', OPP = 'today/opportunity-log.json';
const SECRET = 'test-cron-secret-0123456789';
const res = () => { const r = { out: null, setHeader() {}, json(x) { r.out = x; return x; } }; return r; };
const offline = () => async () => { throw new Error('offline'); };

// A fake store: every durable primitive the route touches is injectable and recorded.
function fakeStore({ originsRead, oppFails = false } = {}) {
  const calls = { writeGuarded: [], updateJSON: [], writeJSON: [] };
  return {
    calls,
    hasStore: () => true,
    readJSON: async () => null,
    writeJSON: async (path, doc) => { calls.writeJSON.push({ path, doc }); },
    blobExists: async () => false,
    readState: async (path) => {
      if (path !== ORIGINS) return { status: 'missing', value: null, etag: null };
      if (originsRead instanceof Error) throw originsRead;
      return originsRead || { status: 'missing', value: null, etag: null };
    },
    writeGuarded: async (path, next, prior) => {
      calls.writeGuarded.push({ path, next, prior });
      if (prior && prior.conflict) throw new StoreCasConflictError(path, 1);
      return { etag: '"new"' };
    },
    updateJSON: async (path, mutate, opts) => {
      if (oppFails) throw new StoreReadError(path, 'unavailable', 'listing failed');
      const next = mutate(opts && opts.initial ? opts.initial : { days: [] });
      calls.updateJSON.push({ path, next, opts });
      return { written: true, value: next, etag: '"x"', attempts: 1 };
    },
  };
}

async function withSecret(fn) {
  const prev = process.env.CRON_SECRET; process.env.CRON_SECRET = SECRET;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; }
}

test('(a) anonymous op=today: no sub-request carries authorization or x-warm', async () => {
  await withSecret(async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => { seen.push({ url, headers: opts.headers || {} }); throw new Error('offline'); };
    const r = res();
    await runToday({ query: {}, headers: {} }, r, { fetchImpl, store: fakeStore() });
    assert.equal(r.out.ok, true);
    assert.ok(seen.length >= 10, 'the fan-out happened');
    for (const s of seen) {
      assert.equal(s.headers.authorization, undefined, `${s.url} must not carry the service bearer`);
      assert.equal(s.headers['x-warm'], undefined, `${s.url} must not carry x-warm`);
    }
  });
});

test('(a) trusted (cron bearer) op=today keeps forwarding exactly as before', async () => {
  await withSecret(async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => { seen.push({ url, headers: opts.headers || {} }); throw new Error('offline'); };
    const r = res();
    await runToday({ query: {}, headers: { authorization: 'Bearer ' + SECRET } }, r, { fetchImpl, store: fakeStore() });
    assert.ok(seen.length >= 10);
    for (const s of seen) {
      assert.equal(s.headers.authorization, 'Bearer ' + SECRET, s.url);
      assert.equal(s.headers['x-warm'], '1', s.url);
    }
  });
});

test('(b) origins: an UNAVAILABLE read skips the write, surfaces originsError, and op=today still answers', async () => {
  const store = fakeStore({ originsRead: new StoreReadError(ORIGINS, 'unavailable', 'listing failed') });
  const r = res();
  await runToday({ query: { log: '1' }, headers: {} }, r, { fetchImpl: offline(), store });
  assert.equal(r.out.ok, true);
  assert.match(String(r.out.originsError), /unavailable|listing failed/);
  assert.equal(store.calls.writeGuarded.filter(w => w.path === ORIGINS).length, 0, 'zero origin writes');
  assert.equal(store.calls.writeJSON.filter(w => w.path === ORIGINS).length, 0);
  assert.equal(r.out.originsTracked, undefined);
});

test('(b) origins: an INVALID read is treated the same as unavailable (never re-initialised)', async () => {
  const store = fakeStore({ originsRead: new StoreReadError(ORIGINS, 'invalid', 'unexpected shape') });
  const r = res();
  await runToday({ query: { log: '1' }, headers: {} }, r, { fetchImpl: offline(), store });
  assert.equal(r.out.ok, true);
  assert.match(String(r.out.originsError), /invalid|unexpected shape/);
  assert.equal(store.calls.writeGuarded.length, 0);
});

test('(b) origins: a VERIFIED-missing doc is initialised through writeGuarded with the missing prior', async () => {
  const store = fakeStore();
  const r = res();
  await runToday({ query: { log: '1' }, headers: {} }, r, { fetchImpl: offline(), store });
  assert.equal(r.out.ok, true);
  const w = store.calls.writeGuarded.filter(x => x.path === ORIGINS);
  assert.equal(w.length, 1);
  assert.equal(w[0].prior.status, 'missing');
  assert.ok(w[0].next && w[0].next.origins && typeof w[0].next.origins === 'object');
  assert.equal(r.out.originsTracked, Object.keys(w[0].next.origins).length);
  assert.equal(r.out.originsError, undefined);
});

test('(b) origins: a FOUND doc is superseded with its etag; a CAS conflict skips, never clobbers', async () => {
  const found = { status: 'found', etag: '"e1"', value: { version: 'origins-v1', origins: { 'screener:swing:OLD': { ticker: 'OLD', firstPrice: 10, bars: 3 } } } };
  const ok = fakeStore({ originsRead: found });
  const r1 = res();
  await runToday({ query: { log: '1' }, headers: {} }, r1, { fetchImpl: offline(), store: ok });
  const w = ok.calls.writeGuarded.find(x => x.path === ORIGINS);
  assert.equal(w.prior.etag, '"e1"');
  assert.equal(w.prior.status, 'found');
  assert.equal(r1.out.originsError, undefined);

  const conflicting = fakeStore({ originsRead: { ...found, conflict: true } });
  const r2 = res();
  await runToday({ query: { log: '1' }, headers: {} }, r2, { fetchImpl: offline(), store: conflicting });
  assert.equal(r2.out.ok, true);
  assert.match(String(r2.out.originsError), /conflict/i);
  assert.equal(r2.out.originsTracked, undefined);
});

test('(c) opportunity log: written through updateJSON (CAS) with an initial {days:[]}; a failed read writes nothing', async () => {
  const store = fakeStore();
  const r = res();
  await runToday({ query: { log: '1' }, headers: {} }, r, { fetchImpl: offline(), store });
  const u = store.calls.updateJSON.find(x => x.path === OPP);
  assert.ok(u, 'opportunity log goes through updateJSON');
  assert.deepEqual(u.opts.initial, { days: [] });
  assert.equal(u.next.days.length, 1);
  assert.equal(r.out.opportunityLogged, 1);
  assert.equal(store.calls.writeJSON.filter(x => x.path === OPP).length, 0, 'no unconditional write of the log');

  const failing = fakeStore({ oppFails: true });
  const r2 = res();
  await runToday({ query: { log: '1' }, headers: {} }, r2, { fetchImpl: offline(), store: failing });
  assert.equal(r2.out.ok, true);
  assert.match(String(r2.out.opportunityLogError), /unavailable|listing failed/);
  assert.equal(failing.calls.updateJSON.length, 0);
  assert.equal(failing.calls.writeJSON.filter(x => x.path === OPP).length, 0);
  assert.equal(r2.out.opportunityLogged, undefined);
});

test('(c) opportunity log: the mutate function replaces today\'s row and keeps the rest (no 180→1 collapse)', async () => {
  const store = fakeStore();
  const existing = { version: 'x', days: Array.from({ length: 120 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`, score: i })) };
  store.updateJSON = async (path, mutate, opts) => { const next = mutate(existing); store.calls.updateJSON.push({ path, next, opts }); return { written: true, value: next }; };
  const r = res();
  await runToday({ query: { log: '1' }, headers: {} }, r, { fetchImpl: offline(), store });
  const u = store.calls.updateJSON.find(x => x.path === OPP);
  assert.equal(u.next.days.length, 121);
  assert.equal(r.out.opportunityLogged, 121);
});
