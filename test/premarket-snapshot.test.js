'use strict';
// PREMARKET SNAPSHOT + GAP LANE CONTRACT.
//
// Before 2026-09-19 the bulk-quote mapper dropped Yahoo's pre/post-market fields, so between
// 04:00 and 09:30 ET every "current" price was yesterday's close and the premarket discovery
// scan rejected every row as a prior-session observation. These tests pin: the fields are
// parsed, the session view picks the right print, the snapshot never throws, and the gap
// lane only fires on a REAL premarket print with real participation.
const { test } = require('node:test');
const assert = require('node:assert');
const qp = require('../lib/quote-provider');
const PM = require('../lib/premarket-snapshot');
const MD = require('../lib/mover-discovery');
const { DISCOVERY } = require('../lib/lowfloat-config');

const PRE = new Date('2026-09-21T12:00:00Z');   // Monday 08:00 ET — premarket
const RTH = new Date('2026-09-21T15:00:00Z');   // Monday 11:00 ET — regular

const yahooRow = (over = {}) => ({
  symbol: 'ABC', regularMarketPrice: 10, regularMarketPreviousClose: 10, regularMarketVolume: 900_000,
  averageDailyVolume3Month: 1_000_000, regularMarketTime: 1789736400,
  preMarketPrice: 10.8, preMarketChangePercent: 8, preMarketVolume: 120_000, preMarketTime: 1789730000,
  postMarketPrice: 10.1, postMarketChangePercent: 1, postMarketTime: 1789780000, marketState: 'PRE',
  ...over,
});
const okResponse = body => ({ ok: true, status: 200, json: async () => body });
const fakeAuth = async () => ({ cookie: 'c=1', crumb: 'abc' });

test('yahooQuotes parses the extended-hours fields additively and leaves the regular fields untouched', async () => {
  // Arrange
  const fetchImpl = async () => okResponse({ quoteResponse: { result: [yahooRow()] } });
  // Act
  const { rows } = await qp.yahooQuotes(['ABC'], { fetchImpl, authImpl: fakeAuth });
  // Assert
  const r = rows[0];
  assert.equal(r.price, 10); assert.equal(r.prevClose, 10); assert.equal(r.dayVolume, 900_000);
  assert.equal(r.preMarketPrice, 10.8); assert.equal(r.preMarketChangePct, 8); assert.equal(r.preMarketVolume, 120_000);
  assert.equal(r.preMarketTime, new Date(1789730000 * 1000).toISOString());
  assert.equal(r.postMarketPrice, 10.1); assert.equal(r.marketState, 'PRE');
});

test('rows without a premarket print carry explicit nulls, never derived values', async () => {
  const fetchImpl = async () => okResponse({ quoteResponse: { result: [yahooRow({ preMarketPrice: undefined, preMarketVolume: undefined, preMarketTime: undefined, marketState: undefined })] } });
  const { rows } = await qp.yahooQuotes(['ABC'], { fetchImpl, authImpl: fakeAuth });
  assert.equal(rows[0].preMarketPrice, null); assert.equal(rows[0].preMarketVolume, null);
  assert.equal(rows[0].preMarketTime, null); assert.equal(rows[0].marketState, null);
  // spark rows carry the same null block so consumers see one shape
  const spark = await qp.yahooSparkQuotes(['ABC'], { fetchImpl: async () => okResponse({ spark: { result: [{ symbol: 'ABC', response: [{ meta: { regularMarketPrice: 5, chartPreviousClose: 4, regularMarketTime: 1 } }] }] } }) });
  assert.equal(spark.rows[0].preMarketPrice, null);
});

test('sessionQuote picks the premarket print in premarket and flags a missing one as regular-stale', () => {
  const withPrint = { price: 10, asOf: 'r', dayVolume: 1, preMarketPrice: 10.8, preMarketTime: 'p', preMarketVolume: 7, postMarketPrice: 10.1, postMarketTime: 'q' };
  assert.deepStrictEqual(qp.sessionQuote(withPrint, 'premarket'), { price: 10.8, asOf: 'p', volume: 7, basis: 'premarket' });
  assert.deepStrictEqual(qp.sessionQuote(withPrint, 'afterhours'), { price: 10.1, asOf: 'q', volume: null, basis: 'postmarket' });
  assert.deepStrictEqual(qp.sessionQuote(withPrint, 'regular'), { price: 10, asOf: 'r', volume: 1, basis: 'regular' });
  const noPrint = { price: 10, asOf: 'r', dayVolume: 1, preMarketPrice: null };
  assert.equal(qp.sessionQuote(noPrint, 'premarket').basis, 'regular-stale');
  assert.equal(qp.sessionQuote(null, 'premarket'), null);
});

