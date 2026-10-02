'use strict';
// lib/house-book-routes — op=housebooktick (privileged, idempotent, time-budgeted, CAS
// persisted), op=housebook (public read + perf metrics), op=mybook (validated client rows).
// Every side effect is injected; no network, no Blob.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/house-book-routes');
const PP = require('../lib/paper-portfolio');

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c, volume: 1e6 });
const D = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
const PRICES = {
  ABC: [bar(D[0], 99, 101, 98, 100), bar(D[1], 100, 103, 99, 102), bar(D[2], 102, 106, 101, 105), bar(D[3], 105, 116, 104, 114), bar(D[4], 114, 115, 112, 113)],
  DEF: [bar(D[0], 49, 50, 48, 50), bar(D[1], 50, 52, 49, 51), bar(D[2], 51, 52, 50, 51.5), bar(D[3], 51, 52, 50, 51), bar(D[4], 51, 52, 50, 51)],
  MNO: [bar(D[0], 99, 101, 98, 100), bar(D[1], 101, 102, 99, 101), bar(D[2], 101, 103, 100, 102), bar(D[3], 102, 104, 101, 103), bar(D[4], 103, 104, 101, 103)],
  SPY: [bar(D[0], 499, 501, 498, 500), bar(D[1], 500, 502, 499, 501), bar(D[2], 501, 503, 500, 502), bar(D[3], 502, 504, 501, 503), bar(D[4], 503, 505, 502, 504)],
};
const item = (ticker, letter, horizon, section, levels = {}) => ({ id: `${section}:${horizon}:${ticker}`, ticker, side: 'long', horizon, timeframe: { key: horizon }, section, tier: 'X', grade: { letter }, levels: { stop: levels.stop ?? null, target: levels.target ?? null }, flags: { heldOut: false } });
const SNAPSHOT = { version: 'session-board-v1', generatedAt: '2026-09-14T21:00:00Z', session: { phase: 'afterhours', etDate: D[0] }, items: [item('ABC', 'A', 'swing', 'Ignition', { stop: 95, target: 115 }), item('DEF', 'B', 'intraday', 'daytrade'), item('MNO', 'B', 'position', 'CERN', { stop: 80, target: 130 })] };
const SUMMARY = { groups: [{ section: 'Ignition' }, { section: 'daytrade' }] };
const FRI_EVENING = new Date('2026-09-18T22:05:00Z');   // 18:05 ET — session 09-18 is due

// A tiny in-memory Blob with CAS-shaped updateJSON (mutate must return a new object).
function fakeStore(seed = {}) {
  const docs = { ...seed };
  const calls = { history: [], updates: [] };
  return {
    docs, calls,
    readJSON: async (p, fallback = null) => (p in docs ? docs[p] : fallback),
    updateJSON: async (p, fn, { initial = null } = {}) => { const cur = p in docs ? docs[p] : initial; const next = fn(cur); assert.notEqual(next, cur, 'mutateFn must return a new object'); docs[p] = next; calls.updates.push(p); return { doc: next }; },
    hasStore: () => true,
    history: async (t) => { calls.history.push(t); if (!PRICES[t]) throw new Error(`no data for ${t}`); return { candles: PRICES[t] }; },
  };
}
function mockRes() { return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } }; }

test('tickCore: advances the book to the due session and persists state + equity via CAS', async () => {
  const st = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT, [R.SUMMARY_PATH]: SUMMARY });
  const out = await R.tickCore({ ...st, now: () => FRI_EVENING });
  assert.equal(out.ok, true);
  assert.equal(out.noop, false);
  assert.equal(out.asOfDate, D[4]);
  assert.equal(out.fills, 3);
  assert.equal(out.exits, 2);
  assert.deepEqual(out.unpriced, []);
  assert.equal(out.reconcile, 'ok');
  assert.deepEqual(st.calls.updates, [R.STATE_PATH, R.EQUITY_PATH]);
  const state = st.docs[R.STATE_PATH];
  assert.equal(state.version, PP.VERSION);
  assert.equal(Object.keys(state.positions).length, 1);
  assert.equal(state.closed.length, 2);
  assert.equal(state.lastSessionDate, D[4]);
  assert.deepEqual(st.docs[R.EQUITY_PATH].points.map((p) => p.date), [D[4]]);
  assert.ok(st.calls.history.includes('SPY'), 'SPY is always priced (benchmark leg)');
});

