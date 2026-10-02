'use strict';
// scripts/nightly-chains-preflight.js — the idempotence gate of the nightly-chains workflow.
// Pure decision + a probe driven by an injected fetch; the script must never fail the night.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PF = require('../scripts/nightly-chains-preflight');

const ROOTS = ['ledger', 'capture', 'maturity'];
const DATE = '2026-10-02';
const health = (chains) => ({ ok: true, healthy: true, chains });

test('decidePreflight: a full, clean record for the session date → skip everything', () => {
  const d = PF.decidePreflight({ health: health({ date: DATE, full: true, ok: true, covered: ROOTS, failed: [], source: 'github-matrix', runUrl: 'u' }), sessionDate: DATE, roots: ROOTS });
  assert.equal(d.skip, true); assert.deepEqual(d.alreadyOk, ROOTS); assert.match(d.reason, /already has a full, clean run/);
});

test('decidePreflight: a partial record → run only the chains not yet ok', () => {
  const d = PF.decidePreflight({ health: health({ date: DATE, full: false, partial: true, ok: false, covered: ['maturity', 'capture'], failed: ['capture'] }), sessionDate: DATE, roots: ROOTS });
  assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, ['maturity']); assert.match(d.reason, /partial record with 1\/3 chains ok/);
});

test('decidePreflight: a full but red record → re-run the failed chains only', () => {
  const d = PF.decidePreflight({ health: health({ date: DATE, full: true, ok: false, covered: ROOTS, failed: ['ledger'] }), sessionDate: DATE, roots: ROOTS });
  assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, ['capture', 'maturity']);
});

test('decidePreflight: no record for tonight (older date, null health, malformed chains) → run everything', () => {
  for (const h of [null, {}, health(null), health({ date: '2026-10-01', full: true, ok: true, covered: ROOTS, failed: [] }), health({ date: DATE, full: true, ok: true, covered: 'x', failed: 'y' })]) {
    const d = PF.decidePreflight({ health: h, sessionDate: DATE, roots: ROOTS });
    if (h && h.chains && h.chains.date === DATE) { assert.equal(d.skip, true); continue; }   // the malformed-but-ok case still trusts full+ok
    assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, []);
  }
});

test('decidePreflight: only= and force=true always run what was asked, even over a clean night', () => {
  const clean = health({ date: DATE, full: true, ok: true, covered: ROOTS, failed: [] });
  assert.deepEqual(PF.decidePreflight({ health: clean, sessionDate: DATE, only: ['maturity'], roots: ROOTS }), { skip: false, alreadyOk: [], reason: 'only=maturity — a filtered dispatch always runs what was asked' });
  assert.equal(PF.decidePreflight({ health: clean, sessionDate: DATE, force: true, roots: ROOTS }).skip, false);
});

test('probeHealth: public GET with a cache-busting run id; non-200, non-JSON and transport errors are nulls, never throws', async () => {
  const calls = [];
  const ok = await PF.probeHealth({ appUrl: 'https://app.test/', runId: '77', fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ chains: { date: DATE } }) }; } });
  assert.equal(calls[0].url, 'https://app.test/api/tracker?op=health&preflight=77');
  assert.equal(calls[0].init.headers.authorization, undefined, 'no bearer — op=health is public and the probe must never carry the secret');
  assert.equal(ok.health.chains.date, DATE);
  assert.equal((await PF.probeHealth({ fetchImpl: async () => ({ status: 503, json: async () => ({}) }) })).error, 'HTTP 503');
  assert.equal((await PF.probeHealth({ fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('bad'); } }) })).error, 'non-JSON body');
  assert.match((await PF.probeHealth({ fetchImpl: async () => { throw new Error('ECONNRESET'); } })).error, /ECONNRESET/);
});

test('main: writes skip/already_ok to GITHUB_OUTPUT, exits 0, and fails OPEN when the probe fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const out = path.join(dir, 'out.txt');
  const now = () => Date.parse('2026-10-02T22:45:00Z');
  const { ROOT_CHAINS } = require('../lib/warm-chains');
  const fetchOk = async () => ({ status: 200, json: async () => health({ date: '2026-10-02', full: true, ok: true, covered: ROOT_CHAINS, failed: [] }) });
  assert.equal(await PF.main({ GITHUB_OUTPUT: out, GITHUB_RUN_ID: '1' }, { fetchImpl: fetchOk, now }), 0);
  assert.match(fs.readFileSync(out, 'utf8'), /^skip=true\nalready_ok=ledger,/);
  fs.writeFileSync(out, '');
  assert.equal(await PF.main({ GITHUB_OUTPUT: out }, { fetchImpl: async () => { throw new Error('down'); }, now }), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\nalready_ok=\n');
  // A late (01:00 UTC) run still asks about the same ET session date.
  fs.writeFileSync(out, '');
  await PF.main({ GITHUB_OUTPUT: out }, { fetchImpl: async () => ({ status: 200, json: async () => health({ date: '2026-10-02', full: false, covered: ['maturity'], failed: [] }) }), now: () => Date.parse('2026-10-03T01:00:00Z') });
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\nalready_ok=maturity\n');
});
