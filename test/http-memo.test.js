'use strict';
// lib/http-memo — two-layer fetch memoization in front of fetchWithTimeout.
//
// Pins: in-flight dedupe (N concurrent → 1 fetch), TTL expiry (injected clock), the
// size bound + LRU eviction, "non-ok / empty vendor shapes are never cached", secret
// query params never reach a cache key, stats, tag expiry, and the L2 contract
// (hit path, failure isolation — a broken L2 never breaks a fetch).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/http-memo');

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
});

// A fetchImpl stub that counts calls and can delay so concurrency is observable.
function stubFetch(responder, { delayMs = 0 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    return responder(url, calls.length);
  };
  return { impl, calls };
}

function makeMemo(extra = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const memo = M.createHttpMemo({ now: clock.now, ...extra });
  return { memo, clock };
}

test('N concurrent calls for one key → exactly one fetch, all callers get the body', async () => {
  const { memo } = makeMemo();
  const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }), { delayMs: 5 });
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    memo.memoFetchJSON('https://x/a', { ttlMs: 60_000, tag: 't', fetchImpl: impl })));
  assert.equal(calls.length, 1);
  for (const r of results) { assert.equal(r.ok, true); assert.deepEqual(r.body, { v: 1 }); }
  const s = memo.getStats();
  assert.equal(s.misses, 1);
  assert.equal(s.inflightDedupes, 24);
  assert.equal(s.size, 1);
});

test('a hit after the first call reads L1 and returns an INDEPENDENT copy of the body', async () => {
  const { memo } = makeMemo();
  const { impl, calls } = stubFetch(() => jsonResponse(200, { rows: [1, 2] }));
  const a = await memo.memoFetchJSON('https://x/a', { ttlMs: 60_000, tag: 't', fetchImpl: impl });
  a.body.rows.push(99);   // a careless caller mutating its copy
  const b = await memo.memoFetchJSON('https://x/a', { ttlMs: 60_000, tag: 't', fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.deepEqual(b.body, { rows: [1, 2] }, 'cached value is not shared by reference');
  assert.equal(b.cached, 'l1');
  assert.equal(memo.getStats().hits, 1);
});

test('TTL expiry: a stale entry is refetched (injected clock, no sleeping)', async () => {
  const { memo, clock } = makeMemo();
  const { impl, calls } = stubFetch((_, n) => jsonResponse(200, { n }));
  const opts = { ttlMs: 10_000, tag: 't', fetchImpl: impl };
  assert.deepEqual((await memo.memoFetchJSON('https://x/a', opts)).body, { n: 1 });
  clock.advance(9_999);
  assert.deepEqual((await memo.memoFetchJSON('https://x/a', opts)).body, { n: 1 }, 'still fresh');
  clock.advance(2);
  assert.deepEqual((await memo.memoFetchJSON('https://x/a', opts)).body, { n: 2 }, 'expired → refetched');
  assert.equal(calls.length, 2);
});

test('size bound: LRU eviction keeps the most recently USED entries', async () => {
  const { memo } = makeMemo({ maxEntries: 3 });
  const { impl, calls } = stubFetch(() => jsonResponse(200, { ok: 1 }));
  const get = (k) => memo.memoFetchJSON(`https://x/${k}`, { ttlMs: 60_000, tag: 't', fetchImpl: impl });
  await get('a'); await get('b'); await get('c');
  await get('a');                 // touch a → b is now least recently used
  await get('d');                 // evicts b
  assert.equal(memo.getStats().size, 3);
  assert.equal(memo.getStats().evictions, 1);
  await get('a'); await get('c'); await get('d');
  assert.equal(calls.length, 4, 'a, c, d all still cached');
  await get('b');
  assert.equal(calls.length, 5, 'b was evicted and had to be refetched');
});

test('byte bound: an entry larger than the item cap is served but never stored', async () => {
  const { memo } = makeMemo({ maxItemBytes: 50 });
  const { impl, calls } = stubFetch(() => jsonResponse(200, { pad: 'x'.repeat(200) }));
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl };
  const r = await memo.memoFetchJSON('https://x/big', opts);
  assert.equal(r.body.pad.length, 200);
  await memo.memoFetchJSON('https://x/big', opts);
  assert.equal(calls.length, 2);
  assert.equal(memo.getStats().size, 0);
  assert.equal(memo.getStats().uncacheable, 2);
});

test('non-ok responses are returned with their status but never cached', async () => {
  const { memo } = makeMemo();
  const { impl, calls } = stubFetch((_, n) => (n === 1 ? jsonResponse(429, { err: 1 }) : jsonResponse(200, { v: 1 })));
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl };
  const r1 = await memo.memoFetchJSON('https://x/a', opts);
  assert.equal(r1.ok, false); assert.equal(r1.status, 429); assert.equal(r1.body, null);
  const r2 = await memo.memoFetchJSON('https://x/a', opts);
  assert.equal(r2.ok, true);
  assert.equal(calls.length, 2);
});

