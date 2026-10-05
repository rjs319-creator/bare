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
  const d = PF.decidePreflight({ health: health({ date: DATE, full: true, ok: true, covered: ROOTS, failed: [], source: 'github-matrix', runUrl: 'u' }), targetSession: DATE, roots: ROOTS });
  assert.equal(d.skip, true); assert.deepEqual(d.alreadyOk, ROOTS); assert.match(d.reason, /already has a full, clean run/);
});

test('decidePreflight: a partial record → run only the chains not yet ok', () => {
  const d = PF.decidePreflight({ health: health({ date: DATE, full: false, partial: true, ok: false, covered: ['maturity', 'capture'], failed: ['capture'] }), targetSession: DATE, roots: ROOTS });
  assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, ['maturity']); assert.match(d.reason, /partial record with 1\/3 chains ok/);
});

test('decidePreflight: a full but red record → re-run the failed chains only', () => {
  const d = PF.decidePreflight({ health: health({ date: DATE, full: true, ok: false, covered: ROOTS, failed: ['ledger'] }), targetSession: DATE, roots: ROOTS });
  assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, ['capture', 'maturity']);
});

test('decidePreflight: no record for tonight (older date, null health, malformed chains) → run everything', () => {
  for (const h of [null, {}, health(null), health({ date: '2026-10-01', full: true, ok: true, covered: ROOTS, failed: [] }), health({ date: DATE, full: true, ok: true, covered: 'x', failed: 'y' })]) {
    const d = PF.decidePreflight({ health: h, targetSession: DATE, roots: ROOTS });
    if (h && h.chains && h.chains.date === DATE) { assert.equal(d.skip, true); continue; }   // the malformed-but-ok case still trusts full+ok
    assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, []);
  }
});

test('decidePreflight: only= and force=true always run what was asked, even over a clean night', () => {
  const clean = health({ date: DATE, full: true, ok: true, covered: ROOTS, failed: [] });
  assert.deepEqual(PF.decidePreflight({ health: clean, targetSession: DATE, only: ['maturity'], roots: ROOTS }), { skip: false, alreadyOk: [], reason: 'only=maturity — a filtered dispatch always runs what was asked' });
  assert.equal(PF.decidePreflight({ health: clean, targetSession: DATE, force: true, roots: ROOTS }).skip, false);
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
  assert.match(fs.readFileSync(out, 'utf8'), /^skip=true\nalready_ok=ledger,[^\n]*\nsession=2026-10-02\n$/);
  fs.writeFileSync(out, '');
  assert.equal(await PF.main({ GITHUB_OUTPUT: out }, { fetchImpl: async () => { throw new Error('down'); }, now }), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\nalready_ok=\nsession=2026-10-02\n');
  // A late (01:00 UTC) run still asks about the same session.
  fs.writeFileSync(out, '');
  await PF.main({ GITHUB_OUTPUT: out }, { fetchImpl: async () => ({ status: 200, json: async () => health({ date: '2026-10-02', full: false, covered: ['maturity'], failed: [] }) }), now: () => Date.parse('2026-10-03T01:00:00Z') });
  assert.equal(fs.readFileSync(out, 'utf8'), 'skip=false\nalready_ok=maturity\nsession=2026-10-02\n');
});

// ── TARGET SESSION (2026-10-02/03): the night is the last COMPLETED session, not the ET date ──
const fetchHealth = (chains) => async () => ({ status: 200, json: async () => health(chains) });
const runMain = async (nowIso, chains) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(out, '');
  await PF.main({ GITHUB_OUTPUT: out, GITHUB_RUN_ID: '9' }, { fetchImpl: fetchHealth(chains), now: () => Date.parse(nowIso) });
  return fs.readFileSync(out, 'utf8');
};
const fullOk = (session, over = {}) => ({ session, date: session, full: true, ok: true, covered: ROOTS, failed: [], source: 'github-matrix', ...over });

test('decidePreflight: compares the health block\'s SESSION to the target (legacy health with only a date still matches)', () => {
  const thursdayRecord = fullOk('2026-10-01', { date: '2026-10-02' });   // the 02:14 ET Friday run, stamped by session
  assert.equal(PF.decidePreflight({ health: health(thursdayRecord), targetSession: '2026-10-01', roots: ROOTS }).skip, true);
  const d = PF.decidePreflight({ health: health(thursdayRecord), targetSession: '2026-10-02', roots: ROOTS });
  assert.equal(d.skip, false); assert.deepEqual(d.alreadyOk, []); assert.match(d.reason, /no record for 2026-10-02/);
  const legacy = { date: '2026-10-01', full: true, ok: true, covered: ROOTS, failed: [] };
  assert.equal(PF.decidePreflight({ health: health(legacy), targetSession: '2026-10-01', roots: ROOTS }).skip, true, 'a health block without `session` is keyed by its date');
});

test('main: THE 10-02 SEQUENCE — 02:14 ET Friday targets Thursday (skip); 20:28 ET Friday targets Friday (run everything); 02:41 ET Saturday targets Friday (skip)', async () => {
  const { ROOT_CHAINS } = require('../lib/warm-chains');
  const thursdayNight = fullOk('2026-10-01', { covered: ROOT_CHAINS });
  // 06:14 UTC Friday 10-02 = 02:14 ET, pre-market: Thursday is the last completed session and it is already covered.
  assert.equal(await runMain('2026-10-02T06:14:00Z', thursdayNight), `skip=true\nalready_ok=${ROOT_CHAINS.join(',')}\nsession=2026-10-01\n`);
  // 00:28 UTC Saturday = 20:28 ET Friday, post-close: Friday is the target and Thursday's record must NOT satisfy it —
  // even when that record was produced on the Friday calendar date (the pre-market run, date 2026-10-02).
  const premarketRecord = fullOk('2026-10-01', { date: '2026-10-02', covered: ROOT_CHAINS });
  assert.equal(await runMain('2026-10-03T00:28:00Z', premarketRecord), 'skip=false\nalready_ok=\nsession=2026-10-02\n');
  // 06:41 UTC Saturday = 02:41 ET: still Friday's session; once Friday's full run has posted the retry is a no-op.
  assert.equal(await runMain('2026-10-03T06:41:00Z', fullOk('2026-10-02', { covered: ROOT_CHAINS })), `skip=true\nalready_ok=${ROOT_CHAINS.join(',')}\nsession=2026-10-02\n`);
  // Holiday: Thanksgiving evening targets Wednesday.
  assert.equal(await runMain('2026-11-26T22:10:00Z', fullOk('2026-11-25', { covered: ROOT_CHAINS })), `skip=true\nalready_ok=${ROOT_CHAINS.join(',')}\nsession=2026-11-25\n`);
});
