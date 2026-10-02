'use strict';
// A dead earnings-date provider must fail op=tonetick visibly (site audit 2026-10-02 #9): with
// every FMP lookup refused there are zero "recent reporters" by construction, the tone ledger
// stops advancing, and tone-shift's cutoff froze at 2026-09-11 while every night reported ok.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tone = require('../lib/earnings-tone');
const { lookupFailureVerdict } = require('../lib/tone-routes');

test('fetchLastEarningsDate records a provider refusal in stats instead of swallowing it', async () => {
  const realFetch = globalThis.fetch, realKey = process.env.FMP_API_KEY;
  process.env.FMP_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: false, status: 402 });
  try {
    const stats = { failures: [] };
    const d = await tone.fetchLastEarningsDate('AAPL', Date.now(), stats);
    assert.equal(d, null);
    assert.deepEqual(stats.failures, [{ symbol: 'AAPL', status: 402 }]);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey == null) delete process.env.FMP_API_KEY; else process.env.FMP_API_KEY = realKey;
  }
});

test('fetchLastEarningsDate still returns the latest past date on a healthy provider (no failure recorded)', async () => {
  const realFetch = globalThis.fetch, realKey = process.env.FMP_API_KEY;
  process.env.FMP_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ date: '2026-09-23' }, { date: '2026-12-20' }, { date: '2026-06-24' }] });
  try {
    const stats = { failures: [] };
    const d = await tone.fetchLastEarningsDate('MU', Date.parse('2026-10-01T00:00:00Z'), stats);
    assert.equal(d, '2026-09-23');
    assert.equal(stats.failures.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey == null) delete process.env.FMP_API_KEY; else process.env.FMP_API_KEY = realKey;
  }
});

test('lookupFailureVerdict: all lookups refused ⇒ a named error; partial failures ⇒ none', () => {
  const dead = lookupFailureVerdict({ attempted: 12, failures: Array.from({ length: 12 }, (_, i) => ({ symbol: 'T' + i, status: 403 })) });
  assert.equal(dead.allFailed, true);
  assert.match(dead.error, /refused all 12 lookup\(s\) \(403\)/);
  assert.equal(lookupFailureVerdict({ attempted: 12, failures: [{ symbol: 'A', status: 500 }] }).allFailed, false);
  assert.equal(lookupFailureVerdict({ attempted: 0, failures: [] }).allFailed, false);
});