test('empty vendor shapes ([] / {}) and unparseable JSON are never cached', async () => {
  const { memo } = makeMemo();
  const bodies = [[], {}, null];
  const { impl, calls } = stubFetch((_, n) => jsonResponse(200, bodies[(n - 1) % bodies.length]));
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl };
  for (let i = 0; i < 3; i++) await memo.memoFetchJSON('https://x/a', opts);
  assert.equal(calls.length, 3);
  assert.equal(memo.getStats().size, 0);

  const bad = async () => ({ ok: true, status: 200, text: async () => '<html>not json' });
  const r = await memo.memoFetchJSON('https://x/html', { ttlMs: 60_000, tag: 't', fetchImpl: bad });
  assert.equal(r.ok, false); assert.equal(r.body, null); assert.equal(r.invalidJson, true);
  assert.equal(memo.getStats().size, 0);
});

test('a caller-supplied shouldCache predicate can refuse a 200 body', async () => {
  const { memo } = makeMemo();
  const { impl, calls } = stubFetch(() => jsonResponse(200, { stale: true }));
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl, shouldCache: (b) => !b.stale };
  await memo.memoFetchJSON('https://x/a', opts);
  await memo.memoFetchJSON('https://x/a', opts);
  assert.equal(calls.length, 2);
});

test('secret query params (apikey/token/crumb) never appear in the cache key', () => {
  const k = M.redactedKey('https://api.example/v1/q?symbol=AAPL&apikey=SECRET1&token=SECRET2&crumb=SECRET3&x=1');
  assert.equal(k.includes('SECRET'), false);
  assert.equal(k, 'https://api.example/v1/q?symbol=AAPL&x=1');
  assert.equal(M.redactedKey('not a url'), 'not a url', 'non-URL keys pass through');
});

test('a thrown fetch rejects every in-flight waiter and leaves nothing cached', async () => {
  const { memo } = makeMemo();
  let n = 0;
  const impl = async () => { n++; if (n === 1) throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); return jsonResponse(200, { v: 1 }); };
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl };
  const results = await Promise.allSettled([memo.memoFetchJSON('https://x/a', opts), memo.memoFetchJSON('https://x/a', opts)]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 2);
  assert.equal(n, 1);
  const r = await memo.memoFetchJSON('https://x/a', opts);
  assert.equal(r.ok, true);
  assert.equal(n, 2);
});

test('expireTag drops only the entries carrying that tag', async () => {
  const { memo } = makeMemo();
  const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }));
  await memo.memoFetchJSON('https://x/c1', { ttlMs: 60_000, tag: 'candles', fetchImpl: impl });
  await memo.memoFetchJSON('https://x/c2', { ttlMs: 60_000, tag: 'candles', fetchImpl: impl });
  await memo.memoFetchJSON('https://x/q1', { ttlMs: 60_000, tag: 'quotes', fetchImpl: impl });
  await memo.expireTag('candles');
  assert.equal(memo.getStats().size, 1);
  await memo.memoFetchJSON('https://x/q1', { ttlMs: 60_000, tag: 'quotes', fetchImpl: impl });
  assert.equal(calls.length, 3, 'quotes entry survived');
});

test('stats report hits/misses/inflightDedupes/size/bytes and reset clears them', async () => {
  const { memo } = makeMemo();
  const { impl } = stubFetch(() => jsonResponse(200, { v: 1 }));
  const opts = { ttlMs: 60_000, tag: 't', fetchImpl: impl };
  await memo.memoFetchJSON('https://x/a', opts);
  await memo.memoFetchJSON('https://x/a', opts);
  const s = memo.getStats();
  assert.equal(s.hits, 1); assert.equal(s.misses, 1); assert.equal(s.size, 1);
  assert.ok(s.bytes > 0);
  assert.equal(s.l2, 'off');
  memo.reset();
  const z = memo.getStats();
  assert.equal(z.hits, 0); assert.equal(z.size, 0); assert.equal(z.bytes, 0);
});

