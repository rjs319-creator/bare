'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickGradeShards, memoFetch, GRADE_CONCURRENCY, GRADE_BUDGET_MS } = require('../lib/swing-search-ledger');

// ── pickGradeShards ────────────────────────────────────────────────────────
// THE BUG: runSwingSearchGrade used `blobs.slice(0, 40)`. Blob list order is
// pathname-ascending, i.e. OLDEST first — so once the ledger passed 40 shards the
// NEWEST days would silently stop being graded, with nothing in the logs saying so.

test('pickGradeShards returns newest-first so new days are never starved by the cap', () => {
  // Arrange — deliberately handed to it in ascending (blob-list) order
  const blobs = [
    { pathname: 'swingsearch/day/universe-2026-08-01.json' },
    { pathname: 'swingsearch/day/universe-2026-08-02.json' },
    { pathname: 'swingsearch/day/universe-2026-08-03.json' },
  ];

  // Act
  const picked = pickGradeShards(blobs, 2);

  // Assert — the two NEWEST survive the cap, not the two oldest
  assert.deepStrictEqual(picked.map(b => b.pathname), [
    'swingsearch/day/universe-2026-08-03.json',
    'swingsearch/day/universe-2026-08-02.json',
  ]);
});

test('pickGradeShards reports nothing dropped when the cap is not reached', () => {
  const blobs = [{ pathname: 'a' }, { pathname: 'b' }];
  assert.strictEqual(pickGradeShards(blobs, 40).length, 2);
});

test('pickGradeShards tolerates empty/missing input rather than throwing', () => {
  assert.deepStrictEqual(pickGradeShards(null, 10), []);
  assert.deepStrictEqual(pickGradeShards([], 10), []);
});

test('pickGradeShards does not mutate the caller array (immutability)', () => {
  const blobs = [{ pathname: 'b' }, { pathname: 'a' }];
  const before = blobs.map(x => x.pathname);
  pickGradeShards(blobs, 10);
  assert.deepStrictEqual(blobs.map(x => x.pathname), before);
});

// ── memoFetch ──────────────────────────────────────────────────────────────
// THE BUG: grading refetched the SAME ticker once per snapshot — 19 shards x ~149
// snapshots = ~2,800 network fetches for ~149 distinct names, against a 300s wall.
// The Vercel logs show EA refetched 7+ times in 75s before the invocation 504'd.

test('memoFetch issues ONE fetch per distinct key however many times it is asked', async () => {
  // Arrange
  let calls = 0;
  const fetcher = memoFetch(async (t) => { calls++; return { ticker: t }; });

  // Act — the shape of the real loop: same ticker, many snapshots
  const a = await fetcher('EA');
  const b = await fetcher('EA');
  const c = await fetcher('BK');

  // Assert
  assert.strictEqual(calls, 2);
  assert.strictEqual(a, b);
  assert.strictEqual(c.ticker, 'BK');
});

test('memoFetch caches NEGATIVE results too — a dead ticker must cost one fetch, not N', async () => {
  // Arrange — EA/AKRO return null (delisted or <60 candles). Re-fetching a dead
  // name is what actually burned the budget: ~20s each (2 hosts x 10s timeout).
  let calls = 0;
  const fetcher = memoFetch(async () => { calls++; return null; });

  // Act
  const first = await fetcher('AKRO');
  const second = await fetcher('AKRO');

  // Assert
  assert.strictEqual(calls, 1, 'a null result must be remembered, not retried');
  assert.strictEqual(first, null);
  assert.strictEqual(second, null);
});

test('memoFetch collapses CONCURRENT callers onto one in-flight fetch', async () => {
  // Arrange
  let calls = 0;
  const fetcher = memoFetch(async () => {
    calls++;
    await new Promise(r => setTimeout(r, 10));
    return { ok: true };
  });

  // Act — the bounded pool has several workers asking at once
  const results = await Promise.all(['EA', 'EA', 'EA'].map(fetcher));

  // Assert
  assert.strictEqual(calls, 1);
  assert.strictEqual(results[0], results[1]);
});

test('memoFetch does not cache a THROWN error as a permanent null (transient stays retryable)', async () => {
  // Arrange — a thrown fetch is a transient failure, unlike an honest null result
  let calls = 0;
  const fetcher = memoFetch(async () => { calls++; if (calls === 1) throw new Error('socket'); return { ok: true }; });

  // Act
  const first = await fetcher('BK');
  const second = await fetcher('BK');

  // Assert
  assert.strictEqual(first, null, 'a throw resolves to null for the caller');
  assert.strictEqual(second.ok, true, 'but the next attempt is allowed to succeed');
  assert.strictEqual(calls, 2);
});

// ── budget constants ───────────────────────────────────────────────────────
test('the grade budget stays under the 300s function wall with headroom', () => {
  assert.ok(GRADE_BUDGET_MS < 300000, 'must finish and WRITE before the wall, not 504');
  assert.ok(GRADE_BUDGET_MS >= 120000, 'but large enough to do real work');
  assert.ok(GRADE_CONCURRENCY >= 2 && GRADE_CONCURRENCY <= 12);
});
