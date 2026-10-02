'use strict';
// 📴 OFFLINE-FIRST PWA — the service worker's request classifier and the empty-state
// detector, both pure. public/js/sw-policy.js is a classic script (importScripts from
// sw.js, side-effect import from fetch-json.js, require() here) so ONE source of truth
// decides what may be cached. The cardinal rules it protects:
//   • anything with an Authorization header, any non-GET, any write/tick/warm op → never
//     touches a cache (the "never fire write ops against production" rule, now mirrored
//     client-side: a cached write response would also be a replayed write to the reader).
//   • /api/price and the deploy-version / health probes are network-only.
//   • an EMPTY or DEGRADED payload is never cached (the CDN-cached-empty-state gotcha).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const POLICY = require(join(ROOT, 'public', 'js', 'sw-policy.js'));
const SRC = readFileSync(join(ROOT, 'public', 'js', 'sw-policy.js'), 'utf8');

const ORIGIN = 'https://market-news-app-chi.vercel.app';
const classify = (path, extra = {}) => POLICY.classifyRequest({ url: ORIGIN + path, method: 'GET', origin: ORIGIN, ...extra });

test('sw-policy.js is a classic script: no import/export, exposes SW_POLICY on the global and via module.exports', () => {
  assert.ok(!/^\s*(import|export)\s/m.test(SRC), 'must stay importScripts-compatible');
  assert.match(SRC, /SW_POLICY\s*=/);
  for (const fn of ['classifyRequest', 'isEmptyState', 'shouldCacheResponse', 'apiCacheKey', 'isStaticAssetPath']) {
    assert.equal(typeof POLICY[fn], 'function', `${fn} exported`);
  }
});

// ── classifyRequest ─────────────────────────────────────────────────────────────────
test('non-GET, Authorization-bearing and cross-origin requests bypass every cache', () => {
  assert.equal(classify('/api/tracker?op=today', { method: 'POST' }), 'bypass');
  assert.equal(classify('/api/tracker?op=today', { hasAuth: true }), 'bypass');
  assert.equal(classify('/api/sectors', { hasAuth: true }), 'bypass');
  assert.equal(POLICY.classifyRequest({ url: 'https://query1.finance.yahoo.com/v8/x', method: 'GET', origin: ORIGIN }), 'bypass');
});

test('write / tick / warm / tracker-write ops bypass, including the ops the cron fans out to', () => {
  const writes = ['daytradetick', 'cerntick', 'pulse2statetick', 'warmchain', 'track', 'challengerlog', 'apexlog',
    'orbitresolve', 'evolvebackfill', 'archive', 'calarchive', 'universebuild', 'universescan', 'universecompile',
    'universecurate', 'modeltrain', 'modelpromote', 'modelrollback', 'swingverify', 'gapgoverify', 'alertsgrade',
    'patterngrade', 'alertsassess', 'intracapture', 'pulserefine', 'pulse2collect', 'timingtune', 'fadeseed',
    'narrative', 'emerging', 'runmanifest', 'fmpaudit', 'insideringest', 'pushsubscribe', 'pushunsubscribe',
    'recalibrate', 'secmasterbuild', 'daytradescan', 'largemoveraudittick', 'omegaabtick', 'dilutiontick'];
  for (const op of writes) assert.equal(classify(`/api/tracker?op=${op}`), 'bypass', `op=${op}`);
  assert.equal(classify('/api/warm'), 'bypass');
  assert.equal(classify('/api/warm?wave=2'), 'bypass');
});

test('force / log / refresh levers on an otherwise cacheable op bypass the cache (they are recompute or write requests)', () => {
  assert.equal(classify('/api/tracker?op=redundancy&force=1'), 'bypass');
  assert.equal(classify('/api/tracker?op=today&log=1'), 'bypass');
  assert.equal(classify('/api/tracker?op=sessionboard&refresh=1'), 'bypass');
});

test('live prices, charts and the version/health/push probes are network-only', () => {
  assert.equal(classify('/api/price?tickers=NVDA,AAPL'), 'live');
  assert.equal(classify('/api/chart?ticker=NVDA'), 'live');
  assert.equal(classify('/api/tracker?op=version'), 'live');
  assert.equal(classify('/api/tracker?op=health'), 'live');
  assert.equal(classify('/api/tracker?op=pushstatus'), 'live');
});

test('snapshot-shaped reads are cacheable: sessionboard, today, sectors, scoreboard (default op), maturity, screener, backtest', () => {
  for (const p of ['/api/tracker?op=sessionboard', '/api/tracker?op=today', '/api/tracker?op=scoreboard', '/api/tracker',
    '/api/tracker?op=maturity', '/api/tracker?op=challenger', '/api/tracker?op=leaderboard', '/api/sectors',
    '/api/sectors?mode=rotation', '/api/screener?scope=large', '/api/backtest?scope=large&months=3',
    '/api/tracker?op=techcommandticker&ticker=MDB', '/api/tracker?op=ignitionlive', '/api/tracker?op=cern']) {
    assert.equal(classify(p), 'snapshot', p);
  }
});

