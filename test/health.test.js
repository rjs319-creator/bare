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

// ── warmchain dispatch reporting ────────────────────────────────────────────
// Ordered cron work moved into its own invocations (lib/warm-chains.js). A chain that
// hasn't reported by warm's ceiling is STILL RUNNING, not failed — the previous model
// ("skipped:budget → deferred → ok:true, self-heals next run") reported healthy while
// 7 stages never ran on ANY run, which is how this stayed invisible for weeks.
const { summarizeRun: sr } = require('../lib/health');

test('a chain still running past warm is healthy, not a failure', () => {
  const r = sr({
    ok: true, at: '2026-07-17T13:00:00Z', elapsedMs: 30000,
    chains: { ledger: { dispatched: true, status: 200 }, capture: { dispatched: true, status: 'running-past-warm' } },
    chainsDispatched: 2,
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.chainDispatchFails, []);
  assert.strictEqual(r.chains.capture.status, 'running-past-warm');
});

test('a chain whose DISPATCH failed is a real failure', () => {
  const r = sr({
    ok: true, at: 'x', chains: { ledger: { dispatched: true, reportError: 'ECONNRESET' } }, chainsDispatched: 1,
  });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.chainDispatchFails, ['ledger']);
  assert.strictEqual(r.failCount, 1);
});

test('an HTTP-error chain dispatch is a failure', () => {
  const r = sr({ ok: true, at: 'x', chains: { capture: { dispatched: true, status: 500 } } });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.chainDispatchFails, ['capture']);
});

test('the chains block is never graded as a stage', () => {
  const r = sr({ ok: true, at: 'x', chains: { a: { dispatched: true, status: 200 } }, chainRoots: ['a'], chainsDispatched: 1 });
  assert.ok(!('chains' in r.stages), 'chains must not appear as a stage');
  assert.ok(!('chainRoots' in r.stages));
  assert.strictEqual(r.stageCount, 0);
});

// ── finding #1: a warmchain returns 200 even when its STEPS failed ──────────
test('a chain reporting FAILED STEPS in its body is a failure despite HTTP 200', () => {
  const r = sr({
    ok: true, at: 'x',
    chains: { decision: { dispatched: true, httpStatus: 200, complete: true, stepFails: ['op=redundancy&force=1'], skipped: [] } },
    chainsDispatched: 1,
  });
  assert.strictEqual(r.ok, false, 'failed steps must fail health even though the dispatch was 200');
  assert.deepStrictEqual(r.chainDispatchFails, ['decision']);
});

test('a chain that budget-skipped steps is surfaced but does not fail the single run', () => {
  const r = sr({
    ok: true, at: 'x',
    chains: { capture: { dispatched: true, httpStatus: 200, complete: false, stepFails: [], skipped: ['op=fadetick'] } },
  });
  assert.strictEqual(r.ok, true, 'a one-off skip self-heals — not a per-run failure');
  assert.deepStrictEqual(r.chainSkips, [{ chain: 'capture', skipped: ['op=fadetick'] }]);
});

test('a healthy completed chain (no fails, no skips) stays green', () => {
  const r = sr({ ok: true, at: 'x', chains: { ledger: { dispatched: true, httpStatus: 200, complete: true, stepFails: [], skipped: [] } } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.chainDispatchFails, []);
  assert.deepStrictEqual(r.chainSkips, []);
});

// ── finding #2: chronic deferral must actually be detected (the premise was never checked) ──
const { detectChronicSkips } = require('../lib/health');

test('a one-off skip is NOT chronic (it self-heals)', () => {
  const runs = [
    { chainSkips: [{ chain: 'capture', skipped: ['op=fadetick'] }] },
    { chainSkips: [] }, { chainSkips: [] }, { chainSkips: [] },
  ];
  assert.deepStrictEqual(detectChronicSkips(runs).chronicSkips, []);
});

test('the SAME chain skipped on 3+ of the last 4 runs is chronic — the bug that hid for weeks', () => {
  const runs = [
    { chainSkips: [{ chain: 'capture', skipped: ['op=archive'] }] },
    { chainSkips: [{ chain: 'capture', skipped: ['op=archive'] }] },
    { chainSkips: [{ chain: 'capture', skipped: ['op=archive'] }] },
    { chainSkips: [] },
  ];
  const c = detectChronicSkips(runs).chronicSkips;
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].name, 'capture');
  assert.strictEqual(c[0].runs, 3);
});

test('legacy top-level budgetSkipped also feeds the chronic detector', () => {
  const runs = Array(3).fill({ budgetSkipped: ['tonetick'] });
  assert.strictEqual(detectChronicSkips(runs).chronicSkips[0].name, 'tonetick');
});

test('empty / malformed history never throws', () => {
  assert.deepStrictEqual(detectChronicSkips(null).chronicSkips, []);
  assert.deepStrictEqual(detectChronicSkips([]).chronicSkips, []);
  assert.deepStrictEqual(detectChronicSkips([null, {}]).chronicSkips, []);
});
