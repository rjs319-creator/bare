'use strict';
// op=patterns SERVER PAGING (site audit 2026-10-02 #8). The populated radar was 24.5 MB
// (17,100 cards) and the UI paged client-side, so every Pattern Radar open downloaded all of
// it. The route now serves one page per bucket (default 30, max 300) with every bucket's total,
// keeps `count` as the full total, pages ONE bucket on demand, and never CDN-caches an empty
// page.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const PR = require('../lib/pattern-routes');
const { EP_STATES } = require('../lib/patterns/episodes');

const STATES = [EP_STATES.EMERGING, EP_STATES.FORMING, EP_STATES.READY, EP_STATES.CONFIRMED, EP_STATES.RETESTING, EP_STATES.MANAGING, EP_STATES.EXPIRED, EP_STATES.STOPPED];
function episode(i) {
  const state = STATES[i % STATES.length];
  return {
    episodeId: `ep-${i}`, ticker: `T${i}`, family: i % 2 ? 'BULL_FLAG' : 'CUP_HANDLE', label: 'x', direction: 'LONG', timeframe: '20d', state,
    detectedDate: '2026-09-20', patternStart: '2026-09-01', lastEvaluatedDate: '2026-10-01', lastClose: 100 + (i % 7),
    frozen: { trigger: { price: 105, type: 'neckline' }, invalidation: { price: 95 }, target: { price: 120 }, atr: 2, plan: { rr: 3 } },
    current: { invalidation: 95, target: 120 },
    setupQuality: 'good', structuralValidity: (i % 10) / 10, featureCoverage: 1, entry: null, barsSinceDetection: 3,
    regimeAtDetection: 'NEUTRAL', transitions: [], amendments: [], modelVersion: 'v2',
  };
}
const N = 700;
const DOC = { version: 'v2', updatedAt: '2026-10-01T22:00:00Z', episodes: Object.fromEntries(Array.from({ length: N }, (_, i) => [`ep-${i}`, episode(i)])) };

const orig = {};
beforeEach(() => {
  orig.hasStore = store.hasStore; orig.readJSON = store.readJSON;
  store.hasStore = () => true;
  store.readJSON = async (p, dflt) => (p === PR.EPISODES_PATH ? DOC : dflt);
});
afterEach(() => { store.hasStore = orig.hasStore; store.readJSON = orig.readJSON; });

const call = async (query) => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await PR.runPatterns({ query }, res);
  return res;
};
const ids = (cards) => cards.map(c => c.episodeId);

test('first load: every bucket is capped at the default page, totals carry the real counts, count is the full total', async () => {
  const res = await call({ view: 'all' });
  assert.equal(res.statusCode, 200);
  const { radar, totals, count, page } = res.body;
  assert.equal(count, N);
  assert.equal(page.limit, PR.PATTERNS_PAGE_DEFAULT);
  let served = 0, total = 0;
  for (const k of Object.keys(radar)) {
    assert.ok(radar[k].length <= PR.PATTERNS_PAGE_DEFAULT, `${k} served ${radar[k].length}`);
    served += radar[k].length; total += totals[k];
  }
  assert.equal(total, N);
  assert.equal(page.served, served);
  assert.ok(served <= 9 * PR.PATTERNS_PAGE_DEFAULT && served <= 300, 'first load must stay under ~300 cards');
  assert.ok(totals.developing > PR.PATTERNS_PAGE_DEFAULT, 'fixture should have a bucket that needs paging');
  assert.match(res.headers['Cache-Control'], /s-maxage=300/);
});

test('a bucket page continues where the first page stopped, in the same order, with other buckets empty', async () => {
  const first = await call({ view: 'all' });
  const second = await call({ view: 'all', bucket: 'developing', offset: String(PR.PATTERNS_PAGE_DEFAULT), limit: String(PR.PATTERNS_PAGE_DEFAULT) });
  assert.equal(second.statusCode, 200);
  const a = ids(first.body.radar.developing), b = ids(second.body.radar.developing);
  assert.equal(b.length, PR.PATTERNS_PAGE_DEFAULT);
  assert.equal(new Set([...a, ...b]).size, a.length + b.length, 'pages overlap');
  for (const k of Object.keys(second.body.radar)) if (k !== 'developing') assert.equal(second.body.radar[k].length, 0);
  assert.equal(second.body.totals.developing, first.body.totals.developing);
  assert.equal(second.body.count, N);
  // Walking every page reproduces the full ranked order exactly once.
  const all = [];
  for (let off = 0; off < first.body.totals.developing; off += 300) {
    const r = await call({ view: 'all', bucket: 'developing', offset: String(off), limit: '300' });
    all.push(...ids(r.body.radar.developing));
  }
  assert.equal(all.length, first.body.totals.developing);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all.slice(0, a.length), a, 'first page is not the head of the full order');
});

test('limit is clamped to the maximum and an empty page is never CDN-cached', async () => {
  const big = await call({ view: 'all', bucket: 'developing', limit: '5000' });
  assert.equal(big.body.page.limit, PR.PATTERNS_PAGE_MAX);
  const beyond = await call({ view: 'all', bucket: 'developing', offset: '100000' });
  assert.equal(beyond.statusCode, 200);
  assert.equal(beyond.body.radar.developing.length, 0);
  assert.equal(beyond.body.page.served, 0);
  assert.equal(beyond.headers['Cache-Control'], 'no-store');
});

test('an unknown bucket is a 400, not an empty 200 that could be cached', async () => {
  const res = await call({ view: 'all', bucket: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.ok(Array.isArray(res.body.known) && res.body.known.includes('developing'));
});

test('rankEpisodes orders by the same rank the cards used (eligible, validity, fresh)', () => {
  const e = (structuralValidity, lastEvaluatedDate) => ({ family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d', structuralValidity, lastEvaluatedDate });
  const now = '2026-10-01T22:00:00.000Z';
  const ordered = PR.rankEpisodes([e(0.2, '2026-10-01'), e(0.9, '2026-01-01'), e(0.5, '2026-10-01')], { evidenceTable: null, nowIso: now });
  // fresh (+0.5) outranks stale validity: 0.5+0.5 > 0.9 > 0.2+0.5
  assert.deepEqual(ordered.map(x => x.structuralValidity), [0.5, 0.9, 0.2]);
});
