'use strict';
// IGNITION LIVE — wiring contract. Source-text assertions in the repo's established style
// (see test/psrl-routes.test.js): every op dispatched, correctly auth-classified, the tick
// integration present in the ONE privileged writer, the UI registered at every touchpoint,
// and the alert builder's dedup/budget behaviour. The defect class prevented: a module that
// exists but is reachable from nothing, or a public op that can write.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TRACKER = read('api/tracker.js');
const APP = read('public/js/app.js');
const HTML = read('public/index.html');
const LF_ROUTES = read('lib/lowfloat-routes.js');
const WORKFLOW = read('.github/workflows/daytrade-scan.yml');

const routes = require('../lib/ignition-live-routes');

// ── Dispatch + auth classes ──────────────────────────────────────────────────

test('all three ignition-live ops are dispatched from api/tracker.js', () => {
  for (const op of ['ignitionlive', 'ignitionreplay', 'ignitionleadtime']) {
    assert.match(TRACKER, new RegExp(`op === '${op}'\\)`), `${op} dispatched`);
  }
});

test('ignition-live ops are read-only: none is in PRIVILEGED_OPS', () => {
  const priv = TRACKER.match(/const PRIVILEGED_OPS = new Set\(\[[\s\S]*?\]\);/)[0];
  for (const op of ['ignitionlive', 'ignitionreplay', 'ignitionleadtime']) {
    assert.ok(!priv.includes(`'${op}'`), `${op} must not be privileged — the writer is op=lowfloattick`);
  }
});

test('the day-listing reads are rate-limited; the single-snapshot read is not', () => {
  const exp = TRACKER.match(/const EXPENSIVE_OPS = new Set\(\[[\s\S]*?\]\);/)[0];
  assert.ok(exp.includes(`'ignitionreplay'`), 'replay lists a whole day of blobs');
  assert.ok(exp.includes(`'ignitionleadtime'`), 'leadtime joins a day of blobs + the audit');
  assert.ok(!exp.includes(`'ignitionlive'`), 'the latest-snapshot read stays a cheap cached projection');
});

// ── Tick integration: one compute serves both boards, failures cannot break the host ─

