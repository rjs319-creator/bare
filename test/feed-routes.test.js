'use strict';
// op=feed — the PUBLIC, READ-ONLY, machine-readable feed for external AI assistants.
// Contract under test: it never mutates, it always carries the paper-trading disclaimer,
// it renders honest empty states, it degrades per-source (one failed source does not
// blank the other), and error responses are never CDN-cached.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const FEED = require('../lib/feed-routes');

function mockRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end(b) { this.body = b; return this; },
  };
}
const req = (query = {}) => ({ query, headers: {}, method: 'GET' });

// ── Fixtures ────────────────────────────────────────────────────────────────
const BOARD_OK = {
  status: 200,
  payload: {
    ok: true, regime: 'neutral', session: 'regular',
    dataFreshness: { sessionDate: '2026-08-11', generatedAt: '2026-08-11T15:00:00.000Z' },
    pacingNote: null,
    bestOpportunities: [{
      rank: 1, ticker: 'ABCD', sector: 'Technology', source: 'Momentum & Liquid',
      relScore: 91, carry: 58, overextended: false, catalyst: 'CONTRACT',
      last: 12.34, pctChange: 8.2, relVol: 4.1, tier: 'A',
      entry: 12.4, stop: 11.8, target: 13.6, rr: 2.0, planBasis: 'live-intraday',
      lifecycleState: 'ACTIONABLE_NOW',
    }],
    lanes: {
      actionableNow: [{ ticker: 'ABCD' }],
      reversalReclaim: [], armed: [{ ticker: 'EFGH' }],
      buildingWatch: [{ ticker: 'IJKL' }, { ticker: 'MNOP' }],
      tooExtended: [{ ticker: 'QRST' }], retiredToday: [], priorSessionWatch: [],
      managing: [], closed: [],
    },
  },
};
const BOARD_EMPTY = {
  status: 200,
  payload: {
    ok: true, regime: 'risk-off', session: 'closed',
    dataFreshness: { sessionDate: '2026-08-08', generatedAt: '2026-08-11T01:00:00.000Z' },
    pacingNote: null, bestOpportunities: [],
    lanes: { actionableNow: [], reversalReclaim: [], armed: [], buildingWatch: [], tooExtended: [], retiredToday: [], priorSessionWatch: [], managing: [], closed: [] },
  },
};
const RADAR_OK = {
  ok: true, session: { label: 'regular' }, regime: 'neutral',
  records: [{
    ticker: 'WXYZ', company: 'Wxyz Inc', price: 3.21, dayChangePct: 42.5,
    floatTier: 'SMALL_SUPPLY', floatConfidence: 'HIGH', relativeVolume: 18.3,
    explosionPotentialScore: 72, tradeQualityScore: 55,
    ignitionState: 'EARLY_IGNITION', structureState: 'CONSTRUCTIVE', actionState: 'READY_IF_TRIGGERED',
    trigger: 3.35, entryZoneLow: 3.3, entryZoneHigh: 3.4, invalidation: 3.05,
    target1: 3.8, target2: 4.2, riskReward: 1.9,
    catalyst: 'FDA', dilutionRisk: 'LOW', analyzed: true, stale: false,
    blockingReasons: [], cautionReasons: [],
  }],
};
const RADAR_EMPTY = { ok: true, session: { label: 'closed' }, regime: 'neutral', records: [] };

const okDeps = (over = {}) => ({
  computeBoard: async () => BOARD_OK,
  computeRadar: async () => RADAR_OK,
  ...over,
});

// ── Rendering ───────────────────────────────────────────────────────────────
test('markdown feed carries the disclaimer, session context and both sections', async () => {
  const res = mockRes();
  await FEED.runFeed(req(), res, okDeps());
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/markdown/);
  const md = String(res.body);
  assert.match(md, /paper/i, 'the paper-trading disclaimer must always be present');
  assert.match(md, /not financial advice/i);
  assert.match(md, /Session/i);
  assert.match(md, /ABCD/, 'best-opportunity ticker renders');
  assert.match(md, /WXYZ/, 'ignition radar ticker renders');
  assert.match(md, /12\.4/, 'entry level renders');
  assert.match(md, /11\.8/, 'stop level renders');
  assert.match(md, /13\.6/, 'target level renders');
  assert.match(md, /EFGH/, 'armed lane ticker renders as watch context');
});