test('fetchPremarketSnapshot maps rows, computes preRelVol vs FULL-DAY average and derives the change when the venue omits it', async () => {
  // Arrange — one venue-reported change, one derived, one without a print
  const fetchBulkQuotes = async () => ({
    rows: [
      { ticker: 'ABC', price: 10, prevClose: 10, avgVolume: 1_000_000, preMarketPrice: 10.8, preMarketChangePct: 8, preMarketVolume: 120_000, marketState: 'PRE' },
      { ticker: 'DEF', price: 20, prevClose: 20, avgVolume: 2_000_000, preMarketPrice: 19, preMarketChangePct: null, preMarketVolume: 50_000 },
      { ticker: 'GHI', price: 5, prevClose: 5, avgVolume: 500_000, preMarketPrice: null, preMarketVolume: null },
    ],
    coverage: { provider: 'yahoo-quote', degraded: false, volumeAvailable: true },
  });
  // Act
  const snap = await PM.fetchPremarketSnapshot(['abc', 'DEF', 'GHI', 'DEF'], { deps: { fetchBulkQuotes }, now: PRE });
  // Assert
  assert.equal(snap.session, 'premarket');
  assert.equal(snap.coverage.requested, 3); assert.equal(snap.coverage.returned, 3);
  assert.equal(snap.coverage.provider, 'yahoo-quote'); assert.equal(snap.coverage.degraded, false);
  assert.equal(snap.coverage.premarketPrints, 2);
  const by = Object.fromEntries(snap.rows.map(r => [r.ticker, r]));
  assert.equal(by.ABC.preRelVol, 0.12); assert.equal(by.ABC.preMarketChangePct, 8);
  assert.equal(by.DEF.preMarketChangePct, -5);          // derived: 19/20 − 1
  assert.equal(by.DEF.preRelVol, 0.025);
  assert.equal(by.GHI.preMarketPrice, null); assert.equal(by.GHI.preRelVol, null); assert.equal(by.GHI.preMarketChangePct, null);
  for (const r of snap.rows) assert.deepStrictEqual(Object.keys(r), ['ticker', 'prevClose', 'price', 'preMarketPrice', 'preMarketChangePct', 'preMarketVolume', 'postMarketPrice', 'postMarketChangePct', 'avgVolume', 'preRelVol', 'marketState']);
});

test('fetchPremarketSnapshot never throws on a provider failure — rows:[] + degraded with the reason', async () => {
  const snap = await PM.fetchPremarketSnapshot(['ABC'], { deps: { fetchBulkQuotes: async () => { throw new Error('boom 429'); } }, now: RTH });
  assert.deepStrictEqual(snap.rows, []);
  assert.equal(snap.coverage.degraded, true); assert.match(snap.coverage.reason, /boom/);
  assert.equal(snap.session, 'regular');
  const empty = await PM.fetchPremarketSnapshot([], { now: RTH });
  assert.equal(empty.coverage.requested, 0);
});

test('premarketGapLane: real print + |gap| ≥ threshold + participation floor + avg-volume floor, sorted by |gap| desc, direction labelled', () => {
  const rows = [
    { ticker: 'UP', prevClose: 10, preMarketPrice: 10.5, preRelVol: 0.10, avgVolume: 1_000_000 },     // +5
    { ticker: 'DOWN', prevClose: 10, preMarketPrice: 9.2, preRelVol: 0.06, avgVolume: 1_000_000 },    // −8
    { ticker: 'SMALLGAP', prevClose: 10, preMarketPrice: 10.2, preRelVol: 0.5, avgVolume: 1_000_000 }, // +2 (below 3)
    { ticker: 'THIN', prevClose: 10, preMarketPrice: 12, preRelVol: 0.01, avgVolume: 1_000_000 },     // no participation
    { ticker: 'ILLIQ', prevClose: 10, preMarketPrice: 12, preRelVol: 0.9, avgVolume: 100_000 },       // below avg-volume floor
    { ticker: 'NOPRINT', prevClose: 10, preMarketPrice: null, preRelVol: null, avgVolume: 1_000_000 },
  ];
  const lane = PM.premarketGapLane(rows);
  assert.deepStrictEqual(lane.map(x => x.ticker), ['DOWN', 'UP']);
  assert.deepStrictEqual(lane[0], { ticker: 'DOWN', gapPct: -8, preRelVol: 0.06, direction: 'down', prevClose: 10, preMarketPrice: 9.2 });
  assert.equal(lane[1].direction, 'up');
  // thresholds are parameters
  assert.equal(PM.premarketGapLane(rows, { minAbsGapPct: 1, minPreRelVol: 0, minAvgVolume: 0 }).length, 5);
  assert.deepStrictEqual(PM.premarketGapLane(null), []);
});

