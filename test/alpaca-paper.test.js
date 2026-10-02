'use strict';
// lib/alpaca-paper — raw-fetch client for the Alpaca PAPER REST API, driven offline by a
// stub fetch. Pins the refusal rules (paper key + ALPACA_PAPER=1), headers, base URL,
// bounded retries, strict response validation and duplicate-client-order-id detection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/alpaca-paper');

const ENV = { ALPACA_KEY_ID: 'PKTEST1234567890ABCD', ALPACA_SECRET_KEY: 'secret-xyz', ALPACA_PAPER: '1' };

// Programmable fetch stub: responses is a queue of { status, json } (or an Error to throw).
function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error('stub exhausted');
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.json, text: async () => JSON.stringify(next.json) };
  };
  return { fetchImpl, calls };
}
const noSleep = async () => {};
const order = (over = {}) => ({ id: 'o1', client_order_id: 'c1', symbol: 'ABCD', status: 'accepted', side: 'buy', type: 'limit', qty: '1', filled_qty: '0', ...over });

test('paperConfig: dormant until both keys exist, ALPACA_PAPER=1 and the key id looks like a paper key', () => {
  assert.deepEqual(A.paperConfig({}), { enabled: false, reason: 'ALPACA_KEY_ID / ALPACA_SECRET_KEY not set', keyId: null, secretKey: null });
  assert.equal(A.paperConfig({ ...ENV, ALPACA_PAPER: undefined }).reason, 'ALPACA_PAPER is not "1"');
  assert.equal(A.paperConfig({ ...ENV, ALPACA_PAPER: 'true' }).reason, 'ALPACA_PAPER is not "1"');
  assert.match(A.paperConfig({ ...ENV, ALPACA_KEY_ID: 'AKLIVE1234567890ABCD' }).reason, /does not look like a paper key/);
  const ok = A.paperConfig(ENV);
  assert.equal(ok.enabled, true); assert.equal(ok.reason, null); assert.equal(ok.keyId, ENV.ALPACA_KEY_ID);
});

test('createAlpacaPaperClient refuses to construct when the config is not enabled', () => {
  assert.throws(() => A.createAlpacaPaperClient({ env: { ...ENV, ALPACA_KEY_ID: 'AKLIVE1234567890ABCD' } }), /does not look like a paper key/);
  assert.throws(() => A.createAlpacaPaperClient({ env: {} }), /not set/);
});

test('requests: paper base URL only, both auth headers, query string, JSON body', async () => {
  const { fetchImpl, calls } = stubFetch([{ status: 200, json: [order()] }, { status: 200, json: order({ id: 'o9' }) }]);
  const c = A.createAlpacaPaperClient({ env: ENV, fetchImpl, sleep: noSleep });
  const list = await c.listOrders({ after: '2026-09-21T00:00:00Z' });
  assert.equal(list.length, 1);
  assert.ok(calls[0].url.startsWith('https://paper-api.alpaca.markets/v2/orders?'), calls[0].url);
  assert.match(calls[0].url, /status=all/); assert.match(calls[0].url, /nested=true/); assert.match(calls[0].url, /after=2026-09-21T00%3A00%3A00Z/); assert.match(calls[0].url, /limit=500/);
  assert.equal(calls[0].headers['APCA-API-KEY-ID'], ENV.ALPACA_KEY_ID);
  assert.equal(calls[0].headers['APCA-API-SECRET-KEY'], ENV.ALPACA_SECRET_KEY);
  const placed = await c.placeOrder({ symbol: 'ABCD', qty: '1', side: 'buy', type: 'limit', client_order_id: 'c9' });
  assert.equal(placed.ok, true); assert.equal(placed.order.id, 'o9');
  assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].body.client_order_id, 'c9');
  assert.equal(calls[1].headers['content-type'], 'application/json');
  assert.equal(c.baseUrl, A.PAPER_BASE_URL);
});

