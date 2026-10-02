'use strict';
// Treasury daily par yield curve — live-captured CSV fixture (2026), name-matched tenors,
// 2s10s in bp, prior-year top-up, FRED-shaped series. memo is injected; no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TC = require('../lib/treasury-curve');

const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', 'treasury-par-yield-2026.sample.csv'), 'utf8');
const NOW = Date.parse('2026-10-02T12:00:00Z');
const memoFor = (byYear, log = []) => async (url) => {
  log.push(url);
  const year = Number(/\.csv\/(\d{4})\//.exec(url)[1]);
  const body = byYear[year];
  return body == null ? { ok: false, status: 404, body: null } : { ok: true, status: 200, body };
};

test('parseCurveCsv: quoted header, MM/DD/YYYY dates, ascending rows, tenors matched by NAME', () => {
  const p = TC.parseCurveCsv(CSV);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 30);
  assert.ok(p.rows.every((r, i) => i === 0 || r.date > p.rows[i - 1].date), 'ascending');
  const last = p.rows[p.rows.length - 1];
  assert.equal(last.date, '2026-10-01');
  assert.equal(last.tenors.y2, 4.78);
  assert.equal(last.tenors.y10, 5.24);
  assert.equal(last.tenors.m1_5, 4.10, 'the 1.5-month column is carried under its own key');
  assert.equal(TC.twoTenSpreadBp(last), 46);
  assert.deepEqual(p.tenors.slice(0, 3), ['m1', 'm1_5', 'm2']);
});

test('parseCurveCsv: a new tenor column shifts nothing; blanks are null; bad rows are counted', () => {
  const text = ['Date,"1 Mo","2 Yr","Brand New","10 Yr"', '10/01/2026,4.0,4.5,9.9,5.0', '09/30/2026,4.0,,9.9,5.1', 'garbage', '09/29/2026,1,2'].join('\n');
  const p = TC.parseCurveCsv(text);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.invalid, 2);
  assert.equal(p.rows[1].tenors['Brand New'], 9.9);
  assert.equal(p.rows[1].tenors.y10, 5.0);
  assert.equal(TC.twoTenSpreadBp(p.rows[1]), 50);
  assert.equal(p.rows[0].tenors.y2, null);
  assert.equal(TC.twoTenSpreadBp(p.rows[0]), null, 'a missing tenor yields no spread, never a shifted number');
  assert.equal(TC.parseCurveCsv('Nope,1 Mo\n1,2').reason, 'bad_header');
  assert.equal(TC.parseCurveCsv('').reason, 'empty_body');
});

test('fetchTreasuryCurve: current year suffices → one request, latest spread, not stale', async () => {
  const log = [];
  const c = await TC.fetchTreasuryCurve({ now: NOW, memo: memoFor({ 2026: CSV }, log) });
  assert.equal(c.available, true);
  assert.equal(log.length, 1);
  assert.match(log[0], /daily-treasury-rates\.csv\/2026\/all\?type=daily_treasury_yield_curve&field_tdr_date_value=2026/);
  assert.equal(c.latest.date, '2026-10-01');
  assert.equal(c.latest.spreadBp, 46);
  assert.equal(c.ageDays, 1);
  assert.equal(c.stale, false);
  assert.equal(c.backtestSafe, true);
  assert.equal(c.observations.length, 30);
});

test('fetchTreasuryCurve: a young year tops up from the prior year; a dead feed is stale; HTTP errors are unavailable', async () => {
  const jan = Date.parse('2026-01-06T12:00:00Z');
  const young = 'Date,"2 Yr","10 Yr"\n01/05/2026,4.0,4.5\n01/02/2026,4.0,4.4';
  const log = [];
  const c = await TC.fetchTreasuryCurve({ now: jan, memo: memoFor({ 2026: young, 2025: CSV.replace(/\/2026/g, '/2025') }, log) });
  assert.equal(c.available, true);
  assert.equal(log.length, 2, 'prior year fetched because the current file is short');
  assert.equal(c.observations.length, 32);
  assert.equal(c.latest.date, '2026-01-05');
  assert.equal(c.ageDays, 1);
  const old = await TC.fetchTreasuryCurve({ now: Date.parse('2026-10-20T00:00:00Z'), memo: memoFor({ 2026: CSV }) });
  assert.equal(old.stale, true);
  const down = await TC.fetchTreasuryCurve({ now: NOW, memo: memoFor({}) });
  assert.equal(down.available, false);
  assert.match(down.reason, /HTTP 404/);
  const thrown = await TC.fetchTreasuryCurve({ now: NOW, memo: async () => { throw new Error('boom'); } });
  assert.match(thrown.reason, /treasury fetch failed: boom/);
});

test('tenYearSeries / twoTenSeries: FRED-shaped series the macro legs can trend', async () => {
  const c = await TC.fetchTreasuryCurve({ now: NOW, memo: memoFor({ 2026: CSV }) });
  const ten = TC.tenYearSeries(c);
  assert.equal(ten.available, true);
  assert.equal(ten.id, 'TREASURY_10Y');
  assert.equal(ten.source, 'treasury');
  assert.equal(ten.invert, true);
  assert.equal(ten.latest.value, 5.24);
  assert.equal(ten.observations.length, 30);
  const curve = TC.twoTenSeries(c);
  assert.equal(curve.latest.value, 46);
  assert.equal(TC.tenYearSeries({ available: false, reason: 'x' }).available, false);
  assert.equal(TC.curveUrl(2026).startsWith('https://home.treasury.gov/'), true);
  assert.throws(() => TC.curveUrl('2026'), /bad year/);
});