test('processIgnitionTick runs inside runLowFloatTick, try/caught, and reports in the response', () => {
  assert.match(LF_ROUTES, /processIgnitionTick\(\{/, 'tick calls the processor');
  const idx = LF_ROUTES.indexOf('processIgnitionTick');
  const around = LF_ROUTES.slice(idx - 600, idx + 400);
  assert.match(around, /try \{/, 'wrapped so a synthesis failure never breaks low-float persistence');
  assert.match(LF_ROUTES, /ignitionLive,/, 'summary surfaced in the tick response');
});

test('no separate ignition writer exists in the scheduler workflow (it rides lowfloattick)', () => {
  assert.ok(!/ignitionlivetick|ignitiontick/.test(WORKFLOW), 'the workflow must not gain a duplicate compute');
  assert.match(WORKFLOW, /op=lowfloattick/, 'the host tick is scheduled');
});

// ── Store paths ──────────────────────────────────────────────────────────────

test('lowfloat-store exposes the ignition-live snapshot, attention and alert-state paths', () => {
  const store = require('../lib/lowfloat-store');
  assert.equal(store.IGNITION_LIVE_PREFIX, 'ignition-live/');
  assert.equal(store.attentionKey('2026-08-11'), 'lowfloat/attention/2026-08-11.json');
  assert.match(store.ignitionLiveKey('2026-08-11', '2026-08-11T14:35:12Z'), /^ignition-live\/2026-08-11\/20260811T143512Z\.json$/);
  assert.equal(typeof store.readIgnitionAlertState, 'function');
});

// ── Alert builder: dedup, budgets, FAILED-only-after-alerted ─────────────────

function view(ticker, over = {}) {
  return {
    ticker, price: 2, ignitionScore: 85, opportunityScore: 80, stage: 'CONFIRMING',
    extensionRisk: 20, extensionLabel: 'NORMAL', structureState: 'BREAKOUT_PENDING',
    trigger: 2.1, invalidation: 1.9, doNotChasePrice: 2.2, setup: 'HOD',
    catalystGrade: 'A', attention: null, alertStates: ['CONFIRMED'], entryTemplate: 'HOD',
    ...over,
  };
}

test('an alert fires once per (ticker,state) per session', () => {
  const first = routes.buildIgnitionAlerts([view('AAA')], null, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(first.alerts.length, 1);
  const second = routes.buildIgnitionAlerts([view('AAA')], first.nextState, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(second.alerts.length, 0);
  assert.ok(second.suppressed >= 1);
});

test('a new session resets the dedup state', () => {
  const first = routes.buildIgnitionAlerts([view('AAA')], null, { now: new Date(), sessionDate: '2026-08-10' });
  const nextDay = routes.buildIgnitionAlerts([view('AAA')], first.nextState, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(nextDay.alerts.length, 1);
});

test('FAILED alerts only fire for names previously alerted constructively', () => {
  const cold = routes.buildIgnitionAlerts([view('AAA', { alertStates: ['FAILED'], stage: 'FAILED' })], null, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(cold.alerts.length, 0, 'never-alerted name fails silently');
  const prior = routes.buildIgnitionAlerts([view('AAA')], null, { now: new Date(), sessionDate: '2026-08-11' });
  const after = routes.buildIgnitionAlerts([view('AAA', { alertStates: ['FAILED'], stage: 'FAILED' })], prior.nextState, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(after.alerts.length, 1);
  assert.equal(after.alerts[0].state, 'FAILED');
});

test('the per-cycle budget binds and higher-value states win the slots', () => {
  const views = Array.from({ length: 15 }, (_, i) => view(`T${i}`, { alertStates: i < 12 ? ['WATCH'] : ['CONFIRMED'], stage: i < 12 ? 'EARLY_IGNITION' : 'CONFIRMING' }));
  const out = routes.buildIgnitionAlerts(views, null, { now: new Date(), sessionDate: '2026-08-11' });
  assert.equal(out.alerts.length, 10, 'MAX_PER_CYCLE');
  const confirmed = out.alerts.filter(a => a.state === 'CONFIRMED').length;
  assert.equal(confirmed, 3, 'every CONFIRMED made the cut before WATCH filled the rest');
});

// ── Honesty furniture ────────────────────────────────────────────────────────

test('the response envelope carries versions and the stated limitations', () => {
  const env = routes.envelope({});
  assert.equal(env.ignitionLiveVersion, 'ignition-live-v1');
  assert.ok(env.limitations.some(l => /halt\/LULD/.test(l)));
  assert.ok(env.limitations.some(l => /RULE_BASED_ESTIMATE/.test(l)));
  assert.ok(env.limitations.some(l => /5-MINUTE|5-minute/.test(l)));
});

// ── UI registration (the 8-point checklist) ──────────────────────────────────

test('ignitionlive is registered at every UI touchpoint', () => {
  assert.match(APP, /'lowfloat', 'ignitionlive', 'breakoutradar'/, 'in TAB_GROUPS.candidates, neighbor-pinned');
  assert.match(APP, /ignitionlive: 'intraday'/, 'SUB_HZ');
  assert.match(APP, /ignitionlive: '🚀 Ignition Live'/, 'SUB_LABEL');
  assert.match(APP, /ignitionlive: 'IGNITION Live/, 'SECTION_HELP');
  assert.match(APP, /ignitionlive: \{\n {6}what:/, 'HOWTO');
  assert.match(APP, /import \{ loadIgnitionLive \} from '\.\/ignition-live\.js'/, 'module import');
  assert.match(APP, /ignitionlive: lazySection\('ignitionlive', loadIgnitionLive\)/, 'lazy loader');
  assert.match(APP, /function ensureIgnitionLive\(\)/, 'hoisted function declaration (showTab TDZ rule)');
  assert.match(APP, /sub === 'ignitionlive' && typeof ensureIgnitionLive === 'function'/, 'showTab dispatch');
  assert.match(HTML, /<section class="screener-section" id="ignitionlive">/, 'index.html section');
  assert.match(HTML, /id="ignitionlive-container"/, 'container');
  assert.match(HTML, /id="ignitionlive-refresh-btn"/, 'refresh button');
});

test('the lab tab pins are untouched (cfl/psrl/peerprop regexes still hold)', () => {
  assert.match(APP, /'edge', 'cfl', 'orbitlab'/);
  assert.match(APP, /'rltlab', 'psrl', 'gridlock'/);
  assert.match(APP, /'peerlab'\]/);
});

test('the frontend module renders only — default sort is opportunity, no scoring math', () => {
  const MOD = read('public/js/ignition-live.js');
  assert.match(MOD, /sortKey: 'opportunityScore'/, 'default sort');
  assert.match(MOD, /RENDER ONLY/i, 'render-only doctrine stated');
  assert.match(MOD, /op=ignitionlive/, 'reads the snapshot op');
  assert.match(MOD, /op=ignitionreplay/, 'timeline uses the replay op');
});
