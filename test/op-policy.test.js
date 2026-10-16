'use strict';
// OPERATION AUTHORIZATION — every dispatched tracker op has an explicit policy, unknown ops
// fail closed, and a denied request reaches no handler (so no store / LLM / provider call).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'api', 'tracker.js'), 'utf8');
const handler = require('../api/tracker');
const { policyOf, POLICY_SETS } = handler;
const SECRET = 'test-cron-secret';

// Every op the dispatch chain can route: `req.query.op === 'x'` plus `[...].includes(req.query.op)`.
function dispatchedOps() {
  const ops = new Set([...SRC.matchAll(/req\.query\.op === '([a-z0-9]+)'/g)].map(m => m[1]));
  for (const m of SRC.matchAll(/\[([^\]]+)\]\.includes\(req\.query\.op\)/g)) {
    for (const o of m[1].matchAll(/'([a-z0-9]+)'/g)) ops.add(o[1]);
  }
  return ops;
}

function withEnv(env, fn) {
  const keys = ['CRON_SECRET', 'VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'ANTHROPIC_API_KEY'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}

// Any outbound I/O during a denied request is a failure of the gate.
async function callCountingIO(req) {
  const origFetch = global.fetch;
  let ioCalls = 0;
  global.fetch = async () => { ioCalls++; throw new Error('network is off in this test'); };
  const res = fakeRes();
  try { await handler(req, res); } finally { global.fetch = origFetch; }
  return { res, ioCalls };
}

test('every dispatched op has a policy, and exactly one base policy', () => {
  const ops = dispatchedOps();
  assert.ok(ops.size > 300, `expected the full dispatch chain, parsed ${ops.size}`);
  const missing = [...ops].filter(op => !policyOf(op));
  assert.deepEqual(missing, [], 'ops with no policy would be refused — classify them explicitly');
  const base = ['PRIVILEGED_OPS', 'INGEST_OPS', 'SHARED_FORCE_OPS', 'USER_WRITE_OPS', 'PUBLIC_READ_OPS'];
  for (const op of ops) {
    const homes = base.filter(n => POLICY_SETS[n].has(op));
    assert.ok(homes.length <= 1, `${op} is in ${homes.join(' + ')}`);
  }
});

test('no policy set names an op the router cannot dispatch (dead entries hide typos)', () => {
  const ops = dispatchedOps();
  ops.add('scoreboard');
  for (const [name, set] of Object.entries(POLICY_SETS)) {
    const dead = [...set].filter(op => !ops.has(op));
    assert.deepEqual(dead, [], `${name} lists undispatched ops`);
  }
});

test('an op with no policy fails closed before dispatch — 400, uncached, zero I/O', async () => {
  await withEnv({ CRON_SECRET: SECRET, VERCEL_ENV: 'production' }, async () => {
    for (const op of ['notarealop', 'anomalytickk', ['today', 'warmchain']]) {
      const { res, ioCalls } = await callCountingIO({ method: 'GET', query: { op }, headers: {} });
      assert.equal(res.statusCode, 400);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(ioCalls, 0);
    }
  });
  assert.equal(policyOf('notarealop'), null);
  assert.equal(policyOf(undefined), null);
});

const WRITERS = ['anomalytick', 'readthroughtick', 'secondwavetick', 'toneshifttick', 'crossassettick',
  'biotechtick', 'biotechgrade', 'universecurate', 'dualreadbackfill', 'fadeseed', 'warmchain', 'chainsummary'];

test('writers that investigate, call an LLM or overwrite state are privileged', () => {
  for (const op of WRITERS) assert.equal(policyOf(op), 'privileged', op);
});

test('anonymous and wrong-token calls to privileged writers are denied with zero store/LLM/provider I/O', async () => {
  await withEnv({ CRON_SECRET: SECRET, VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'x', ANTHROPIC_API_KEY: 'x' }, async () => {
    for (const op of WRITERS) {
      for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { 'x-warm': '1' }]) {
        const { res, ioCalls } = await callCountingIO({ method: 'GET', query: { op }, headers });
        assert.equal(res.statusCode, 401, `${op} ${JSON.stringify(headers)}`);
        assert.equal(res.body.ok, false);
        assert.equal(ioCalls, 0, `${op} performed I/O while denied`);
      }
    }
  });
});

