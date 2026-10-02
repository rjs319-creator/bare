'use strict';
// op=shortvoltick / op=shortvol — budget-by-time, per-day partial persistence, self-healing
// back-fill, 403 = not posted yet, CAS append. Store and network are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SV = require('../lib/finra-shortvol');
const R = require('../lib/finra-shortvol-routes');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', 'CNMSshvol20261001.sample.txt'), 'utf8');
const UNI = ['A', 'AA', 'AAAA', 'GME', 'NVDA'];
const FRI_EVENING = Date.parse('2026-10-02T23:00:00Z');

function fakeStore(initial = {}) {
  const docs = { ...initial };
  const calls = { writes: [], updates: 0 };
  return {
    docs, calls,
    hasStore: () => true,
    readJSON: async (p, fb) => (p in docs ? docs[p] : fb),
    writeJSON: async (p, doc) => { calls.writes.push(p); docs[p] = doc; },
    updateJSON: async (p, mutate, { initial: init = null } = {}) => {
      calls.updates++;
      const next = mutate(p in docs ? docs[p] : init);
      docs[p] = next;
      return { written: true, value: next, attempts: 1 };
    },
  };
}

// Serves the fixture re-dated to the requested day (symbol A's short volume varies with the
// day so its ratio is not flat across the window); `missing` days answer 403 (FINRA's "no file").
function fakeFetch({ missing = [], broken = [] } = {}) {
  const urls = [];
  return {
    urls,
    fetchText: async (url) => {
      urls.push(url);
      const compact = /CNMSshvol(\d{8})\.txt$/.exec(url)[1];
      const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
      if (missing.includes(iso)) return { ok: false, status: 403, text: '' };
      if (broken.includes(iso)) return { ok: true, status: 200, text: 'Date|Symbol|Nope\n' };
      const day = Number(compact.slice(6, 8));
      return { ok: true, status: 200, text: FIXTURE.replace(/20261001/g, compact).replace('|A|482143.150276|', `|A|${400000 + day * 3000}|`) };
    },
  };
}

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

test('first tick: today not posted yet (403) is skipped, the last sessions are back-filled, each day persists shard + rolling', async () => {
  const store = fakeStore();
  const net = fakeFetch({ missing: ['2026-10-02'] });
  const out = await R.tickCore({ store, fetchText: net.fetchText, universe: UNI, now: () => FRI_EVENING });
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates, ['2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28']);
  assert.deepEqual(out.processed.map((p) => p.status), ['no-file', 'written', 'written', 'written', 'written']);
  assert.deepEqual(out.written, ['2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28']);
  assert.equal(store.calls.writes.length, 4, 'one shard per written day');
  assert.equal(store.calls.updates, 4, 'one CAS append per written day');
  const rolling = store.docs[SV.ROLLING_PATH];
  assert.deepEqual(rolling.dates, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  assert.equal(rolling.asOf, '2026-10-01');
  assert.ok(rolling.updatedAt);
  assert.ok(store.docs['shortvol/2026-10-01.json'].hypothesis.topDecile);
  assert.deepEqual(out.skipped, []);
});

test('budget: a deadline that expires mid-run skips the rest — the finished day is fully persisted', async () => {
  const store = fakeStore();
  const net = fakeFetch();
  let t = FRI_EVENING;
  const now = () => { t += 30_000; return t; };   // every clock read costs 30s
  const out = await R.tickCore({ store, fetchText: net.fetchText, universe: UNI, now, deadlineMs: 60_000, lookback: 3 });
  assert.equal(out.ok, false, 'a budget skip is not a clean run');
  assert.equal(out.written.length, 1);
  assert.equal(out.skipped.length, 2);
  assert.equal(store.calls.writes.length, 1);
  assert.deepEqual(store.docs[SV.ROLLING_PATH].dates, ['2026-10-02']);
  assert.equal(net.urls.length, 1, 'no fetch is started once the budget is gone');
});

test('second tick is idempotent and self-healing: only missing sessions are fetched', async () => {
  const store = fakeStore();
  const net = fakeFetch({ missing: ['2026-10-02'] });
  await R.tickCore({ store, fetchText: net.fetchText, universe: UNI, now: () => FRI_EVENING });
  net.urls.length = 0;
  // Later that night FINRA has posted the file.
  const net2 = fakeFetch();
  const out = await R.tickCore({ store, fetchText: net2.fetchText, universe: UNI, now: () => FRI_EVENING + 3_600_000 });
  assert.deepEqual(out.candidates, ['2026-10-02']);
  assert.deepEqual(out.written, ['2026-10-02']);
  assert.equal(net2.urls.length, 1);
  assert.deepEqual(store.docs[SV.ROLLING_PATH].dates.slice(-2), ['2026-10-01', '2026-10-02']);
});

test('a malformed file is reported for its day and leaves nothing behind; the other days proceed', async () => {
  const store = fakeStore();
  const net = fakeFetch({ broken: ['2026-10-01'] });
  const out = await R.tickCore({ store, fetchText: net.fetchText, universe: UNI, now: () => FRI_EVENING, lookback: 2 });
  assert.deepEqual(out.processed.map((p) => [p.date, p.status]), [['2026-10-02', 'written'], ['2026-10-01', 'invalid:bad_header']]);
  assert.equal(store.docs['shortvol/2026-10-01.json'], undefined);
  assert.deepEqual(store.docs[SV.ROLLING_PATH].dates, ['2026-10-02']);
  assert.equal(out.ok, true, 'a vendor-side bad file is not a tick failure; it is retried next run');
});

test('a thrown fetch is isolated to its day and marks the run not ok', async () => {
  const store = fakeStore();
  let n = 0;
  const fetchText = async () => { n++; if (n === 1) throw new Error('socket hang up'); return { ok: false, status: 403, text: '' }; };
  const out = await R.tickCore({ store, fetchText, universe: UNI, now: () => FRI_EVENING, lookback: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.processed[0].status, 'error');
  assert.match(out.processed[0].error, /socket hang up/);
  assert.equal(out.processed[1].status, 'no-file');
});

test('op=shortvol read: empty state is never CDN-cached; a populated doc serves summary and per-symbol features', async () => {
  const empty = mockRes();
  await R.runShortVol({ query: {} }, empty, fakeStore());
  assert.equal(empty._json.ok, false);
  assert.equal(empty._headers['Cache-Control'], 'no-store');

  const store = fakeStore();
  await R.tickCore({ store, fetchText: fakeFetch().fetchText, universe: UNI, now: () => FRI_EVENING, lookback: 12 });
  const summary = mockRes();
  await R.runShortVol({ query: {} }, summary, store);
  assert.equal(summary._json.ok, true);
  assert.equal(summary._json.weight, 0);
  assert.equal(summary._json.summary.days, 12);
  assert.match(summary._headers['Cache-Control'], /s-maxage/);

  const sym = mockRes();
  await R.runShortVol({ query: { symbol: 'a' } }, sym, store);
  assert.equal(sym._json.symbol, 'A');
  assert.ok(Number.isFinite(sym._json.features.z20), 'z20 exists after 11+ trailing sessions');
  assert.equal(sym._json.features.scoreInput, false);

  const unknown = mockRes();
  await R.runShortVol({ query: { symbol: 'NOTINUNI' } }, unknown, store);
  assert.equal(unknown._json.ok, false);
  assert.equal(unknown._headers['Cache-Control'], 'no-store');

  const bad = mockRes();
  await R.runShortVol({ query: { symbol: '!!' } }, bad, store);
  assert.equal(bad._status, 400);
});
