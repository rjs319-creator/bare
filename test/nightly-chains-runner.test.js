'use strict';
// scripts/run-nightly-chain.js + scripts/nightly-chains-summary.js, driven offline with an
// injected fetch: the retry policy, the body-based grading, the no-report fold, and the POST.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RUN = require('../scripts/run-nightly-chain');
const SUM = require('../scripts/nightly-chains-summary');

const resp = (status, body, text = null) => ({ status, ok: status >= 200 && status < 300, text: async () => (text != null ? text : JSON.stringify(body)) });
const clock = (step = 1000) => { let t = Date.parse('2026-10-02T22:05:00Z'); return () => { t += step; return t; }; };
const opts = (fetchImpl, over = {}) => ({ appUrl: 'https://app.test', secret: 's3cret', fetchImpl, now: clock(), retryDelayMs: 0, ...over });

test('runChain: HTTP 200 with a clean body → ok, one attempt, bearer + x-warm headers, right URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return resp(200, { ok: true, complete: true, failed: [], skipped: [], elapsedMs: 4321 }); };
  const r = await RUN.runChain('maturity', opts(fetchImpl));
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.attempts, 1); assert.equal(r.elapsedMs, 4321); assert.equal(r.complete, true);
  assert.equal(calls[0].url, 'https://app.test/api/tracker?op=warmchain&name=maturity');
  assert.equal(calls[0].init.headers.authorization, 'Bearer s3cret');
  assert.equal(calls[0].init.headers['x-warm'], '1');
});

test('runChain: a FAST 503 is retried once and the second attempt counts', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? resp(503, { ok: false, error: 'edge' }) : resp(200, { ok: true, failed: [], skipped: [] }));
  const r = await RUN.runChain('maturity', opts(fetchImpl));
  assert.equal(r.attempts, 2); assert.equal(r.ok, true);
});

test('runChain: two fast 503s → http:503 with the body error surfaced; exit would be red', async () => {
  const fetchImpl = async () => resp(503, { ok: false, error: 'server authorization not configured' });
  const r = await RUN.runChain('maturity', opts(fetchImpl));
  assert.equal(r.attempts, 2); assert.equal(r.ok, false); assert.equal(r.status, 'http:503'); assert.match(r.error, /authorization/);
  assert.match(RUN.annotations(r)[0], /^::error title=chain maturity http:503::/);
});

test('runChain: a SLOW failure is never retried — the chain ran, re-running would double-execute', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; throw new Error('socket hang up'); };
  const r = await RUN.runChain('maturity', opts(fetchImpl, { now: clock(RUN.FAST_FAIL_MS) }));
  assert.equal(n, 1); assert.equal(r.attempts, 1); assert.equal(r.status, 'no-response'); assert.match(r.error, /socket hang up/);
});

test('runChain: HTTP 200 whose BODY reports failed steps is graded failed (the 200==healthy trap)', async () => {
  const fetchImpl = async () => resp(200, { ok: false, complete: true, failed: ['op=track', 'decision/op=redundancy&force=1'], skipped: [], failDetail: [{ op: 'op=track', status: 'http:503', error: 'no picks' }] });
  const r = await RUN.runChain('ledger', opts(fetchImpl));
  assert.equal(r.ok, false); assert.equal(r.status, 'failed'); assert.deepEqual(r.failed, ['op=track', 'decision/op=redundancy&force=1']);
  assert.equal(r.attempts, 1, 'a chain that ran is never retried'); assert.match(r.error, /op=track http:503 no picks/);
});

test('runChain: budget skips alone stay ok (complete:false) with a warning annotation; non-JSON 200 is graded unknown-but-ok', async () => {
  const r = await RUN.runChain('capture', opts(async () => resp(200, { ok: false, complete: false, failed: [], skipped: ['op=fadetick'] })));
  assert.equal(r.ok, true); assert.equal(r.complete, false); assert.deepEqual(r.skipped, ['op=fadetick']);
  assert.match(RUN.annotations(r)[0], /budget-skipped::op=fadetick/);
  const r2 = await RUN.runChain('capture', opts(async () => resp(200, null, 'not json')));
  assert.equal(r2.ok, true); assert.equal(r2.complete, null);
});

test('runChain: an unknown chain name throws before any request', async () => {
  await assert.rejects(() => RUN.runChain('nope', opts(async () => { throw new Error('must not fetch'); })), /unknown chain/);
});

test('main: without CRON_SECRET writes a skipped:no-secret result, warns, exits 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  const code = await RUN.main(['node', 'x', 'maturity'], { OUT_DIR: dir });
  assert.equal(code, 0);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'maturity.json'), 'utf8'));
  assert.equal(r.status, 'skipped:no-secret'); assert.equal(r.ok, true);
});

