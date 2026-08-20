'use strict';
// THE SILENT BANNER — why 7 consecutive failed cron runs showed the user nothing.
//
// public/js/app.js computed its warning from d.lastRun.failed + d.lastRun.warmFails
// only. The chain refactor moved ordered work into warmchain roots, so a chain that
// 500s lands in chainDispatchFails and a chain that never reports lands in
// lateChainFails — BOTH of which the banner ignored. On 2026-08-18 the server said
// failCount:5 (atlasx, ticks3 and swing OOM-killed, swingsearch 504'd) while
// failed:[] and warmFails:[] — so the banner computed 0 real failures and suppressed
// itself. The app looked fine for a week while none of that work happened.
//
// The fix is to compute the list ONCE, server-side, where it can actually be tested,
// instead of having the client re-derive a shape it does not fully know about.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProblems, buildHealthResponse } = require('../lib/health');

// A PINNED clock plus a benchmark series that reaches the session due at that instant.
// Without this the fixtures inherited Date.now(), so whether `healthy` could ever be true
// depended on the day the suite ran — latent flakiness these tests should not carry,
// especially now that staleness is judged by decision session rather than bar age.
const FRESH_DATA = {
  now: Date.parse('2026-08-19T23:00:00Z'),   // Wednesday, after the US close
  spyDate: '2026-08-19',
  spyDates: ['2026-08-17', '2026-08-18', '2026-08-19'],
  ageDays: 0.2,
};

test('runProblems surfaces chain dispatch failures — the case the banner missed', () => {
  // Arrange — the exact shape of the 2026-08-18 run
  const run = { ok: false, failed: [], warmFails: [], budgetSkipped: [],
    chainDispatchFails: ['atlasx', 'ticks3', 'swing'], lateChainFails: ['swingsearch'] };

  // Act
  const problems = runProblems(run);

  // Assert
  assert.deepStrictEqual(problems,
    ['chain:atlasx', 'chain:ticks3', 'chain:swing', 'chain:swingsearch']);
});

test('runProblems still reports classic stage and cache-warm failures', () => {
  const run = { failed: ['track'], warmFails: [{ path: '/api/screener?scope=large' }],
    budgetSkipped: [], chainDispatchFails: [], lateChainFails: [] };
  assert.deepStrictEqual(runProblems(run), ['track', '/api/screener?scope=large']);
});

test('runProblems EXCLUDES budget-deferred stages — they self-heal and are not errors', () => {
  // Preserves the deliberate suppression the banner already had; alarming on every
  // capacity-bound run is the fatigue that masked the original bug.
  const run = { failed: ['archive'], budgetSkipped: ['archive'], warmFails: [],
    chainDispatchFails: [], lateChainFails: [] };
  assert.deepStrictEqual(runProblems(run), []);
});

test('runProblems does not double-report a chain that both failed and vanished', () => {
  const run = { failed: [], warmFails: [], budgetSkipped: [],
    chainDispatchFails: ['swing'], lateChainFails: ['swing'] };
  assert.deepStrictEqual(runProblems(run), ['chain:swing']);
});

test('runProblems is empty for a clean run, and safe on missing input', () => {
  assert.deepStrictEqual(runProblems({ ok: true, failed: [], warmFails: [] }), []);
  assert.deepStrictEqual(runProblems(null), []);
  assert.deepStrictEqual(runProblems(undefined), []);
});

test('buildHealthResponse exposes problems so the client renders instead of re-deriving', () => {
  // Arrange
  const runs = [{ at: '2026-08-18T22:05:45.910Z', ok: false, failed: [], warmFails: [],
    budgetSkipped: [], chainDispatchFails: ['atlasx'], chainSkips: [] }];

  // Act
  const res = buildHealthResponse(runs, { ...FRESH_DATA,
    auth: { ok: true, production: true, secretConfigured: true, warnings: [] } });

  // Assert
  assert.deepStrictEqual(res.problems, ['chain:atlasx']);
  assert.equal(res.healthy, false, 'a failed chain must not read as healthy');
  assert.equal(res.failStreak, 1);
});

test('a clean run yields no problems and healthy true', () => {
  const runs = [{ at: '2026-08-18T22:05:45.910Z', ok: true, failed: [], warmFails: [],
    budgetSkipped: [], chainDispatchFails: [], chainSkips: [] }];
  const res = buildHealthResponse(runs, { ...FRESH_DATA,
    auth: { ok: true, production: true, secretConfigured: true, warnings: [] } });
  assert.deepStrictEqual(res.problems, []);
  assert.equal(res.healthy, true);
});

test('`ok` is the ENVELOPE flag, never the verdict — the verdict is `healthy`', () => {
  // Pinned because this is exactly the trap: `ok` is the first field in the response
  // and stayed true through a 7-run outage. Anything deciding "is the app fine" must
  // read `healthy` / `problems`, not `ok`.
  const runs = [{ at: 'x', ok: false, failed: ['track'], warmFails: [], budgetSkipped: [],
    chainDispatchFails: [], chainSkips: [] }];
  const res = buildHealthResponse(runs, { auth: { ok: true, production: true, secretConfigured: true, warnings: [] } });
  assert.equal(res.ok, true, 'envelope stays true — the request itself succeeded');
  assert.equal(res.healthy, false, 'but the verdict is false');
  assert.ok(res.problems.length > 0);
});

// ── client render pin ──────────────────────────────────────────────────────
// Source-level only (app.js is a browser IIFE), so it is a REGRESSION FENCE, not
// the logic test — the logic is exercised against runProblems above.
test('the banner renders the server list and no longer re-derives it', () => {
  const fs = require('node:fs'), path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const health = app.slice(app.indexOf('async function checkHealth()'), app.indexOf('checkHealth();'));

  assert.ok(health.includes('d.problems'), 'banner must read the server-derived problems list');
  assert.ok(!/const\s+realFailed\s*=/.test(health),
    'banner must not reconstruct the failure list — that is what hid the chain failures');
  assert.ok(!/lastRun\.warmFails/.test(health),
    'warmFails is only one of several failure shapes; the server already folds them together');
});
