'use strict';
// WHY THE 18 SOURCES CAME BACK NULL — the one fact the code was throwing away.
//
// The 2026-08-20 22:00 UTC run finally produced hard evidence, and it killed BOTH of my
// earlier hypotheses:
//
//   challenger.gather: present:0 total:18 empty:<all 18> barren:none perSource:{}
//   stepFailDetail:    http:503 in 2002ms
//
// Not barren (so not the cache-rebuild theory) and not a timeout (2s is far too fast for
// a 25s deadline). No 401/403/429 appears in the runtime logs for that window — only
// 200s, 304s, and challengerlog's own 503 — so the sibling requests appear to fail before
// they ever reach a function.
//
// `catch { return null }` discarded the reason every single time. Three hypotheses have
// now been wrong; this stops guessing and records what actually happened per source:
// the HTTP status when there was one, or the error name/message when the fetch never
// completed. Also records the resolved host, since a bad host would fail exactly like
// this and nothing currently proves which host was used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFetchJSON, sourceDiagnostics } = require('../lib/challenger-routes');

test('records the HTTP status when a source answers non-ok', async () => {
  // Arrange
  const reasons = {};
  const fetchJson = async () => ({ ok: false, status: 502, json: async () => ({}) });

  // Act
  const out = await makeFetchJSON('h', { fetchJson, reasons })('/api/tracker?op=coil');

  // Assert
  assert.equal(out, null);
  assert.equal(reasons['/api/tracker?op=coil'], 'http:502');
});

test('records the ERROR NAME when the fetch never completes — the observed case', async () => {
  const reasons = {};
  const fetchJson = async () => { const e = new TypeError('fetch failed'); throw e; };
  const out = await makeFetchJSON('h', { fetchJson, reasons })('/p');
  assert.equal(out, null);
  assert.match(reasons['/p'], /^TypeError/, 'a network-layer failure must name itself');
});

test('distinguishes an abort/timeout from a connection failure', async () => {
  const reasons = {};
  const fetchJson = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  await makeFetchJSON('h', { fetchJson, reasons })('/p');
  assert.match(reasons['/p'], /TimeoutError/);
});

test('records a body-parse failure separately from a transport failure', async () => {
  const reasons = {};
  const fetchJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  await makeFetchJSON('h', { fetchJson, reasons })('/p');
  assert.match(reasons['/p'], /SyntaxError/);
});

test('a successful source records no failure reason', async () => {
  const reasons = {};
  const fetchJson = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  const out = await makeFetchJSON('h', { fetchJson, reasons })('/p');
  assert.deepStrictEqual(out, { ok: 1 });
  assert.equal(reasons['/p'], undefined);
});

test('works with no reasons collector supplied (callers that do not want one)', async () => {
  const fetchJson = async () => { throw new Error('boom'); };
  const out = await makeFetchJSON('h', { fetchJson })('/p');
  assert.equal(out, null, 'must still degrade to a null source, never throw');
});

test('sourceDiagnostics carries the reasons and the resolved host through', () => {
  const diag = sourceDiagnostics({ coil: null, gapgo: null }, {
    host: 'market-news-app-chi.vercel.app',
    reasons: { '/api/tracker?op=coil': 'TypeError: fetch failed' },
  });
  assert.equal(diag.host, 'market-news-app-chi.vercel.app');
  assert.ok(JSON.stringify(diag.reasons).includes('TypeError'));
  assert.deepStrictEqual(diag.empty, ['coil', 'gapgo']);
});

test('sourceDiagnostics still works with no context — it runs on a failing path', () => {
  const diag = sourceDiagnostics({ coil: null });
  assert.equal(diag.host, null);
  assert.deepStrictEqual(diag.reasons, {});
  assert.deepStrictEqual(diag.empty, ['coil']);
});
