'use strict';
// PSRL wiring test — cross-file contracts asserted from source text (the same
// technique test/cfl-routes.test.js uses). Guards dispatch, auth class, warm
// chain, registry posture, UI registration and store namespacing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TRACKER = read('api/tracker.js');
const CHAINS = read('lib/warm-chains.js');
const APP = read('public/js/app.js');
const HTML = read('public/index.html');
const REGISTRY = read('lib/strategy-registry.js');
const PKG = read('package.json');
const OMEGA_ROUTES = read('lib/omega-swing-routes.js');

test('tracker dispatches every psrl op', () => {
  for (const op of ['psrl', 'psrldetail', 'psrlhealth', 'psrltick', 'psrlresearch']) {
    assert.match(TRACKER, new RegExp(`op === '${op}'\\).*psrl-routes`), `op=${op} dispatched to psrl-routes`);
  }
});

test('the writer is privileged; reads are not; research is rate-limited', () => {
  const priv = TRACKER.slice(TRACKER.indexOf('const PRIVILEGED_OPS'), TRACKER.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'psrltick'/, 'psrltick must require the cron bearer');
  for (const op of ['psrl', 'psrldetail', 'psrlhealth', 'psrlresearch']) {
    assert.ok(!new RegExp(`'${op}'`).test(priv.replace(/'psrltick'/g, '')), `${op} must stay a public read`);
  }
  const exp = TRACKER.slice(TRACKER.indexOf('const EXPENSIVE_OPS'), TRACKER.indexOf('const EXPENSIVE_LIMIT'));
  assert.match(exp, /'psrlresearch'/, 'psrlresearch is browser-triggerable → rate-limited');
});

test('own root warm chain, single in-process step', () => {
  assert.match(CHAINS, /psrl: \['op=psrltick'\]/, 'single-step chain (Blob read-back lag rule)');
  const roots = CHAINS.match(/const ROOT_CHAINS = \[[^\]]+\]/)[0];
  assert.match(roots, /'psrl'/, 'psrl must be a ROOT chain');
});

test('strategy registry: shadow, weight-0 posture with promotion criteria', () => {
  assert.match(REGISTRY, /id: 'psrl'[^\n]*maturity: 'shadow'/, 'psrl registered as shadow');
  assert.match(REGISTRY, /id: 'psrl'[^\n]*criteria:/, 'promotion criteria stated');
});

test('hypothesis registry carries the three preregistered psrl trials', () => {
  const H = require('../lib/research/hypothesis-registry');
  for (const id of ['psrl-continuity-conditional', 'psrl-residual-vs-raw', 'psrl-incremental-omega']) {
    const h = H.HYPOTHESES.find((x) => x.id === id);
    assert.ok(h, `${id} registered`);
    assert.strictEqual(h.familyId, 'swing-ranking', 'widens the swing-ranking denominator');
    assert.strictEqual(h.status, 'open');
    assert.ok(H.validateHypothesis(h).valid, `${id} passes schema validation`);
  }
});

test('OMEGA annotation is weight-0, fail-soft, and labeled as correlated evidence', () => {
  const block = OMEGA_ROUTES.slice(OMEGA_ROUTES.indexOf('psrl:'), OMEGA_ROUTES.indexOf('psrl:') + 1600);
  assert.match(block, /weight: 0/, 'annotation carries weight 0');
  assert.match(block, /portfolioEligible: false/);
  assert.match(block, /probability: null/);
  assert.match(OMEGA_ROUTES, /catch \{ \/\* annotation is optional; OMEGA payload unchanged on any failure \*\//, 'fail-soft');
  assert.match(block, /correlated/i, 'must not read as independent confirmation');
});

test('UI fully registered without displacing the pinned lab tail', () => {
  assert.match(APP, /'rltlab', 'psrl', 'gridlock'/, 'psrl in TAB_GROUPS.lab, neighbor-pinned (outside the cfl-test triplet)');
  assert.match(APP, /'peerlab'\]/, 'peerlab stays the last lab entry (peerprop test pin)');
  assert.match(APP, /psrl: '🪜 Persistent Trends \(shadow\)'/, 'SUB_LABEL entry');
  assert.match(APP, /psrl: 'Persistent Trends —/, 'SECTION_HELP entry');
  assert.match(APP, /import \{ loadPsrlLab \} from '\.\/psrl-lab\.js'/, 'module import');
  assert.match(APP, /sub === 'psrl' && typeof ensurePsrlLab === 'function'/, 'showTab dispatch');
  assert.match(HTML, /<section class="screener-section" id="psrl">/, 'index.html section');
  assert.match(HTML, /id="psrl-container"/);
  assert.match(HTML, /id="psrl-refresh-btn"/);
  const LAB = read('public/js/psrl-lab.js');
  assert.match(LAB, /SHADOW — weight 0/, 'shadow banner');
  assert.ok(!/probability of profit/i.test(LAB), 'no probability-of-profit language');
});

test('store keys are namespaced under psrl/v1/ and syntax check covers lib/psrl', () => {
  const CFG = require('../lib/psrl/config');
  assert.ok(Object.values(CFG.STORE).every((v) => typeof v !== 'string' || v.startsWith('psrl/v1/')));
  assert.strictEqual(CFG.STORE.dayKey('2026-08-11'), 'psrl/v1/day/2026-08-11.json');
  // Was: assert.match(PKG, /lib\/psrl\/\*\.js/). That pinned the per-directory glob
  // form of `npm run check` — which validated only the FIRST file of each glob, because
  // `node --check` ignores every argument after the first. lib/psrl is now covered by a
  // recursive `find api lib ... | xargs -n1 node --check` sweep, so the intent (this
  // directory is syntax-checked) holds more strongly than before, but the literal glob
  // is gone. See test/check-script-coverage.test.js.
  assert.match(PKG, /find api lib[^"]*xargs -0 -n1[^"]*node --check/, 'npm run check sweeps lib/ recursively');
});

test('routes degrade gracefully without a Blob store token', async () => {
  const routes = require('../lib/psrl-routes');
  const res = {
    headers: {}, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await routes.runPsrlTick({ query: {} }, res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.reason, /no-blob-store/);
    await routes.runPsrlBoard({ query: {} }, res);
    assert.strictEqual(res.code, 200, 'board read never throws without a store');
  } finally {
    if (hadToken) process.env.BLOB_READ_WRITE_TOKEN = hadToken;
  }
});

test('board projection keeps novice and expert reads separated and un-probabilistic', () => {
  const { compactCard } = require('../lib/psrl-routes');
  const fake = {
    rank: 1, ticker: 'TT', sector: 'Technology', liquidity: { price: 10, dollarVol: 1e7 },
    arrows: { price: 'UP2' }, arrowGlyphs: { price: '↑↑' }, entry: { state: 'WATCH', reasons: [] },
    quadrant: 'TRUE_LEADER', stage: 'CONFIRMED_LEADER', absPath: { state: 'STEADY_ADVANCE' },
    scores: { combinedAfterPenalties: 70, persistentTrend: 60, relativeLeadership: 65 },
    trend: { byHorizon: {} }, residual: { byHorizon: {} }, continuity: {}, penalties: [],
    support: { grade: 'FULL' }, speeds: { interpretation: 'HEALTHY_CONTINUATION' },
  };
  const c = compactCard(fake);
  assert.ok(c.novice && typeof c.novice.read === 'string');
  assert.strictEqual(c.expert.calibrationStatus, 'uncalibrated');
});
