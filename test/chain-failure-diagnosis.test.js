// A FAILED CRON STEP MUST SAY WHY (2026-08-17).
// That night's warm cron reported five separate HTTP 500s — patternlog, pulserefine,
// swingsearchgrade, universecompile and the whole capture chain — and op=health showed
// `error: null` for every one of them. The reason was already in the response body the
// chain runner had fetched; it was simply discarded. These tests pin it to the report.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runChain, CHAINS } = require('../lib/warm-chains');

// A `call` stub in the same shape lib/warm-chains-routes.js produces.
function stubCall(byOp) {
  return async (path) => {
    const m = /op=([^&]+)/.exec(path);
    const op = m ? m[1] : path;
    const r = byOp[op] || { ok: true, status: 200, body: { ok: true }, raw: null };
    return r;
  };
}
const clock = () => { let t = 0; return () => (t += 10); };

test('a failed step carries the op\'s own JSON error into failDetail', async () => {
  const failing = CHAINS.universe.find(s => s === 'op=universecompile');
  assert.ok(failing, 'op=universecompile is still part of the universe chain');
  const res = await runChain('universe', {
    now: clock(),
    call: stubCall({
      universecompile: { ok: false, status: 500, body: { ok: false, error: 'shard merge exceeded memory' }, raw: null },
    }),
  });
  const detail = res.failDetail.find(d => d.op === 'op=universecompile');
  assert.ok(detail, 'the failure is reported');
  assert.strictEqual(detail.status, 'http:500');
  assert.strictEqual(detail.error, 'shard merge exceeded memory', 'no longer null');
});

test('a non-JSON platform error still yields a usable snippet instead of null', async () => {
  const res = await runChain('pattern', {
    now: clock(),
    call: stubCall({
      patternlog: { ok: false, status: 500, body: null, raw: '<!DOCTYPE html><h1>FUNCTION_INVOCATION_FAILED</h1>' },
    }),
  });
  const detail = res.failDetail.find(d => d.op === 'op=patternlog');
  assert.ok(detail.error && detail.error.includes('FUNCTION_INVOCATION_FAILED'),
    `expected a readable snippet, got ${JSON.stringify(detail.error)}`);
});

test('a fail-closed 503 reports its refusal reason, not just the status', async () => {
  const res = await runChain('alphacal', {
    now: clock(),
    call: stubCall({
      calarchive: { ok: false, status: 503, body: { ok: false, error: 'calendar fetch failed (after retries) — no snapshot written' }, raw: null },
    }),
  });
  const detail = res.failDetail.find(d => d.op === 'op=calarchive');
  assert.strictEqual(detail.status, 'http:503');
  assert.match(detail.error, /calendar fetch failed/);
});

test('successful steps stay clean — no error field, no behaviour change', async () => {
  const res = await runChain('alphacal', { now: clock(), call: stubCall({}) });
  assert.deepStrictEqual(res.failed, []);
  assert.strictEqual(res.failDetail.length, 0);
  assert.strictEqual(res.complete, true);
});

test('a nested chain still propagates its children\'s detail, now with reasons', async () => {
  // ledger → @decision → ... : the child body carries failDetail up, name-prefixed.
  const res = await runChain('ledger', {
    now: clock(),
    call: async (path) => {
      if (path.includes('op=warmchain')) {
        return { ok: true, status: 200, raw: null, body: {
          complete: false, failed: ['op=redundancy&force=1'], skipped: [],
          failDetail: [{ op: 'op=redundancy&force=1', status: 'http:500', ms: 12, error: 'candle refetch failed' }],
        } };
      }
      return { ok: true, status: 200, body: { ok: true }, raw: null };
    },
  });
  const detail = res.failDetail.find(d => d.op === 'decision/op=redundancy&force=1');
  assert.ok(detail, 'nested failure is attributed to the named child step');
  assert.strictEqual(detail.error, 'candle refetch failed');
});
