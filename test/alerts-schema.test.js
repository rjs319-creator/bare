'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/alerts-schema');

const COLLECTED = Date.parse('2026-07-21T15:00:00Z');

test('v2 ingest: normalizes a full post and the SERVER controls collectedAt', () => {
  const r = s.normalizeV2Post({
    platform: 'x', authorId: 'u123', handle: 'trader', text: 'long $NVDA breakout',
    publishedAt: '2026-07-21T14:30:00Z', collectedAt: '2020-01-01T00:00:00Z',   // collector-supplied — must be ignored
  }, { collectedAtMs: COLLECTED, collectorId: 'box1' });
  assert.equal(r.ok, true);
  assert.equal(r.record.collectedAt, new Date(COLLECTED).toISOString());     // server clock, not the collector's
  assert.equal(r.record.accountKey, 'x:u123');
  assert.equal(r.record.identityKnown, true);
  assert.equal(r.record.provenanceQuality, 'full');
});

test('legacy adapter: {text, account, timestamp} still works with DEGRADED provenance and no stable id', () => {
  const r = s.adaptLegacyPost({ text: 'buying $TSLA', account: 'someguy', timestamp: '2026-07-20T12:00:00Z' }, { collectedAtMs: COLLECTED });
  assert.equal(r.ok, true);
  assert.equal(r.record.provenanceQuality, 'degraded');
  assert.equal(r.record.identityKnown, false);           // a legacy handle is NOT a stable id
  assert.equal(r.record.accountKey, 'legacy:someguy');   // keys a legacy pseudo-account, not a canonical id
  assert.ok(r.record.dataQualityFlags.includes('legacy_adapter'));
});

test('future publication timestamp is flagged and NOT coerced to now', () => {
  const r = s.normalizeV2Post({ platform: 'x', authorId: 'u1', text: 'long $AAPL', publishedAt: '2030-01-01T00:00:00Z' }, { collectedAtMs: COLLECTED });
  assert.equal(r.ok, true);
  assert.equal(r.record.publishedAt, null);
  assert.equal(r.record.publishedValid, false);
  assert.ok(r.record.dataQualityFlags.includes('future_published_ts'));
});

test('malformed timestamp and missing text are rejected/flagged', () => {
  assert.equal(s.normalizeV2Post({ platform: 'x', authorId: 'u1', text: '' }, { collectedAtMs: COLLECTED }).ok, false);
  const bad = s.normalizeV2Post({ platform: 'x', authorId: 'u1', text: 'hi $AAPL', publishedAt: 'not-a-date' }, { collectedAtMs: COLLECTED });
  assert.ok(bad.record.dataQualityFlags.includes('malformed_published_ts'));
});

test('oversized payload is rejected', () => {
  const huge = 'x'.repeat(s.MAX_TEXT_LEN + 1);
  assert.equal(s.normalizeV2Post({ platform: 'x', authorId: 'u1', text: huge }, { collectedAtMs: COLLECTED }).ok, false);
});

test('unknown identity: contributes as a record but earns NO account key (never pooled under "?")', () => {
  const r = s.normalizeV2Post({ platform: 'x', text: 'long $GME', publishedAt: '2026-07-21T14:00:00Z' }, { collectedAtMs: COLLECTED });
  assert.equal(r.ok, true);
  assert.equal(r.record.accountKey, null);
  assert.equal(r.record.identityKnown, false);
  assert.ok(r.record.dataQualityFlags.includes('unknown_identity'));
});

test('stable identity: handle change keeps the SAME canonical account key', () => {
  const a = s.normalizeV2Post({ platform: 'x', authorId: 'u9', handle: 'oldname', text: 'long $MSFT' }, { collectedAtMs: COLLECTED });
  const b = s.normalizeV2Post({ platform: 'x', authorId: 'u9', handle: 'newname', text: 'long $MSFT' }, { collectedAtMs: COLLECTED });
  assert.equal(a.record.accountKey, b.record.accountKey);   // id is identity; handle is not
});

test('content hashing: exact-duplicate text (modulo URL/whitespace) hashes identically', () => {
  const h1 = s.contentHash('LONG $NVDA  breakout https://x.com/a');
  const h2 = s.contentHash('long $nvda breakout https://x.com/DIFFERENT');
  assert.equal(h1, h2);
  assert.notEqual(h1, s.contentHash('short $NVDA breakdown'));
});

test('normalizeBatch routes v2 and legacy rows and drops invalid ones', () => {
  const out = s.normalizeBatch([
    { platform: 'x', authorId: 'u1', text: 'long $AAPL', publishedAt: '2026-07-21T14:00:00Z' },
    { text: 'legacy $TSLA', account: 'joe', timestamp: '2026-07-20T00:00:00Z' },
    { text: '' },
  ], { collectedAtMs: COLLECTED });
  assert.equal(out.records.length, 2);
  assert.equal(out.rejected.length, 1);
});
