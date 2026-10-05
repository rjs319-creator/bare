'use strict';
// op=health `chains` block — the dead-man read side. The nightly chains now report via a
// posted per-night summary (chains/<date>.json, op=chainsummary); health surfaces it as a
// compact { date, ok, failed, source } block, folds its failures into `problems` (so the
// existing banner path renders the names), and trips when NO summary exists while the
// in-process dispatcher is switched off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthResponse, summarizeRun } = require('../lib/health');
const WC = require('../lib/warm-chains');

const AUTH = { ok: true, production: true, secretConfigured: true, warnings: [] };
const FRESH = { now: Date.parse('2026-10-02T23:00:00Z'), spyDate: '2026-10-02', spyDates: ['2026-09-30', '2026-10-01', '2026-10-02'], ageDays: 0.2, auth: AUTH };
const cleanRun = { at: '2026-10-02T22:04:00Z', ok: true, failed: [], warmFails: [], budgetSkipped: [], chainDispatchFails: [], chainSkips: [], chains: { ledger: { dispatched: true, complete: true } } };
const okAll = () => Object.fromEntries(WC.ROOT_CHAINS.map((c) => [c, { ok: true, failed: [], skipped: [] }]));
const summary = (over = {}) => ({ date: '2026-10-02', source: 'github-matrix', runId: '7', runUrl: 'https://github.com/o/r/actions/runs/7', finishedAt: '2026-10-02T22:41:00Z',
  ok: false, failed: ['capture', 'challenger'], chains: { ...okAll(), capture: { ok: false, failed: ['op=archive'], skipped: [] }, challenger: { ok: false, failed: ['op=challengerlog'], skipped: [] } }, ...over });

test('health: a posted GitHub summary with failures → chains block, problems, healthy:false', () => {
  const r = buildHealthResponse([cleanRun], { ...FRESH, chainSummary: summary({ partial: false }) });
  assert.deepEqual(r.chains, { session: '2026-10-02', date: '2026-10-02', ok: false, full: true, partial: false, covered: WC.ROOT_CHAINS, failed: ['capture', 'challenger'], skipped: [], crashedWithPeers: [], source: 'github-matrix',
    runUrl: 'https://github.com/o/r/actions/runs/7', at: '2026-10-02T22:41:00Z', missing: false, noMatrixRun: null });
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes('chain:capture') && r.problems.includes('chain:challenger'));
  // The severity split still applies: challenger is a verified shadow chain.
  assert.deepEqual(r.problemsBySeverity.data, ['chain:capture']);
  assert.deepEqual(r.problemsBySeverity.background, ['chain:challenger']);
});

test('health: a clean GitHub summary keeps healthy:true and adds no problems', () => {
  const r = buildHealthResponse([cleanRun], { ...FRESH, chainSummary: summary({ partial: false, ok: true, failed: [], chains: okAll() }) });
  assert.equal(r.chains.ok, true); assert.equal(r.healthy, true); assert.deepEqual(r.problems, []);
});

// ── the dead-man that a partial run cannot satisfy (2026-10-02) ───────────────────────
const handedOff = { ...cleanRun, at: '2026-10-02T22:00:40Z', chainsInProcess: false, chains: {} };
const partialMorning = summary({ source: 'manual', partial: true, ok: true, failed: [], runUrl: 'https://github.com/o/r/actions/runs/6', finishedAt: '2026-10-02T13:30:00Z',
  chains: { delisting: { ok: true, failed: [], skipped: [] }, maturity: { ok: true, failed: [], skipped: [] } } });
const GRACE = require('../lib/chain-summary').NO_MATRIX_RUN_GRACE_MS;

test('health: a partial (only=) summary alone is not a covered night — ok:false, partial:true, but no problem before the grace', () => {
  const r = buildHealthResponse([handedOff], { ...FRESH, now: Date.parse('2026-10-02T22:30:00Z'), chainSummaries: [partialMorning], inProcessChains: false });
  assert.equal(r.chains.ok, false); assert.equal(r.chains.partial, true); assert.equal(r.chains.full, false);
  assert.deepEqual(r.chains.covered, ['delisting', 'maturity']); assert.deepEqual(r.chains.failed, []);
  assert.equal(r.chains.noMatrixRun, null);
  assert.deepEqual(r.problems, []); assert.equal(r.healthy, true, 'inside the grace window the night is simply pending');
});

test('health: 90 min after a handed-off warm with only a partial summary → chains:no-matrix-run, healthy:false, plain warning', () => {
  const now = Date.parse(handedOff.at) + GRACE;
  const r = buildHealthResponse([handedOff], { ...FRESH, now, chainSummaries: [partialMorning], inProcessChains: false });
  assert.ok(r.problems.includes('chains:no-matrix-run'));
  assert.equal(r.healthy, false);
  assert.deepEqual(r.chains.noMatrixRun, { session: '2026-10-02', warmAt: handedOff.at, graceMs: GRACE });
  assert.match(r.warning, /background refresh for 2026-10-02 has not run/i);
  assert.ok(r.problemsBySeverity.data.includes('chains:no-matrix-run'), 'a missing night is user-facing, never background');
});

