'use strict';
// op=sessionboard route: injected deps, fail-soft sources, session-aware snapshot freshness,
// cache headers (no-store on empty/degraded), elapsedMs, tracker wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/session-board-routes');
const SB = require('../lib/session-board');

const PRE = new Date('2026-09-18T12:30:00Z');   // 08:30 ET premarket
const REG = new Date('2026-09-18T15:00:00Z');   // 11:00 ET
const SAT = new Date('2026-09-19T14:00:00Z');

const ROW = { id: 'screener:swing:ABC', ticker: 'ABC', section: 'screener', tier: 'Setup', scope: 'large', horizon: 'swing', side: 'long', entry: 101, stop: 95, target: 115, rr: 2.3, confidence: 70, price: 100 };
const TODAY = { regime: { riskOn: true, label: 'Risk-on' }, opportunity: { decision: 'selective', decisionLabel: 'Selective', maxExposurePct: 40, score: 55 }, sectors: { leading: [{ name: 'Tech', changePct: 1 }], weakening: [] }, horizons: { intraday: [], swing: [ROW], position: [], portfolio: [] }, researchByHorizon: { intraday: [], swing: [], position: [], portfolio: [] } };
const DAYTRADE = { lanes: { actionableNow: [], reversalReclaim: [], armed: [{ ticker: 'IOVA', tier: 'B', lifecycleState: 'ARMED', entry: 10, stop: 9, target: 13, rr: 3, last: 10.1, avgDollarVol: 30e6 }], managing: [], buildingWatch: [] } };
const SUMMARY = { groups: [], negativeLanes: [] };
const GOV = { strategies: [{ id: 'screener', section: 'screener', grade: 'promising', weight: 0 }] };
const MARKET = { mode: { mode: 'RISK_ON_TREND' }, indexes: { SPY: { dayReturnPct: 0.5 } }, marketDataAsOf: '2026-09-18T12:00:00Z' };

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

function deps(over = {}) {
  const calls = { premarket: [], live: 0, bars: [], writes: [] };
  const d = {
    now: () => PRE,
    pullToday: async () => TODAY,
    pullDaytrade: async () => DAYTRADE,
    readJSON: async (p) => (p === R.SNAPSHOT_PATH ? null : p === 'scoreboard/summary.json' ? SUMMARY : p === 'governance/latest.json' ? GOV : null),
    writeJSON: async (p, doc) => { calls.writes.push({ p, doc }); },
    hasStore: () => true,
    readMarketState: async () => MARKET,
    fetchPremarketSnapshot: async (tickers) => { calls.premarket.push(tickers); return { asOf: PRE.toISOString(), session: 'premarket', rows: [{ ticker: 'ABC', prevClose: 100, preMarketPrice: 103, preMarketChangePct: 3, preRelVol: 0.5 }, { ticker: 'GAPR', prevClose: 10, preMarketPrice: 11.5, preMarketChangePct: 15, preRelVol: 1.2 }], coverage: { requested: tickers.length, returned: 2 } }; },
    premarketGapLane: (rows) => rows.filter((r) => Math.abs(r.preMarketChangePct) >= 3).map((r) => ({ ticker: r.ticker, gapPct: r.preMarketChangePct, preRelVol: r.preRelVol, direction: 'up', prevClose: r.prevClose, preMarketPrice: r.preMarketPrice })),
    liveStatus: ({ row, quote }) => { calls.live++; return { status: quote && quote.preMarketPrice > (row && row.entry) ? 'triggered' : 'not-triggered', pct: { toEntry: 1, toStop: -5, toTarget: 14 }, vwap: null, orb: null, relVol: null, dayRangePct: null, note: null }; },
    fetchIntradayBatch: async (tickers) => { calls.bars.push(tickers); return tickers.map((t) => ({ ok: true, ticker: t, bars: [] })); },
    universe: () => ['ABC', 'GAPR', 'ZZZ'],
    ...over,
  };
  return { d, calls };
}