test('tickCore: idempotent per date — a re-run is a no-op that fetches nothing and writes nothing', async () => {
  const st = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT, [R.SUMMARY_PATH]: SUMMARY });
  await R.tickCore({ ...st, now: () => FRI_EVENING });
  const before = JSON.stringify(st.docs);
  st.calls.history.length = 0; st.calls.updates.length = 0;
  const again = await R.tickCore({ ...st, now: () => FRI_EVENING });
  assert.equal(again.ok, true);
  assert.equal(again.noop, true);
  assert.deepEqual(st.calls.history, []);
  assert.deepEqual(st.calls.updates, []);
  assert.equal(JSON.stringify(st.docs), before);
});

test('tickCore: nothing to do (no board, no book) writes nothing; no due session is reported, not invented', async () => {
  const st = fakeStore();
  const out = await R.tickCore({ ...st, now: () => FRI_EVENING });
  assert.equal(out.ok, true);
  assert.equal(out.noop, true);
  assert.deepEqual(st.calls.updates, []);
  const st2 = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT });
  const none = await R.tickCore({ ...st2, now: () => FRI_EVENING, sessionDue: () => null });
  assert.equal(none.ok, false);
  assert.match(none.error, /no settled session/);
});

test('tickCore: budgets by time — tickers not priced inside the budget stay pending and are reported', async () => {
  const st = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT });
  let t = 0;
  const now = () => new Date(FRI_EVENING.getTime() + t);
  const slow = async (tk) => { t += 1000; return st.history(tk); };
  const out = await R.tickCore({ ...st, now, history: slow, fetchBudgetMs: 1500 });
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true);
  assert.ok(out.unpriced.length >= 1);
  assert.ok(st.calls.history[0] === 'SPY', 'the benchmark is fetched first, before the budget can run out');
  const state = st.docs[R.STATE_PATH];
  assert.equal(state.pending.length, out.unpriced.length, 'unpriced rows wait for the next tick');
});

test('tickCore: a failed candle fetch prices the rest and lists the failure (fail-soft per name)', async () => {
  const snap = { ...SNAPSHOT, items: [...SNAPSHOT.items, item('NOPE', 'A', 'swing', 'Ignition')] };
  const st = fakeStore({ [R.SNAPSHOT_PATH]: snap });
  const out = await R.tickCore({ ...st, now: () => FRI_EVENING });
  assert.equal(out.ok, true);
  assert.equal(out.fills, 3);
  assert.deepEqual(out.unpriced, ['NOPE']);
});

test('runHouseBookTick: 503-shaped refusal without storage; a thrown step is a 502 that wrote nothing', async () => {
  const res = mockRes();
  await R.runHouseBookTick({ query: {} }, res, { hasStore: () => false });
  assert.equal(res._json.ok, false);
  const res2 = mockRes();
  const st = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT });
  await R.runHouseBookTick({ query: {} }, res2, { ...st, now: () => FRI_EVENING, history: async () => { throw new Error('boom'); }, sessionDue: () => { throw new Error('calendar down'); } });
  assert.equal(res2._status, 502);
  assert.match(res2._json.error, /calendar down/);
  assert.deepEqual(st.calls.updates, []);
  assert.equal(res2._headers['Cache-Control'], 'no-store');
});