// ── summary ──────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-02T22:40:00Z');
const res = (chain, over = {}) => ({ chain, ok: true, status: 'ok', httpStatus: 200, attempts: 1, complete: true, failed: [], skipped: [], elapsedMs: 1000, startedAt: '2026-10-02T22:06:00Z', finishedAt: '2026-10-02T22:08:00Z', ...over });

test('buildSummaryPayload: every expected root is present; a missing one is no-report and failed; date from the earliest start', () => {
  const p = SUM.buildSummaryPayload([res('ledger'), res('capture', { ok: false, status: 'failed', failed: ['op=archive'], error: 'op=archive http:500' })],
    { expected: ['ledger', 'capture', 'ticks1'], runId: 99, runUrl: 'https://gh/run/99', now: NOW });
  assert.equal(p.date, '2026-10-02'); assert.equal(p.source, 'github-matrix'); assert.equal(p.runId, '99');
  assert.equal(p.partial, false); assert.deepEqual(p.covered, ['ledger', 'capture', 'ticks1']);
  assert.equal(p.chains.ledger.ok, true);
  assert.deepEqual(p.chains.capture.failed, ['op=archive']);
  assert.equal(p.chains.ticks1.status, 'no-report'); assert.equal(p.chains.ticks1.ok, false);
  assert.equal(p.startedAt, '2026-10-02T22:06:00.000Z'); assert.equal(p.finishedAt, new Date(NOW).toISOString());
  // The payload round-trips through the server-side validator untouched.
  const CS = require('../lib/chain-summary');
  const v = CS.normalizeChainSummary(p, { now: NOW });
  assert.equal(v.error, null); assert.deepEqual(v.value.failed, ['capture', 'ticks1']);
});

test('buildSummaryPayload: a filtered (workflow_dispatch only=) run expects only those roots and is recorded as manual', () => {
  const p = SUM.buildSummaryPayload([res('maturity')], { expected: ['ledger', 'maturity', 'bearcase'], only: ['maturity', 'bearcase'], now: NOW });
  assert.deepEqual(Object.keys(p.chains), ['maturity', 'bearcase']); assert.equal(p.source, 'manual');
  assert.equal(p.partial, true, 'a filtered run can never cover the night'); assert.deepEqual(p.covered, ['maturity', 'bearcase']);
  assert.equal(p.chains.bearcase.status, 'no-report');
  assert.match(SUM.stepSummaryMarkdown(p), /\(manual, partial\)/);
  assert.deepEqual(SUM.parseOnly(' maturity, bearcase ,'), ['maturity', 'bearcase']);
});

test('buildSummaryPayload: a run that starts after 00:00 UTC is dated by its ET session (same evening in New York)', () => {
  const late = res('ledger', { startedAt: '2026-10-03T01:02:00Z', finishedAt: '2026-10-03T01:05:00Z' });
  const p = SUM.buildSummaryPayload([late], { expected: ['ledger'], now: Date.parse('2026-10-03T01:06:00Z') });
  assert.equal(p.date, '2026-10-02');
});

test('stepSummaryMarkdown: names the failed chains up top and one row per chain', () => {
  const p = SUM.buildSummaryPayload([res('ledger'), res('capture', { ok: false, status: 'failed', failed: ['op=archive'] })], { expected: ['ledger', 'capture'], now: NOW });
  const md = SUM.stepSummaryMarkdown(p);
  assert.match(md, /\*\*1 failed:\*\* capture/); assert.match(md, /\| ✅ ledger \|/); assert.match(md, /\| ❌ capture \| failed \|/);
});

test('postSummary: POSTs JSON with the bearer to op=chainsummary and reports the status; transport errors never throw', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return resp(200, { ok: true, written: true }); };
  const p = SUM.buildSummaryPayload([res('ledger')], { expected: ['ledger'], now: NOW });
  const r = await SUM.postSummary(p, { appUrl: 'https://app.test', secret: 's3cret', fetchImpl });
  assert.equal(r.httpStatus, 200); assert.equal(calls[0].url, 'https://app.test/api/tracker?op=chainsummary');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.authorization, 'Bearer s3cret');
  assert.equal(JSON.parse(calls[0].init.body).chains.ledger.ok, true);
  const bad = await SUM.postSummary(p, { appUrl: 'https://app.test', secret: 's3cret', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(bad.httpStatus, null); assert.match(bad.error, /down/);
});

test('readResults: ignores non-JSON and non-result files, tolerates a missing dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-sum-'));
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(res('ledger')));
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'other.json'), '{"x":1}');
  assert.deepEqual(SUM.readResults(dir).map((r) => r.chain), ['ledger']);
  assert.deepEqual(SUM.readResults(path.join(dir, 'missing')), []);
});