test('invalid arguments fail fast', async () => {
  const { memo } = makeMemo();
  await assert.rejects(() => memo.memoFetchJSON('', { ttlMs: 1000 }), /url/);
  await assert.rejects(() => memo.memoFetchJSON('https://x/a', { ttlMs: 0 }), /ttlMs/);
  await assert.rejects(() => memo.memoFetchJSON('https://x/a', {}), /ttlMs/);
});

// ── L2 contract ─────────────────────────────────────────────────────────────
function fakeL2() {
  const store = new Map();
  const log = [];
  return {
    log, store,
    cache: {
      get: async (k) => { log.push(['get', k]); const e = store.get(k); return e ? JSON.parse(JSON.stringify(e.value)) : null; },
      set: async (k, value, opts) => { log.push(['set', k, opts]); store.set(k, { value, opts }); },
      expireTag: async (tag) => { log.push(['expireTag', tag]); for (const [k, e] of store) if ((e.opts.tags || []).includes(tag)) store.delete(k); },
    },
  };
}

test('L2: a miss in L1 that hits L2 skips the network and re-populates L1', async () => {
  const l2 = fakeL2();
  const { memo } = makeMemo({ l2: () => l2.cache });
  const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }));
  const opts = { ttlMs: 30_000, tag: 'candles', fetchImpl: impl };
  await memo.memoFetchJSON('https://x/a', opts);
  const set = l2.log.find(e => e[0] === 'set');
  assert.ok(set, 'ok body written to L2');
  assert.equal(set[2].ttl, 30, 'ttl in seconds');
  assert.deepEqual(set[2].tags, ['candles']);

  const fresh = M.createHttpMemo({ now: () => 1, l2: () => l2.cache });   // a new instance = new L1
  const r = await fresh.memoFetchJSON('https://x/a', opts);
  assert.equal(r.cached, 'l2');
  assert.deepEqual(r.body, { v: 1 });
  assert.equal(calls.length, 1);
  assert.equal(fresh.getStats().l2Hits, 1);
  assert.equal(fresh.getStats().size, 1, 'L1 re-populated from L2');
});

test('L2: a throwing cache never breaks the fetch and is counted', async () => {
  const broken = { get: async () => { throw new Error('cache down'); }, set: async () => { throw new Error('cache down'); }, expireTag: async () => { throw new Error('cache down'); } };
  const { memo } = makeMemo({ l2: () => broken });
  const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }));
  const r = await memo.memoFetchJSON('https://x/a', { ttlMs: 30_000, tag: 't', fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  await memo.expireTag('t');
  assert.equal(memo.getStats().l2Errors, 3);
});

test('L2: non-ok responses are never written to L2 either', async () => {
  const l2 = fakeL2();
  const { memo } = makeMemo({ l2: () => l2.cache });
  const { impl } = stubFetch(() => jsonResponse(500, { err: 1 }));
  await memo.memoFetchJSON('https://x/a', { ttlMs: 30_000, tag: 't', fetchImpl: impl });
  assert.equal(l2.store.size, 0);
});

test('default singleton: memoFetchJSON / getHttpMemoStats / resetHttpMemo are wired', async () => {
  M.resetHttpMemo();
  const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }));
  await M.memoFetchJSON('https://x/single', { ttlMs: 1000, tag: 't', fetchImpl: impl });
  await M.memoFetchJSON('https://x/single', { ttlMs: 1000, tag: 't', fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(M.getHttpMemoStats().hits, 1);
  M.resetHttpMemo();
  assert.equal(M.getHttpMemoStats().size, 0);
});

test('HTTP_MEMO=off bypasses both layers (operational kill switch)', async () => {
  const prev = process.env.HTTP_MEMO;
  process.env.HTTP_MEMO = 'off';
  try {
    const { memo } = makeMemo();
    const { impl, calls } = stubFetch(() => jsonResponse(200, { v: 1 }));
    await memo.memoFetchJSON('https://x/a', { ttlMs: 60_000, tag: 't', fetchImpl: impl });
    await memo.memoFetchJSON('https://x/a', { ttlMs: 60_000, tag: 't', fetchImpl: impl });
    assert.equal(calls.length, 2);
    assert.equal(memo.getStats().bypassed, 2);
  } finally {
    if (prev === undefined) delete process.env.HTTP_MEMO; else process.env.HTTP_MEMO = prev;
  }
});
