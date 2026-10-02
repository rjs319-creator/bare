'use strict';
// op=paperopen / op=paperpoll / op=paperexec driven end-to-end with an in-memory CAS store
// and a stub Alpaca client: dormant without keys, idempotent placement via client_order_id,
// union-monotonic polls, exit arming for stop_limit parents, intraday flatten, read op.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const R = require('../lib/exec-paper-routes');
const SB = require('../lib/session-board');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'session-board-sample.json'), 'utf8'));
const DATE = '2026-09-18';                              // a Friday
const REG = new Date('2026-09-18T15:00:00Z');           // 11:00 ET — regular session
const CLOSED = new Date('2026-09-19T15:00:00Z');        // Saturday
const ENV = { ALPACA_KEY_ID: 'PKTEST1234567890ABCD', ALPACA_SECRET_KEY: 's', ALPACA_PAPER: '1' };
const snapshotFor = (date) => ({ ...JSON.parse(JSON.stringify(FIXTURE)), generatedAt: `${date}T13:31:00.000Z`, session: { ...FIXTURE.session, etDate: date, phase: 'regular' } });

test.before(() => { assert.equal(SB.sessionPhase(REG).phase, 'regular', 'test instant must be inside the regular session'); });

// In-memory store with the updateJSON (CAS) contract: mutateFn(current|initial) → new doc or the input to skip.
function memStore(seed = {}) {
  const docs = new Map(Object.entries(seed));
  return {
    docs,
    hasStore: () => true,
    readJSON: async (p) => (docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : null),
    updateJSON: async (p, fn, { initial = null } = {}) => {
      const cur = docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : initial;
      const next = await fn(cur);
      if (next === cur) return { written: false, value: cur };
      docs.set(p, next);
      return { written: true, value: next };
    },
  };
}

// Stub Alpaca client: records calls; programmable per-client_order_id failures and order listings.
function stubClient({ failIds = new Set(), orders = [] } = {}) {
  const calls = { place: [], list: [], close: [] };
  let seq = 0;
  return {
    calls,
    client: {
      placeOrder: async (body) => {
        calls.place.push(body);
        if (failIds.has(body.client_order_id)) return { ok: false, status: 422, error: 'rejected by stub' };
        return { ok: true, order: { id: `ord-${++seq}`, client_order_id: body.client_order_id, symbol: body.symbol, status: 'accepted' }, duplicate: false };
      },
      listOrders: async (q) => { calls.list.push(q); return orders; },
      closePosition: async (symbol) => { calls.close.push(symbol); return { ok: true, order: { id: `flat-${symbol}`, client_order_id: 'alpaca-gen', symbol, status: 'accepted', type: 'market', side: 'sell' } }; },
    },
  };
}

function deps(over = {}) {
  const store = over.store || memStore();
  const stub = over.stub || stubClient();
  const d = {
    now: () => REG, env: ENV, hasStore: store.hasStore, readJSON: store.readJSON, updateJSON: store.updateJSON,
    pullSnapshot: async () => snapshotFor(DATE), createClient: () => stub.client, fetchDailyBars: async () => ({}),
    ...over.deps,
  };
  return { d, store, stub };
}
function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

