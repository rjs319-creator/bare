'use strict';
// ARK daily-holdings CSV: URL table, parser (fixture trimmed from the live 2026-10-01 ARKK
// file), boundary validation (missing column → named error, never silent zeros), fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../lib/ark-holdings');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ark-arkk-holdings-2026-10-01.csv'), 'utf8');

test('ARK_FUNDS: the six equity ETFs, each with an https CSV URL on assets.ark-funds.com', () => {
  assert.deepEqual([...A.ARK_FUNDS].sort(), ['ARKF', 'ARKG', 'ARKK', 'ARKQ', 'ARKW', 'ARKX']);
  for (const f of A.ARK_FUNDS) {
    const url = A.ARK_CSV_URLS[f];
    assert.match(url, /^https:\/\/assets\.ark-funds\.com\/fund-documents\/funds-etf-csv\/ARK_.*_HOLDINGS\.csv$/, f);
    assert.ok(url.includes(`_${f}_HOLDINGS`), `${f} url names its fund`);
    assert.doesNotMatch(url, /[&\s]/, `${f}: ampersand/space must be percent-encoded`);
  }
});

test('parseArkCsv: the live fixture → ISO as-of date, numeric shares/value/weight, cash + warrant + disclaimer rows skipped and COUNTED', () => {
  const r = A.parseArkCsv(FIXTURE, { fund: 'ARKK' });
  assert.equal(r.fund, 'ARKK');
  assert.equal(r.asOf, '2026-10-01');
  assert.equal(r.holdings.length, 8);
  assert.deepEqual(r.holdings[0], { ticker: 'TSLA', cusip: '88160R101', company: 'TESLA INC', shares: 2087330, marketValue: 740605557.30, weight: 9.08 });
  assert.equal(r.holdings[7].ticker, 'HOOD');
  // Two blank-ticker rows (money-market cash, a warrant placeholder) and the disclaimer.
  assert.equal(r.skipped.noTicker, 2);
  assert.equal(r.skipped.malformed, 1);
  assert.equal(r.skipped.badNumber, 0);
});

test('parseArkCsv: Bloomberg-style ticker suffixes and class dots are normalized to the app convention', () => {
  const csv = 'date,fund,company,ticker,cusip,shares,market value ($),weight (%)\n'
    + '01/02/2026,ARKX,ROCKET LAB,RKLB UQ,773121108,"659,546","$46,009,928.96",8.90%\n'
    + '01/02/2026,ARKX,BROWN FORMAN,BF.B,115637209,"100","$1,000.00",0.01%\n';
  const r = A.parseArkCsv(csv, { fund: 'ARKX' });
  assert.deepEqual(r.holdings.map((h) => h.ticker), ['RKLB', 'BF-B']);
  assert.equal(r.asOf, '2026-01-02');
});

test('parseArkCsv: a missing required column is a clear schema error naming the column — not a sheet of zeros', () => {
  const noShares = FIXTURE.replace('shares,market value ($)', 'market value ($)').replace(/,"\d[\d,]*","\$/g, ',"$');
  assert.throws(() => A.parseArkCsv(noShares, { fund: 'ARKK' }), /schema.*\bshares\b/i);
  const renamed = FIXTURE.replace('market value ($)', 'market value');
  assert.throws(() => A.parseArkCsv(renamed, { fund: 'ARKK' }), /market value \(\$\)/);
});

test('parseArkCsv: a non-numeric shares cell is counted as badNumber and the row dropped (never coerced to 0)', () => {
  const csv = 'date,fund,company,ticker,cusip,shares,market value ($),weight (%)\n'
    + '10/01/2026,ARKK,TESLA INC,TSLA,88160R101,"n/a","$740,605,557.30",9.08%\n'
    + '10/01/2026,ARKK,TEMPUS AI INC-CL A,TEM,88023B103,"5,881,278","$481,676,668.20",5.91%\n';
  const r = A.parseArkCsv(csv, { fund: 'ARKK' });
  assert.deepEqual(r.holdings.map((h) => h.ticker), ['TEM']);
  assert.equal(r.skipped.badNumber, 1);
});

test('parseArkCsv: wrong fund, empty body, or zero parsed holdings all throw rather than yield an empty snapshot', () => {
  assert.throws(() => A.parseArkCsv(FIXTURE, { fund: 'ARKW' }), /fund.*ARKW.*ARKK/i);
  assert.throws(() => A.parseArkCsv('', { fund: 'ARKK' }), /empty|header/i);
  const headerOnly = FIXTURE.split('\n')[0] + '\n';
  assert.throws(() => A.parseArkCsv(headerOnly, { fund: 'ARKK' }), /no holdings/i);
});

test('fetchArkHoldings: non-2xx throws with fund + status; 200 parses', async () => {
  await assert.rejects(A.fetchArkHoldings('ARKK', { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }), /ARKK.*503/);
  const r = await A.fetchArkHoldings('ARKK', { fetchImpl: async (url) => { assert.equal(url, A.ARK_CSV_URLS.ARKK); return { ok: true, status: 200, text: async () => FIXTURE }; } });
  assert.equal(r.holdings.length, 8);
});

test('fetchAllArkHoldings: one fund failing never hides the others — errors are per fund', async () => {
  const fetchImpl = async (url) => (url.includes('_ARKG_') ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => FIXTURE.replace(/ARKK/g, A.fundFromUrl(url)) });
  const r = await A.fetchAllArkHoldings({ fetchImpl, funds: ['ARKK', 'ARKG', 'ARKW'] });
  assert.deepEqual(Object.keys(r.funds).sort(), ['ARKK', 'ARKW']);
  assert.match(r.errors.ARKG, /404/);
});