test('retries: 503 / 429 / network error retried with backoff up to MAX_ATTEMPTS; 4xx never retried', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const s1 = stubFetch([{ status: 503, json: { message: 'down' } }, new Error('ECONNRESET'), { status: 200, json: { id: 'acct', status: 'ACTIVE' } }]);
  const c1 = A.createAlpacaPaperClient({ env: ENV, fetchImpl: s1.fetchImpl, sleep });
  const acct = await c1.account();
  assert.equal(acct.status, 'ACTIVE'); assert.equal(s1.calls.length, 3); assert.equal(slept.length, 2);
  assert.ok(slept[1] > slept[0], 'exponential backoff');

  const s2 = stubFetch(Array.from({ length: A.MAX_ATTEMPTS + 2 }, () => ({ status: 503, json: {} })));
  const c2 = A.createAlpacaPaperClient({ env: ENV, fetchImpl: s2.fetchImpl, sleep: noSleep });
  await assert.rejects(() => c2.account(), /HTTP 503/);
  assert.equal(s2.calls.length, A.MAX_ATTEMPTS, 'bounded');

  const s3 = stubFetch([{ status: 403, json: { message: 'forbidden' } }]);
  const c3 = A.createAlpacaPaperClient({ env: ENV, fetchImpl: s3.fetchImpl, sleep: noSleep });
  await assert.rejects(() => c3.account(), /HTTP 403/);
  assert.equal(s3.calls.length, 1);
});

test('strict validation: a list that is not an array, or an order without id/symbol/status, is an error — never silently accepted', async () => {
  const bad = stubFetch([{ status: 200, json: { orders: [] } }, { status: 200, json: [{ id: 'x' }] }]);
  const c = A.createAlpacaPaperClient({ env: ENV, fetchImpl: bad.fetchImpl, sleep: noSleep });
  await assert.rejects(() => c.listOrders(), /expected an array/);
  await assert.rejects(() => c.listOrders(), /order shape/);
});

test('placeOrder: 422 is returned (not thrown) with the broker message; a duplicate client_order_id is flagged and resolved by lookup', async () => {
  const s = stubFetch([
    { status: 422, json: { code: 40010001, message: 'client_order_id must be unique' } },
    { status: 200, json: order({ id: 'existing', client_order_id: 'c1' }) },
    { status: 422, json: { message: 'stop_price must be below limit_price' } },
    { status: 403, json: { message: 'insufficient buying power' } },
  ]);
  const c = A.createAlpacaPaperClient({ env: ENV, fetchImpl: s.fetchImpl, sleep: noSleep });
  const dup = await c.placeOrder({ client_order_id: 'c1', symbol: 'ABCD' });
  assert.equal(dup.ok, true); assert.equal(dup.duplicate, true); assert.equal(dup.order.id, 'existing');
  assert.match(s.calls[1].url, /orders:by_client_order_id\?client_order_id=c1/);
  const rej = await c.placeOrder({ client_order_id: 'c2', symbol: 'ABCD' });
  assert.equal(rej.ok, false); assert.equal(rej.status, 422); assert.match(rej.error, /stop_price/);
  const bp = await c.placeOrder({ client_order_id: 'c3', symbol: 'ABCD' });
  assert.equal(bp.ok, false); assert.equal(bp.status, 403);
  assert.equal(s.calls.length, 4);
});

test('closePosition: DELETE /positions/{symbol}?cancel_orders=true returns the closing order; 404 (no position) is ok:false, not a throw', async () => {
  const s = stubFetch([{ status: 200, json: order({ id: 'flat1', type: 'market', side: 'sell' }) }, { status: 404, json: { message: 'position does not exist' } }]);
  const c = A.createAlpacaPaperClient({ env: ENV, fetchImpl: s.fetchImpl, sleep: noSleep });
  const r = await c.closePosition('ABCD');
  assert.equal(r.ok, true); assert.equal(r.order.id, 'flat1');
  assert.equal(s.calls[0].method, 'DELETE');
  assert.equal(s.calls[0].url, 'https://paper-api.alpaca.markets/v2/positions/ABCD?cancel_orders=true');
  const miss = await c.closePosition('ZZZZ');
  assert.equal(miss.ok, false); assert.equal(miss.status, 404);
  await assert.rejects(() => c.closePosition('bad symbol'), /symbol/);
});
