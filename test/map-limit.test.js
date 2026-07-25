'use strict';
// mapLimit — the bounded-concurrency primitive behind the op=scoreboard ledger load.
// Its two guarantees are what the caller depends on: results come back in INPUT order
// (runScoreboard destructures 19 loaders positionally), and no more than `limit` run at once
// (the whole reason it isn't a flat Promise.all).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapLimit } = require('../lib/map-limit');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('preserves INPUT order regardless of completion order', async () => {
  // Arrange: later items finish first.
  const items = [30, 20, 10, 0];

  // Act
  const out = await mapLimit(items, 4, async ms => { await tick(ms); return ms; });

  // Assert: positional destructuring in runScoreboard would silently mis-assign 19 ledgers
  // to the wrong variables if this ever returned completion order.
  assert.deepEqual(out, [30, 20, 10, 0]);
});

test('never exceeds the concurrency limit', async () => {
  // Arrange
  let inFlight = 0, peak = 0;
  const items = Array.from({ length: 19 }, (_, i) => i);

  // Act
  await mapLimit(items, 6, async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await tick(5);
    inFlight--;
  });

  // Assert
  assert.ok(peak <= 6, `peak concurrency ${peak} exceeded the limit of 6`);
  assert.ok(peak > 1, 'nothing ran concurrently — the helper degenerated to sequential');
});

test('passes the index as the second argument', async () => {
  const out = await mapLimit(['a', 'b', 'c'], 2, async (v, i) => `${i}:${v}`);
  assert.deepEqual(out, ['0:a', '1:b', '2:c']);
});

test('handles an empty list without hanging', async () => {
  assert.deepEqual(await mapLimit([], 6, async () => 1), []);
});

test('a limit above the item count still runs every item once', async () => {
  let calls = 0;
  const out = await mapLimit([1, 2, 3], 99, async v => { calls++; return v * 2; });
  assert.equal(calls, 3);
  assert.deepEqual(out, [2, 4, 6]);
});

test('rejects if any worker throws — a broken ledger read is not swallowed', async () => {
  // runScoreboard relies on this: readAllPicks/readAllGhost intentionally have NO .catch, so a
  // real storage failure must surface rather than silently producing an empty scoreboard.
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async v => { if (v === 2) throw new Error('boom'); return v; }),
    /boom/);
});

// ── op=scoreboard ledger-load guard ───────────────────────────────────────────
// The ~10-12s scoreboard cache-MISS path was dominated by ~19 SEQUENTIAL ledger reads, each a
// Blob list + fan-out. They are independent, so they now load with bounded concurrency. This
// guards the shape at the source, since the cost only shows up against real Blob storage.
const fs = require('node:fs');
const path = require('node:path');
const APEX = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');

const scoreboardBody = () => {
  const start = APEX.indexOf('async function runScoreboard(');
  assert.ok(start > -1, 'runScoreboard not found');
  // Up to the first-appearance dedup, which is where the loading phase ends.
  const end = APEX.indexOf('const firstSeen = new Map();', start);
  assert.ok(end > start, 'could not bound the runScoreboard load phase');
  return APEX.slice(start, end);
};

test('runScoreboard loads its ledgers with bounded concurrency, not sequentially', () => {
  const body = scoreboardBody();
  assert.match(body, /await mapLimit\(/, 'ledger load is no longer routed through mapLimit');
  assert.match(body, /LEDGER_LOAD_CONCURRENCY/, 'concurrency is a magic number, not the named constant');
});

test('THE REGRESSION: no sequential `await readAll*` chain in the load phase', () => {
  // Each `await readAllX()` at statement level is one more serialized list+fetch wave.
  const body = scoreboardBody();
  const sequential = body.match(/await\s+readAll\w+\(/g) || [];
  assert.equal(sequential.length, 0,
    `${sequential.length} sequential ledger await(s) reintroduced: ${sequential.join(', ')}`);
});

test('the ledger concurrency cap stays in a sane band', () => {
  const m = APEX.match(/LEDGER_LOAD_CONCURRENCY\s*=\s*(\d+)/);
  assert.ok(m, 'LEDGER_LOAD_CONCURRENCY not found');
  const limit = Number(m[1]);
  // >1 or it is sequential again; capped because each loader ALREADY fans out over its own
  // daily files, so the real socket count is this number multiplied by that fan-out.
  assert.ok(limit > 1 && limit <= 8, `LEDGER_LOAD_CONCURRENCY=${limit} is outside the sane 2-8 band`);
});

test('every ledger destructured is actually loaded (count parity)', () => {
  const body = scoreboardBody();
  const loaders = (body.match(/\(\)\s*=>\s*read\w+\(/g) || []).length;
  // The destructuring target list sits between `const [` and `] = await mapLimit(`.
  const destructured = body
    .slice(body.indexOf('const [') + 7, body.indexOf('] = await mapLimit('))
    .split(',').map(s => s.trim()).filter(Boolean).length;
  assert.equal(destructured, loaders,
    `${destructured} destructured names vs ${loaders} loaders — positional mismatch would silently swap ledgers`);
});
