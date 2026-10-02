'use strict';
// BLS v2 — live-captured fixtures (2026-10-02), period→date, whitelist budget discipline,
// FRED-shaped output. memo is injected; no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BLS = require('../lib/bls');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', `bls-${name}.sample.json`), 'utf8'));
const NOW = Date.parse('2026-10-02T12:00:00Z');
const memoOk = (body, log = []) => async (url, opts) => { log.push({ url, opts }); return { ok: true, status: 200, body, cached: 'l2' }; };

test('periodToDate: monthly periods → first of month; annual/other → null', () => {
  assert.equal(BLS.periodToDate('2026', 'M08'), '2026-08-01');
  assert.equal(BLS.periodToDate(2026, 'M12'), '2026-12-01');
  assert.equal(BLS.periodToDate('2026', 'M13'), null);
  assert.equal(BLS.periodToDate('2026', 'Q01'), null);
  assert.equal(BLS.periodToDate('abc', 'M01'), null);
});

test('normalizeBls: CPI fixture → ascending numeric observations; revised duplicate keeps the last', () => {
  const obs = BLS.normalizeBls(fixture('cpi'), 'CUUR0000SA0');
  // 14 rows in the fixture; October 2025 is published as "-" (the 2025 lapse in appropriations)
  // and is dropped rather than coerced to 0 — a real gap in the real series.
  assert.equal(obs.length, 13);
  assert.ok(!obs.some((o) => o.date === '2025-10-01'), 'the "-" month is absent, not zero');
  assert.ok(obs.every((o, i) => i === 0 || o.date > obs[i - 1].date));
  assert.deepEqual(obs[obs.length - 1], { date: '2026-08-01', value: 334.98 });
  const dup = BLS.normalizeBls({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'X', data: [{ year: '2026', period: 'M01', value: '1' }, { year: '2026', period: 'M01', value: '2' }, { year: '2026', period: 'M13', value: '9' }] }] } }, 'X');
  assert.deepEqual(dup, [{ date: '2026-01-01', value: 2 }]);
  assert.equal(BLS.normalizeBls({ status: 'REQUEST_NOT_PROCESSED' }, 'X'), null);
  assert.equal(BLS.normalizeBls(fixture('cpi'), 'LNS14000000'), null, 'the body must carry the requested series');
});

test('fetchBlsSeries: whitelisted series only (keyless 25/day budget), 24h memo, FRED-shaped result', async () => {
  const other = await BLS.fetchBlsSeries('CES0000000001', { memo: memoOk(fixture('cpi')) });
  assert.equal(other.available, false);
  assert.match(other.reason, /not a whitelisted/);
  assert.match(other.reason, /25\/day/);

  const log = [];
  const cpi = await BLS.fetchBlsSeries('CUUR0000SA0', { memo: memoOk(fixture('cpi'), log), now: NOW });
  assert.equal(cpi.available, true);
  assert.equal(cpi.leg, 'inflation');
  assert.equal(cpi.invert, false);
  assert.equal(cpi.latest.value, 334.98);
  assert.equal(cpi.latest.date, '2026-08-01');
  assert.equal(cpi.ageDays, 32, 'aged from the month END (Aug 31 → Oct 2)');
  assert.equal(cpi.stale, false);
  assert.equal(cpi.backtestSafe, false);
  assert.equal(cpi.source, 'BLS');
  assert.equal(log[0].url, 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0');
  assert.equal(log[0].opts.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(log[0].opts.tag, 'bls');

  const unrate = await BLS.fetchBlsSeries('LNS14000000', { memo: memoOk(fixture('unrate')), now: NOW });
  assert.equal(unrate.invert, true, 'a rising unemployment rate is risk-negative');
  assert.equal(unrate.latest.value, 4.1);
});

test('fetchBlsSeries: HTTP failure, API-level failure message, stale series, thrown memo', async () => {
  const http = await BLS.fetchBlsSeries('CUUR0000SA0', { memo: async () => ({ ok: false, status: 429, body: null }) });
  assert.match(http.reason, /HTTP 429/);
  const api = await BLS.fetchBlsSeries('CUUR0000SA0', { memo: memoOk({ status: 'REQUEST_NOT_PROCESSED', message: ['daily threshold exceeded'] }) });
  assert.match(api.reason, /daily threshold exceeded/);
  const stale = await BLS.fetchBlsSeries('CUUR0000SA0', { memo: memoOk(fixture('cpi')), now: Date.parse('2027-01-15T00:00:00Z') });
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason, /release delayed/);
  const thrown = await BLS.fetchBlsSeries('CUUR0000SA0', { memo: async () => { throw new Error('ECONNRESET'); } });
  assert.match(thrown.reason, /ECONNRESET/);
});
