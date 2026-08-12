'use strict';
// UNAUTHENTICATED WRITE LEVERS (alpha-research pass 3).
//
// `?log=1` is this codebase's universal "persist this" convention. Several of its
// targets are WRITE-ONCE — today/parity/<date>.json, the research decision snapshot,
// the hash-chained swing ledger — so the FIRST caller of the day becomes the immutable
// record of decision and the cron's real board is later rejected as `already-recorded`.
//
// Before this fix `stripForceParams` removed only force/refresh/reset, and it ran ONLY
// for ops in SHARED_FORCE_OPS. `today`, `swingmonitor`, `rlt` and `omegafunnel` were in
// no policy set at all, so nothing was stripped from them; `atlasx` was in
// SHARED_FORCE_OPS but `log` was not in the stripped list. Both halves are tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripForceParams, stripWriteParams } = require('../lib/auth');

const TRACKER = fs.readFileSync(path.join(__dirname, '..', 'api', 'tracker.js'), 'utf8');

// isTrusted() reads the bearer against CRON_SECRET. Run each case under a known secret
// so "trusted" and "untrusted" are both genuinely exercised rather than fail-open.
function withSecret(secret, fn) {
  const prev = process.env.CRON_SECRET;
  const prevEnv = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = secret;
  process.env.VERCEL_ENV = 'production';
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    if (prevEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prevEnv;
  }
}

const anonReq = (query) => ({ query: { ...query }, headers: {} });
const cronReq = (query, secret) => ({ query: { ...query }, headers: { authorization: 'Bearer ' + secret } });

test('an anonymous caller loses the log= persistence lever', () => {
  withSecret('s3cret-value', () => {
    const req = anonReq({ op: 'today', log: '1' });
    stripWriteParams(req);
    assert.equal(req.query.log, undefined, 'log must not survive on an untrusted request');
    assert.equal(req.query.op, 'today', 'the op itself is untouched — the read still works');
  });
});

test('cron keeps the log= lever — the nightly chain must still write', () => {
  withSecret('s3cret-value', () => {
    const req = cronReq({ op: 'today', log: '1' }, 's3cret-value');
    stripWriteParams(req);
    assert.equal(req.query.log, '1', 'a trusted caller retains its persistence lever');
  });
});

test('a wrong bearer is not trusted', () => {
  withSecret('s3cret-value', () => {
    const req = cronReq({ op: 'swingmonitor', log: '1' }, 'not-the-secret');
    stripWriteParams(req);
    assert.equal(req.query.log, undefined);
  });
});

test('stripForceParams also removes the write lever — SHARED_FORCE_OPS ops were exposed too', () => {
  withSecret('s3cret-value', () => {
    // atlasx IS in SHARED_FORCE_OPS, so stripForceParams was the only thing running for
    // it — and it did not strip `log`. Persisting a board is not a "force" concern.
    const req = anonReq({ op: 'atlasx', log: '1', force: '1' });
    stripForceParams(req);
    assert.equal(req.query.log, undefined, 'log is stripped alongside force');
    assert.equal(req.query.force, undefined);
  });
});

test('the dispatcher strips write params on every non-privileged path, not just SHARED_FORCE_OPS', () => {
  // The regression this guards: `today`/`swingmonitor`/`rlt`/`omegafunnel` are in NO
  // policy set. An `else if` chain that ends at SHARED_FORCE_OPS leaves them unstripped.
  // Requiring a terminal `else` keeps a future op covered on the day it ships.
  assert.match(
    TRACKER,
    /else if \(SHARED_FORCE_OPS\.has\(op\)\) \{ stripForceParams\(req\); \}[\s\S]{0,900}?else stripWriteParams\(req\);/,
    'the auth gate must end in an unconditional stripWriteParams for untrusted callers',
  );
});

test('writers that mutate durable state or spend metered budget are privileged', () => {
  // universecurate read-modify-writes the curation `skip` list (removing tickers from
  // the universe every scan draws from) and runs an LLM over up to 150 names.
  // researchgrade and swinggrade write outcome ledgers.
  const privileged = TRACKER.slice(TRACKER.indexOf('const PRIVILEGED_OPS'), TRACKER.indexOf('const EXPENSIVE_OPS'));
  for (const op of ['universecurate', 'researchgrade', 'swinggrade']) {
    assert.ok(privileged.includes(`'${op}'`), `${op} writes durable state and must require the bearer`);
  }
});

test('op=maturity gates the capital-control WRITE, not the public read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maturity-routes.js'), 'utf8');
  // The read must stay public — the evidence banner on ~35 tabs fetches this op, so
  // gating the whole op would blank the honesty layer across the app.
  const privileged = TRACKER.slice(TRACKER.indexOf('const PRIVILEGED_OPS'), TRACKER.indexOf('const EXPENSIVE_OPS'));
  assert.ok(!privileged.includes("'maturity'"), 'maturity must not become bearer-only; the UI reads it');
  assert.match(src, /const mayPersist = isTrusted\(req\)/, 'write authority is decided explicitly');
  assert.match(src, /if \(hasStore\(\) && mayPersist\) \{/, 'governance/latest.json write is gated');
  assert.match(src, /\(hasStore\(\) && mayPersist\)\s*\n?\s*\? await require\('\.\/governance-transitions'\)/,
    'the transition-ledger append is gated by the same authority as the write it records');
});
