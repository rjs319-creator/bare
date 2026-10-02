'use strict';
// lib/options-gex-routes — the nightly tick (write-once per session, time-boxed, truncation
// recorded), the public read (empty → no-store), loadLatestGex, and the Session Board join
// (gammaFlipDistancePct on `live`, weight 0, never degrading the board).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/options-gex-routes');
const SBR = require('../lib/session-board-routes');

const NOW = Date.UTC(2026, 9, 1, 22, 30);   // Thu 2026-10-01 18:30 ET (after hours → session 2026-10-01)
const EXP = Math.floor(Date.UTC(2026, 9, 31) / 1000);
const contract = (strike, oi) => ({ strike, openInterest: oi, impliedVolatility: 0.25 });
const fullChain = (sym, spot = 100) => ({
  underlyingSymbol: sym, chainComplete: true, source: 'cboe-delayed', quote: { regularMarketPrice: spot },
  options: [{ expirationDate: EXP, calls: [100, 105, 110].map((k) => contract(k, 3000)), puts: [85, 90, 95].map((k) => contract(k, 3000)) }],
});

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}
function deps(over = {}) {
  const store = {};
  const d = {
    now: () => NOW, hasStore: () => true,
    readJSON: async (p, fb) => (p in store ? store[p] : (p === 'sessionboard/latest.json' ? { items: [{ ticker: 'IOVA' }, { ticker: 'bad ticker' }, { ticker: 'SPY' }], heldOut: [{ ticker: 'ZZZ' }] } : fb)),
    writeJSON: async (p, doc) => { store[p] = doc; },
    fetchChain: async (t) => (t === 'ZZZ' ? null : fullChain(t)),
    provider: () => ({ mode: 'cboe', order: ['cboe', 'yahoo'] }),
    ...over,
  };
  return { d, store };
}

test('boardTickers: validated, deduped against the core set, capped', () => {
  const t = R.boardTickers({ items: [{ ticker: 'spy' }, { ticker: 'IOVA' }, { ticker: 'IOVA' }, { ticker: 'x y' }], heldOut: [{ ticker: 'ZZZ' }] });
  assert.deepEqual(t, ['IOVA', 'ZZZ']);
  assert.equal(R.boardTickers({ items: Array.from({ length: 50 }, (_, i) => ({ ticker: `T${i}` })) }).length, R.MAX_BOARD_TICKERS);
  assert.deepEqual(R.boardTickers(null), []);
});

test('decisionSession: after-hours attests today; a weekend attests the last completed session', () => {
  assert.equal(R.decisionSession(new Date(NOW)), '2026-10-01');
  assert.equal(R.decisionSession(new Date(Date.UTC(2026, 9, 3, 12))), '2026-10-02');
});

test('tick: SPY + QQQ + board tickers → write-once session doc + latest; unavailable chains recorded with a reason', async () => {
  const { d, store } = deps();
  const res = mockRes();
  await R.runOptionsGexTick({ query: {} }, res, d);
  const out = res._json;
  assert.equal(out.ok, true); assert.equal(out.session, '2026-10-01'); assert.equal(out.tickers, 4); assert.equal(out.available, 3);
  const doc = store['optionsflow-v2/gex/2026-10-01.json'];
  assert.deepEqual(doc.tickers, ['SPY', 'QQQ', 'IOVA', 'ZZZ']);
  assert.equal(doc.weight, 0); assert.equal(doc.truncatedAt, null);
  const spy = doc.records.find((r) => r.ticker === 'SPY');
  assert.equal(spy.available, true); assert.ok(spy.gammaFlipDistancePct > 0); assert.ok(Array.isArray(spy.perStrike));
  assert.equal(spy.control.seed, 20261001, 'control seed is the session, so it is reproducible');
  const zzz = doc.records.find((r) => r.ticker === 'ZZZ');
  assert.equal(zzz.available, false); assert.match(zzz.reason, /no chain/);
  assert.deepEqual(store['optionsflow-v2/gex/latest.json'], doc);
  assert.equal(res._headers['Cache-Control'], 'no-store');

  // Idempotent: a second run on the same session is a no-op unless forced.
  const res2 = mockRes();
  let writes = 0;
  await R.runOptionsGexTick({ query: {} }, res2, { ...d, writeJSON: async () => { writes++; } });
  assert.equal(res2._json.skipped, 'session already captured'); assert.equal(writes, 0);
  const res3 = mockRes();
  await R.runOptionsGexTick({ query: { force: '1' } }, res3, { ...d, writeJSON: async () => { writes++; } });
  assert.equal(res3._json.ok, true); assert.equal(writes, 2);
});

