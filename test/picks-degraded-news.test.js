'use strict';
// PROVIDER FAILURE MUST BE DISTINGUISHABLE FROM REAL ABSTENTION (audit 2026-08-14).
//
// api/picks.js fetched NewsAPI with no res.ok check and no catch. A 429/outage became
// `articles: []`, the LLM saw an empty feed and returned zero picks, and the response
// was stamped `abstained: true` with `s-maxage=14400` — a provider outage recorded AND
// CDN-pinned for 4 hours as a genuine quiet-day abstention. A thrown network error
// rejected an unguarded Promise.all → 500. The fix: per-feed res.ok + catch tracking a
// `degraded` flag; a degraded zero-pick run is NOT an abstention and gets a short
// cache; a healthy genuine abstention gets a short cache too (never CDN-cache empty
// state for 4h); only healthy runs WITH picks keep the 4h cache.

// Env BEFORE require — the handler reads its keys per request, but downstream modules
// (lib/fundamentals) read theirs at module load.
process.env.NEWS_API_KEY = 'test-news';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
delete process.env.FMP_API_KEY;      // fetchSectorPEs → null without a network trip

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Stub the Anthropic SDK BEFORE api/picks.js is required so the handler runs
// end-to-end with no network and no real key (same require-cache seam as the
// @vercel/blob stub in test/store-read-completeness.test.js).
let anthropicResponse = { content: [] };
// CI runs the suite DEPENDENCY-FREE (no npm install step) — the SDK is only present
// locally. The functional battery needs the require-cache stub, so it skips cleanly
// where the module cannot resolve; the structural source assertions below always run.
let sdkId = null;
try { sdkId = require.resolve('@anthropic-ai/sdk'); } catch { /* dependency-free CI */ }
if (sdkId) {
  require.cache[sdkId] = {
    id: sdkId, filename: sdkId, loaded: true,
    exports: class FakeAnthropic {
      constructor() { this.messages = { create: async () => anthropicResponse }; }
    },
  };
}
const handler = sdkId ? require('../api/picks') : null;
// Functional tests (need the stubbed SDK); structural tests keep the plain `test`.
const ftest = (name, fn) => test(name, { skip: sdkId ? false : '@anthropic-ai/sdk not installed (dependency-free CI)' }, fn);

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'picks.js'), 'utf8');

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const toolMsg = (picks) => ({ content: [{ type: 'tool_use', input: { picks } }] });
const onePick = () => [{
  rank: 1, ticker: 'TEST', company: 'Test Co', sector: 'Technology',
  overallRating: 8.2, ratingLabel: 'Strong Buy', sourceCoverage: 3, optionsSignal: 'None detected',
  factors: {
    newsSentiment: 8, fundamentals: 8, sectorTailwind: 8, macroAlignment: 8, technicalMomentum: 8,
    riskReward: 8, relativeStrength: 8, catalystClarity: 8, valuation: 8, institutionalSignal: 8,
  },
  thesis: 'Cited from feed.', keyRisk: 'Reverses on guidance.',
}];

function mkRes() {
  return {
    headers: {}, code: 200, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function run() { const res = mkRes(); await handler({ query: {}, headers: {} }, res); return res; }

ftest('a news-provider 429 with zero picks is degraded, NOT a genuine abstention, and short-cached', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('newsapi.org')) return resp(429, { status: 'error', code: 'rateLimited' });
    throw new Error('unexpected fetch: ' + url);
  };
  anthropicResponse = toolMsg([]);
  const res = await run();
  assert.equal(res.code, 200, 'a provider outage must degrade, not 500');
  assert.equal(res.body.degraded, true, 'the outage must be visible on the response');
  assert.equal(res.body.abstained, false, 'a starved model is not an abstaining model');
  assert.match(String(res.headers['Cache-Control']), /s-maxage=300\b/,
    'a degraded run must not pin the CDN — 5 minutes, not 4 hours');
});

ftest('a THROWN news fetch no longer rejects the unguarded Promise.all into a 500', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('newsapi.org')) throw new Error('ECONNRESET');
    throw new Error('unexpected fetch: ' + url);
  };
  anthropicResponse = toolMsg([]);
  const res = await run();
  assert.equal(res.code, 200);
  assert.equal(res.body.degraded, true);
  assert.equal(res.body.abstained, false);
});

ftest('a healthy genuine abstention keeps abstained:true but is short-cached (never 4h on empty state)', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('newsapi.org')) return resp(200, { status: 'ok', articles: [] });
    throw new Error('no sectors today');       // fetchSectors degrades to null on its own
  };
  anthropicResponse = toolMsg([]);
  const res = await run();
  assert.equal(res.code, 200);
  assert.equal(res.body.degraded, false, 'all feeds answered — nothing degraded');
  assert.equal(res.body.abstained, true, 'the abstention contract is unchanged for healthy runs');
  assert.deepEqual(res.body.rejectionReasonCounts, { noQualifyingCatalyst: 1 });
  assert.match(String(res.headers['Cache-Control']), /s-maxage=1800\b/,
    'a genuine abstention is cacheable, briefly — never CDN-pinned for 4h');
});

ftest('only a healthy run WITH picks keeps the 4-hour CDN cache', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('newsapi.org')) {
      return resp(200, { status: 'ok', articles: [{ title: 'Test Co beats earnings', source: { name: 'Reuters' } }] });
    }
    throw new Error('provider unavailable');   // enrichment fetches all fail soft
  };
  anthropicResponse = toolMsg(onePick());
  const res = await run();
  assert.equal(res.code, 200);
  assert.equal(res.body.degraded, false);
  assert.equal(res.body.abstained, false);
  assert.equal(res.body.screenedCount, 1);
  assert.match(String(res.headers['Cache-Control']), /s-maxage=14400\b/);
});

ftest('a degraded run that still yields picks is flagged and short-cached too', async () => {
  // 3 of 4 feeds answer; one is down. The picks are usable but the read is partial —
  // it must not be pinned for 4h as if it were a full-coverage run.
  let newsCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('newsapi.org')) {
      newsCalls++;
      if (newsCalls === 2) return resp(503, {});
      return resp(200, { status: 'ok', articles: [{ title: 'Test Co beats earnings', source: { name: 'Reuters' } }] });
    }
    throw new Error('provider unavailable');
  };
  anthropicResponse = toolMsg(onePick());
  const res = await run();
  assert.equal(res.code, 200);
  assert.equal(res.body.degraded, true);
  assert.match(String(res.headers['Cache-Control']), /s-maxage=300\b/);
});

test('fetchNews itself now fails LOUD on a non-ok response instead of returning []', () => {
  // The load-bearing half: without a throw (or explicit failure value) inside
  // fetchNews, the handler cannot distinguish outage from quiet day.
  assert.match(SRC, /if \(!res\.ok\) throw/, 'fetchNews must not swallow a non-ok status');
  // The unconditional 4h header must be gone — the cache is now a health-based policy.
  assert.ok(!/setHeader\('Cache-Control', 's-maxage=14400'\)/.test(SRC),
    'the flat 4h cache must not return');
  assert.match(SRC, /const cacheSeconds = degraded \? CACHE_DEGRADED_S/,
    'degradation must drive the cache policy');
});

test('the abstention flag is keyed off the screened book AND provider health', () => {
  assert.match(SRC, /const abstained = all\.length === 0 && !degraded/,
    'abstained must be false when the empty book was caused by a starved feed');
});
