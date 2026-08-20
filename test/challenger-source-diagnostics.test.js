'use strict';
// WHY challengerlog's 503 STAYED after the OOM was fixed.
//
// The 2026-08-19 cron was the first clean run in 8 days: failCount 5 -> 1, no OOM, and
// atlasx/ticks3/swing/rlt/swingsearch all reported complete. The single survivor was
// `decision/reprime/op=challengerlog`, still 503 "no ranked signals gathered".
//
// So the OOM hypothesis for THIS step was wrong. Gathering the same sources from outside
// returns 311 ranked signals, so the failure cannot be reproduced from the public side
// and the 503 records nothing about WHICH sources came back empty. Two changes:
//
//   1. Measure before you bound. CHALLENGER_FETCH.timeoutMs was set to 12s without
//      measuring: `today` takes ~12.7s and `scoreboard` ~15.8s, so the two sources that
//      matter most were the two most likely to be cut off.
//   2. Make the failure self-diagnosing — name the empty sources instead of guessing
//      again on the next run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceDiagnostics, CHALLENGER_FETCH } = require('../lib/challenger-routes');
const { SOURCE_URLS } = require('../lib/decision-sources');

test('the fetch budget clears the SLOWEST measured source with headroom', () => {
  // Measured against production 2026-08-20: scoreboard ~15.8s, today ~12.7s.
  const SLOWEST_MEASURED_MS = 15800;
  assert.ok(CHALLENGER_FETCH.timeoutMs > SLOWEST_MEASURED_MS,
    `${CHALLENGER_FETCH.timeoutMs}ms cuts off scoreboard (~${SLOWEST_MEASURED_MS}ms) — the source the ranking depends on`);
});

test('the worst-case fetch budget still fits inside the chain deadline', () => {
  const { CHAIN_DEADLINE_MS } = require('../lib/warm-chains');
  const worstCase = CHALLENGER_FETCH.timeoutMs * (CHALLENGER_FETCH.retries + 1);
  assert.ok(worstCase < CHAIN_DEADLINE_MS,
    `${worstCase}ms of retries would blow the ${CHAIN_DEADLINE_MS}ms chain deadline`);
});

test('sourceDiagnostics names exactly which sources came back empty', () => {
  // Arrange — the shape gatherRankedSignals returns: key -> parsed body or null
  const sources = { today: { x: 1 }, scoreboard: null, screener: { y: 2 }, gapgo: null };

  // Act
  const diag = sourceDiagnostics(sources);

  // Assert
  assert.deepStrictEqual(diag.empty, ['scoreboard', 'gapgo']);
  assert.equal(diag.present, 2);
  assert.equal(diag.total, 4);
});

test('sourceDiagnostics reports an all-empty gather — the exact 503 case', () => {
  const sources = Object.fromEntries(Object.keys(SOURCE_URLS).map(k => [k, null]));
  const diag = sourceDiagnostics(sources);
  assert.equal(diag.present, 0);
  assert.equal(diag.empty.length, Object.keys(SOURCE_URLS).length);
  assert.ok(diag.empty.includes('today') && diag.empty.includes('scoreboard'));
});

test('sourceDiagnostics reports a fully healthy gather as no empties', () => {
  const sources = { today: {}, scoreboard: {} };
  const diag = sourceDiagnostics(sources);
  assert.deepStrictEqual(diag.empty, []);
  assert.equal(diag.present, 2);
});

test('sourceDiagnostics is safe on missing input rather than throwing inside the error path', () => {
  // It runs while ALREADY failing — it must never turn a 503 into a 500.
  for (const bad of [null, undefined, {}]) {
    const diag = sourceDiagnostics(bad);
    assert.equal(diag.present, 0);
    assert.deepStrictEqual(diag.empty, []);
    assert.equal(diag.total, 0);
  }
});