test('production with no configured secret fails closed (503) — a missing secret never means allow', async () => {
  await withEnv({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'x' }, async () => {
    for (const op of WRITERS) {
      const { res, ioCalls } = await callCountingIO({ method: 'GET', query: { op }, headers: { authorization: 'Bearer anything' } });
      assert.equal(res.statusCode, 503, op);
      assert.equal(ioCalls, 0);
    }
  });
});

test('valid service auth passes the gate and reaches the handler (authenticated cron GET still works)', async () => {
  // No Blob token: the handler runs and reports the store is not configured, which proves
  // the request got PAST authorization without touching any real storage.
  await withEnv({ CRON_SECRET: SECRET, VERCEL_ENV: 'production' }, async () => {
    const { res } = await callCountingIO({ method: 'GET', query: { op: 'fadeseed' }, headers: { authorization: `Bearer ${SECRET}` } });
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 503);
    assert.notEqual(res.statusCode, 400);
  });
});

test('parameter-dependent write levers are stripped for untrusted callers and kept for the cron', () => {
  const { stripForceParams, stripWriteParams } = require('../lib/auth');
  const prev = { s: process.env.CRON_SECRET, e: process.env.VERCEL_ENV };
  process.env.CRON_SECRET = SECRET; process.env.VERCEL_ENV = 'production';
  try {
    const anon = { query: { op: 'gameplan', refresh: '1', force: '1', reset: '1', log: '1' }, headers: {} };
    stripForceParams(anon);
    assert.deepEqual(anon.query, { op: 'gameplan' });
    const today = { query: { op: 'today', log: '1' }, headers: {} };
    stripWriteParams(today);
    assert.equal('log' in today.query, false, 'today(log=1) cannot write shared state for an anonymous caller');
    const cron = { query: { op: 'today', log: '1', force: '1' }, headers: { authorization: `Bearer ${SECRET}` } };
    stripForceParams(cron);
    assert.deepEqual(cron.query, { op: 'today', log: '1', force: '1' });
  } finally {
    if (prev.s === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev.s;
    if (prev.e === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prev.e;
  }
  for (const op of ['gameplan', 'readthrough', 'optionsflow', 'pulse', 'atlasx']) assert.equal(policyOf(op), 'shared-force', op);
  assert.equal(policyOf('today'), 'public-read');
});

test('internal forwarding cannot escalate a public read: only a trusted inbound request forwards the bearer', () => {
  const { forwardedInternalHeaders, internalHeadersForHost } = require('../lib/auth');
  const prev = { s: process.env.CRON_SECRET, h: process.env.WARM_HOST };
  process.env.CRON_SECRET = SECRET; delete process.env.WARM_HOST;
  try {
    assert.deepEqual(forwardedInternalHeaders({ headers: {} }), {}, 'anonymous: no bearer, no x-warm');
    assert.deepEqual(forwardedInternalHeaders({ headers: { authorization: 'Bearer nope' } }), {});
    assert.deepEqual(forwardedInternalHeaders({ headers: { authorization: `Bearer ${SECRET}` } }), { 'x-warm': '1', authorization: `Bearer ${SECRET}` });
    assert.equal(internalHeadersForHost('market-news-app-chi.vercel.app').authorization, `Bearer ${SECRET}`);
    assert.deepEqual(internalHeadersForHost('attacker.example'), {}, 'the bearer is never sent to a request-derived foreign host');
    assert.deepEqual(internalHeadersForHost(undefined), {});
  } finally {
    if (prev.s === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev.s;
    if (prev.h !== undefined) process.env.WARM_HOST = prev.h;
  }
  const whynow = fs.readFileSync(path.join(ROOT, 'lib', 'whynow-routes.js'), 'utf8');
  assert.doesNotMatch(whynow, /internalHeaders\(\)/, 'op=whynow must not attach service credentials unconditionally');
});

test('screener warm lever: trusted always; unconfigured secret allows it only outside production', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'screener.js'), 'utf8');
  assert.match(src, /const isWarm = warmRequested && \(isTrusted\(req\) \|\| \(!cronSecret\(\) && !isProduction\(\)\)\);/);
  assert.doesNotMatch(src, /warmRequested && \(!cronSecret\(\) \|\| isTrusted\(req\)\)/, 'the absent-secret bypass must not return');
});
