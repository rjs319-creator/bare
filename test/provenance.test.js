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

// ── Session-aware staleness (review 2026-10: no universal stale threshold) ──────────
test('enrichFreshness: Friday-close data is NOT stale on the weekend, however many hours old', () => {
  const rows = [{ source: 'screener', ok: true, asOf: '2026-10-02T22:05:00Z' }]; // Fri 18:05 ET
  const sunday = P.enrichFreshness(rows, Date.parse('2026-10-04T23:00:00Z'));   // ~49h later
  assert.ok(sunday[0].ageHours > 30);
  assert.equal(sunday[0].stale, false);
  assert.equal(sunday[0].staleBasis, 'session');
  assert.equal(sunday[0].sessionDue, '2026-10-02');
});

test('enrichFreshness: a holiday does not make the prior session stale', () => {
  // Fri 2026-07-03 is the observed Independence Day holiday.
  const rows = [{ source: 'coil', ok: true, asOf: '2026-07-02T22:05:00Z' }];     // Thu close
  const monPreOpen = P.enrichFreshness(rows, Date.parse('2026-07-06T12:00:00Z')); // Mon 08:00 ET
  assert.equal(monPreOpen[0].stale, false);
  assert.equal(monPreOpen[0].sessionDue, '2026-07-02');
});

test('enrichFreshness: a source that missed the due session IS stale even when under 30h old', () => {
  // Mon close data, read Tue 21:00 ET (Tue session closed + settle grace elapsed).
  const rows = [{ source: 'screener', ok: true, asOf: '2026-10-05T22:05:00Z' }];
  const out = P.enrichFreshness(rows, Date.parse('2026-10-07T01:00:00Z'));
  assert.ok(out[0].ageHours < 30);
  assert.equal(out[0].stale, true);
  assert.equal(out[0].sessionDue, '2026-10-06');
});

test('enrichFreshness: an early close is honoured (13:00 ET bell + grace)', () => {
  // Fri 2026-11-27 closes 13:00 ET; at 17:30 ET that session is due, Wednesday data is stale.
  const rows = [{ source: 'screener', ok: true, asOf: '2026-11-25T22:05:00Z' }];
  const out = P.enrichFreshness(rows, Date.parse('2026-11-27T22:30:00Z'));
  assert.equal(out[0].sessionDue, '2026-11-27');
  assert.equal(out[0].stale, true);
});

test('enrichFreshness: a missing timestamp is unknown — never fresh, never substituted with now', () => {
  const out = P.enrichFreshness([{ source: 'screener', ok: true, asOf: null }], Date.parse('2026-10-04T23:00:00Z'));
  assert.equal(out[0].timestampKnown, false);
  assert.equal(out[0].staleBasis, 'unknown');
  assert.equal(out[0].ageHours, null);
});
