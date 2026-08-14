'use strict';
// CATALYST–FLOW ROUTES — registration and the read-only guarantee.
//
// The structural tests here exist because a module that is written, tested and never wired
// is indistinguishable from one that does not exist. They pin the op dispatch, the tab
// registration and the section markup, and — most importantly — assert that the routes
// module exposes NO write or train path, which is what makes "a request never trains
// LightGBM" a property of the code rather than a promise in a comment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROUTES = require('../lib/catalyst-flow-routes');

test('the three read ops are dispatched from api/tracker.js', () => {
  const tracker = read('api/tracker.js');
  for (const op of ['catalystflow', 'catalystflowcoverage', 'catalystflowregistry']) {
    assert.match(tracker, new RegExp(`req\\.query\\.op === '${op}'`), `${op} must be routed`);
  }
  assert.match(tracker, /catalyst-flow-routes/);
});

test('the routes module exposes ONLY read handlers — no tick, no train, no backfill', () => {
  const names = Object.keys(ROUTES);
  assert.deepStrictEqual(names.sort(), ['runCatalystFlow', 'runCatalystFlowCoverage', 'runCatalystFlowRegistry']);
  assert.ok(!names.some((n) => /tick|train|backfill|write|publish/i.test(n)),
    'a write path here would let a request mutate or recompute a ranking');
});

test('the routes module never requires a trainer or a model runtime', () => {
  // Comments discuss LightGBM on purpose; what matters is what the file actually LOADS.
  const code = read('lib/catalyst-flow-routes.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const required = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(required.length > 0);
  assert.ok(required.every((r) => /^\.\//.test(r)), `only local modules may be loaded, got ${required.join(', ')}`);
  assert.ok(!/lightgbm|child_process|spawn\(|execFile/i.test(code),
    'serving must neither load a model runtime nor shell out to the trainer');
});

test('the storage layer writes only under its own versioned prefix', () => {
  const S = require('../lib/catalyst-flow/store');
  assert.match(S.KEYS.LATEST, /^catalystflow\/v1\//);
  assert.match(S.predictionKey('2026-06-10'), /^catalystflow\/v1\/predictions\/2026-06-10\.json$/);
  assert.ok(S.PREDICTION_RE.test('catalystflow/v1/predictions/2026-06-10.json'));
  assert.ok(!S.PREDICTION_RE.test('catalystflow/v1/predictions/not-a-date.json'));
});

test('the coverage op reports E3 as INSUFFICIENT_DATA and names the missing capabilities', async () => {
  const headers = {};
  let payload = null;
  const res = { setHeader: (k, v) => { headers[k] = v; }, json: (b) => { payload = b; return b; } };
  await ROUTES.runCatalystFlowCoverage({ query: { op: 'catalystflowcoverage' } }, res);

  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.arms.E3_CATALYST_FLOW_RANKER, 'INSUFFICIENT_DATA');
  assert.strictEqual(payload.providers.signedOptions.optionsSignedCoverage, false);
  assert.deepStrictEqual(payload.providers.signedOptions.missingCapabilities,
    ['identifiesParticipant', 'identifiesSide', 'identifiesOpenClose']);
  assert.strictEqual(payload.flags.enabled, false, 'off by default');
  assert.match(headers['Cache-Control'], /no-store/);
});

test('the registry op serves every declared feature with its full contract', () => {
  let payload = null;
  ROUTES.runCatalystFlowRegistry({ query: {} }, { setHeader: () => {}, json: (b) => { payload = b; return b; } });
  assert.strictEqual(payload.ok, true);
  assert.ok(payload.features.length >= 50);
  assert.ok(payload.features.every((f) => f.source && f.availability && f.missing && f.direction));
  // E2's declared families must not include the signed-options family.
  assert.ok(!payload.armFeatureFamilies.E2_CATALYST_RANKER.includes('C_SIGNED_OPTION_CONFIRMATION'));
  assert.ok(payload.armFeatureFamilies.E3_CATALYST_FLOW_RANKER.includes('C_SIGNED_OPTION_CONFIRMATION'));
});

test('the lab tab is registered without disturbing the neighbours other tests pin', () => {
  const app = read('public/js/app.js');
  assert.match(app, /'gridlock', 'catalyst', 'peerlab'\]/, 'catalyst sits before peerlab in TAB_GROUPS.lab');
  assert.match(app, /catalyst: '⚡ Catalyst–Flow \(research\)'/);
  assert.match(app, /sub === 'catalyst'/, 'lazy-load hook wired in showTab');
  assert.match(app, /catalyst-lab\.js/);
});

test('the section markup exists and the container the renderer targets is present', () => {
  const html = read('public/index.html');
  assert.match(html, /<section class="screener-section" id="catalyst">/);
  assert.match(html, /id="catalyst-container"/);
  assert.match(html, /id="catalyst-refresh-btn"/);
});

test('the board never formats a model score as a percentage or a probability', () => {
  const ui = read('public/js/catalyst-lab.js');
  // The score cell must be rendered by the plain numeric formatter, and the file must
  // carry the ordinal disclaimer next to it.
  assert.match(ui, /num\(r\.score, 3\)/);
  assert.ok(!/pct\(\s*r\.score/.test(ui), 'a percentage-formatted score would misrepresent an ordinal value');
  assert.match(ui, /not an expected return and not a probability/);
  assert.match(ui, /INSUFFICIENT_DATA/, 'unmeasured arms must be surfaced as such');
});
