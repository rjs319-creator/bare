'use strict';
// 🕰 LAST-GOOD SNAPSHOT LAYER (public/js/last-good.js + fetch-json.js).
// On a successful snapshot read the payload is remembered per op key ({asOf, data}); when the
// read fails, comes back as an empty/degraded state, or was served by the service worker from
// its cache, the last good payload is returned flagged `stale:true, asOf` so the tab renders an
// honest "as of HH:MM · showing last good data" strip instead of an empty state or a spinner.
// Every storage access is wrapped — a throwing IndexedDB (private mode, quota) must never break
// a render.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const url = (f) => pathToFileURL(join(ROOT, 'public', 'js', f)).href;
let LG, FJ;
test.before(async () => { LG = await import(url('last-good.js')); FJ = await import(url('fetch-json.js')); });

const memStore = () => { const m = new Map(); return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } }; };
const GOOD = { ok: true, generatedAt: '2026-10-01T13:30:00.000Z', items: [{ id: 'a', ticker: 'ABCD' }] };
const T0 = Date.parse('2026-10-01T14:00:00.000Z');

// ── mergeLastGood (pure) ─────────────────────────────────────────────────────────────
test('mergeLastGood returns the fresh payload untouched when it is usable', () => {
  const out = LG.mergeLastGood(GOOD, { asOf: '2026-09-30T00:00:00Z', data: { ok: true, items: [{ id: 'old' }] } }, { nowMs: T0 });
  assert.equal(out, GOOD, 'same object identity — no copy, no flags');
});

test('mergeLastGood falls back to the cached snapshot flagged stale with its asOf and a reason', () => {
  const cached = { asOf: '2026-10-01T13:31:00.000Z', data: GOOD };
  const out = LG.mergeLastGood(null, cached, { error: new Error('HTTP 503'), nowMs: T0 });
  assert.equal(out.stale, true);
  assert.equal(out.asOf, cached.asOf);
  assert.match(out.staleReason, /HTTP 503/);
  assert.deepEqual(out.items, GOOD.items);
  assert.equal(cached.data.stale, undefined, 'the cached object is not mutated');
  const empty = LG.mergeLastGood({ ok: true, items: [] }, cached, { nowMs: T0 });
  assert.equal(empty.stale, true);
  assert.match(empty.staleReason, /empty/i);
});

test('mergeLastGood refuses a cached snapshot older than the max age and hands back the fresh (empty) answer', () => {
  const ancient = { asOf: new Date(T0 - LG.LAST_GOOD_MAX_AGE_MS - 1000).toISOString(), data: GOOD };
  const fresh = { ok: true, items: [] };
  assert.equal(LG.mergeLastGood(fresh, ancient, { nowMs: T0 }), fresh);
  assert.equal(LG.mergeLastGood(null, ancient, { error: new Error('x'), nowMs: T0 }), null);
});

test('mergeLastGood keeps a service-worker-served stale payload when it is newer than the stored one', () => {
  const swServed = { ...GOOD, stale: true, asOf: '2026-10-01T13:59:00.000Z', staleSource: 'sw-cache' };
  const older = { asOf: '2026-10-01T13:00:00.000Z', data: GOOD };
  assert.equal(LG.mergeLastGood(swServed, older, { nowMs: T0 }), swServed);
  const newer = { asOf: '2026-10-01T13:59:30.000Z', data: GOOD };
  assert.equal(LG.mergeLastGood(swServed, newer, { nowMs: T0 }).asOf, newer.asOf);
});

// ── withLastGood (storage + fetch orchestration) ─────────────────────────────────────
test('withLastGood stores a good payload under the key and returns it as-is', async () => {
  const store = memStore();
  const out = await LG.withLastGood('sessionboard', async () => GOOD, { store, nowMs: T0 });
  assert.equal(out, GOOD);
  const entry = store.m.get(LG.LAST_GOOD_PREFIX + 'sessionboard');
  assert.equal(entry.asOf, new Date(T0).toISOString());
  assert.equal(entry.data, GOOD);
});

test('withLastGood returns the remembered snapshot flagged stale when the fetch throws or the payload is empty', async () => {
  const store = memStore();
  await LG.withLastGood('today', async () => GOOD, { store, nowMs: T0 });
  const failed = await LG.withLastGood('today', async () => { throw new Error('Failed to fetch'); }, { store, nowMs: T0 + 60_000 });
  assert.equal(failed.stale, true);
  assert.equal(failed.asOf, new Date(T0).toISOString());
  assert.deepEqual(failed.items, GOOD.items);
  const empty = await LG.withLastGood('today', async () => ({ ok: true, empty: true, items: [] }), { store, nowMs: T0 + 120_000 });
  assert.equal(empty.stale, true);
  assert.equal(store.m.get(LG.LAST_GOOD_PREFIX + 'today').data, GOOD, 'an empty payload never overwrites the last good one');
});

test('withLastGood with nothing remembered: rethrows a fetch error, passes an empty payload through', async () => {
  const store = memStore();
  await assert.rejects(LG.withLastGood('x', async () => { throw new Error('HTTP 500'); }, { store }), /HTTP 500/);
  const empty = { ok: false, error: 'no board' };
  assert.equal(await LG.withLastGood('x', async () => empty, { store }), empty);
});