// ── mover-discovery: lane G fires on the premarket print before there is an open ───────────
test('evaluateLanes GAP_PREMARKET fires premarket on preGapPct + preRelVol, and only then', () => {
  const base = { price: 10, prevClose: 10, dayChangePct: 0, open: null, gapPct: null };
  // premarket, real gap, real participation → fires with basis premarket, holdingOpen null
  const hit = MD.evaluateLanes({ ...base, session: 'premarket', preGapPct: 6, preRelVol: 0.08 });
  assert.ok(hit.lanes.includes(MD.LANES.GAP_PREMARKET));
  assert.deepStrictEqual(hit.evidence.GAP_PREMARKET, { gapPct: 6, open: null, holdingOpen: null, basis: 'premarket', preRelVol: 0.08 });
  // thin participation → no lane
  assert.ok(!MD.evaluateLanes({ ...base, session: 'premarket', preGapPct: 6, preRelVol: 0.01 }).lanes.includes(MD.LANES.GAP_PREMARKET));
  // gap below threshold → no lane
  assert.ok(!MD.evaluateLanes({ ...base, session: 'premarket', preGapPct: DISCOVERY.GAP_MIN_PCT - 0.1, preRelVol: 0.5 }).lanes.includes(MD.LANES.GAP_PREMARKET));
  // same inputs outside premarket → the premarket branch must NOT fire (regular lane needs an open)
  assert.ok(!MD.evaluateLanes({ ...base, session: 'regular', preGapPct: 6, preRelVol: 0.08 }).lanes.includes(MD.LANES.GAP_PREMARKET));
  // the regular-hours contract is unchanged: gap + holding the open fires with basis regular
  const reg = MD.evaluateLanes({ ...base, session: 'regular', open: 10.5, price: 10.6, gapPct: 5 });
  assert.equal(reg.evidence.GAP_PREMARKET.basis, 'regular'); assert.equal(reg.evidence.GAP_PREMARKET.holdingOpen, true);
  assert.equal(DISCOVERY.PREMARKET_GAP_MIN_REL_VOL, 0.05);
});

test('buildCandidates in premarket reads the premarket print (preGapPct/preRelVol) and never fabricates one from the regular fields', () => {
  const nowIso = PRE.toISOString();
  const quotes = [
    { ticker: 'GAP', price: 10, prevClose: 10, dayVolume: 900_000, avgVolume: 1_000_000, asOf: nowIso, preMarketPrice: 10.6, preMarketVolume: 80_000 },
    { ticker: 'NOPRINT', price: 10, prevClose: 10, dayVolume: 900_000, avgVolume: 1_000_000, asOf: nowIso, preMarketPrice: null, preMarketVolume: null },
  ];
  const built = MD.buildCandidates({ quotes, now: PRE, minutesSinceOpen: -90, session: 'premarket' });
  const gap = built.candidates.find(c => c.ticker === 'GAP');
  assert.ok(gap, 'the premarket gapper is discovered');
  assert.ok(gap.discoverySources.includes(MD.LANES.GAP_PREMARKET));
  assert.equal(gap.preGapPct, 6); assert.equal(gap.preRelVol, 0.08); assert.equal(gap.sessionBasis, 'premarket');
  assert.equal(gap.gapPct, null, 'no open yet → the regular gap is unknown, not zero');
  assert.ok(!built.candidates.find(c => c.ticker === 'NOPRINT'), 'no print → nothing to discover');
  // outside premarket the premarket fields are null even when the row carries a print
  const rth = MD.buildCandidates({ quotes: [{ ...quotes[0], open: 10.4, price: 10.5, asOf: RTH.toISOString() }], now: RTH, minutesSinceOpen: 90, session: 'regular' });
  const c = rth.candidates.find(x => x.ticker === 'GAP');
  assert.ok(c); assert.equal(c.preMarketPrice, null); assert.equal(c.sessionBasis, 'regular'); assert.equal(c.gapPct, 4);
});

test('sessionStatus reads the calendar session (it used to read a field that does not exist)', () => {
  const { sessionStatus } = require('../lib/intraday-data');
  assert.equal(sessionStatus(PRE).session, 'PREMARKET');
  assert.equal(sessionStatus(RTH).session, 'REGULAR'); assert.equal(sessionStatus(RTH).isRegularHours, true);
  assert.equal(sessionStatus(new Date('2026-09-21T21:00:00Z')).session, 'AFTERHOURS');
  assert.equal(sessionStatus(new Date('2026-09-20T15:00:00Z')).session, 'CLOSED');   // Sunday
});