test('dormant: without Alpaca env every op is ok:true skipped with the reason — no store, no client, no snapshot pull', async () => {
  let touched = 0;
  const { d } = deps({ deps: { env: {}, pullSnapshot: async () => { touched++; }, createClient: () => { touched++; } } });
  const open = await R.openCore(d);
  assert.equal(open.ok, true); assert.equal(open.skipped, true); assert.equal(open.dormant, true); assert.match(open.reason, /not set/);
  const poll = await R.pollCore(d);
  assert.equal(poll.skipped, true); assert.equal(poll.dormant, true);
  assert.equal(touched, 0);
  const res = mockRes();
  await R.runPaperOpen({ query: {} }, res, d);
  assert.equal(res._status, 200); assert.equal(res._json.skipped, true); assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('openCore: outside the regular session → skipped (unless force=1); no snapshot → skipped', async () => {
  const a = deps({ deps: { now: () => CLOSED } });
  const r = await R.openCore(a.d);
  assert.equal(r.skipped, true); assert.equal(r.reason, 'market-closed');
  assert.equal(a.stub.calls.place.length, 0);
  const b = deps({ deps: { pullSnapshot: async () => ({ ok: false, empty: true, items: [] }) } });
  assert.equal((await R.openCore(b.d)).reason, 'no-snapshot');
  const c = deps({ deps: { pullSnapshot: async () => snapshotFor('2026-09-17') } });
  assert.equal((await R.openCore(c.d)).reason, 'snapshot-date-mismatch');
});

test('openCore: plans from the pulled snapshot, places one order per A/B row, writes the ledger; a re-run is idempotent', async () => {
  const { d, store, stub } = deps();
  const r = await R.openCore(d);
  assert.equal(r.ok, true); assert.equal(r.date, DATE); assert.equal(r.snapshotId, `sb-${DATE}`);
  assert.equal(r.planned, 2); assert.equal(r.placed, 2); assert.deepEqual(r.failed, []); assert.equal(r.notPlaced, 3);
  assert.deepEqual(stub.calls.place.map((b) => b.symbol).sort(), ['ABCD', 'IJKL']);
  const doc = store.docs.get(R.ledgerPath(DATE));
  assert.equal(doc.version, 'paper-exec-v1');
  assert.equal(Object.values(doc.placed).filter((p) => p.ok).length, 2);
  assert.ok(doc.placedAt);
  assert.equal(doc.rows.length, 2);
  assert.deepEqual(doc.snapshotRowIds, FIXTURE.items.map((i) => i.id));
  // second call: nothing re-placed, snapshot not re-pulled
  const d2 = { ...d, pullSnapshot: async () => { throw new Error('must not pull'); } };
  const again = await R.openCore(d2);
  assert.equal(again.alreadyPlaced, true); assert.equal(stub.calls.place.length, 2);
});

test('openCore: a rejected placement is recorded with its error and retried alone on the next run', async () => {
  const stub = stubClient({ failIds: new Set([`sb-${DATE}:gapgo:intraday:ABCD`]) });
  const { d, store } = deps({ stub });
  const r = await R.openCore(d);
  assert.equal(r.placed, 1); assert.deepEqual(r.failed.map((f) => f.symbol), ['ABCD']); assert.match(r.failed[0].error, /rejected by stub/);
  const doc = store.docs.get(R.ledgerPath(DATE));
  assert.equal(doc.placed[`sb-${DATE}:gapgo:intraday:ABCD`].ok, false);
  stub.client.placeOrder = async (body) => { stub.calls.place.push(body); return { ok: true, order: { id: 'late', client_order_id: body.client_order_id, symbol: body.symbol, status: 'accepted' } }; };
  const r2 = await R.openCore(d);
  assert.equal(r2.placed, 1); assert.equal(r2.alreadyPlaced, undefined);
  assert.deepEqual(stub.calls.place.slice(2).map((b) => b.symbol), ['ABCD'], 'only the failed row is retried');
  assert.equal(store.docs.get(R.ledgerPath(DATE)).placed[`sb-${DATE}:gapgo:intraday:ABCD`].orderId, 'late');
});

test('pollCore: no ledger → skipped; with fills → exits armed for stop_limit parents, flatten closes open INTRADAY rows, polls union-monotonic', async () => {
  const { d, store, stub } = deps();
  assert.equal((await R.pollCore(d)).reason, 'no-ledger');
  await R.openCore(d);
  const cidABCD = `sb-${DATE}:gapgo:intraday:ABCD`, cidIJKL = `sb-${DATE}:coremo:portfolio:IJKL`;
  const filled = (id, cid, symbol, extra = {}) => ({ id, client_order_id: cid, symbol, status: 'filled', side: 'buy', type: 'stop_limit', qty: '1', filled_qty: '1', filled_avg_price: '21.45', filled_at: `${DATE}T14:00:00Z`, legs: null, ...extra });
  const placedIds = Object.fromEntries(Object.entries(store.docs.get(R.ledgerPath(DATE)).placed).map(([k, v]) => [k, v.orderId]));
  // poll 1: ABCD (stop_limit parent) filled; IJKL (bracket) still resting; a foreign order is ignored
  stub.client.listOrders = async (q) => { stub.calls.list.push(q); return [
    filled(placedIds[cidABCD], cidABCD, 'ABCD'),
    { id: placedIds[cidIJKL], client_order_id: cidIJKL, symbol: 'IJKL', status: 'new', type: 'limit', side: 'buy', legs: [{ id: 'leg-tp', symbol: 'IJKL', status: 'held', type: 'limit', side: 'sell' }] },
    { id: 'foreign', client_order_id: 'someone-else', symbol: 'ZZZ', status: 'filled' },
  ]; };
  const p1 = await R.pollCore(d);
  assert.equal(p1.ok, true); assert.equal(p1.filled, 1); assert.equal(p1.exitsArmed, 1); assert.equal(p1.flattened, 0);
  assert.equal(stub.calls.list[0].after, `${DATE}T00:00:00Z`);
  const armed = stub.calls.place.find((b) => b.order_class === 'oco');
  assert.equal(armed.client_order_id, `${cidABCD}:exit`); assert.equal(armed.side, 'sell'); assert.equal(armed.take_profit.limit_price, '23.60');
  let doc = store.docs.get(R.ledgerPath(DATE));
  assert.equal(doc.orders.foreign, undefined, 'orders outside this snapshot never enter the ledger');
  assert.equal(doc.rows.find((r) => r.rowId === 'gapgo:intraday:ABCD').fillPx, 21.45);
  assert.equal(doc.placed[`${cidABCD}:exit`].ok, true);
  assert.equal(doc.polls.length, 1);
  // poll 2 (flatten): a STALE listing says ABCD is 'new' again — must not regress; the intraday row is flattened once
  stub.client.listOrders = async () => [{ ...filled(placedIds[cidABCD], cidABCD, 'ABCD'), status: 'new', filled_qty: '0', filled_avg_price: null, filled_at: null }];
  const p2 = await R.pollCore(d, { flatten: true });
  assert.equal(p2.flattened, 1); assert.deepEqual(stub.calls.close, ['ABCD']);
  doc = store.docs.get(R.ledgerPath(DATE));
  assert.equal(doc.orders[placedIds[cidABCD]].status, 'filled');
  assert.equal(doc.placed[`${cidABCD}:flat`].orderId, 'flat-ABCD');
  assert.equal(doc.polls.length, 2);
  // poll 3: the flat order filled → exitKind horizon with realized R vs frozen risk (21.4 − 20.3 = 1.1)
  stub.client.listOrders = async () => [filled('flat-ABCD', 'alpaca-gen', 'ABCD', { type: 'market', side: 'sell', filled_avg_price: '22.00', filled_at: `${DATE}T19:52:00Z` })];
  const p3 = await R.pollCore(d, { flatten: true });
  assert.equal(p3.flattened, 0, 'already flattened — never closed twice');
  const row = store.docs.get(R.ledgerPath(DATE)).rows.find((r) => r.rowId === 'gapgo:intraday:ABCD');
  assert.equal(row.exitKind, 'horizon'); assert.equal(row.exitPx, 22); assert.equal(row.realizedR, +((22 - 21.45) / 1.1).toFixed(3));
});

test('pollCore: a broker error fails closed (ok:false, nothing written)', async () => {
  const { d, store, stub } = deps();
  await R.openCore(d);
  const before = JSON.stringify(store.docs.get(R.ledgerPath(DATE)));
  stub.client.listOrders = async () => { throw new Error('alpaca-paper /orders: HTTP 503'); };
  const res = mockRes();
  await R.runPaperPoll({ query: {} }, res, d);
  assert.equal(res._status, 502); assert.equal(res._json.ok, false); assert.match(res._json.error, /503/);
  assert.equal(JSON.stringify(store.docs.get(R.ledgerPath(DATE))), before);
});

test('runPaperExec: no ledger → exists:false no-store; with a ledger → summary + rows, CDN-cached; compare=1 pulls daily bars; bad date rejected', async () => {
  const { d, store } = deps();
  let res = mockRes();
  await R.runPaperExec({ query: {} }, res, d);
  assert.deepEqual(res._json, { ok: true, exists: false, date: DATE });
  assert.equal(res._headers['Cache-Control'], 'no-store');
  await R.openCore(d);
  res = mockRes();
  await R.runPaperExec({ query: { date: DATE } }, res, d);
  assert.equal(res._json.exists, true); assert.equal(res._json.summary.placed, 2); assert.equal(res._json.rows.length, 2); assert.equal(res._json.notPlaced.length, 3);
  assert.equal(res._json.summary.reconciliation.ok, true);
  assert.equal(res._json.summary.compare, null);
  assert.match(res._headers['Cache-Control'], /s-maxage=60/);
  const asked = [];
  const d2 = { ...d, fetchDailyBars: async (tickers, date) => { asked.push([tickers, date]); return { ABCD: { open: 21, high: 24, low: 20, close: 23 } }; } };
  res = mockRes();
  await R.runPaperExec({ query: { date: DATE, compare: '1' } }, res, d2);
  assert.deepEqual(asked, [[['ABCD', 'IJKL'], DATE]]);
  assert.equal(res._json.summary.compare.counts.sameDayAmbiguous, 1);
  res = mockRes();
  await R.runPaperExec({ query: { date: 'yesterday' } }, res, d);
  assert.equal(res._status, 400);
  assert.equal(store.docs.size, 1);
});

test('tracker wiring: paperopen/paperpoll are PRIVILEGED, all three ops routed to lib/exec-paper-routes', () => {
  const src = readFileSync(join(__dirname, '..', 'api', 'tracker.js'), 'utf8');
  const priv = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'paperopen', 'paperpoll'/);
  assert.match(src, /op === 'paperopen'\) return require\('\.\.\/lib\/exec-paper-routes'\)\.runPaperOpen/);
  assert.match(src, /op === 'paperpoll'\) return require\('\.\.\/lib\/exec-paper-routes'\)\.runPaperPoll/);
  assert.match(src, /op === 'paperexec'\) return require\('\.\.\/lib\/exec-paper-routes'\)\.runPaperExec/);
  assert.ok(!priv.includes("'paperexec'"), 'the read op stays public');
});
