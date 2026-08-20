'use strict';
// CHALLENGERLOG'S LOST DAYS.
//
// op=challengerlog self-fetches sibling endpoints to gather ranked signals. If it
// gathers zero it returns 503 and refuses to log — correct, because immutably recording
// an empty board is worse. But the cost of that refusal is a WHOLE DAY of predictions,
// and the next attempt is 24h away.
//
// On 2026-08-18 it failed in 155ms: every sibling fetch failed instantly because the
// 22:0x burst was OOM-killing those invocations (its own source comment names this).
// makeFetchJSON did a single bare fetch() with no timeout and no retry, so one transient
// 5xx from a sibling cost the day. Worse, a network THROW propagated out of the gather
// and killed the whole board rather than dropping one source.
//
// lib/http.js fetchWithTimeout already implements the bounded retry this needs and its
// docs call out exactly this case ("low-volume callers can opt in"). challengerlog is a
// handful of self-fetches once a night — the opt-in case.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFetchJSON, CHALLENGER_FETCH } = require('../lib/challenger-routes');

test('the self-fetch opts in to a bounded retry and a hard timeout', async () => {
  // Arrange
  const calls = [];
  const fetchJson = async (url, opts) => { calls.push({ url, opts }); return okJson({ signals: [] }); };

  // Act
  await makeFetchJSON('example.test', { fetchJson })('/api/tracker?op=x');

  // Assert
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://example.test/api/tracker'));
  assert.ok(calls[0].opts.retries >= 1, 'a transient sibling 5xx must not cost the day');
  assert.ok(calls[0].opts.timeoutMs > 0, 'a hung sibling must not consume the invocation');
});

test('a non-ok sibling response yields null for that source, as before', async () => {
  const fetchJson = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const out = await makeFetchJSON('h', { fetchJson })('/p');
  assert.equal(out, null);
});

test('a THROWN sibling fetch drops only that source — it must not kill the whole board', async () => {
  // This is the regression that mattered: one network error used to propagate out of the
  // gather, so the board was lost even when every OTHER source answered fine.
  const fetchJson = async () => { throw new TypeError('fetch failed'); };
  const out = await makeFetchJSON('h', { fetchJson })('/p');
  assert.equal(out, null, 'a throw becomes a null source, not an exception');
});

test('malformed JSON from a sibling is a null source, not a crash', async () => {
  const fetchJson = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  const out = await makeFetchJSON('h', { fetchJson })('/p');
  assert.equal(out, null);
});

test('a good sibling still returns its parsed body', async () => {
  const fetchJson = async () => okJson({ signals: [{ ticker: 'AAPL' }] });
  const out = await makeFetchJSON('h', { fetchJson })('/p');
  assert.deepStrictEqual(out, { signals: [{ ticker: 'AAPL' }] });
});

test('the retry budget is bounded — this must not become a retry storm', () => {
  // The `timeoutMs <= 20000` bound here was originally 12s and was a GUESS: it was
  // written before anyone measured the sources, and it cut off scoreboard (~15.8s) and
  // today (~12.7s) — the two the ranking and regime read depend on. The real constraint
  // is the chain deadline, which is what this now asserts (see
  // test/challenger-source-diagnostics.test.js for the measured lower bound).
  const { CHAIN_DEADLINE_MS } = require('../lib/warm-chains');
  assert.ok(CHALLENGER_FETCH.retries <= 3, 'unbounded retries would just move the failure');
  assert.ok(CHALLENGER_FETCH.timeoutMs * (CHALLENGER_FETCH.retries + 1) < CHAIN_DEADLINE_MS,
    'worst-case retry budget must fit the chain deadline');
});

function okJson(body) { return { ok: true, status: 200, json: async () => body }; }
