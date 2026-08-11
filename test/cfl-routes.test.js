'use strict';
// CFL ROUTES + WIRING — cross-file contracts asserted from source text (the same
// technique test/pulse2-routes.test.js uses): op registration, privilege classes,
// the warm chain, the live capture hook, and the UI registration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TRACKER = read('api/tracker.js');
const SCREENER = read('api/screener.js');
const APP = read('public/js/app.js');
const INDEX = read('public/index.html');
const WC = require('../lib/warm-chains');
const ROUTES = require('../lib/cfl-routes');
const CFLSTORE = require('../lib/cfl/store');

test('every CFL op is dispatched in api/tracker.js', () => {
  for (const op of ['cfl', 'cflmissed', 'cflduds', 'cfltrace', 'cflforecast', 'cfltick', 'cflbackfill']) {
    assert.match(TRACKER, new RegExp(`op === '${op}'`), `op=${op} must be routed`);
  }
});

test('the WRITER ops are PRIVILEGED; the read ops are public', () => {
  const privBlock = TRACKER.slice(TRACKER.indexOf('const PRIVILEGED_OPS'), TRACKER.indexOf('const EXPENSIVE_OPS'));
  assert.match(privBlock, /'cfltick', 'cflbackfill'/);
  for (const op of ["'cfl'", "'cflmissed'", "'cflduds'", "'cfltrace'", "'cflforecast'"]) {
    assert.ok(!privBlock.includes(op), `${op} is a public read and must NOT be privileged`);
  }
});

test('the cfl chain is a ROOT chain exactly once and contains only the single tick step (no cursor handoff)', () => {
  assert.ok(WC.ROOT_CHAINS.includes('cfl'));
  assert.deepStrictEqual(WC.CHAINS.cfl, ['op=cfltick']);
});

test('the live screener captures the decision snapshot BEFORE the response truncates rejections', () => {
  const captureIdx = SCREENER.indexOf('captureDecisionSnapshot');
  const truncateIdx = SCREENER.indexOf('sel.rejections.slice(0, 50)');
  assert.ok(captureIdx > 0, 'capture hook exists');
  assert.ok(truncateIdx > captureIdx, 'capture happens before the 50-row truncation');
  const hookRegion = SCREENER.slice(Math.max(0, captureIdx - 700), captureIdx);
  assert.match(hookRegion, /isWarm && isFullUniverse/, 'capture only on the canonical warm run');
});

test('route exports are complete and the store keys are namespaced under cfl/v1/', () => {
  for (const fn of ['runCflTick', 'runCflBackfill', 'runCflSummary', 'runCflMissed', 'runCflDuds', 'runCflTrace', 'runCflForecast']) {
    assert.strictEqual(typeof ROUTES[fn], 'function', `${fn} exported`);
  }
  assert.ok(Object.values(CFLSTORE.KEYS).every(k => k.startsWith('cfl/v1/')));
  assert.match(CFLSTORE.dayKey('large', 'h21', '2026-06-01'), /^cfl\/v1\/day\/large-h21-2026-06-01\.json$/);
});

test('without a Blob token the store degrades honestly (no throw, no fake data)', async () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    assert.strictEqual(await CFLSTORE.readSummary(), null);
    assert.deepStrictEqual(await CFLSTORE.listDayPaths(), []);
  } finally {
    if (saved != null) process.env.BLOB_READ_WRITE_TOKEN = saved;
  }
});

test('UI registration: lab tab, section, label, help, HOWTO, import and ensure hook all present', () => {
  assert.match(APP, /'edge', 'cfl', 'orbitlab'/, 'cfl registered in TAB_GROUPS.lab');
  assert.match(APP, /cfl: '🔭 Counterfactual Lab'/, 'SUB_LABEL entry');
  assert.match(APP, /cfl: 'Counterfactual Lab —/, 'SECTION_HELP entry');
  assert.match(APP, /cfl: \{\n\s+what:/, 'HOWTO entry');
  assert.match(APP, /import \{ loadCflLab \} from '\.\/cfl-lab\.js'/, 'module import');
  assert.match(APP, /sub === 'cfl' && typeof ensureCflLab === 'function'/, 'showTab dispatch');
  assert.match(INDEX, /<section class="screener-section" id="cfl">/, 'index.html section');
  assert.match(INDEX, /id="cfl-container"/, 'container div');
});

test('the CFL strategy-registry entry is shadow/informational — structurally unable to move a live pick', () => {
  const REG = require('../lib/strategy-registry');
  const entry = (REG.STRATEGY_REGISTRY || REG.registry || REG).find
    ? (REG.STRATEGY_REGISTRY || REG.registry || REG).find(e => e.id === 'cfl')
    : null;
  const src = read('lib/strategy-registry.js');
  assert.match(src, /id: 'cfl'.*maturity: 'shadow'/, 'registry entry exists and is shadow');
  if (entry) {
    assert.strictEqual(entry.maturity, 'shadow');
    assert.strictEqual(entry.core, false);
  }
});

test('the UI module renders empty/error states honestly (no fabricated boards)', () => {
  const ui = read('public/js/cfl-lab.js');
  assert.match(ui, /unavailable/i, 'error state exists');
  assert.match(ui, /No attributed missed winners yet/, 'honest empty state for missed winners');
  assert.match(ui, /survivorship/i, 'survivorship caveat surfaced to the user');
});