test('withLastGood survives a throwing store and a missing store', async () => {
  const broken = { get: async () => { throw new Error('idb blocked'); }, set: async () => { throw new Error('quota'); } };
  assert.equal(await LG.withLastGood('k', async () => GOOD, { store: broken }), GOOD);
  await assert.rejects(LG.withLastGood('k', async () => { throw new Error('HTTP 502'); }, { store: broken }), /HTTP 502/);
  assert.equal(await LG.withLastGood('k', async () => GOOD, { store: null }), GOOD);
  assert.equal(await LG.recallSnapshot('k', null), null);
  assert.equal(await LG.rememberSnapshot('k', GOOD, Date.now(), null), false);
});

test('recallSnapshot ignores a malformed stored entry', async () => {
  const store = memStore();
  store.m.set(LG.LAST_GOOD_PREFIX + 'bad', 'garbage');
  store.m.set(LG.LAST_GOOD_PREFIX + 'bad2', { asOf: 'not a date', data: GOOD });
  assert.equal(await LG.recallSnapshot('bad', store), null);
  assert.equal(await LG.recallSnapshot('bad2', store), null);
});

// ── the strip ───────────────────────────────────────────────────────────────────────
test('asOfLabel is a clock time the same day and carries the date otherwise (staleness-honesty rule)', () => {
  const now = new Date('2026-10-01T18:00:00.000Z');
  assert.match(LG.asOfLabel('2026-10-01T13:30:00.000Z', now), /^\d{1,2}:\d{2} (AM|PM) ET$/);
  assert.match(LG.asOfLabel('2026-09-28T13:30:00.000Z', now), /Sep 28, 2026, \d{1,2}:\d{2} (AM|PM) ET/);
  assert.equal(LG.asOfLabel(null, now), '–');
  assert.equal(LG.asOfLabel('garbage', now), '–');
});

test('lastGoodStripHTML renders only for a stale payload and says "showing last good data"', () => {
  const now = new Date('2026-10-01T18:00:00.000Z');
  assert.equal(LG.lastGoodStripHTML(GOOD, { now }), '');
  const html = LG.lastGoodStripHTML({ ...GOOD, stale: true, asOf: '2026-10-01T13:30:00.000Z', staleReason: 'refresh failed (<b>HTTP 503</b>)' }, { now, cls: 'sb-stale' });
  assert.match(html, /class="lg-strip sb-stale"/);
  assert.match(html, /as of \d{1,2}:\d{2} (AM|PM) ET · showing last good data/);
  assert.ok(!html.includes('<b>HTTP'), 'the reason is escaped');
  assert.ok(!/undefined|NaN/.test(html));
});

// ── fetchJSON: a service-worker cache hit is surfaced, never silently fresh ──────────
test('fetchJSON flags a payload the service worker served from its cache (x-sw-served) as stale', async () => {
  const headers = new Map([['x-sw-served', 'cache'], ['x-sw-cached-at', '2026-10-01T13:00:00.000Z']]);
  const marked = FJ.markSwServed({ ok: true, items: [1] }, { get: (k) => headers.get(k) || null });
  assert.equal(marked.stale, true);
  assert.equal(marked.asOf, '2026-10-01T13:00:00.000Z');
  assert.equal(marked.staleSource, 'sw-cache');
  const plain = { ok: true };
  assert.equal(FJ.markSwServed(plain, { get: () => null }), plain, 'a network response is returned untouched');
  assert.deepEqual(FJ.markSwServed([1, 2], { get: () => 'cache' }), [1, 2], 'arrays are left alone');
});

test('fetchSnapshot composes fetchJSON with the last-good layer under the given key', async () => {
  const store = memStore();
  const realFetch = globalThis.fetch;
  let status = 200;
  globalThis.fetch = async () => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => GOOD });
  try {
    const first = await FJ.fetchSnapshot('/api/tracker?op=sessionboard', { key: 'sb', store, nowMs: T0 });
    assert.equal(first, GOOD);
    status = 503;
    const second = await FJ.fetchSnapshot('/api/tracker?op=sessionboard', { key: 'sb', store, nowMs: T0 + 1000 });
    assert.equal(second.stale, true);
    assert.match(second.staleReason, /HTTP 503/);
  } finally { globalThis.fetch = realFetch; }
});

test('fetch-json.js keeps its timeout constants and the fetchJSON contract (pinned by heavy-fetch-timeout tests)', () => {
  const src = readFileSync(join(ROOT, 'public', 'js', 'fetch-json.js'), 'utf8');
  assert.match(src, /export const DEFAULT_TIMEOUT_MS = 20000/);
  assert.match(src, /export const HEAVY_TIMEOUT_MS = 70000/);
  assert.match(src, /export const OPTIONAL_TIMEOUT_MS = 30000/);
  assert.match(src, /export async function fetchJSON\(/);
  assert.match(src, /export async function fetchSnapshot\(/);
});
