'use strict';
// PEAK-MEMORY FIXES — the two unbounded reads left after the 2026-08-19 OOM pass.
//
// The memory bump in vercel.json raised the ceiling; these lower the floor. Both were
// found while tracing why /api/tracker was OOM-killed 24 times in 11 days, and both are
// the same shape: load EVERYTHING, then use a little of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── 1. readAllByPrefix — fetched every archive body, then threw most away ──
//
// lib/optionsflow-v2-routes.js: readAllByPrefix(OBS_PREFIX, OBS_RE).slice(-26).
// Every options observation doc ever written was downloaded and held in memory so 26
// could be used. That grows without bound as the archive grows, and each doc carries
// per-ticker observations for the whole options universe.
const { pickNewestBlobs } = require('../lib/store');

test('pickNewestBlobs keeps the NEWEST n and returns them oldest-first', () => {
  // Arrange — blob list order is pathname-ascending
  const blobs = ['a/2026-08-01.json', 'a/2026-08-02.json', 'a/2026-08-03.json', 'a/2026-08-04.json']
    .map(pathname => ({ pathname }));

  // Act
  const picked = pickNewestBlobs(blobs, 2);

  // Assert — newest two, still ascending so downstream date ordering is unchanged
  assert.deepStrictEqual(picked.map(b => b.pathname), ['a/2026-08-03.json', 'a/2026-08-04.json']);
});

test('pickNewestBlobs is a no-op without a limit — full-ledger callers keep everything', () => {
  const blobs = [{ pathname: 'a' }, { pathname: 'b' }, { pathname: 'c' }];
  assert.equal(pickNewestBlobs(blobs, null).length, 3);
  assert.equal(pickNewestBlobs(blobs, 0).length, 3);
  assert.equal(pickNewestBlobs(blobs, 99).length, 3);
});

test('pickNewestBlobs does not mutate the caller array and tolerates junk', () => {
  const blobs = [{ pathname: 'b' }, { pathname: 'a' }];
  const before = blobs.map(b => b.pathname);
  pickNewestBlobs(blobs, 1);
  assert.deepStrictEqual(blobs.map(b => b.pathname), before);
  assert.deepStrictEqual(pickNewestBlobs(null, 5), []);
  assert.deepStrictEqual(pickNewestBlobs([], 5), []);
});

// ── 2. loadUniverseRows — held all four scope docs at once ────────────────
//
// lib/rlt-routes.js loaded 'large', 'small', 'micro' and 'expanded' candle caches with
// one Promise.all, so every scope's FULL candle document was resident simultaneously
// before any row was derived. Shared by four chains (rlt, peerprop, psrl,
// target-compare), so several invocations could each hold all four at once — on the
// same Fluid instance that was being OOM-killed.
const { loadUniverseRows } = require('../lib/rlt-routes');

test('loadUniverseRows holds ONE scope document at a time, not all four', async () => {
  // Arrange — a loader that reports how many docs are resident concurrently
  let inFlight = 0, maxInFlight = 0;
  const seenScopes = [];
  const loadScope = async (scope) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    seenScopes.push(scope);
    await new Promise(r => setTimeout(r, 5));
    try { return fakeScopeDoc(scope); } finally { inFlight--; }
  };

  // Act
  const out = await loadUniverseRows({ loadScope });

  // Assert
  assert.equal(maxInFlight, 1, 'scope docs must be loaded and released one at a time');
  assert.deepStrictEqual(seenScopes, ['large', 'small', 'micro', 'expanded'], 'all scopes still covered');
  assert.ok(out.rows.length > 0, 'and it still actually returns rows');
});

test('loadUniverseRows still dedupes a ticker across scopes, first scope winning', async () => {
  const loadScope = async (scope) => fakeScopeDoc(scope, ['DUPE']);
  const out = await loadUniverseRows({ loadScope });
  const dupes = out.rows.filter(r => r.ticker === 'DUPE');
  assert.equal(dupes.length, 1, 'a ticker present in every scope must appear once');
  assert.equal(dupes[0].scope, 'large', 'and keep the first scope that carried it');
});

test('loadUniverseRows survives a scope whose cache is missing or throws', async () => {
  const loadScope = async (scope) => {
    if (scope === 'micro') throw new Error('blob unreachable');
    if (scope === 'small') return null;
    return fakeScopeDoc(scope);
  };
  const out = await loadUniverseRows({ loadScope });
  assert.ok(out.rows.length > 0, 'a bad scope must not take the whole pool down');
  assert.deepStrictEqual(out.scopes.sort(), ['expanded', 'large'], 'and coverage reports only what loaded');
});

// A candle-cache-shaped doc. The cache stores the COMPACT tuple encoding
// ({ c: [[date, o, h, l, c, v, adjClose], ...] }) that decodeEntry expands — not the
// decoded { candles: [...] } shape — so the fixture has to speak the stored form or
// cacheGet returns null and the test would pass for the wrong reason.
function fakeScopeDoc(scope, extraTickers = []) {
  const c = Array.from({ length: 40 }, (_, i) => [
    `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, 10, 11, 9, 10, 1_000_000, null,
  ]);
  const data = {};
  for (const t of [`${scope.toUpperCase()}1`, `${scope.toUpperCase()}2`, ...extraTickers]) {
    data[t] = { c, m: ['', '', ''], p: null };
  }
  return { data };
}
