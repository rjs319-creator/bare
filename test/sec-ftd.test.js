'use strict';
// SEC fails-to-deliver — period/URL math and the inner-file parser are real; the fetch is an
// explicit, honest stub (www.sec.gov did not resolve from the build sandbox on 2026-10-02).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const FTD = require('../lib/sec-ftd');

test('periodFor/urlFor: 1st–15th is the "a" half, 16th–end the "b" half', () => {
  assert.deepEqual(FTD.periodFor('2026-09-15'), { yyyymm: '202609', half: 'a', id: '202609a' });
  assert.deepEqual(FTD.periodFor('2026-09-16'), { yyyymm: '202609', half: 'b', id: '202609b' });
  assert.equal(FTD.urlFor('2026-09-03'), 'https://www.sec.gov/files/data/fails-deliver-data/cnsfails202609a.zip');
  assert.equal(FTD.urlFor({ yyyymm: '202512', half: 'b' }), 'https://www.sec.gov/files/data/fails-deliver-data/cnsfails202512b.zip');
  assert.throws(() => FTD.periodFor('09/15/2026'), /ISO date/);
  assert.throws(() => FTD.urlFor({ yyyymm: '2026', half: 'c' }), /yyyymm/);
});

test('parseFtdText: the published pipe format, bad rows counted, trailer ignored', () => {
  const text = [
    FTD.EXPECTED_HEADER,
    '20260901|037833100|AAPL|12345|APPLE INC|229.87',
    '20260901|36467W109|GME|250000|GAMESTOP CORP CL A|.',
    '20260901|BAD|X|notanumber|BAD QTY|1',
    '20260901|ONLY|THREE',
    'Trailer record 3',
  ].join('\r\n');
  const p = FTD.parseFtdText(text);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], { settlementDate: '2026-09-01', cusip: '037833100', symbol: 'AAPL', fails: 12345, description: 'APPLE INC', price: 229.87 });
  assert.equal(p.rows[1].price, null, 'a "." price is unknown, not zero');
  assert.deepEqual(p.health.invalidReasons, { bad_quantity: 1, bad_column_count: 1 });
  assert.equal(FTD.parseFtdText('nope\n1|2|3|4|5|6').reason, 'bad_header');
  assert.equal(FTD.parseFtdText('').reason, 'empty_body');
});

test('fetchFtd is an explicit unavailable with the sandbox reason and the URL it would have fetched', async () => {
  const r = await FTD.fetchFtd('2026-09-20');
  assert.equal(r.available, false);
  assert.match(r.reason, /not implemented/i);
  assert.match(r.reason, /did not resolve/i);
  assert.equal(r.url, 'https://www.sec.gov/files/data/fails-deliver-data/cnsfails202609b.zip');
  assert.equal(r.period.id, '202609b');
  const bare = await FTD.fetchFtd();
  assert.equal(bare.url, null);
});