test('the app shell and same-origin static assets classify as static; the document as navigate', () => {
  for (const p of ['/js/app.js', '/js/vendor/fuse-7.1.0.min.mjs', '/css/app.css', '/icon.svg', '/manifest.webmanifest']) {
    assert.equal(classify(p), 'static', p);
    assert.equal(POLICY.isStaticAssetPath(new URL(ORIGIN + p).pathname), true, p);
  }
  assert.equal(classify('/'), 'navigate');
  assert.equal(classify('/index.html'), 'navigate');
  assert.equal(classify('/?source=pwa'), 'navigate');
  assert.equal(classify('/sw.js'), 'bypass', 'the worker script itself is never served from its own cache');
  assert.equal(classify('/feed/daytrade.md'), 'snapshot', 'the public feed rewrite is a read');
});

test('a malformed URL classifies as bypass rather than throwing inside the fetch handler', () => {
  assert.equal(POLICY.classifyRequest({ url: 'not a url', method: 'GET', origin: ORIGIN }), 'bypass');
  assert.equal(POLICY.classifyRequest(null), 'bypass');
});

// ── apiCacheKey ─────────────────────────────────────────────────────────────────────
test('apiCacheKey strips the per-poll cache-buster so a live board hits one entry instead of growing the cache', () => {
  const a = POLICY.apiCacheKey(ORIGIN + '/api/tracker?op=sessionboard&_cb=1700000000000');
  const b = POLICY.apiCacheKey(ORIGIN + '/api/tracker?op=sessionboard&_cb=1700000060000');
  assert.equal(a, b);
  assert.equal(a, ORIGIN + '/api/tracker?op=sessionboard');
  assert.equal(POLICY.apiCacheKey(ORIGIN + '/api/tracker?op=evidence&view=all&_cb=5'), ORIGIN + '/api/tracker?op=evidence&view=all');
  assert.equal(POLICY.apiCacheKey(ORIGIN + '/api/tracker'), ORIGIN + '/api/tracker');
});

// ── isEmptyState ────────────────────────────────────────────────────────────────────
test('isEmptyState: the route-level failure signals are all empty states', () => {
  assert.equal(POLICY.isEmptyState(null), true);
  assert.equal(POLICY.isEmptyState('x'), true);
  assert.equal(POLICY.isEmptyState([]), true);
  assert.equal(POLICY.isEmptyState({ ok: false, error: 'boom' }), true, 'ok:false');
  assert.equal(POLICY.isEmptyState({ ok: true, empty: true, items: [] }), true, 'empty:true');
  assert.equal(POLICY.isEmptyState({ ok: true, persisted: false, items: [{ id: 1 }] }), true, 'persisted:false = Blob-lag write failure');
  assert.equal(POLICY.isEmptyState({ ok: true, degraded: true, items: [{ id: 1 }] }), true, 'degraded:true');
  assert.equal(POLICY.isEmptyState({ error: 'Failed to fetch sector data', sectors: [] }), true, 'error without ok');
  assert.equal(POLICY.isEmptyState({ ok: true, items: [{ id: 1 }], sources: [{ source: 'today', ok: false }] }), true,
    'a partial read (any source ok:false) mirrors lib/session-board-routes cacheHeaderFor → no-store');
});

test('isEmptyState: a payload whose primary collection is empty is an empty state', () => {
  assert.equal(POLICY.isEmptyState({ sectors: [] }), true, '/api/sectors with nothing');
  assert.equal(POLICY.isEmptyState({ ok: true, items: [], heldOut: [] }), true, 'session board with nothing graded');
  assert.equal(POLICY.isEmptyState({ ok: true, groups: [] }), true, 'scoreboard with no groups');
  assert.equal(POLICY.isEmptyState({ ok: true, counts: { signals: 0 }, horizons: {} }), true, 'op=today with zero signals');
  assert.equal(POLICY.isEmptyState({ ok: true, items: [], heldOut: [{ id: 'h1' }] }), false,
    'held-out rows are still data — only an all-empty collection set is empty');
});

test('isEmptyState: real payloads are not empty', () => {
  assert.equal(POLICY.isEmptyState({ sectors: [{ symbol: 'XLK', changePct: 1.2 }] }), false);
  assert.equal(POLICY.isEmptyState({ ok: true, items: [{ id: 'a' }], sources: [{ source: 'today', ok: true }], persisted: true }), false);
  assert.equal(POLICY.isEmptyState({ ok: true, counts: { signals: 12 }, horizons: { swing: [{ ticker: 'X' }] } }), false);
  assert.equal(POLICY.isEmptyState({ ok: true, version: 'abc' }), false, 'an unknown shape with ok:true is trusted');
  assert.equal(POLICY.isEmptyState({ rotation: [{ symbol: 'XLK' }], asOf: '2026-10-01' }), false);
});

// ── shouldCacheResponse ─────────────────────────────────────────────────────────────
test('shouldCacheResponse: only a 200 JSON body that is not an empty state is cacheable', () => {
  const good = { ok: true, items: [{ id: 1 }] };
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'application/json; charset=utf-8', json: good }), true);
  assert.equal(POLICY.shouldCacheResponse({ status: 500, contentType: 'application/json', json: good }), false, 'non-200');
  assert.equal(POLICY.shouldCacheResponse({ status: 304, contentType: 'application/json', json: good }), false, '304 is not a body');
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'text/html', json: good }), false, 'not JSON (an error page)');
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'application/json', json: { ok: true, items: [] } }), false, 'empty');
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'application/json', json: { ok: false } }), false, 'degraded');
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'text/markdown', json: null, bodyText: '# feed' }), true,
    'the public markdown feed is cacheable when non-empty');
  assert.equal(POLICY.shouldCacheResponse({ status: 200, contentType: 'text/markdown', json: null, bodyText: '' }), false);
});
