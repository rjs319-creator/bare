'use strict';
// JOB GRADING + HEALTH (job-grading audit D6–D10, 2026-10-04). Reproduced before the fix with
// lib/health.js buildHealthResponse: a single warm run dated 34 days before `now`, with the
// SPY series unavailable, answered healthy:true (stale:false because sessionsBehind was null);
// the fire-and-forget kicks were never graded at all (dispatch ack == done). Injected clocks,
// mocked I/O, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/health');
const WARM = require('../api/warm');

const AUTH = { ok: true, production: true, secretConfigured: true, warnings: [] };
const NOW = Date.parse('2026-10-05T15:00:00Z');            // Monday 11:00 ET; the due session is Fri 10-02
const SPY_FRESH = { spyDate: '2026-10-02', spyDates: ['2026-09-30', '2026-10-01', '2026-10-02'], ageDays: 2.6 };
const cleanRun = (at) => ({ at, ok: true, failed: [], warmFails: [], budgetSkipped: [], chainDispatchFails: [], chainSkips: [], chainsInProcess: true,
  chains: { ledger: { dispatched: true, httpStatus: 200, complete: true, stepFails: [], skipped: [] } }, failCount: 0, stages: {} });
const build = (runs, over = {}) => H.buildHealthResponse(runs, { now: NOW, auth: AUTH, inProcessChains: true, ...over });

// ── D8: scheduler liveness — an old success cannot establish health ──────────────────
test('D8: a clean run from 34 days ago with fresh data is NOT healthy — warm:stale-run is named', () => {
  const r = build([cleanRun('2026-09-01T22:00:00Z')], SPY_FRESH);
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes(H.STALE_RUN_PROBLEM), JSON.stringify(r.problems));
  assert.equal(r.verdicts.scheduler, 'stale'); assert.equal(r.verdicts.inputs, 'current');
  assert.ok(r.scheduler.sessionsBehind >= H.RUN_STALE_SESSIONS); assert.equal(r.scheduler.dueSession, '2026-10-02');
  assert.match(r.warning, /has not run for \d+ sessions/);
  assert.ok(r.problemsBySeverity.data.includes(H.STALE_RUN_PROBLEM), 'a dead scheduler is a data problem, not background');
});

test('D8: last night\'s run is live (one session behind at most, before tonight\'s cron) — healthy with fresh data', () => {
  // Friday evening's run, checked Monday mid-morning: Friday is the due session → 0 behind.
  const fri = build([cleanRun('2026-10-02T22:00:00Z')], SPY_FRESH);
  assert.equal(fri.healthy, true); assert.equal(fri.verdicts.scheduler, 'ok'); assert.deepEqual(fri.problems, []);
  // Thursday's run checked Monday morning: Friday's cron never ran → 1 behind, still inside
  // the allowance (the cron fires after the due flip) — not yet stale.
  const thu = build([cleanRun('2026-10-01T22:00:00Z')], SPY_FRESH);
  assert.equal(thu.scheduler.sessionsBehind, 1); assert.equal(thu.scheduler.stale, false); assert.equal(thu.healthy, true);
  // Wednesday's run: two sessions (Thu, Fri) have come due since → stale.
  const wed = build([cleanRun('2026-09-30T22:00:00Z')], SPY_FRESH);
  assert.equal(wed.scheduler.sessionsBehind, 2); assert.equal(wed.scheduler.stale, true); assert.equal(wed.healthy, false);
});

test('D8: no run at all is `missing`, never healthy; a run with an unparseable timestamp is `unknown` (not stale by guess)', () => {
  const none = build([], SPY_FRESH);
  assert.equal(none.healthy, false); assert.equal(none.verdicts.scheduler, 'missing'); assert.equal(none.scheduler.lastRunAt, null);
  const odd = build([cleanRun('x')], SPY_FRESH);
  assert.equal(odd.verdicts.scheduler, 'unknown'); assert.equal(odd.scheduler.stale, false);
});

