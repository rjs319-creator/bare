'use strict';
// op=today source pulls (2026-09-09). MEASURED on prod, cache-busted: op=scoreboard 16.3s,
// op=daytrade 10.6s, op=gapgo 7.4s. The old 12s ceiling cut the scoreboard on every call,
// so Today ranked with no realized-record evidence. The rank now reads the PERSISTED
// summary first (the same record maturity/governance judge on), live only as fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/decision-routes');

const MEASURED_SLOWEST_MS = 16327;   // op=scoreboard, 2026-09-09 — re-measure before lowering

test('pull timeout clears the slowest measured dependency with headroom', () => {
  assert.ok(R.PULL_TIMEOUT_MS >= MEASURED_SLOWEST_MS * 1.5, `PULL_TIMEOUT_MS ${R.PULL_TIMEOUT_MS} must be ≥ 1.5× the slowest measured pull (${MEASURED_SLOWEST_MS}ms)`);
});

test('pull: honours the injected timeout and reports a value, never throws', async () => {
  const fetchImpl = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const r = await R.pull('/api/tracker?op=slow', { timeoutMs: 20, fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /abort/i);
  assert.equal(r.data, null);
});

test('pullScoreboard: persisted summary first — no live call when the doc is present', async () => {
  const doc = { generatedAt: '2026-09-09T13:03:15Z', evidenceKeyVersion: 'scoped-v1', groups: [{ section: 'screener', tier: 'Early', scope: 'large', horizons: {} }], sectionDecile: { screener: { verdict: 'noise' } }, negativeLanes: [] };
  let liveCalls = 0;
  const r = await R.pullScoreboard({ readJSON: async () => doc, pullLive: async () => { liveCalls++; return { ok: true, data: {} }; } });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'persisted-summary');
  assert.equal(r.path, R.SCOREBOARD_SUMMARY_PATH);
  assert.equal(r.data.sectionDecile.screener.verdict, 'noise');
  assert.equal(liveCalls, 0);
});

test('pullScoreboard: absent / empty / unreadable doc falls back to the live pull, labelled', async () => {
  for (const readJSON of [async () => null, async () => ({ groups: [] }), async () => { throw new Error('blob down'); }]) {
    const r = await R.pullScoreboard({ readJSON, pullLive: async () => ({ path: '/api/tracker?op=scoreboard', ok: true, status: 200, ms: 5, data: { groups: [{}] } }) });
    assert.equal(r.basis, 'live-fallback');
    assert.equal(r.ok, true);
  }
});
