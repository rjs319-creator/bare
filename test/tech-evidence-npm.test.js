'use strict';
// Prevents: partial "today" counts entering the ledger, missing days silently inflating
// growth, malformed payloads fabricating observations, and date-window drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const NPM = require('../lib/tech-evidence/adapters/npm');

const NOW = new Date('2026-08-11T15:00:00Z');
const MAPPING = { ticker: 'MDB', mappingId: 'MDB-npm-mongodb', version: 2 };

const payload = (start, end, rows) => ({ package: 'mongodb', start, end, downloads: rows });

test('parseRange excludes the partial current day and keeps complete days', () => {
  const body = payload('2026-08-08', '2026-08-11', [
    { day: '2026-08-08', downloads: 100 },
    { day: '2026-08-09', downloads: 110 },
    { day: '2026-08-10', downloads: 120 },
    { day: '2026-08-11', downloads: 7 }, // today (UTC) — partial, must not enter
  ]);
  const r = NPM.parseRange(body, { pkg: 'mongodb', mapping: MAPPING, retrievedAt: NOW.toISOString(), endBound: '2026-08-11', basis: 'live' });
  assert.equal(r.observations.length, 3);
  assert.ok(r.observations.every(o => o.effectiveDate < '2026-08-11'));
  assert.equal(r.observations[0].publicAt, '2026-08-09T00:00:00Z', 'a day count becomes public the following day');
});

test('parseRange counts missing days instead of inventing them', () => {
  const body = payload('2026-08-01', '2026-08-08', [
    { day: '2026-08-01', downloads: 100 },
    { day: '2026-08-04', downloads: 90 }, // 02, 03 missing
    { day: '2026-08-05', downloads: 95 },
  ]);
  const r = NPM.parseRange(body, { pkg: 'mongodb', mapping: MAPPING, retrievedAt: NOW.toISOString(), endBound: '2026-08-11', basis: 'live' });
  assert.equal(r.observations.length, 3);
  assert.equal(r.missingDays, 5, '02,03,06,07,08 are absent and must be counted, not filled');
});

test('parseRange rejects malformed payloads and negative counts', () => {
  const bad = NPM.parseRange({ nope: true }, { pkg: 'x', mapping: MAPPING, retrievedAt: NOW.toISOString(), endBound: '2026-08-11', basis: 'live' });
  assert.match(bad.error, /malformed/);
  const neg = NPM.parseRange(payload('2026-08-01', '2026-08-01', [{ day: '2026-08-01', downloads: -5 }]),
    { pkg: 'x', mapping: MAPPING, retrievedAt: NOW.toISOString(), endBound: '2026-08-11', basis: 'live' });
  assert.equal(neg.observations.length, 0);
});

test('collectNpm builds the exact requested window and survives a failing package', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('dd-trace')) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'oops' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload('2026-07-27', '2026-08-10', [{ day: '2026-08-10', downloads: 5 }])) };
  };
  const r = await NPM.collectNpm({
    mappings: [{ ...MAPPING, sourceId: 'mongodb' }, { ticker: 'DDOG', mappingId: 'DDOG-npm-dd-trace', version: 2, sourceId: 'dd-trace' }],
    days: 14, now: NOW, fetchImpl,
  });
  assert.match(urls[0], /\/2026-07-28:2026-08-10\/mongodb$/, 'window is [today-14, today-1]');
  assert.equal(r.partial, true, 'one package failing must yield partial success, not total failure');
  assert.equal(r.observations.length, 1);
  assert.equal(r.coverage.perEntity['dd-trace'].ok, false);
});

test('deterministic observation ids make retries idempotent; restatements get new ids', () => {
  const args = { pkg: 'mongodb', mapping: MAPPING, retrievedAt: NOW.toISOString(), endBound: '2026-08-11', basis: 'live' };
  const a = NPM.parseRange(payload('2026-08-10', '2026-08-10', [{ day: '2026-08-10', downloads: 42 }]), args);
  const b = NPM.parseRange(payload('2026-08-10', '2026-08-10', [{ day: '2026-08-10', downloads: 42 }]), args);
  const c = NPM.parseRange(payload('2026-08-10', '2026-08-10', [{ day: '2026-08-10', downloads: 43 }]), args);
  assert.equal(a.observations[0].id, b.observations[0].id);
  assert.notEqual(a.observations[0].id, c.observations[0].id, 'a restated value is a NEW observation (revision)');
});
