'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRun } = require('../lib/health');

test('summarizeRun: all-ok run', () => {
  const r = summarizeRun({ ok: true, host: 'h', at: '2026-06-24T00:00:00Z', warmed: [{ p: '/a', status: 200 }],
    track: { ok: true }, crowdtick: { ok: true }, brieftick: { ok: true } });
  assert.equal(r.ok, true);
  assert.equal(r.failCount, 0);
  assert.equal(r.stageCount, 3);
  assert.deepEqual(r.failed, []);
});

test('summarizeRun: captures a failed tick', () => {
  const r = summarizeRun({ ok: true, at: 'x', track: { ok: true }, crowdtick: { error: 'Blob storage not configured' }, brieftick: { ok: false } });
  assert.equal(r.ok, false);
  assert.equal(r.failCount, 2);
  assert.ok(r.failed.includes('crowdtick'));
  assert.ok(r.failed.includes('brieftick'));
  assert.equal(r.stages.crowdtick.error, 'Blob storage not configured');
});

test('summarizeRun: captures cache-warm HTTP failures', () => {
  const r = summarizeRun({ ok: true, at: 'x', warmed: [{ p: '/ok', status: 200 }, { p: '/bad', status: 500 }, { p: '/err', error: 'timeout' }] });
  assert.equal(r.warmFails.length, 2);
  assert.equal(r.warmFails[0].path, '/bad');
  assert.equal(r.failCount, 2);
  assert.equal(r.ok, false);
});

test('summarizeRun: ignores non-stage keys', () => {
  const r = summarizeRun({ ok: true, host: 'h', at: 'x', warmed: [], warmedExtra: [], track: { ok: true },
    stageStatus: { track: 'ok' }, elapsedMs: 1234, aiTicksKicked: 6, calibKicked: true });
  assert.equal(r.stageCount, 1);   // only "track" — stageStatus/elapsedMs/etc not graded
});

test('summarizeRun: a budget-deferred stage is visible but does NOT fail health', () => {
  const r = summarizeRun({ ok: true, at: 'x',
    track: { ok: true },
    apexlog: { ok: true, skipped: 'market-closed' },  // legitimate skip → healthy
    tonetick: { skipped: 'budget' },                  // deferred → tracked, not failed
    elapsedMs: 58000 });
  assert.equal(r.ok, true);                            // deferrals alone keep health green
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.budgetSkipped, ['tonetick']);    // but the deferral is visible
  assert.equal(r.elapsedMs, 58000);
});

test('summarizeRun: a real error still fails health even alongside a deferral', () => {
  const r = summarizeRun({ ok: true, at: 'x',
    track: { error: 'boom' },
    tonetick: { skipped: 'budget' } });
  assert.equal(r.ok, false);
  assert.ok(r.failed.includes('track'));
  assert.deepEqual(r.budgetSkipped, ['tonetick']);
});

test('summarizeRun: a degraded-but-ok ledger skip stays healthy', () => {
  const r = summarizeRun({ ok: true, at: 'x', track: { ok: true, skipped: 'degraded-empty', degraded: true } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
});
