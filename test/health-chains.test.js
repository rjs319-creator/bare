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
const summary = (over = {}) => ({ date: '2026-10-02', source: 'github-matrix', runId: '7', runUrl: 'https://github.com/o/r/actions/runs/7', finishedAt: '2026-10-02T22:41:00Z',
  ok: false, failed: ['capture', 'challenger'], chains: { ledger: { ok: true, failed: [], skipped: [] }, capture: { ok: false, failed: ['op=archive'], skipped: [] }, challenger: { ok: false, failed: ['op=challengerlog'], skipped: [] } }, ...over });

test('health: a posted GitHub summary with failures → chains block, problems, healthy:false', () => {
  const r = buildHealthResponse([cleanRun], { ...FRESH, chainSummary: summary() });
  assert.deepEqual(r.chains, { date: '2026-10-02', ok: false, failed: ['capture', 'challenger'], skipped: [], source: 'github-matrix',
    runUrl: 'https://github.com/o/r/actions/runs/7', at: '2026-10-02T22:41:00Z', missing: false });
  assert.equal(r.healthy, false);
  assert.ok(r.problems.includes('chain:capture') && r.problems.includes('chain:challenger'));
  // The severity split still applies: challenger is a verified shadow chain.
  assert.deepEqual(r.problemsBySeverity.data, ['chain:capture']);
  assert.deepEqual(r.problemsBySeverity.background, ['chain:challenger']);
});

test('health: a clean GitHub summary keeps healthy:true and adds no problems', () => {
  const r = buildHealthResponse([cleanRun], { ...FRESH, chainSummary: summary({ ok: true, failed: [], chains: { ledger: { ok: true, failed: [], skipped: [] } } }) });
  assert.equal(r.chains.ok, true); assert.equal(r.healthy, true); assert.deepEqual(r.problems, []);
});

test('health: no summary + in-process ON → the block is derived from the run record (source in-process)', () => {
  const run = { ...cleanRun, ok: false, chainDispatchFails: ['atlasx'], chains: { atlasx: { dispatched: true, httpStatus: 500 } } };
  const r = buildHealthResponse([run], { ...FRESH, chainSummary: null, inProcessChains: true });
  assert.equal(r.chains.source, 'in-process'); assert.deepEqual(r.chains.failed, ['atlasx']); assert.equal(r.chains.date, '2026-10-02');
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
