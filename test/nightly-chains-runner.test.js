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
const opts = (fetchImpl, over = {}) => ({ appUrl: 'https://app.test', secret: 's3cret', fetchImpl, now: clock(), retryDelayMs: 0, crashRetryDelayMs: 0, ...over });

test('runChain: HTTP 200 with a clean body → ok, one attempt, bearer + x-warm headers, right URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return resp(200, { ok: true, complete: true, failed: [], skipped: [], elapsedMs: 4321 }); };
  const r = await RUN.runChain('maturity', opts(fetchImpl));
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.attempts, 1); assert.equal(r.elapsedMs, 4321); assert.equal(r.complete, true);
  assert.equal(r.session, '2026-10-02', 'stamped with the TARGET SESSION (22:05 UTC Thursday → Thursday)'); assert.equal(r.date, '2026-10-02');
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

// ── platform crashes (co-located Fluid instance OOM) ─────────────────────────────────
const CRASH_TEXT = 'A server error has occurred\n\nFUNCTION_INVOCATION_FAILED\n\niad1::abc-123';

test('runChain: a SLOW FUNCTION_INVOCATION_FAILED 500 on the chain IS retried once after the crash backoff (the one slow-failure exception)', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? resp(500, null, CRASH_TEXT) : resp(200, { ok: true, failed: [], skipped: [], elapsedMs: 100 }));
  const r = await RUN.runChain('capture', opts(fetchImpl, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 2); assert.equal(r.attempts, 2); assert.equal(r.ok, true); assert.equal(r.crashRetry, true);
  assert.equal(r.attemptFailures.length, 1, 'the crashed attempt\'s instant is recorded'); assert.equal(r.failedAt, null);
});