test('health: the full run arriving clears no-matrix-run; a full run missing a root lists that root as failed', () => {
  const now = Date.parse(handedOff.at) + 2 * GRACE;
  const full = summary({ partial: false, ok: true, failed: [], chains: okAll() });
  const r = buildHealthResponse([handedOff], { ...FRESH, now, chainSummaries: [full, partialMorning], inProcessChains: false });
  assert.equal(r.chains.noMatrixRun, null); assert.equal(r.chains.ok, true); assert.equal(r.healthy, true);
  const { [WC.ROOT_CHAINS[1]]: dropped, ...fewer } = full.chains;
  const r2 = buildHealthResponse([handedOff], { ...FRESH, now, chainSummaries: [{ ...full, chains: fewer }], inProcessChains: false });
  assert.equal(r2.chains.noMatrixRun, null, 'the night ran');
  assert.deepEqual(r2.chains.failed, [WC.ROOT_CHAINS[1]]); assert.ok(r2.problems.includes(`chain:${WC.ROOT_CHAINS[1]}`)); assert.equal(r2.healthy, false);
});

test('health: no summary at all + handed-off warm past the grace → both dead-man problems', () => {
  const now = Date.parse(handedOff.at) + GRACE;
  const r = buildHealthResponse([handedOff], { ...FRESH, now, chainSummaries: [], inProcessChains: false });
  assert.ok(r.problems.includes('chains:no-summary')); assert.ok(r.problems.includes('chains:no-matrix-run'));
  assert.equal(r.healthy, false);
});

test('health: no summary + in-process ON → the block is derived from the run record (source in-process)', () => {
  const run = { ...cleanRun, ok: false, chainDispatchFails: ['atlasx'], chains: { atlasx: { dispatched: true, httpStatus: 500 } } };
  const r = buildHealthResponse([run], { ...FRESH, chainSummary: null, inProcessChains: true });
  assert.equal(r.chains.source, 'in-process'); assert.deepEqual(r.chains.failed, ['atlasx']); assert.equal(r.chains.date, '2026-10-02'); assert.equal(r.chains.session, '2026-10-02');
  assert.deepEqual(r.problems, ['chain:atlasx']);
});

test('health: no summary + in-process OFF → dead-man tripped (missing:true, healthy:false, named problem)', () => {
  const r = buildHealthResponse([cleanRun], { ...FRESH, chainSummary: null, inProcessChains: false });
  assert.equal(r.chains.source, 'none'); assert.equal(r.chains.missing, true);
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes('chains:no-summary'));
  assert.match(r.warning, /no nightly chain summary/i);
});

test('health: summary failures are not double-counted when the run record names the same chain', () => {
  const run = { ...cleanRun, ok: false, chainDispatchFails: ['capture'] };
  const r = buildHealthResponse([run], { ...FRESH, chainSummary: summary() });
  assert.equal(r.problems.filter((p) => p === 'chain:capture').length, 1);
});

test('summarizeRun: a warm run with in-process chains disabled records that, and grades no chain', () => {
  const r = summarizeRun({ ok: true, at: '2026-10-02T22:00:30Z', warmed: [{ p: '/a', status: 200 }], chains: {}, chainsDispatched: 0, chainsInProcess: false, chainRoots: WC.ROOT_CHAINS });
  assert.equal(r.ok, true); assert.equal(r.stageCount, 0); assert.deepEqual(r.chainDispatchFails, []);
  assert.equal(r.chainsInProcess, false);
});

test('warm-chains: inProcessChainsEnabled reads WARM_CHAINS_INPROCESS (default ON; 0/false/off disable)', () => {
  assert.equal(WC.inProcessChainsEnabled({}), true);
  assert.equal(WC.inProcessChainsEnabled({ WARM_CHAINS_INPROCESS: '1' }), true);
  assert.equal(WC.inProcessChainsEnabled({ WARM_CHAINS_INPROCESS: 'yes' }), true);
  for (const v of ['0', 'false', 'off', 'FALSE', ' Off ']) assert.equal(WC.inProcessChainsEnabled({ WARM_CHAINS_INPROCESS: v }), false, v);
});