// ── D9: input quality — unknown data is never current ────────────────────────────────
test('D9: a fresh clean run with the SPY series UNAVAILABLE is not healthy — data:unknown is named, dataCurrent is null', () => {
  const r = build([cleanRun('2026-10-02T22:00:00Z')], { spyDate: null, spyDates: null, ageDays: null });
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes(H.DATA_UNKNOWN_PROBLEM));
  assert.equal(r.dataKnown, false); assert.equal(r.dataCurrent, null); assert.equal(r.data.known, false); assert.equal(r.data.current, null);
  assert.equal(r.data.stale, false, 'unknown is not the same as stale');
  assert.equal(r.verdicts.inputs, 'unknown');
  assert.match(r.warning, /could not be checked/);
});

test('D9 (the reproduction): the OLD-success + UNKNOWN-data combination that used to read healthy:true now names both problems', () => {
  const r = build([cleanRun('2026-09-01T22:00:00Z')], { spyDate: null, spyDates: null, ageDays: null });
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes(H.STALE_RUN_PROBLEM) && r.problems.includes(H.DATA_UNKNOWN_PROBLEM), JSON.stringify(r.problems));
});

// ── D10: dataCurrent is evidence, not reassurance ────────────────────────────────────
test('D10: dataCurrent is true only when the benchmark is observed AT the due session; false when behind; null when unknown', () => {
  assert.equal(build([cleanRun('2026-10-02T22:00:00Z')], SPY_FRESH).dataCurrent, true);
  const behind = build([cleanRun('2026-10-02T22:00:00Z')], { spyDate: '2026-10-01', spyDates: ['2026-09-30', '2026-10-01'], ageDays: 3.6 });
  assert.equal(behind.dataCurrent, false); assert.equal(behind.data.stale, true); assert.equal(behind.verdicts.inputs, 'stale'); assert.equal(behind.healthy, false);
  assert.equal(build([cleanRun('2026-10-02T22:00:00Z')], {}).dataCurrent, null);
});

test('D10: a background (optional analytics) failure with independently CURRENT data stays healthy, is named, and dataCurrent stays true', () => {
  const WC = require('../lib/warm-chains');
  const okAll = Object.fromEntries(WC.ROOT_CHAINS.map((c) => [c, { ok: true, complete: true, failed: [], skipped: [] }]));
  const summary = { session: '2026-10-02', date: '2026-10-02', source: 'github-matrix', partial: false, runId: '7', finishedAt: '2026-10-02T22:41:00Z',
    chains: { ...okAll, alphacal: { ok: false, status: 'app-failed', complete: true, failed: ['op=calarchive'], skipped: [], error: 'FMP_API_KEY required' } } };
  const r = build([{ ...cleanRun('2026-10-02T22:00:40Z'), chainsInProcess: false, chains: {} }], { ...SPY_FRESH, inProcessChains: false, chainSummaries: [summary] });
  assert.deepEqual(r.problemsBySeverity.background, ['chain:alphacal'], 'named, not hidden');
  assert.deepEqual(r.problemsBySeverity.data, []);
  assert.equal(r.dataCurrent, true); assert.equal(r.verdicts.analytics, 'degraded'); assert.equal(r.verdicts.inputs, 'current');
  // The EXISTING contract is kept: any failed chain still denies `healthy` (chainsOk) — the
  // split sizes the alarm; it does not loosen the verdict.
  assert.equal(r.healthy, false);
});

// ── D6/D7: kicks are graded on what they answered; a dispatch ack is not completed work ──
const kickResult = (op, over) => ({ p: `/api/tracker?op=${op}`, status: 200, ms: 5, appOk: true, benign: null, error: null, ...over });

