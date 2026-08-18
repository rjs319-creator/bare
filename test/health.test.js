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

// ── runHealth response assembly (guards the ReferenceError class) ───────────
// A prior edit shipped `recent.length` out of scope here — a 500 on prod that the pure
// helper tests could not catch because they never built the response. This exercises it.
const { buildHealthResponse } = require('../lib/health');

test('buildHealthResponse: assembles a healthy response from real-shaped runs', () => {
  const runs = [
    { at: '2026-07-17T13:00:00Z', ok: true, failCount: 0, chains: { ledger: { dispatched: true, httpStatus: 200 } } },
    { at: '2026-07-16T13:00:00Z', ok: true, failCount: 0 },
  ];
  const r = buildHealthResponse(runs, { spyDate: '2026-07-17', ageDays: 0.5, now: 0 });
  assert.strictEqual(r.healthy, true);
  assert.strictEqual(r.warning, null);
  assert.strictEqual(r.failStreak, 0);
  assert.strictEqual(r.recentRuns.length, 2);
});

test('buildHealthResponse: chronic skips flip healthy to false with a warning', () => {
  const runs = Array(4).fill(0).map(() => ({ at: 'x', ok: true, failCount: 0, chainSkips: [{ chain: 'capture', skipped: ['op=archive'] }] }));
  const r = buildHealthResponse(runs, { spyDate: '2026-07-17', ageDays: 0.5 });
  assert.strictEqual(r.healthy, false);
  assert.ok(/capture/.test(r.warning) && /not self-healing/.test(r.warning));
  assert.strictEqual(r.chronicSkips[0].name, 'capture');
});

test('buildHealthResponse: stale data flips healthy to false', () => {
  const r = buildHealthResponse([{ at: 'x', ok: true }], { spyDate: '2026-07-01', ageDays: 10 });
  assert.strictEqual(r.healthy, false);
  assert.strictEqual(r.data.stale, true);
});

test('buildHealthResponse: empty history never throws and is not healthy', () => {
  const r = buildHealthResponse([], {});
  assert.strictEqual(r.healthy, false);
  assert.strictEqual(r.lastRun, null);
  assert.deepStrictEqual(r.chronicSkips, []);
});

// ── Persisted chain-report overlay (2026-08-07) ─────────────────────────────
// Warm's drain only hears chains that report before its ceiling. On 2026-08-06 the
// `ledger` chain budget-skipped @decision AFTER warm's report window closed — the day's
// decision snapshot was silently lost while op=health read green — and four roots died
// at the function wall with no report at all. Each warmchain invocation now persists its
// own report (warm/chains/<name>.json); these tests pin the read-time overlay.
const { overlayPersistedChains } = require('../lib/health');

test('overlayPersistedChains: a fresh persisted report replaces running-past-warm with the real outcome', () => {
  const run = { at: '2026-08-06T22:01:06Z', ok: true, chains: {
    ledger: { dispatched: true, status: 'running-past-warm' },
    vrp: { dispatched: true, httpStatus: 200, complete: true, stepFails: [], skipped: [] },
  } };
  const persisted = { ledger: { name: 'ledger', at: '2026-08-06T22:02:30Z', complete: false, failed: [], skipped: ['op=runmanifest', '@decision'], failDetail: [], elapsedMs: 52478 } };
  const r = overlayPersistedChains(run, persisted);
  assert.notEqual(r, run, 'returns a new object (no mutation)');
  assert.equal(run.chains.ledger.status, 'running-past-warm', 'input untouched');
  assert.equal(r.chains.ledger.persistedReport, true);
  assert.equal(r.chains.ledger.complete, false);
  assert.deepEqual(r.chains.ledger.skipped, ['op=runmanifest', '@decision']);
  assert.equal(r.chains.vrp.complete, true, 'heard chains are untouched');
  assert.ok(!(r.lateChainFails || []).length, 'skips alone are not late FAILURES');
});

test('overlayPersistedChains: persisted step failures surface as lateChainFails', () => {
  const run = { at: '2026-08-06T22:01:06Z', chains: { alphacal: { dispatched: true, status: 'running-past-warm' } } };
  const persisted = { alphacal: { name: 'alphacal', at: '2026-08-06T22:03:00Z', complete: true, failed: ['op=revarchive'], skipped: [], failDetail: [{ op: 'op=revarchive', status: 'http:503' }], elapsedMs: 36022 } };
  const r = overlayPersistedChains(run, persisted);
  assert.deepEqual(r.lateChainFails, ['alphacal']);
  assert.deepEqual(r.chains.alphacal.stepFails, ['op=revarchive']);
});