test('runHouseBook: public read — book, equity vs SPY, exact perf metrics, reconciliation; cached only when populated', async () => {
  const st = fakeStore({ [R.SNAPSHOT_PATH]: SNAPSHOT, [R.SUMMARY_PATH]: SUMMARY });
  await R.tickCore({ ...st, now: () => FRI_EVENING });
  // A second equity point so the metrics have one return.
  st.docs[R.EQUITY_PATH] = PP.appendEquityPoint(st.docs[R.EQUITY_PATH], { date: '2026-09-21', equity: st.docs[R.EQUITY_PATH].points[0].equity * 1.01, cash: 0, openPositions: 1, spyClose: 509.04 });
  const res = mockRes();
  await R.runHouseBook({ query: {} }, res, st);
  const p = res._json;
  assert.equal(p.ok, true);
  assert.equal(p.state, 'SHADOW');
  assert.equal(p.weight, 0);
  assert.equal(p.asOfDate, D[4]);
  assert.equal(p.book.openPositions.length, 1);
  assert.equal(p.book.recentClosed.length, 2);
  assert.equal(p.equity.points.length, 2);
  assert.equal(p.metrics.n, 1);
  assert.ok(Math.abs(p.metrics.totalReturn - 0.01) < 1e-9, 'exact precision, never rounded');
  assert.ok(Math.abs(p.metrics.benchmarkTotalReturn - 0.01) < 1e-9);
  assert.equal(p.reconcile.status, 'ok');
  assert.match(res._headers['Cache-Control'], /s-maxage/);
  const empty = mockRes();
  await R.runHouseBook({ query: {} }, empty, fakeStore());
  assert.equal(empty._json.ok, true);
  assert.equal(empty._json.empty, true);
  assert.equal(empty._headers['Cache-Control'], 'no-store');
});

test('parseClientRows: strict validation at the boundary', () => {
  const ok = R.parseClientRows('ABC~2026-09-14T21:00:00Z~swing~95~115~A~Ignition,DEF~2026-09-14~intraday~~~B~daytrade');
  assert.equal(ok.error, null);
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.rows[0].signalDate, D[0], 'an ISO timestamp resolves to the last completed session');
  assert.equal(ok.rows[0].stop, 95);
  assert.equal(ok.rows[1].stop, null);
  assert.equal(ok.rows[1].costTier, 'liquid');
  assert.match(R.parseClientRows('').error, /no rows/);
  assert.match(R.parseClientRows('ab$c~2026-09-14~swing~~~A~x').error, /ticker/);
  assert.match(R.parseClientRows('ABC~yesterday~swing~~~A~x').error, /date/);
  assert.match(R.parseClientRows('ABC~2026-09-14~weekly~~~A~x').error, /time frame/);
  assert.match(R.parseClientRows('ABC~2026-09-14~swing~abc~~A~x').error, /stop/);
  const many = new Array(R.MY_BOOK_MAX_ROWS + 1).fill('ABC~2026-09-14~swing~~~A~x').join(',');
  assert.match(R.parseClientRows(many).error, /at most/);
});

test('runMyBook: simulates the caller’s rows under the same policy and returns per-row status + metrics', async () => {
  const st = fakeStore();
  const res = mockRes();
  await R.runMyBook({ query: { rows: 'ABC~2026-09-14T21:00:00Z~swing~95~115~A~Ignition,MNO~2026-09-14~position~80~130~B~CERN' } }, res, { ...st, now: () => FRI_EVENING });
  const p = res._json;
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  const abc = p.rows.find((r) => r.ticker === 'ABC');
  assert.equal(abc.status, 'closed');
  assert.equal(abc.exit.reason, 'target');
  assert.ok(Math.abs(abc.fillPrice - 100.3) < 1e-9);
  const mno = p.rows.find((r) => r.ticker === 'MNO');
  assert.equal(mno.status, 'open');
  assert.equal(mno.mark.price, 103);
  assert.equal(p.equity.points.length, 4, 'one point per session from the first fill');
  assert.equal(p.metrics.n, 3);
  assert.match(res._headers['Cache-Control'], /s-maxage/);
  const bad = mockRes();
  await R.runMyBook({ query: { rows: 'bad' } }, bad, st);
  assert.equal(bad._status, 400);
  assert.equal(bad._json.ok, false);
});