test('D7: summarizeRun grades kicks — app failure on an OPEN session is a named `kick:<op>` problem that does NOT flip ok', () => {
  const run = H.summarizeRun({ ok: true, at: '2026-10-02T22:00:00Z', warmed: [], track: { ok: true },
    kicksSession: { date: '2026-10-02', closed: false },
    kicks: [kickResult('anomalytick', { appOk: false, error: 'no ANTHROPIC_API_KEY' }), kickResult('putsell'), kickResult('calibration', { status: 504, appOk: null, error: 'gateway timeout' })] });
  assert.equal(run.ok, true, 'optional analytics never flip the run verdict');
  assert.equal(run.failCount, 0);
  assert.deepEqual(run.kicks.failed.map((k) => [k.op, k.error]), [['anomalytick', 'no ANTHROPIC_API_KEY'], ['calibration', 'gateway timeout']]);
  assert.equal(run.kicks.ok, 1); assert.equal(run.kicks.total, 3);
  const problems = H.runProblems(run);
  assert.deepEqual(problems, ['kick:anomalytick', 'kick:calibration']);
  assert.deepEqual(H.classifyProblems(problems, { dataStale: false }), { data: [], background: ['kick:anomalytick', 'kick:calibration'] });
});

test('D7: an application no-op on a CLOSED session is deferred (named, not a problem); a benign marker is benign; no body is unknown; unsettled is running', () => {
  const run = H.summarizeRun({ ok: true, at: '2026-10-03T22:00:00Z', warmed: [],
    kicksSession: { date: '2026-10-03', closed: true },
    kicks: [
      kickResult('optionsassess', { appOk: false, error: 'No options-flow snapshot for today yet' }),
      kickResult('optionsepisodes', { appOk: false, benign: 'disabled', error: 'OPTIONS_V2_MODE=off' }),
      kickResult('research', { appOk: null, error: 'no parseable JSON body — outcome unknown' }),
      { p: '/api/tracker?op=biotechgrade', status: 'running-past-warm', appOk: null, benign: null, error: null },
      kickResult('readthroughtick', { status: 500, appOk: null, error: 'FUNCTION_INVOCATION_FAILED' }),
    ] });
  assert.deepEqual(run.kicks.deferred.map((k) => k.op), ['optionsassess']);
  assert.deepEqual(run.kicks.benign.map((k) => [k.op, k.reason]), [['optionsepisodes', 'disabled']]);
  assert.deepEqual(run.kicks.unknown.map((k) => k.op), ['research'], 'no body is never success');
  assert.deepEqual(run.kicks.running.map((k) => k.op), ['biotechgrade']);
  assert.deepEqual(run.kicks.failed.map((k) => k.op), ['readthroughtick'], 'a transport/HTTP failure is a failure on any session');
  assert.equal(run.kicks.ok, 0); assert.equal(run.kicks.closedSession, true);
  assert.deepEqual(H.runProblems(run), ['kick:readthroughtick']);
});

test('D7: a run without a kicks record (legacy) summarises to null and adds no problems', () => {
  const run = H.summarizeRun({ ok: true, at: 'x', track: { ok: true }, aiTicksKicked: 6 });
  assert.equal(run.kicks, null); assert.deepEqual(H.runProblems(run), []);
});

test('D7: kick problems are reported in op=health but never flip `healthy`; the kick record is on lastRun', () => {
  const run = H.summarizeRun({ ok: true, at: '2026-10-02T22:00:00Z', warmed: [], chains: { ledger: { dispatched: true, httpStatus: 200, complete: true, stepFails: [], skipped: [] } },
    kicksSession: { date: '2026-10-02', closed: false }, kicks: [kickResult('secondwavetick', { appOk: false, error: 'investigate failed' })] });
  const r = build([run], SPY_FRESH);
  assert.equal(r.healthy, true, 'optional analytics do not decide health');
  assert.deepEqual(r.problems, ['kick:secondwavetick']);
  assert.deepEqual(r.problemsBySeverity.background, ['kick:secondwavetick']); assert.equal(r.verdicts.analytics, 'degraded');
  assert.equal(r.lastRun.kicks.failed[0].op, 'secondwavetick');
});