test('overlayPersistedChains: a chain with NO fresh report is marked no-report and counted failed', () => {
  const run = { at: '2026-08-06T22:01:06Z', chains: {
    pattern: { dispatched: true, status: 'running-past-warm' },       // died at the wall — never persisted
    pulse: { dispatched: true, status: 'running-past-warm' },
  } };
  // pulse has only a STALE report from a previous night — must not masquerade as tonight's.
  const persisted = { pulse: { name: 'pulse', at: '2026-08-05T22:02:00Z', complete: true, failed: [], skipped: [] } };
  const r = overlayPersistedChains(run, persisted);
  assert.equal(r.chains.pattern.status, 'no-report');
  assert.equal(r.chains.pulse.status, 'no-report', 'stale report rejected');
  assert.deepEqual([...r.lateChainFails].sort(), ['pattern', 'pulse']);
});

test('overlayPersistedChains: null/absent inputs pass through unchanged', () => {
  assert.equal(overlayPersistedChains(null, {}), null);
  const run = { at: 'x', chains: { a: { dispatched: true, status: 'running-past-warm' } } };
  assert.equal(overlayPersistedChains(run, null), run);
});

test('buildHealthResponse: lateChainFails flip healthy false with a warning', () => {
  const runs = [{ at: '2026-08-06T22:01:06Z', ok: true, failCount: 0, chains: { pattern: { dispatched: true, status: 'running-past-warm' } } }];
  const r = buildHealthResponse(runs, { spyDate: '2026-08-06', ageDays: 0.5, persistedChains: {} });
  assert.strictEqual(r.healthy, false);
  assert.ok(/pattern/.test(r.warning));
});

test('compactChainReport: health-shaped, bounded, and pure', () => {
  const { compactChainReport } = require('../lib/warm-chains-routes');
  const result = { name: 'ledger', complete: false, failed: ['x'], skipped: ['y'], failDetail: Array(20).fill({ op: 'z' }), elapsedMs: 52478, steps: [{ op: 'op=track' }] };
  const rep = compactChainReport(result, '2026-08-06T22:02:30Z');
  assert.deepEqual(Object.keys(rep).sort(), ['at', 'complete', 'elapsedMs', 'failDetail', 'failed', 'name', 'skipped']);
  assert.equal(rep.failDetail.length, 12, 'detail bounded');
  assert.equal(rep.at, '2026-08-06T22:02:30Z');
  assert.equal(result.failDetail.length, 20, 'input not mutated');
});

// ── STALENESS IS MEASURED IN SESSIONS, NOT CALENDAR DAYS ────────────────────
// The old bound was raw calendar days despite its "excl. weekends" comment, so it
// false-alarmed after a long weekend and stayed quiet through a genuine missing bar.
const TUE_0922_ET = Date.parse('2026-08-18T13:22:00Z');

test('buildHealthResponse: a missing weekday session is stale and reported in sessions', () => {
  // Prod 2026-08-18: provider had no 2026-08-17 SPY bar.
  const r = buildHealthResponse([{ at: 'x', ok: true }], { spyDate: '2026-08-14', ageDays: 4.5, now: TUE_0922_ET });
  assert.strictEqual(r.data.sessionsBehind, 1);
  assert.strictEqual(r.data.calendarSession, '2026-08-17');
  assert.strictEqual(r.data.stale, true);
  assert.strictEqual(r.healthy, false, 'a session behind is not healthy');
});

test('buildHealthResponse: a benchmark at the last completed session is fresh', () => {
  const r = buildHealthResponse([{ at: 'x', ok: true }], { spyDate: '2026-08-17', ageDays: 1.5, now: TUE_0922_ET });
  assert.strictEqual(r.data.sessionsBehind, 0);
  assert.strictEqual(r.data.stale, false);
  assert.strictEqual(r.healthy, true);
});

test('buildHealthResponse: a long holiday weekend is NOT stale even past the calendar-day bound', () => {
  // Labor Day 2026-09-07 (Monday). Tuesday morning, the newest completed session is
  // still Friday 09-04 — 4.4 CALENDAR days old, but zero sessions behind.
  const tueAfterLaborDay = Date.parse('2026-09-08T13:22:00Z');
  const r = buildHealthResponse([{ at: 'x', ok: true }], { spyDate: '2026-09-04', ageDays: 4.4, now: tueAfterLaborDay });
  assert.strictEqual(r.data.calendarSession, '2026-09-04');
  assert.strictEqual(r.data.sessionsBehind, 0);
  assert.strictEqual(r.data.stale, false, 'the old calendar-day bound (>4) would have false-alarmed here');
  assert.strictEqual(r.healthy, true);
});
