'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/provenance');

test('stalenessOf: fresh vs stale vs unknown', () => {
  const now = Date.parse('2026-07-12T18:00:00Z');
  const fresh = P.stalenessOf('2026-07-12T15:00:00Z', now); // 3h old
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageHours, 3);
  const stale = P.stalenessOf('2026-07-10T00:00:00Z', now); // ~66h old
  assert.equal(stale.stale, true);
  const unknown = P.stalenessOf(null, now);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.stale, false);
});

test('enrichFreshness: attaches feed, delayed flag, staleness, kind', () => {
  const now = Date.parse('2026-07-12T18:00:00Z');
  const rows = [
    { source: 'screener', ok: true, ms: 200, asOf: '2026-07-12T17:00:00Z' },
    { source: 'ts', ok: true, ms: 900, asOf: '2026-07-09T00:00:00Z' },
  ];
  const out = P.enrichFreshness(rows, now);
  assert.equal(out[0].delayed, true);            // EOD dashboard — nothing real-time
  assert.ok(out[0].feed.includes('Yahoo candles'));
  assert.equal(out[0].stale, false);
  assert.equal(out[0].kind, 'signal');
  assert.equal(out[1].stale, true);              // 3+ days old
  assert.ok(out[1].feed.join(' ').includes('Claude'));
});

test('enrichFreshness: unknown source falls back gracefully', () => {
  const out = P.enrichFreshness([{ source: 'mystery', ok: false, asOf: null }], Date.parse('2026-07-12T18:00:00Z'));
  assert.equal(out[0].label, 'mystery');
  assert.equal(out[0].timestampKnown, false);
});

test('DATA_TRUST_LEGEND: has the four evidence-basis buckets', () => {
  const keys = P.DATA_TRUST_LEGEND.map(x => x.key);
  assert.deepEqual(keys, ['fact', 'feature', 'ai', 'unknown']);
});
