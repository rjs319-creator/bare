'use strict';
// Handlers that stay publicly readable but whose WRITE is a trusted action.
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakeBlob } = require('./helpers/fake-blob');

const SECRET = 'test-cron-secret';
const fake = installFakeBlob();
if (!fake) {
  test('trusted write levers (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
async function withSecret(fn) {
  const prev = { s: process.env.CRON_SECRET, e: process.env.VERCEL_ENV };
  process.env.CRON_SECRET = SECRET; process.env.VERCEL_ENV = 'production';
  try { return await fn(); } finally {
    if (prev.s === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev.s;
    if (prev.e === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prev.e;
  }
}
const captureWrites = () => fake.putCalls.filter(c => c.pathname.startsWith('lifecycle/daytrade/capture/'));

test('op=daytradecapture: an anonymous ?date= gets the report but cannot overwrite a stored day', async () => {
  const { runDaytradeCapture } = require('../lib/runner-capture');
  const stored = { date: '2026-08-03', kept: 'original report' };
  await withSecret(async () => {
    fake.docs.clear(); fake.putCalls.length = 0;
    fake.seed('lifecycle/daytrade/capture/2026-08-03.json', stored);
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
      const res = fakeRes();
      await runDaytradeCapture({ query: { date: '2026-08-03' }, headers }, res);
      assert.equal(res.body.ok, true, 'the computed report is still returned');
    }
    assert.equal(captureWrites().length, 0);
    assert.deepEqual(fake.read('lifecycle/daytrade/capture/2026-08-03.json'), stored);

    const res = fakeRes();
    await runDaytradeCapture({ query: { date: '2026-08-03' }, headers: { authorization: `Bearer ${SECRET}` } }, res);
    assert.equal(res.body.ok, true);
    assert.equal(captureWrites().length, 1, 'the scheduler (bearer) persists the report');
  });
});

test('op=recalibrate: adoption and the model write are behind trust; the browser gets a labelled dry run', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function runRecalibrate'), src.indexOf('async function', src.indexOf('async function runRecalibrate') + 10));
  assert.match(fn, /const dryRun = !isTrusted\(req\);/);
  assert.match(fn, /else if \(diag\.fittedAny && !dryRun\) \{/, 'a new version is pushed only for a trusted caller');
  assert.match(fn, /if \(!dryRun\) \{\s*try \{ await modelState\.write\(model, modelPrior\)/, 'the model doc is written only for a trusted caller, guarded by the prior read');
  assert.doesNotMatch(fn, /await writeModel\(model\)/, 'no unconditional model write');
  assert.match(fn, /refit: diag\.fittedAny && !dryRun && !policyBlockedAdoption/, '`refit` means a fit is IN FORCE, never merely computed');
  assert.match(fn, /await modelState\.read\(\)/, 'version history comes from a strict read (an outage cannot restart it at .1)');
});

test('the daytrade-scan workflow sends the bearer on the capture step (it is what persists the report)', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daytrade-scan.yml'), 'utf8');
  assert.match(yml, /-H "Authorization: Bearer \$CRON_SECRET" "\$APP_URL\/api\/tracker\?op=daytradecapture"/);
});
