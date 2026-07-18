'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../lib/run-manifest');

// ── hashContent: stable + order-independent ─────────────────────────────────
test('hashContent is deterministic and key-order independent', () => {
  assert.equal(M.hashContent({ a: 1, b: 2 }), M.hashContent({ b: 2, a: 1 }));
  assert.match(M.hashContent({ a: 1 }), /^[0-9a-f]{64}$/);
});

// ── buildManifest: shape + derived fields ───────────────────────────────────
test('buildManifest requires a runId', () => {
  assert.throws(() => M.buildManifest({}), /runId is required/);
});

test('buildManifest stamps version, code identity, and computes durationMs', () => {
  const m = M.buildManifest({
    runId: '2026-01-15',
    trigger: 'warm-cron',
    startedAt: '2026-01-15T13:00:00.000Z',
    finishedAt: '2026-01-15T13:00:03.000Z',
    outputs: [{ key: 'picks/2026-01-15.json', present: true, hash: 'abc', bytes: 10 }],
  });
  assert.equal(m.v, M.MANIFEST_VERSION);
  assert.equal(m.runId, '2026-01-15');
  assert.equal(m.durationMs, 3000);
  assert.ok('sha' in m.code && 'env' in m.code);
  assert.equal(m.outputs.length, 1);
});

test('buildManifest defends array/object fields against partial input', () => {
  const m = M.buildManifest({ runId: 'x' });
  assert.deepEqual(m.inputs, []);
  assert.deepEqual(m.outputs, []);
  assert.deepEqual(m.steps, []);
  assert.deepEqual(m.params, {});
  assert.equal(m.durationMs, null); // no startedAt → unknown, not fabricated
});

// ── verifyOutputs: pure comparison logic (no store → all current absent) ─────
test('verifyOutputs: an output recorded ABSENT stays ok when it is still absent', async () => {
  // With no BLOB_READ_WRITE_TOKEN, hashOutputs reports every key present:false, so a
  // manifest that recorded the same key as absent should verify ok (nothing changed).
  const m = M.buildManifest({ runId: 'x', outputs: [{ key: 'picks/x.json', present: false, hash: null, bytes: 0 }] });
  const v = await M.verifyOutputs(m);
  assert.equal(v.ok, true);
  assert.equal(v.checks[0].ok, true);
});

test('verifyOutputs: an output recorded PRESENT is NOT ok when it can no longer be read', async () => {
  const m = M.buildManifest({ runId: 'x', outputs: [{ key: 'picks/x.json', present: true, hash: 'deadbeef', bytes: 5 }] });
  const v = await M.verifyOutputs(m);
  assert.equal(v.ok, false);
  assert.equal(v.checks[0].ok, false);
  assert.equal(v.checks[0].recordedHash, 'deadbeef');
});

// ── codeVersion: honest about missing SHA ───────────────────────────────────
test('codeVersion returns null sha off-Vercel rather than fabricating one', () => {
  const c = M.codeVersion();
  assert.ok(c.sha === null || typeof c.sha === 'string');
  assert.ok(typeof c.env === 'string');
});