test('runSessionBoard: builds from injected sources, grades, persists, session-aware cache header', async () => {
  const { d, calls } = deps();
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  const p = res._json;
  assert.equal(p.ok, true);
  assert.equal(p.version, SB.VERSION);
  assert.equal(p.served, 'built');
  assert.equal(p.session.phase, 'premarket');
  assert.ok(Number.isFinite(p.elapsedMs));
  assert.equal(p.market.mode, 'RISK_ON_TREND');
  assert.equal(p.market.density.decision, 'selective');
  assert.equal(p.regime.state, 'risk-on');
  const tickers = p.items.map((i) => i.ticker);
  assert.ok(tickers.includes('ABC') && tickers.includes('IOVA') && tickers.includes('GAPR'));
  assert.equal(p.items.find((i) => i.ticker === 'ABC').live.status, 'triggered');
  assert.ok(p.items.every((i) => i.grade.letter !== 'A'), 'paper governance caps at B');
  assert.deepEqual(p.sources.map((s) => s.source).sort(), ['daytrade', 'governance', 'market', 'premarket', 'scoreboard', 'today']);
  assert.ok(p.sources.every((s) => s.ok === true));
  assert.equal(res._headers['Cache-Control'], 's-maxage=60, stale-while-revalidate=120');
  // premarket: the snapshot covers the board names PLUS the universe pools
  assert.deepEqual([...calls.premarket[0]].sort(), ['ABC', 'GAPR', 'IOVA', 'ZZZ']);
  assert.equal(calls.bars.length, 0, 'no intraday bars outside regular hours');
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].p, R.SNAPSHOT_PATH);
  assert.equal(p.persisted, true);
  assert.equal(p.governanceWeightSeen, false);
});

test('runSessionBoard: regular hours quotes only board names and fetches bars for the top N', async () => {
  const { d, calls } = deps({ now: () => REG });
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  assert.deepEqual([...calls.premarket[0]].sort(), ['ABC', 'IOVA']);
  assert.equal(calls.bars.length, 1);
  assert.ok(calls.bars[0].length <= R.LIVE_BARS_TOP_N);
  assert.ok(!res._json.items.some((i) => i.source === 'premarket-gap'), 'no gap lane during the session');
});