test('D6/D7: api/warm kickOne grades transport AND application outcome from the body (injected fetch, no network)', async () => {
  const respond = (status, text) => async () => ({ ok: status < 400, status, text: async () => text });
  const appFail = await WARM.kickOne('/api/tracker?op=anomalytick', { fetchImpl: respond(200, JSON.stringify({ ok: false, error: 'no ANTHROPIC_API_KEY' })) });
  assert.equal(appFail.status, 200); assert.equal(appFail.appOk, false); assert.equal(appFail.error, 'no ANTHROPIC_API_KEY'); assert.equal(appFail.benign, null);
  const fine = await WARM.kickOne('/api/tracker?op=putsell', { fetchImpl: respond(200, JSON.stringify({ ok: true, items: 3 })) });
  assert.equal(fine.appOk, true); assert.equal(fine.error, null);
  const noBody = await WARM.kickOne('/api/tracker?op=research', { fetchImpl: respond(200, '<html>killed') });
  assert.equal(noBody.appOk, null, 'a dispatch acknowledgement with no readable outcome is not success'); assert.match(noBody.error, /unknown/);
  const http = await WARM.kickOne('/api/tracker?op=calibration&force=1', { fetchImpl: respond(504, 'gateway timeout') });
  assert.equal(http.status, 504); assert.equal(http.appOk, null); assert.match(http.error, /gateway timeout/);
  const benign = await WARM.kickOne('/api/tracker?op=optionsepisodes', { fetchImpl: respond(200, JSON.stringify({ ok: false, disabled: true })) });
  assert.equal(benign.appOk, false); assert.equal(benign.benign, 'disabled');
  const thrown = await WARM.kickOne('/api/tracker?op=x', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(thrown.status, null); assert.match(thrown.error, /ECONNRESET/);
});

test('D7: kickSink lists settled results as graded and unsettled kicks as running-past-warm', async () => {
  const sink = WARM.kickSink();
  let release;
  sink.track('/api/tracker?op=a', Promise.resolve({ p: '/api/tracker?op=a', status: 200, appOk: true }));
  sink.track('/api/tracker?op=b', new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  const list = sink.list();
  assert.equal(list[0].appOk, true); assert.equal(list[1].status, 'running-past-warm'); assert.equal(list[1].appOk, null);
  release({ p: '/api/tracker?op=b', status: 200, appOk: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(sink.list()[1].appOk, false);
});

test('api/warm source: every fire-and-forget kick is graded through the sink and the run record carries kicks + the session calendar', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/warm.js'), 'utf8');
  for (const op of ['readthroughtick', 'anomalytick', 'secondwavetick', 'crossassettick', 'toneshifttick', 'biotechtick']) assert.ok(src.includes(`'/api/tracker?op=${op}'`), op);
  assert.match(src, /\]\.map\(p => delayedWarmOne\(p, AI_TICKS_DELAY_MS, kicks\)\)/, 'AI ticks feed the sink');
  for (const kick of ['optionsassess', 'putsell', 'optionsepisodes&refresh=1', 'calibration&force=1', 'research&scope=large', 'biotechgrade']) {
    assert.match(src, new RegExp(`delayedWarmOne\\('/api/tracker\\?op=${kick.replace(/[?&=]/g, (m) => '\\' + m)}', SINGLE_KICKS_DELAY_MS, kicks\\)`), `${kick} feeds the sink`);
  }
  assert.match(src, /kicks: kicks\.list\(\), kicksSession/, 'the run record carries the graded kicks');
  assert.doesNotMatch(src, /aiTicks = \[[^\]]*\]\.map\(p => delayedWarmOne\(p, AI_TICKS_DELAY_MS\)\)/, 'no kick is left ungraded');
});