test('empty lists render an honest empty state, never fabricated picks', async () => {
  const res = mockRes();
  await FEED.runFeed(req(), res, okDeps({
    computeBoard: async () => BOARD_EMPTY,
    computeRadar: async () => RADAR_EMPTY,
  }));
  const md = String(res.body);
  assert.match(md, /No .*(actionable|candidate)/i, 'an explicit empty-state sentence is required');
  assert.doesNotMatch(md, /ABCD|WXYZ/, 'no phantom tickers');
  assert.match(md, /paper/i, 'disclaimer still present on the empty state');
});

test('one failed source degrades that section only — the other still renders', async () => {
  const res = mockRes();
  await FEED.runFeed(req(), res, okDeps({
    computeRadar: async () => { throw new Error('provider down'); },
  }));
  assert.equal(res.statusCode, 200);
  const md = String(res.body);
  assert.match(md, /ABCD/, 'the healthy source still renders');
  assert.match(md, /unavailable/i, 'the failed source is reported, not hidden');
});

// ── Caching ─────────────────────────────────────────────────────────────────
test('success is CDN-cached briefly; total failure is never cached', async () => {
  const ok = mockRes();
  await FEED.runFeed(req(), ok, okDeps());
  assert.match(ok.headers['cache-control'] || '', /s-maxage=\d+/);
  assert.doesNotMatch(ok.headers['cache-control'] || '', /no-store/);

  const bad = mockRes();
  await FEED.runFeed(req(), bad, {
    computeBoard: async () => { throw new Error('a'); },
    computeRadar: async () => { throw new Error('b'); },
  });
  assert.match(bad.headers['cache-control'] || '', /no-store/, 'a dead feed must not be pinned into the CDN');
});

// ── JSON projection ─────────────────────────────────────────────────────────
test('format=json returns the compact structured model with the same honesty fields', async () => {
  const res = mockRes();
  await FEED.runFeed(req({ format: 'json' }), res, okDeps());
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.readOnly, true);
  assert.ok(b.disclaimer && /paper/i.test(JSON.stringify(b.disclaimer)));
  assert.ok(Array.isArray(b.bestOpportunities));
  assert.equal(b.bestOpportunities[0].ticker, 'ABCD');
  assert.equal(b.bestOpportunities[0].entry, 12.4);
  assert.ok(Array.isArray(b.ignition.candidates));
  assert.equal(b.ignition.candidates[0].ticker, 'WXYZ');
  assert.ok(b.generatedAt);
});

// ── Read-only authority ─────────────────────────────────────────────────────
test('the feed computes both sources with mutate:false and never writes the store', async () => {
  const calls = [];
  const store = require('../lib/store');
  const originalWrite = store.writeJSON;
  let writes = 0;
  store.writeJSON = async () => { writes++; };
  try {
    const res = mockRes();
    await FEED.runFeed(req(), res, {
      computeBoard: async (opts) => { calls.push(['board', opts]); return BOARD_OK; },
      computeRadar: async (opts) => { calls.push(['radar', opts]); return RADAR_OK; },
    });
    for (const [name, opts] of calls) {
      assert.notEqual((opts || {}).mutate, true, `${name} must never be invoked as a mutator`);
    }
    assert.equal(writes, 0, 'the public feed performed a store WRITE');
  } finally {
    store.writeJSON = originalWrite;
  }
});

// ── Table hygiene ───────────────────────────────────────────────────────────
test('markdown table cells are pipe-safe', () => {
  const md = FEED.renderFeedMarkdown(FEED.buildFeedModel({
    board: {
      ...BOARD_OK.payload,
      bestOpportunities: [{ ...BOARD_OK.payload.bestOpportunities[0], sector: 'Weird|Sector' }],
    },
    radar: RADAR_OK,
    now: new Date('2026-08-11T15:00:00Z'),
  }));
  assert.doesNotMatch(md, /Weird\|Sector/, 'raw pipes would break the table layout');
});