test('tick: a fetch that throws is recorded per ticker, never aborts the doc; the deadline truncates and says so', async () => {
  const { d, store } = deps({ fetchChain: async (t) => { if (t === 'QQQ') throw new Error('ECONNRESET'); return fullChain(t); } });
  await R.runOptionsGexTick({ query: {} }, mockRes(), d);
  const qqq = store['optionsflow-v2/gex/2026-10-01.json'].records.find((r) => r.ticker === 'QQQ');
  assert.equal(qqq.available, false); assert.match(qqq.reason, /chain-fetch-error: ECONNRESET/);

  let t = NOW;
  const slow = await R.buildOverlay(['A', 'B', 'C'], { fetchChain: async (s) => { t += 60_000; return fullChain(s); }, now: () => t, deadlineMs: 100_000, concurrency: 1 });
  assert.equal(slow.records.length, 2); assert.equal(slow.truncatedAt, 2);
});

test('read: empty overlay → no-store empty envelope; populated → CDN-cached doc', async () => {
  const empty = mockRes();
  await R.runOptionsGexRead({ query: {} }, empty, { hasStore: () => true, readJSON: async () => null });
  assert.equal(empty._json.empty, true); assert.equal(empty._headers['Cache-Control'], 'no-store');
  const full = mockRes();
  await R.runOptionsGexRead({ query: {} }, full, { hasStore: () => true, readJSON: async () => ({ session: 's', records: [{ ticker: 'SPY', available: true }] }) });
  assert.equal(full._json.records.length, 1); assert.match(full._headers['Cache-Control'], /s-maxage/);
  const nostore = mockRes();
  await R.runOptionsGexRead({ query: {} }, nostore, { hasStore: () => false });
  assert.equal(nostore._json.ok, false);
});

test('loadLatestGex: ticker map of available records only; {} without a store or doc', async () => {
  const doc = { session: '2026-10-01', records: [{ ticker: 'SPY', available: true, gammaFlipDistancePct: 1.5, gammaFlip: 98.5, asOf: 'T' }, { ticker: 'ZZZ', available: false }] };
  const m = await R.loadLatestGex({ hasStore: () => true, readJSON: async () => doc });
  assert.deepEqual(m, { SPY: { gammaFlipDistancePct: 1.5, gammaFlip: 98.5, asOf: 'T', session: '2026-10-01' } });
  assert.deepEqual(await R.loadLatestGex({ hasStore: () => false }), {});
  assert.deepEqual(await R.loadLatestGex({ hasStore: () => true, readJSON: async () => { throw new Error('x'); } }), {});
});

test('session board: withGexOverlay attaches gammaFlipDistancePct to live (null when absent) without mutating inputs', () => {
  const live = { SPY: { status: 'in-zone', pct: {} }, ABC: { status: 'triggered' } };
  const gex = { SPY: { gammaFlipDistancePct: 2.1, gammaFlip: 97.9, asOf: 'T' }, LONE: { gammaFlipDistancePct: -0.5, gammaFlip: 50, asOf: 'T' } };
  const out = SBR.withGexOverlay(live, gex, ['SPY', 'ABC', 'LONE', 'NONE']);
  assert.equal(out.SPY.gammaFlipDistancePct, 2.1); assert.equal(out.SPY.gammaFlip, 97.9); assert.equal(out.SPY.status, 'in-zone');
  assert.equal(out.ABC.gammaFlipDistancePct, null);
  assert.equal(out.LONE.status, 'unknown'); assert.equal(out.LONE.gammaFlipDistancePct, -0.5);
  assert.equal(out.NONE, undefined, 'no live and no overlay → the board supplies its own default');
  assert.deepEqual(live.SPY, { status: 'in-zone', pct: {} }, 'input not mutated');
});

test('session board: the live score ignores the overlay (weight 0) and a failed overlay never degrades the board', async () => {
  const SB = require('../lib/session-board');
  const a = SB._components.liveScore({ status: 'in-zone' }, null, false);
  const b = SB._components.liveScore({ status: 'in-zone', gammaFlipDistancePct: 40 }, null, false);
  assert.equal(a, b);
  // frontend pin: the live row renders the labelled γ-flip read
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../public/js/session-board.js'), 'utf8');
  assert.match(src, /gammaFlipDistancePct/); assert.match(src, /weight 0/);
});
