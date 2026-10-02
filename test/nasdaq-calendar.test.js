'use strict';
// Nasdaq calendars — live-captured fixtures (2026-10-02), boundary normalization, FMP fallback
// order, and the earnings-today projection. memo/fmp are injected; no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const NC = require('../lib/nasdaq-calendar');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', `nasdaq-${name}.sample.json`), 'utf8'));
const memoOk = (body) => async () => ({ ok: true, status: 200, body, cached: false });
const memoStatus = (status) => async () => ({ ok: false, status, body: null, cached: false });
const fmpFail = async () => ({ ok: false, status: 403, category: 'plan-gated', body: null, error: 'FMP /x HTTP 403' });

test('helpers: US dates, accounting numbers, split ratios', () => {
  assert.equal(NC.usDateToIso('10/09/2026'), '2026-10-09');
  assert.equal(NC.usDateToIso('9/08/2026'), '2026-09-08');
  assert.equal(NC.usDateToIso('N/A'), null);
  assert.equal(NC.parseAccountingNumber('($0.31)'), -0.31);
  assert.equal(NC.parseAccountingNumber('$43,807,184'), 43807184);
  assert.equal(NC.parseAccountingNumber(''), null);
  assert.equal(NC.parseAccountingNumber(0.05), 0.05);
  assert.deepEqual(NC.parseSplitRatio('3 : 1'), { numerator: 3, denominator: 1, factor: 3 });
  assert.equal(NC.parseSplitRatio('1 : 5').factor, 0.2);
  assert.equal(NC.parseSplitRatio('weird'), null);
  assert.equal(NC.calendarUrl('earnings', '2026-10-02'), 'https://api.nasdaq.com/api/calendar/earnings?date=2026-10-02');
  assert.throws(() => NC.calendarUrl('ipos', '2026-10-02'), /unknown kind/);
  assert.throws(() => NC.calendarUrl('earnings', '10/02/2026'), /YYYY-MM-DD/);
});

test('normalizeNasdaq: earnings rows (data.rows) carry forecast/estimates as numbers', () => {
  const n = NC.normalizeNasdaq('earnings', fixture('earnings'), '2026-10-02');
  assert.equal(n.rows.length, 3);
  assert.equal(n.dropped, 0);
  const enlv = n.rows.find((r) => r.symbol === 'ENLV');
  assert.equal(enlv.epsForecast, -0.31);
  assert.equal(enlv.noOfEsts, 1);
  assert.equal(enlv.lastYearEps, -1.2);
  assert.equal(enlv.date, '2026-10-02');
  assert.equal(enlv.time, 'time-not-supplied');
  const celu = n.rows.find((r) => r.symbol === 'CELU');
  assert.equal(celu.epsForecast, null, 'an empty forecast is null, not 0');
});

test('normalizeNasdaq: splits (data.rows) and dividends (data.calendar.rows) — different nesting, one shape', () => {
  const s = NC.normalizeNasdaq('splits', fixture('splits'), '2026-10-02');
  assert.equal(s.rows.length, 4);
  const dxj = s.rows.find((r) => r.symbol === 'DXJ');
  assert.deepEqual(dxj, { symbol: 'DXJ', name: 'WisdomTree Japan Hedged Equity Fund', ratio: '3 : 1', factor: 3, reverse: false, executionDate: '2026-10-09' });
  const mgf = s.rows.find((r) => r.symbol === 'MGF');
  assert.equal(mgf.reverse, true);
  const d = NC.normalizeNasdaq('dividends', fixture('dividends'), '2026-10-02');
  assert.equal(d.rows.length, 3);
  const alco = d.rows.find((r) => r.symbol === 'ALCO');
  assert.equal(alco.exDate, '2026-10-02');
  assert.equal(alco.payDate, '2026-10-16');
  assert.equal(alco.announcementDate, '2026-09-08');
  assert.equal(alco.rate, 0.05);
  assert.equal(alco.indicatedAnnual, 0.2);
});

