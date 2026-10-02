'use strict';
// op=arktick driven end-to-end with an in-memory CAS store and canned CSV fetches:
// first snapshot (no trades), a real diff (trades + events + latest pointer), a stale
// republish (nothing rewritten), a per-fund fetch failure, and the public read shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/ark-routes');
const S = require('../lib/ark-store');

const HEADER = 'date,fund,company,ticker,cusip,shares,market value ($),weight (%)\n';
const row = (date, fund, t, shares, px) => `${date},${fund},${t} INC,${t},0000,"${shares.toLocaleString('en-US')}","$${(shares * px).toFixed(2)}",1.00%\n`;

function memStore(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const writes = [];
  return {
    docs, writes,
    hasStore: () => true,
    readJSON: async (k, fb) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : fb),
    updateJSON: async (k, fn, { initial = null } = {}) => {
      const cur = docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : initial;
      const next = await fn(cur);
      if (next === cur) return { written: false, value: cur };
      docs.set(k, next); writes.push(k);
      return { written: true, value: next };
    },
    readAllByPrefix: async (prefix, re, { limit = null } = {}) => {
      const keys = [...docs.keys()].filter((k) => k.startsWith(prefix) && re.test(k)).sort();
      return (limit ? keys.slice(-limit) : keys).map((k) => docs.get(k));
    },
  };
}