test('runChain: a slow 503 / 502 is retried as a crash; a slow 504 or a slow transport error is not (the chain ran)', async () => {
  for (const code of [502, 503]) {
    let n = 0;
    const r = await RUN.runChain('capture', opts(async () => { n++; return resp(code, { ok: false, error: 'edge' }); }, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
    assert.equal(n, 2, `slow ${code} retried once`); assert.equal(r.crashRetry, true); assert.equal(r.status, `http:${code}`);
    assert.equal(r.attemptFailures.length, 2); assert.equal(r.failedAt, r.attemptFailures[1]);
  }
  let n = 0;
  const r504 = await RUN.runChain('capture', opts(async () => { n++; return resp(504, null, 'gateway timeout'); }, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 1); assert.equal(r504.crashRetry, false);
  // A plain 500 WITHOUT the marker is the chain handler's own catch — a code defect, not a kill.
  n = 0;
  const r500 = await RUN.runChain('capture', opts(async () => { n++; return resp(500, { ok: false, error: 'TypeError: x is not a function' }); }, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 1); assert.equal(r500.crashRetry, false);
});

test('runChain: a 200 whose STEP died with FUNCTION_INVOCATION_FAILED is a crash too — retried once, step failure instants stamped from the body', async () => {
  let n = 0;
  const crashedBody = { ok: false, complete: true, elapsedMs: 6000, failed: ['op=alertsassess'],
    steps: [{ op: 'op=track', status: 'ok', ms: 1000 }, { op: 'op=alertsassess', status: 'http:500', ms: 4000, error: CRASH_TEXT }, { op: 'op=fadetick', status: 'ok', ms: 1000 }],
    failDetail: [{ op: 'op=alertsassess', status: 'http:500', ms: 4000, error: CRASH_TEXT }], skipped: [] };
  const fetchImpl = async () => (++n === 1 ? resp(200, crashedBody) : resp(200, { ok: true, failed: [], skipped: [], elapsedMs: 100 }));
  const r = await RUN.runChain('capture', opts(fetchImpl, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 2); assert.equal(r.ok, true); assert.equal(r.crashRetry, true);
  assert.equal(r.attemptFailures.length, 1);
  // The step ended 1 s before the chain finished (fadetick ran 1 s after it): instant = response time − 1000 ms.
  const stamped = RUN.stampFailDetail(crashedBody, crashedBody.failDetail, Date.parse('2026-10-02T22:56:33Z'));
  assert.equal(stamped[0].at, '2026-10-02T22:56:32.000Z');
  // A nested child failure is stamped with its parent @step's end; no elapsedMs → at:null.
  const nested = { elapsedMs: 3000, steps: [{ op: '@decision', status: 'ok', ms: 2000 }, { op: 'op=x', status: 'ok', ms: 1000 }] };
  assert.equal(RUN.stampFailDetail(nested, [{ op: 'decision/op=redundancy', status: 'http:503' }], Date.parse('2026-10-02T22:56:33Z'))[0].at, '2026-10-02T22:56:32.000Z');
  assert.equal(RUN.stampFailDetail({}, [{ op: 'op=x' }], 1)[0].at, null);
});

test('runChain: a 200 with an ordinary failed step (not a kill) is still never retried — including a deliberate app-level 503', async () => {
  // challengerlog answers 503 on an empty board and privileged ops 503 without a secret:
  // app decisions, not instance deaths. Only the Vercel marker / a 502 are kills at step level.
  for (const [status, error] of [['http:503', 'challenger: empty board'], ['http:400', 'bad input'], ['http:500', 'TypeError: x is not a function']]) {
    let n = 0;
    const r = await RUN.runChain('ledger', opts(async () => { n++; return resp(200, { ok: false, complete: true, elapsedMs: 10, failed: ['op=track'], steps: [{ op: 'op=track', status, ms: 10 }], failDetail: [{ op: 'op=track', status, error }] }); }, { now: clock(RUN.FAST_FAIL_MS) }));
    assert.equal(n, 1, `${status} is not a platform kill`); assert.equal(r.crashRetry, false);
    assert.equal(r.attemptFailures.length, 1, 'the step failure instant is still recorded for peer clustering');
  }
  let m = 0;
  await RUN.runChain('ledger', opts(async () => { m++; return resp(200, { ok: false, complete: true, elapsedMs: 10, failed: ['op=track'], steps: [{ op: 'op=track', status: 'http:502', ms: 10 }], failDetail: [{ op: 'op=track', status: 'http:502', error: 'Bad Gateway' }] }); }, { now: clock(RUN.FAST_FAIL_MS) }));
  assert.equal(m, 2, 'a step-level 502 is the platform and gets the one crash retry');
});

// ── THE 2026-10-08 INCIDENT: a real crash that slipped past both the marker and the
// error-text pipeline. Vercel's out-of-memory kill (1) does not contain the literal string
// "FUNCTION_INVOCATION_FAILED" the regex looked for, and (2) can be served as a JSON body —
// because the runner sends `Accept: application/json` — shaped `{"error":{"code":...,
// "message":...}}`, an OBJECT the old code handed straight to `String()`, producing the
// literal text "[object Object]" in op=health instead of the real diagnostic.
const OOM_JSON_BODY = { error: { code: 'FUNCTION_INVOCATION_FAILED', message: 'Vercel Runtime Error: instance was killed because it ran out of available memory' } };

test('reasonText: never collapses to "[object Object]" — pulls message/code from whatever shape a reason takes', () => {
  assert.equal(RUN.reasonText('plain string'), 'plain string');
  assert.equal(RUN.reasonText({ message: 'boom' }), 'boom');
  assert.equal(RUN.reasonText({ code: 'E_X', message: 'boom' }), 'E_X: boom');
  assert.equal(RUN.reasonText({ error: 'nested string' }), 'nested string');
  assert.match(RUN.reasonText({ weird: 'shape', n: 1 }), /"weird":"shape"/);
  assert.equal(RUN.reasonText(null), ''); assert.equal(RUN.reasonText(undefined), '');
  // The exact shape from the 2026-10-08 incident:
  assert.equal(RUN.reasonText(OOM_JSON_BODY.error), 'FUNCTION_INVOCATION_FAILED: Vercel Runtime Error: instance was killed because it ran out of available memory');
});

test('runChain: a slow 500 whose JSON body is {error:{code,message}} (an OBJECT, not a string) — the 2026-10-08 universe incident — IS retried as a crash, and the surfaced error is readable, never "[object Object]"', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? resp(500, OOM_JSON_BODY) : resp(200, { ok: true, failed: [], skipped: [], elapsedMs: 100 }));
  const r = await RUN.runChain('universe', opts(fetchImpl, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 2, 'the OOM-worded crash (no FUNCTION_INVOCATION_FAILED substring needed) gets the retry');
  assert.equal(r.attempts, 2); assert.equal(r.ok, true); assert.equal(r.crashRetry, true);
});

test('runChain: a slow 500 whose JSON body is {error:{...}} and NEVER recovers — the final error is a readable string, not "[object Object]"', async () => {
  const r = await RUN.runChain('universe', opts(async () => resp(500, OOM_JSON_BODY), { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(r.ok, false); assert.equal(r.status, 'http:500');
  assert.doesNotMatch(r.error, /\[object Object\]/);
  assert.match(r.error, /ran out of available memory/);
});

test('gradeAttempt: a 200 whose failed STEP carries an object `.error` (not a string) still produces a readable chain-level error, never "[object Object]"', () => {
  const body = { ok: false, complete: true, elapsedMs: 10, failed: ['op=universecompile'], steps: [{ op: 'op=universecompile', status: 'http:500', ms: 10 }], failDetail: [{ op: 'op=universecompile', status: 'http:500', error: { code: 'E_X', message: 'nested object error' } }] };
  const g = RUN.gradeAttempt({ httpStatus: 200, body, raw: null, error: null, endMs: 1 });
  assert.doesNotMatch(g.error, /\[object Object\]/);
  assert.match(g.error, /nested object error/);
});

// ── THE 2026-10-15 INCIDENT: a THIRD distinct platform-kill wording ("500: A server error
// has occurred" — no FUNCTION_INVOCATION_FAILED, no OOM text, nothing a regex can anchor
// on). Chasing Vercel's exact crash-page wording is unwinnable; the durable signal is the
// app's own invariant (api/tracker.js's top-level catch): our code NEVER returns a non-JSON
// 500, so an unparseable 500 body can only be the platform, by elimination.
test('runChain: a slow 500 with an UNPARSEABLE (non-JSON) body — the exact 2026-10-15 pitdata wording, no marker text at all — IS retried as a crash purely because the body is not JSON', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? resp(500, null, '500: A server error has occurred') : resp(200, { ok: true, failed: [], skipped: [], elapsedMs: 100 }));
  const r = await RUN.runChain('pitdata', opts(fetchImpl, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 2, 'an unparseable 500 body gets the crash retry even with zero marker text'); assert.equal(r.crashRetry, true); assert.equal(r.ok, true);
});

test('runChain: a slow 500 whose body IS valid JSON (our own top-level catch, e.g. {error:"TypeError..."}) is NEVER treated as a platform crash by the unparseable-body rule — only the existing marker-text rule can catch it, and here it does not', async () => {
  let n = 0;
  const r = await RUN.runChain('ledger', opts(async () => { n++; return resp(500, { ok: false, error: 'TypeError: x is not a function' }); }, { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(n, 1, 'a parseable JSON 500 body is our own app catch, not an unparseable platform page'); assert.equal(r.crashRetry, false);
});

test('runChain: an unparseable 500 that NEVER recovers still surfaces a readable error, never "[object Object]" and never silently empty', async () => {
  const r = await RUN.runChain('pitdata', opts(async () => resp(500, null, '500: A server error has occurred'), { now: clock(RUN.FAST_FAIL_MS), crashRetryDelayMs: 0 }));
  assert.equal(r.ok, false); assert.equal(r.crashRetry, true);
  assert.match(r.error, /A server error has occurred/);
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

test('main: a chain named in ALREADY_OK is reported already-ok (ok, no request, exit 0) — the preflight found it done tonight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  try {
    const code = await RUN.main(['node', 'x', 'maturity'], { OUT_DIR: dir, CRON_SECRET: 's3cret', ALREADY_OK: ' ledger, maturity ' });
    assert.equal(code, 0);
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'maturity.json'), 'utf8'));
    assert.equal(r.status, 'already-ok'); assert.equal(r.ok, true); assert.equal(r.attempts, 0);
    assert.match(r.session, /^\d{4}-\d{2}-\d{2}$/, 'already-ok results carry the session too');
    // It round-trips through the summary + the server validator as an ok chain.
    const CS = require('../lib/chain-summary');
    const p = SUM.buildSummaryPayload([r], { expected: ['maturity'], now: Date.parse(r.finishedAt) });
    const v = CS.normalizeChainSummary(p, { now: Date.parse(r.finishedAt), roots: ['maturity'] });
    assert.equal(v.error, null); assert.equal(v.value.chains.maturity.ok, true); assert.equal(v.value.chains.maturity.status, 'already-ok');
  } finally { globalThis.fetch = prevFetch; }
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
  assert.equal(p.date, '2026-10-02'); assert.equal(p.session, '2026-10-02');
});

test('buildSummaryPayload: the record is keyed by the TARGET SESSION of the earliest start; `date` stays the ET wall-clock date (2026-10-02 defect)', () => {
  // 06:14 UTC Friday 10-02 = 02:14 ET, pre-market: Thursday is the last completed session.
  const premarket = res('ledger', { startedAt: '2026-10-02T06:14:00Z', finishedAt: '2026-10-02T06:20:00Z', session: '2026-10-01' });
  const p = SUM.buildSummaryPayload([premarket], { expected: ['ledger'], now: Date.parse('2026-10-02T06:21:00Z') });
  assert.equal(p.session, '2026-10-01'); assert.equal(p.date, '2026-10-02');
  assert.match(SUM.stepSummaryMarkdown(p), /session 2026-10-01/);
  // 00:28 UTC Saturday = 20:28 ET Friday, post-close → Friday's session (the night Thursday's record must not satisfy).
  const postClose = res('ledger', { startedAt: '2026-10-03T00:28:00Z', finishedAt: '2026-10-03T00:30:00Z' });
  assert.equal(SUM.buildSummaryPayload([postClose], { expected: ['ledger'], now: Date.parse('2026-10-03T00:31:00Z') }).session, '2026-10-02');
  // 06:41 UTC Saturday = 02:41 ET → still Friday.
  const sat = res('ledger', { startedAt: '2026-10-03T06:41:00Z', finishedAt: '2026-10-03T06:45:00Z' });
  const ps = SUM.buildSummaryPayload([sat], { expected: ['ledger'], now: Date.parse('2026-10-03T06:46:00Z') });
  assert.equal(ps.session, '2026-10-02'); assert.equal(ps.date, '2026-10-03');
  // The preflight's session (TARGET_SESSION) wins over the clock when the workflow passes it through.
  assert.equal(SUM.buildSummaryPayload([sat], { expected: ['ledger'], session: '2026-10-02', now: Date.parse('2026-10-03T06:46:00Z') }).session, '2026-10-02');
  // The server validator keys the night by that session, not by date.
  const CS = require('../lib/chain-summary');
  const v = CS.normalizeChainSummary({ ...p, partial: false }, { now: Date.parse('2026-10-02T06:21:00Z'), roots: ['ledger'] });
  assert.equal(v.error, null); assert.equal(v.value.session, '2026-10-01'); assert.equal(v.value.date, '2026-10-02');
});

test('main (runner): TARGET_SESSION from the preflight stamps the result; an invalid value falls back to the clock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  await RUN.main(['node', 'x', 'maturity'], { OUT_DIR: dir, CRON_SECRET: 's3cret', ALREADY_OK: 'maturity', TARGET_SESSION: '2026-10-01' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'maturity.json'), 'utf8')).session, '2026-10-01');
  await RUN.main(['node', 'x', 'maturity'], { OUT_DIR: dir, CRON_SECRET: 's3cret', ALREADY_OK: 'maturity', TARGET_SESSION: 'garbage' });
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'maturity.json'), 'utf8')).session, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(RUN.resolveSession({ TARGET_SESSION: '2026-10-01' }, () => Date.parse('2026-10-03T00:28:00Z')), '2026-10-01');
  assert.equal(RUN.resolveSession({}, () => Date.parse('2026-10-03T00:28:00Z')), '2026-10-02');
});

test('markPeerCrashes: failures of different chains within 5 s are one co-located crash; lone failures and ok chains are untouched', () => {
  const T = (s) => `2026-10-01T22:56:${s}Z`;
  const fails = (chain, ...ats) => res(chain, { ok: false, status: 'failed', failed: ['op=x'], attemptFailures: ats, failedAt: ats[ats.length - 1] });
  const marked = SUM.markPeerCrashes([fails('capture', T('28')), fails('universe', T('31')), fails('pulse', T('34')), fails('pattern', T('59')), res('ledger')]);
  const by = Object.fromEntries(marked.map((r) => [r.chain, r]));
  assert.equal(by.capture.crashedWithPeers, true); assert.deepEqual(by.capture.peers, ['universe'], '28 and 34 are 6 s apart — not direct peers');
  assert.deepEqual(by.universe.peers, ['capture', 'pulse'], 'universe is within 5 s of both');
  assert.deepEqual(by.pulse.peers, ['universe']);
  assert.equal('crashedWithPeers' in by.pattern, false, '26 s away is a separate failure');
  assert.equal('crashedWithPeers' in by.ledger, false);
  // The payload carries the label; the server validator keeps it; a lone failure has none.
  const p = SUM.buildSummaryPayload(marked, { expected: ['capture', 'universe', 'pulse', 'pattern', 'ledger'], now: NOW });
  assert.equal(p.chains.capture.crashedWithPeers, true); assert.deepEqual(p.chains.pulse.peers, ['universe']); assert.equal('crashedWithPeers' in p.chains.pattern, false);
  const CS = require('../lib/chain-summary');
  const v = CS.normalizeChainSummary({ ...p, partial: false }, { now: NOW, roots: ['capture', 'universe', 'pulse', 'pattern', 'ledger'] });
  assert.equal(v.value.chains.capture.crashedWithPeers, true); assert.deepEqual(v.value.chains.universe.peers, ['capture', 'pulse']); assert.equal('crashedWithPeers' in v.value.chains.pattern, false);
  assert.deepEqual(CS.chainsHealthView({ summaries: [{ ...v.value, date: '2026-10-01' }], roots: ['capture', 'universe', 'pulse', 'pattern', 'ledger'], now: NOW }).crashedWithPeers, ['capture', 'universe', 'pulse']);
  assert.match(SUM.stepSummaryMarkdown(p), /co-located crash[^\n]*capture, universe, pulse/);
  // Inputs are not mutated.
  assert.equal('crashedWithPeers' in fails('a', T('00')), false);
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
