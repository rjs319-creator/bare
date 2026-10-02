'use strict';
// op=chainsummary — the per-night chains record the GitHub Actions matrix POSTs so the app
// knows what happened to the nightly chains without reading the Actions UI.
//   • pure: payload validation + normalisation, health view derivation, lookback dates
//   • route: bearer auth, POST-only, 400 on a bad payload, writeChecked to chains/<date>.json,
//     idempotent per (date, runId)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CS = require('../lib/chain-summary');
const R = require('../lib/chain-summary-routes');

const NOW = Date.parse('2026-10-02T22:40:00Z');
const okChain = { ok: true, status: 'ok', httpStatus: 200, attempts: 1, complete: true, failed: [], skipped: [], elapsedMs: 1200 };
const badChain = { ok: false, status: 'failed', httpStatus: 200, attempts: 1, complete: true, failed: ['op=track'], skipped: [], elapsedMs: 900, error: 'op=track http:503' };
const payload = (over = {}) => ({
  date: '2026-10-02', source: 'github-matrix', runId: '42', runUrl: 'https://github.com/x/y/actions/runs/42',
  startedAt: '2026-10-02T22:05:00Z', finishedAt: '2026-10-02T22:39:00Z',
  chains: { ledger: okChain, capture: badChain },
  ...over,
});

// ── normalizeChainSummary ────────────────────────────────────────────────────
test('normalizeChainSummary: accepts a well-formed payload and derives ok/failed', () => {
  const r = CS.normalizeChainSummary(payload(), { now: NOW });
  assert.equal(r.error, null);
  assert.equal(r.value.date, '2026-10-02');
  assert.equal(r.value.source, 'github-matrix');
  assert.equal(r.value.ok, false);
  assert.deepEqual(r.value.failed, ['capture']);
  assert.equal(r.value.chainCount, 2);
  assert.equal(r.value.chains.capture.error, 'op=track http:503');
  assert.deepEqual(r.value.chains.capture.failed, ['op=track']);
  assert.equal(r.value.runId, '42');
});

test('normalizeChainSummary: rejects a bad date, an out-of-window date, an unknown source and non-object chains', () => {
  assert.match(CS.normalizeChainSummary(payload({ date: '2026/10/02' }), { now: NOW }).error, /date/);
  assert.match(CS.normalizeChainSummary(payload({ date: '2025-01-01' }), { now: NOW }).error, /date/);
  assert.match(CS.normalizeChainSummary(payload({ source: 'elsewhere' }), { now: NOW }).error, /source/);
  assert.match(CS.normalizeChainSummary(payload({ chains: [] }), { now: NOW }).error, /chains/);
  assert.match(CS.normalizeChainSummary(payload({ chains: {} }), { now: NOW }).error, /chains/);
  assert.match(CS.normalizeChainSummary(null, { now: NOW }).error, /object/);
});

test('normalizeChainSummary: drops unknown fields, bounds arrays and strings, rejects bad chain names', () => {
  const longName = 'x'.repeat(200);
  const p = payload({ chains: { ledger: { ...okChain, junk: 1, failed: Array.from({ length: 80 }, (_, i) => `op=${i}${longName}`) } } });
  const r = CS.normalizeChainSummary(p, { now: NOW });
  assert.equal(r.error, null);
  assert.equal('junk' in r.value.chains.ledger, false);
  assert.equal(r.value.chains.ledger.failed.length, CS.MAX_STEPS_PER_CHAIN);
  assert.ok(r.value.chains.ledger.failed[0].length <= CS.MAX_TEXT);
  assert.match(CS.normalizeChainSummary(payload({ chains: { 'Bad Name!': okChain } }), { now: NOW }).error, /chain name/);
  const tooMany = Object.fromEntries(Array.from({ length: CS.MAX_CHAINS + 1 }, (_, i) => [`c${i}`, okChain]));
  assert.match(CS.normalizeChainSummary(payload({ chains: tooMany }), { now: NOW }).error, /chains/);
});

test('normalizeChainSummary: a chain without an explicit ok is graded from status/failed', () => {
  const r = CS.normalizeChainSummary(payload({ chains: { a: { status: 'no-report' }, b: { failed: ['op=x'] }, c: { status: 'ok' } } }), { now: NOW });
  assert.deepEqual(r.value.failed, ['a', 'b']);
  assert.equal(r.value.chains.c.ok, true);
});

// ── health view ──────────────────────────────────────────────────────────────
test('chainsHealthView: a GitHub summary becomes the compact banner block', () => {
  const { value } = CS.normalizeChainSummary(payload(), { now: NOW });
  const v = CS.chainsHealthView({ summary: value });
  assert.deepEqual(v, { date: '2026-10-02', ok: false, failed: ['capture'], skipped: [], source: 'github-matrix',
    runUrl: 'https://github.com/x/y/actions/runs/42', at: '2026-10-02T22:39:00.000Z', missing: false });
});

test('chainsHealthView: falls back to the in-process run record when no summary exists', () => {
  const run = { at: '2026-10-01T22:04:00Z', chainDispatchFails: ['atlasx'], lateChainFails: ['atlasx', 'swing'], chains: { atlasx: {}, swing: {}, ledger: {} } };
  const v = CS.chainsHealthView({ summary: null, run, inProcess: true });
  assert.equal(v.source, 'in-process');
  assert.equal(v.date, '2026-10-01');
  assert.deepEqual(v.failed, ['atlasx', 'swing']);
  assert.equal(v.ok, false);
});