// 25 bars at $10 × 200k shares → ADV20 = $2M (thin). LIQ: $100 × 10M → $1B.
const history = async (t) => ({ candles: Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(1 + i).padStart(2, '0')}`, close: t === 'LIQ' ? 100 : 10, volume: t === 'LIQ' ? 10_000_000 : 200_000 })) });
const csvFor = (body) => async (url) => ({ ok: true, status: 200, text: async () => HEADER + body(url) });

const DAY1 = '09/30/2026';
const DAY2 = '10/01/2026';

test('tick 1: first snapshot per fund is stored, latest pointer set, no trades (nothing to diff against)', async () => {
  const store = memStore();
  const fetchImpl = csvFor((url) => (url.includes('_ARKK_') ? row(DAY1, 'ARKK', 'AAA', 100_000, 10) + row(DAY1, 'ARKK', 'LIQ', 1000, 100) : row(DAY1, 'ARKW', 'AAA', 50_000, 10)));
  const r = await R.tickCore({ date: '2026-09-30', store, fetchImpl, history, funds: ['ARKK', 'ARKW'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.funds.ARKK, { asOf: '2026-09-30', holdings: 2, status: 'first-snapshot', trades: 0 });
  assert.deepEqual(r.funds.ARKW, { asOf: '2026-09-30', holdings: 1, status: 'first-snapshot', trades: 0 });
  assert.equal(r.events.length, 0);
  const snap = store.docs.get(S.arkSnapshotKey('2026-09-30'));
  assert.deepEqual(Object.keys(snap.funds).sort(), ['ARKK', 'ARKW']);
  assert.equal(snap.funds.ARKK.holdings[0].ticker, 'AAA');
  assert.deepEqual(store.docs.get(S.ARK_LATEST_KEY).funds, { ARKK: { asOf: '2026-09-30' }, ARKW: { asOf: '2026-09-30' } });
  assert.ok(!store.docs.has(S.arkTradesKey('2026-09-30')), 'no trades doc on a first snapshot');
});

test('tick 2: holdings moved → per-fund trades, cross-fund net, ADV-gated events; pointer advances; trades doc keyed by the tick date', async () => {
  const store = memStore();
  const day1 = csvFor((url) => (url.includes('_ARKK_') ? row(DAY1, 'ARKK', 'AAA', 100_000, 10) + row(DAY1, 'ARKK', 'LIQ', 1000, 100) : row(DAY1, 'ARKW', 'AAA', 50_000, 10)));
  await R.tickCore({ date: '2026-09-30', store, fetchImpl: day1, history, funds: ['ARKK', 'ARKW'] });
  // ARKK: AAA +30,000 (+$300k = 15% of $2M ADV), LIQ +9,000 (liquid → never an event);
  // ARKW: AAA −5,000 → net AAA +25,000 = $250k = 12.5% of ADV → ARK_NET_BUY.
  const day2 = csvFor((url) => (url.includes('_ARKK_') ? row(DAY2, 'ARKK', 'AAA', 130_000, 10) + row(DAY2, 'ARKK', 'LIQ', 10_000, 100) : row(DAY2, 'ARKW', 'AAA', 45_000, 10)));
  const r = await R.tickCore({ date: '2026-10-01', store, fetchImpl: day2, history, funds: ['ARKK', 'ARKW'] });
  assert.deepEqual(r.funds.ARKK, { asOf: '2026-10-01', holdings: 2, status: 'diffed', trades: 2, prevAsOf: '2026-09-30' });
  assert.deepEqual(r.funds.ARKW, { asOf: '2026-10-01', holdings: 1, status: 'diffed', trades: 1, prevAsOf: '2026-09-30' });
  assert.deepEqual(r.events.map((e) => [e.symbol, e.type, e.meta.deltaShares, e.meta.pctOfAdv20]), [['AAA', 'ARK_NET_BUY', 25_000, 0.125]]);
  assert.equal(r.events[0].sessionDate, '2026-10-01');
  const doc = store.docs.get(S.arkTradesKey('2026-10-01'));
  assert.equal(doc.date, '2026-10-01');
  assert.deepEqual(doc.net.map((n) => n.ticker), ['LIQ', 'AAA'], 'net sorted by |$| — the liquid name is recorded, just not an event');
  assert.equal(doc.funds.ARKK.prevAsOf, '2026-09-30');
  assert.equal(doc.events.length, 1);
  assert.deepEqual(store.docs.get(S.ARK_LATEST_KEY).funds.ARKK, { asOf: '2026-10-01' });
  assert.ok(store.docs.has(S.arkSnapshotKey('2026-10-01')));
});

test('tick 3: a fund whose CSV still carries the old as-of date is "unchanged" — no snapshot, no trades, nothing rewritten', async () => {
  const store = memStore();
  const same = csvFor(() => row(DAY1, 'ARKK', 'AAA', 100_000, 10));
  await R.tickCore({ date: '2026-09-30', store, fetchImpl: same, history, funds: ['ARKK'] });
  const writesBefore = store.writes.length;
  const r = await R.tickCore({ date: '2026-10-01', store, fetchImpl: same, history, funds: ['ARKK'] });
  assert.deepEqual(r.funds.ARKK, { asOf: '2026-09-30', holdings: 1, status: 'unchanged', trades: 0 });
  assert.equal(store.writes.length, writesBefore, 'a stale republish writes nothing');
  assert.equal(r.events.length, 0);
});

test('a failing or malformed fund is reported per fund and never blocks the others; the tick still succeeds', async () => {
  const store = memStore();
  const fetchImpl = async (url) => {
    if (url.includes('_ARKG_')) return { ok: false, status: 503, text: async () => '' };
    if (url.includes('_ARKW_')) return { ok: true, status: 200, text: async () => 'date,fund,company,ticker\n' + row(DAY1, 'ARKW', 'AAA', 1, 1) };
    return { ok: true, status: 200, text: async () => HEADER + row(DAY1, 'ARKK', 'AAA', 100_000, 10) };
  };
  const r = await R.tickCore({ date: '2026-09-30', store, fetchImpl, history, funds: ['ARKK', 'ARKG', 'ARKW'] });
  assert.equal(r.ok, true);
  assert.equal(r.funds.ARKK.status, 'first-snapshot');
  assert.match(r.errors.ARKG, /503/);
  assert.match(r.errors.ARKW, /schema/i);
  assert.equal(store.docs.get(S.ARK_LATEST_KEY).funds.ARKG, undefined);
});

test('readRecentArkEvents: the last few trades docs → flat event list (what cern-run ingests)', async () => {
  const store = memStore({
    [S.arkTradesKey('2026-09-29')]: { date: '2026-09-29', events: [{ type: 'ARK_NET_SELL', symbol: 'OLD' }] },
    [S.arkTradesKey('2026-09-30')]: { date: '2026-09-30', events: [{ type: 'ARK_NET_BUY', symbol: 'AAA' }] },
    [S.arkTradesKey('2026-10-01')]: { date: '2026-10-01', events: [] },
  });
  const evs = await S.readRecentArkEvents({ store, limit: 2 });
  assert.deepEqual(evs.map((e) => e.symbol), ['AAA']);
});

test('op=ark public read: no-store on the empty state; cached once data exists; shadow disclosure + frozen constants', async () => {
  const headers = {};
  const res = () => { const o = { code: 200, body: null, setHeader: (k, v) => { headers[k] = v; }, status(c) { o.code = c; return o; }, json(b) { o.body = b; return o; } }; return o; };
  const empty = res();
  await R.runArk({ query: {} }, empty, { store: memStore() });
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(empty.body.weight, 0);
  assert.equal(empty.body.state, 'SHADOW');
  const store = memStore({ [S.ARK_LATEST_KEY]: { funds: { ARKK: { asOf: '2026-10-01' } } }, [S.arkTradesKey('2026-10-01')]: { date: '2026-10-01', net: [], events: [{ type: 'ARK_NET_BUY', symbol: 'AAA' }], funds: {} } });
  const full = res();
  await R.runArk({ query: {} }, full, { store });
  assert.match(headers['Cache-Control'], /s-maxage/);
  assert.equal(full.body.recent[0].events, 1);
  assert.equal(full.body.frozen.EVENT_MIN_PCT_OF_ADV, 0.10);
});