test('normalizeNasdaq: wrong envelope or malformed rows are rejected/dropped, not passed through', () => {
  assert.equal(NC.normalizeNasdaq('earnings', { status: { rCode: 400 }, data: { rows: [] } }, '2026-10-02'), null);
  assert.equal(NC.normalizeNasdaq('dividends', { status: { rCode: 200 }, data: { rows: [] } }, '2026-10-02'), null, 'dividends must nest under calendar');
  const n = NC.normalizeNasdaq('splits', { status: { rCode: 200 }, data: { rows: [{ symbol: 'OK', ratio: '2 : 1', executionDate: '10/10/2026' }, { symbol: 'NODATE', ratio: '2 : 1' }, 'junk', null] } }, '2026-10-02');
  assert.equal(n.rows.length, 1);
  assert.equal(n.dropped, 3);
});

test('fetchNasdaqCalendar: Nasdaq answers → source nasdaq, browser UA + Accept JSON on the request', async () => {
  let seen = null;
  const memo = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, body: fixture('earnings'), cached: 'l1' }; };
  const r = await NC.fetchNasdaqCalendar('earnings', '2026-10-02', { memo, fmp: fmpFail });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'nasdaq');
  assert.equal(r.rows.length, 3);
  assert.equal(r.cached, 'l1');
  assert.equal(seen.opts.init.headers.Accept, 'application/json');
  assert.match(seen.opts.init.headers['User-Agent'], /Mozilla/);
  assert.equal(seen.opts.ttlMs, NC.MEMO_TTL_MS);
  assert.equal(seen.opts.tag, NC.MEMO_TAG);
});

test('fetchNasdaqCalendar: a 403 from Nasdaq falls back to FMP with the same row shape and says so', async () => {
  let fmpCall = null;
  const fmp = async (p, params, opts) => { fmpCall = { p, params, opts }; return { ok: true, status: 200, body: [{ symbol: 'AAPL', date: '2026-10-02', numerator: 4, denominator: 1 }, { symbol: 'BAD', date: 'x' }], cached: false }; };
  const r = await NC.fetchNasdaqCalendar('splits', '2026-10-02', { memo: memoStatus(403), fmp });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'fmp');
  assert.match(r.reason, /nasdaq: HTTP 403 → FMP fallback/);
  assert.deepEqual(r.rows, [{ symbol: 'AAPL', name: null, ratio: '4 : 1', factor: 4, reverse: false, executionDate: '2026-10-02' }]);
  assert.equal(r.dropped, 1);
  assert.equal(fmpCall.p, '/splits-calendar');
  assert.deepEqual(fmpCall.params, { from: '2026-10-02', to: '2026-10-02' });
  assert.equal(fmpCall.opts.memoTtlMs, NC.MEMO_TTL_MS);
});

test('fetchNasdaqCalendar: both vendors down → ok:false with BOTH reasons and no rows; a thrown memo is contained', async () => {
  const r = await NC.fetchNasdaqCalendar('dividends', '2026-10-02', { memo: memoOk({ status: { rCode: 200 }, data: {} }), fmp: fmpFail });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows, []);
  assert.match(r.reason, /nasdaq: unexpected envelope; fmp: FMP \/x HTTP 403/);
  const thrown = await NC.fetchNasdaqCalendar('earnings', '2026-10-02', { memo: async () => { throw new Error('ETIMEDOUT'); }, fmp: fmpFail });
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /nasdaq: ETIMEDOUT/);
});

test('earningsTickersOn: sorted tickers + per-ticker time, never throws', async () => {
  const r = await NC.earningsTickersOn('2026-10-02', { memo: memoOk(fixture('earnings')), fmp: fmpFail });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tickers, [...r.tickers].sort());
  assert.ok(r.tickers.includes('ENLV'));
  assert.equal(r.byTicker.ENLV.epsForecast, -0.31);
  const down = await NC.earningsTickersOn('2026-10-02', { memo: memoStatus(500), fmp: fmpFail });
  assert.equal(down.ok, false);
  assert.deepEqual(down.tickers, []);
});