test('chainsHealthView: in-process disabled and no summary = the dead-man tripped', () => {
  const v = CS.chainsHealthView({ summary: null, run: { at: 'x', chains: {} }, inProcess: false });
  assert.equal(v.source, 'none');
  assert.equal(v.ok, false);
  assert.equal(v.missing, true);
});

test('chainsHealthView: nothing known at all (fresh deploy, in-process on) is null, not an alarm', () => {
  assert.equal(CS.chainsHealthView({ summary: null, run: null, inProcess: true }), null);
});

test('recentSummaryDates: today first, then back over the lookback (covers a weekend)', () => {
  assert.deepEqual(CS.recentSummaryDates(Date.parse('2026-10-05T14:00:00Z')), ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
  assert.equal(CS.summaryPath('2026-10-02'), 'chains/2026-10-02.json');
});

// ── route ────────────────────────────────────────────────────────────────────
function fakeRes() {
  return { headers: {}, body: null, code: 200,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return o; } };
}
function memStore() {
  const docs = new Map();
  return {
    docs, writes: 0,
    hasStore: () => true,
    readJSON: async (k, fb) => (docs.has(k) ? docs.get(k) : fb),
    writeJSON: async (k, o) => { docs.set(k, o); return { pathname: k }; },
  };
}
const withSecret = async (secret, fn) => {
  const prev = process.env.CRON_SECRET, prevEnv = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = secret; process.env.VERCEL_ENV = 'production';
  try { return await fn(); } finally {
    if (prev == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    if (prevEnv == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prevEnv;
  }
};
const req = (over = {}) => ({ method: 'POST', query: { op: 'chainsummary' }, headers: { authorization: 'Bearer s3cret' }, body: payload(), ...over });

test('runChainSummary: rejects a missing/wrong bearer with 401 and never writes', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ headers: {} }), res, { store, now: () => NOW });
  assert.equal(res.code, 401); assert.equal(store.docs.size, 0);
  const res2 = fakeRes();
  await R.runChainSummary(req({ headers: { authorization: 'Bearer nope' } }), res2, { store, now: () => NOW });
  assert.equal(res2.code, 401);
}));

test('runChainSummary: GET is 405 (the record is a POSTed body, never a query string)', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ method: 'GET' }), res, { store, now: () => NOW });
  assert.equal(res.code, 405); assert.equal(store.docs.size, 0);
}));

test('runChainSummary: a bad payload is 400 with the reason, and nothing is written', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ body: payload({ date: 'nope' }) }), res, { store, now: () => NOW });
  assert.equal(res.code, 400); assert.match(res.body.error, /date/); assert.equal(store.docs.size, 0);
}));

test('runChainSummary: writes chains/<date>.json via writeChecked and reports the verdict; a string body is parsed', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ body: JSON.stringify(payload()) }), res, { store, now: () => NOW });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.written, true); assert.equal(res.body.verified, true);
  assert.equal(res.body.chainsOk, false); assert.deepEqual(res.body.failed, ['capture']);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const doc = store.docs.get('chains/2026-10-02.json');
  assert.equal(doc.runId, '42'); assert.equal(doc.receivedAt, new Date(NOW).toISOString());
}));

test('runChainSummary: idempotent — the same run posted twice yields one identical doc; a newer run replaces it', () => withSecret('s3cret', async () => {
  const store = memStore();
  await R.runChainSummary(req(), fakeRes(), { store, now: () => NOW });
  const first = store.docs.get('chains/2026-10-02.json');
  await R.runChainSummary(req(), fakeRes(), { store, now: () => NOW });
  assert.deepEqual(store.docs.get('chains/2026-10-02.json'), first);
  await R.runChainSummary(req({ body: payload({ runId: '43', chains: { ledger: okChain } }) }), fakeRes(), { store, now: () => NOW });
  assert.equal(store.docs.get('chains/2026-10-02.json').runId, '43');
  assert.equal(store.docs.size, 1, 'one key per date — never a shared RMW doc');
}));

test('runChainSummary: no store = honest 200 written:false (never a 500 that fails the dead-man job for a config gap)', () => withSecret('s3cret', async () => {
  const store = { ...memStore(), hasStore: () => false }; const res = fakeRes();
  await R.runChainSummary(req(), res, { store, now: () => NOW });
  assert.equal(res.code, 200); assert.equal(res.body.written, false); assert.match(res.body.note, /Blob/);
}));

test('readLatestChainSummary: returns the newest doc inside the lookback, or null', async () => {
  const store = memStore();
  store.docs.set('chains/2026-10-02.json', { date: '2026-10-02', ok: true, failed: [], source: 'github-matrix', chains: {} });
  const hit = await R.readLatestChainSummary({ store, now: () => Date.parse('2026-10-04T12:00:00Z') });
  assert.equal(hit.date, '2026-10-02');
  assert.equal(await R.readLatestChainSummary({ store, now: () => Date.parse('2026-10-09T12:00:00Z') }), null);
  assert.equal(await R.readLatestChainSummary({ store: { ...store, hasStore: () => false }, now: () => NOW }), null);
});