// ── TARGET SESSION (2026-10-02/03): a pre-market record is the PREVIOUS night ─────────────
test('health: THE 10-02 SEQUENCE — the 02:14 ET full record (session 10-02) does not cover Friday; the 20:28 ET run does', () => {
  const warmFri = { ...handedOff, at: '2026-10-02T22:00:40Z' };  // 18:00 ET Friday, after the close → target session 2026-10-02
  const premarket = summary({ partial: false, ok: true, failed: [], chains: okAll(), session: '2026-10-01', date: '2026-10-02', startedAt: '2026-10-02T06:14:00Z', finishedAt: '2026-10-02T07:10:00Z' });
  const fresh = { ...FRESH, spyDate: '2026-10-02', spyDates: ['2026-09-30', '2026-10-01', '2026-10-02'] };
  const now = Date.parse(warmFri.at) + GRACE;
  const r = buildHealthResponse([warmFri], { ...fresh, now, chainSummaries: [premarket], inProcessChains: false });
  assert.equal(r.chains.session, '2026-10-01', 'the newest record is Thursday\'s night, whatever its calendar date says');
  assert.equal(r.chains.date, '2026-10-02');
  assert.deepEqual(r.chains.noMatrixRun, { session: '2026-10-02', warmAt: warmFri.at, graceMs: GRACE });
  assert.ok(r.problems.includes('chains:no-matrix-run')); assert.equal(r.healthy, false);
  assert.match(r.warning, /background refresh for 2026-10-02 has not run/i);
  const friday = summary({ partial: false, ok: true, failed: [], chains: okAll(), session: '2026-10-02', date: '2026-10-02', finishedAt: '2026-10-03T01:10:00Z' });
  const r2 = buildHealthResponse([warmFri], { ...fresh, now: Date.parse('2026-10-03T06:41:00Z'), chainSummaries: [friday, premarket], inProcessChains: false });
  assert.equal(r2.chains.session, '2026-10-02'); assert.equal(r2.chains.noMatrixRun, null); assert.equal(r2.chains.ok, true); assert.equal(r2.healthy, true);
});

test('health: a weekend warm targets Friday, which Friday\'s full record covers — a repeat full run is a no-op that still reads covered', () => {
  const warmSat = { ...handedOff, at: '2026-10-03T22:00:40Z' };
  const friday = summary({ partial: false, ok: true, failed: [], chains: okAll(), session: '2026-10-02', date: '2026-10-02', finishedAt: '2026-10-03T01:10:00Z' });
  const fresh = { ...FRESH, spyDate: '2026-10-02', spyDates: ['2026-09-30', '2026-10-01', '2026-10-02'], now: Date.parse(warmSat.at) + 2 * GRACE };
  const r = buildHealthResponse([warmSat], { ...fresh, chainSummaries: [friday], inProcessChains: false });
  assert.equal(r.chains.noMatrixRun, null); assert.equal(r.chains.ok, true); assert.deepEqual(r.problems, []); assert.equal(r.healthy, true);
  // A legacy doc (date only, no session) for Friday covers it the same way.
  const { session: _s, ...legacy } = friday;
  assert.equal(buildHealthResponse([warmSat], { ...fresh, chainSummaries: [legacy], inProcessChains: false }).chains.noMatrixRun, null);
});

// ── source pins (the client/warm wiring the pure tests cannot see) ──────────
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('app.js banner: reads d.chains — shows the night + run link for the GitHub matrix and warns on a tripped dead-man', () => {
  const app = read('public/js/app.js');
  const health = app.slice(app.indexOf('async function checkHealth()'), app.indexOf('checkHealth();'));
  assert.match(health, /const ch = d\.chains \|\| null;/);
  assert.match(health, /ch\.source === 'github-matrix'/);
  assert.match(health, /esc\(ch\.runUrl\)/, 'the run link is escaped before it is rendered');
  assert.match(health, /if \(ch && ch\.missing\)/);
  assert.match(health, /No nightly chain summary has been posted/);
  assert.match(health, /if \(ch && ch\.noMatrixRun\)/, 'the night-not-run dead-man has its own line');
  assert.match(health, /ch\.noMatrixRun\.session/, 'the night is named by its SESSION, not the wall-clock date');
  assert.match(health, /esc\(ch\.session \|\| ch\.date \|\| ''\)/, 'the provenance line names the session');
  assert.match(health, /ch\.crashedWithPeers/, 'co-located crashes are labelled as one event');
  assert.match(health, /esc\(ch\.crashedWithPeers\.join/, 'chain names are escaped before rendering');
  assert.match(health, /background refresh has not run yet/i, 'said plainly');
});

test('warm.js: in-process chain dispatch is gated by inProcessChainsEnabled and recorded as chainsInProcess', () => {
  const warm = read('api/warm.js');
  assert.match(warm, /const chainsInProcess = WC\.inProcessChainsEnabled\(\);/);
  assert.match(warm, /\(chainsInProcess \? WC\.ROOT_CHAINS : \[\]\)\.map\(/);
  assert.match(warm, /chainsInProcess,\n/, 'the flag reaches the health record');
  // The deferred kicks must be drained explicitly now that the chain drain can be empty.
  assert.match(warm, /Promise\.allSettled\(\[\.\.\.aiTicks, optionsAssessKick, putsellKick, optionsEpisodesKick, calibKick, researchKick, biotechGradeKick\]\)/);
});

test('tracker: op=chainsummary is privileged and routed', () => {
  const tracker = read('api/tracker.js');
  const priv = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'chainsummary'/);
  assert.match(tracker, /op === 'chainsummary'\) return require\('\.\.\/lib\/chain-summary-routes'\)\.runChainSummary/);
});