test('runSessionBoard: a failing source is reported, the board still builds, header is no-store', async () => {
  const { d } = deps({ pullDaytrade: async () => { throw new Error('daytrade down'); }, readMarketState: async () => null });
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  const p = res._json;
  assert.equal(p.ok, true);
  const dt = p.sources.find((s) => s.source === 'daytrade');
  assert.equal(dt.ok, false);
  assert.match(dt.reason, /daytrade down/);
  assert.equal(p.sources.find((s) => s.source === 'market').ok, false);
  assert.ok(p.items.some((i) => i.ticker === 'ABC'));
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('runSessionBoard: missing premarket/live modules degrade to unknown live and no gap lane', async () => {
  const { d } = deps({ fetchPremarketSnapshot: null, premarketGapLane: null, liveStatus: null });
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  const p = res._json;
  assert.equal(p.sources.find((s) => s.source === 'premarket').reason, 'module-missing');
  assert.equal(p.sources.find((s) => s.source === 'live').reason, 'module-missing');
  assert.ok(p.items.every((i) => i.live.status === 'unknown'));
  assert.ok(!p.items.some((i) => i.source === 'premarket-gap'));
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('runSessionBoard: empty board → empty:true, no-store, nothing persisted', async () => {
  const { d, calls } = deps({ pullToday: async () => ({ horizons: {}, researchByHorizon: {} }), pullDaytrade: async () => ({ lanes: {} }), fetchPremarketSnapshot: async () => ({ rows: [] }) });
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  assert.equal(res._json.empty, true);
  assert.equal(res._headers['Cache-Control'], 'no-store');
  assert.equal(calls.writes.length, 0);
});

test('runSessionBoard: a fresh persisted snapshot is served without rebuilding; ?refresh=1 rebuilds', async () => {
  const snap = { ok: true, version: SB.VERSION, generatedAt: new Date(PRE.getTime() - 30 * 1000).toISOString(), items: [{ ticker: 'X' }], heldOut: [], empty: false, sources: [{ source: 'today', ok: true }] };
  let built = 0;
  const { d } = deps({ readJSON: async (p) => (p === R.SNAPSHOT_PATH ? snap : null), pullToday: async () => { built++; return TODAY; } });
  const res = mockRes();
  await R.runSessionBoard({ query: {} }, res, d);
  assert.equal(res._json.served, 'persisted-snapshot');
  assert.equal(res._json.snapshotAgeMs, 30000);
  assert.equal(built, 0);
  const res2 = mockRes();
  await R.runSessionBoard({ query: { refresh: '1' } }, res2, d);
  assert.equal(res2._json.served, 'built');
  assert.equal(built, 1);
});

test('isFresh: 60s budget inside a session, 15 min when closed; future or undated → stale', () => {
  const at = (ms, now) => ({ generatedAt: new Date(now.getTime() - ms).toISOString() });
  assert.equal(R.isFresh(at(30 * 1000, PRE), PRE), true);
  assert.equal(R.isFresh(at(90 * 1000, PRE), PRE), false);
  assert.equal(R.isFresh(at(10 * 60 * 1000, SAT), SAT), true);
  assert.equal(R.isFresh(at(20 * 60 * 1000, SAT), SAT), false);
  assert.equal(R.isFresh(at(-5000, PRE), PRE), false);
  assert.equal(R.isFresh({}, PRE), false);
  assert.equal(R.SNAPSHOT_FRESH_MS, 60 * 1000);
  assert.equal(R.SNAPSHOT_FRESH_CLOSED_MS, 15 * 60 * 1000);
});

test('cacheHeaderFor: empty or any failed source → no-store; open vs closed budgets', () => {
  assert.equal(R.cacheHeaderFor({ empty: true, sources: [] }, 'regular'), 'no-store');
  assert.equal(R.cacheHeaderFor({ empty: false, sources: [{ ok: false }] }, 'regular'), 'no-store');
  assert.equal(R.cacheHeaderFor({ empty: false, sources: [{ ok: true }] }, 'premarket'), 's-maxage=60, stale-while-revalidate=120');
  assert.equal(R.cacheHeaderFor({ empty: false, sources: [{ ok: true }] }, 'closed'), 's-maxage=300, stale-while-revalidate=600');
});

test('maturityBySectionOf + daytradeRowsOf helpers', () => {
  const m = R.maturityBySectionOf({ strategies: [{ id: 'ghost', section: 'Ghost', grade: 'promising' }, { id: 'daytrade', grade: 'experimental' }] });
  assert.equal(m.Ghost, 'promising');
  assert.equal(m.daytrade, 'experimental');
  assert.deepEqual(R.maturityBySectionOf(null), {});
  assert.deepEqual(R.daytradeRowsOf(DAYTRADE).map((c) => c.ticker), ['IOVA']);
  assert.deepEqual(R.daytradeRowsOf(null), []);
});

test('PULL_TIMEOUT_MS clears the slowest measured dependency (op=today miss ~20s) with headroom', () => {
  const MEASURED_SLOWEST_MS = 20000;
  assert.ok(R.PULL_TIMEOUT_MS >= MEASURED_SLOWEST_MS * 1.5);
});

test('api/tracker wires op=sessionboard publicly and rate-limits it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'tracker.js'), 'utf8');
  assert.match(src, /op === 'sessionboard'\) return require\('\.\.\/lib\/session-board-routes'\)\.runSessionBoard/);
  const expensive = src.slice(src.indexOf('const EXPENSIVE_OPS'), src.indexOf(']);', src.indexOf('const EXPENSIVE_OPS')));
  assert.match(expensive, /'sessionboard'/);
  const privileged = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf(']);', src.indexOf('const PRIVILEGED_OPS')));
  assert.doesNotMatch(privileged, /'sessionboard'/);
});
