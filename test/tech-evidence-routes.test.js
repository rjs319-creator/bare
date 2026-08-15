'use strict';
// Prevents: write ops reachable without the CRON_SECRET bearer, public reads mutating
// storage, the empty state being CDN-cached (the known trap), unvalidated params, and
// the feature silently dropping out of the nightly warm chain.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function mockRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (query = {}) => ({ query, headers: {}, method: 'GET' });

test('tracker wiring: writers privileged, reads throttled-public, all five ops dispatched', () => {
  const src = read('api/tracker.js');
  const privBlock = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf('const EXPENSIVE_OPS'));
  for (const op of ['techevtick', 'techevresolve', 'techevbackfill']) {
    assert.ok(privBlock.includes(`'${op}'`), `op=${op} must require the CRON_SECRET bearer`);
  }
  assert.ok(!privBlock.includes("'techev'\n") && !privBlock.includes("'techevdetail'"), 'public reads must NOT be privileged');
  const expBlock = src.slice(src.indexOf('const EXPENSIVE_OPS'), src.indexOf('const EXPENSIVE_LIMIT'));
  assert.ok(expBlock.includes("'techev', 'techevdetail'"), 'public reads are rate-limited for anonymous callers');
  for (const op of ['techev', 'techevdetail', 'techevtick', 'techevresolve', 'techevbackfill']) {
    assert.ok(src.includes(`req.query.op === '${op}'`), `op=${op} must be dispatched`);
  }
});

test('warm chain: techev root chain runs tick then resolve; backfill is NOT cron-wired', () => {
  const WC = require('../lib/warm-chains');
  assert.deepEqual(WC.CHAINS.techev, ['op=techevtick', 'op=techevresolve']);
  assert.ok(WC.ROOT_CHAINS.includes('techev'));
  assert.ok(!JSON.stringify(WC.CHAINS).includes('techevbackfill'), 'backfill is manual-only by design');
});

test('public reads perform ZERO store writes and never cache the empty state', async (t) => {
  const STORE = require('../lib/store');
  const origWrite = STORE.writeJSON;
  const origRead = STORE.readJSON;
  let writes = 0;
  STORE.writeJSON = async () => { writes += 1; throw new Error('public read attempted a write'); };
  STORE.readJSON = async (key, fallback) => fallback; // pre-first-tick world: nothing exists
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = hadToken || 'test-token';
  t.after(() => {
    STORE.writeJSON = origWrite;
    STORE.readJSON = origRead;
    if (hadToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = hadToken;
  });
  const R = require('../lib/tech-evidence-routes');
  const res = mockRes();
  await R.runTechEv(req(), res);
  assert.equal(writes, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store', 'empty state must NEVER be CDN-cached');
  assert.equal(res.body.ok, true);
  assert.match(res.body.health.note, /Collection has not run/);
  const detailRes = mockRes();
  await R.runTechEvDetail(req({ ticker: 'MDB' }), detailRes);
  assert.equal(writes, 0);
  assert.equal(detailRes.headers['cache-control'], 'no-store');
});

test('a populated snapshot IS CDN-cached', async (t) => {
  const STORE = require('../lib/store');
  const origRead = STORE.readJSON;
  STORE.readJSON = async (key, fallback) => {
    if (key.includes('signals/latest')) return { cutoffDate: '2026-08-07', generatedAt: '2026-08-08T02:00:00Z', signals: [] };
    return fallback;
  };
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = hadToken || 'test-token';
  t.after(() => {
    STORE.readJSON = origRead;
    if (hadToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = hadToken;
  });
  const R = require('../lib/tech-evidence-routes');
  const res = mockRes();
  await R.runTechEv(req(), res);
  assert.match(res.headers['cache-control'], /s-maxage=/);
});

test('param validation: bad ticker 400s; bad backfill src 400s with the allowed list', async (t) => {
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = hadToken || 'test-token';
  t.after(() => { if (hadToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = hadToken; });
  const R = require('../lib/tech-evidence-routes');
  const res = mockRes();
  await R.runTechEvDetail(req({ ticker: '../etc' }), res);
  assert.equal(res.statusCode, 400);
  const res2 = mockRes();
  await R.runTechEvBackfill(req({ src: 'wayback' }), res2);
  assert.equal(res2.statusCode, 400);
  assert.match(res2.body.error, /npm\|github\|sec\|statuspage\|derive/);
});

test('writers fail closed without Blob storage (503, no-store)', async (t) => {
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  t.after(() => { if (hadToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = hadToken; });
  const R = require('../lib/tech-evidence-routes');
  for (const fn of [R.runTechEvTick, R.runTechEvResolve, R.runTechEvBackfill]) {
    const res = mockRes();
    await fn(req({ src: 'npm' }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('public unconfigured state is honest and un-cached (degraded, not empty-success)', async (t) => {
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  t.after(() => { if (hadToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = hadToken; });
  const R = require('../lib/tech-evidence-routes');
  const res = mockRes();
  await R.runTechEv(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.state, 'not-configured');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the frontend section is actually mounted on the Technology page', () => {
  const tc = read('public/js/tech-command.js');
  assert.match(tc, /renderTechEvidence\(/, 'tech-command must render the Operational Evidence section');
  assert.match(tc, /op=techev/, 'tech-command must fetch the techev payload');
  const render = read('public/js/tech-evidence-render.js');
  assert.match(render, /Research evidence, not a trade recommendation/, 'the disclosure line must be visible');
});
