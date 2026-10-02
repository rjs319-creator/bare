'use strict';
// Tiingo supported-tickers cross-check core: zip reading (deflated, stored, data-descriptor),
// CSV boundary validation, the staleness-based dead rule, common-ticker filtering, and the
// diff against both secmaster shapes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const T = require('../research/lib/tiingo-tickers');

// Minimal zip writer for fixtures: one or more entries, deflate or stored, optional
// data-descriptor flag (sizes zeroed in the local header, as streaming writers emit).
function makeZip(entries, { method = 8, dataDescriptor = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const data = Buffer.from(content, 'utf8');
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(dataDescriptor ? 8 : 0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(0, 14);
    local.writeUInt32LE(dataDescriptor ? 0 : comp.length, 18); local.writeUInt32LE(dataDescriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const desc = dataDescriptor ? (() => { const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(comp.length, 8); d.writeUInt32LE(data.length, 12); return d; })() : Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    const rec = Buffer.concat([local, nameBuf, comp, desc]);
    parts.push(rec); offset += rec.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const CSV = [
  'ticker,exchange,assetType,priceCurrency,startDate,endDate',
  'AAPL,NASDAQ,Stock,USD,1980-12-12,2026-10-01',
  'ATVI,NASDAQ,Stock,USD,1993-10-25,2023-10-13',
  'DEADX,NYSE,Stock,USD,2015-01-02,2026-09-15',       // 16d before as-of → dead
  'EDGEX,NYSE,Stock,USD,2015-01-02,2026-09-21',       // exactly 10d before → NOT dead (boundary)
  'FRC-P-B,NYSE,Stock,USD,2010-12-09,2017-05-17',     // preferred → excluded by the common filter
  'AMG 5.15,PINK,Stock,USD,2011-09-15,2026-01-02',    // OTC baby bond → not listed-US
  'SPY,NYSE ARCA,ETF,USD,1993-01-29,2026-10-01',      // not a Stock
  '000001,SHE,Stock,CNY,2007-01-04,2026-09-30',       // not USD / not US
  'NOEND,NASDAQ,Stock,USD,2020-01-01,',               // empty endDate → active (never dead)
  'BAD,ROW',                                          // malformed → counted
  '',
].join('\n');

test('readSupportedTickersZip inflates a deflated single-entry archive', () => {
  const text = T.readSupportedTickersZip(makeZip([{ name: 'supported_tickers.csv', content: CSV }]));
  assert.equal(text, CSV);
});

test('readSupportedTickersZip handles stored entries, data descriptors and multi-entry picks the csv', () => {
  assert.equal(T.readSupportedTickersZip(makeZip([{ name: 'x.csv', content: CSV }], { method: 0 })), CSV);
  assert.equal(T.readSupportedTickersZip(makeZip([{ name: 'x.csv', content: CSV }], { dataDescriptor: true })), CSV);
  const multi = makeZip([{ name: 'README.txt', content: 'hello' }, { name: 'supported_tickers.csv', content: CSV }]);
  assert.equal(T.readSupportedTickersZip(multi), CSV, 'the .csv entry wins over a leading readme');
  assert.equal(T.readCentralEntries(multi).length, 2);
});

test('readSupportedTickersZip fails closed on garbage and truncation', () => {
  assert.throws(() => T.readSupportedTickersZip(Buffer.from('not a zip at all, definitely not')), /end-of-central-directory/);
  const z = makeZip([{ name: 'x.csv', content: CSV }]);
  assert.throws(() => T.readSupportedTickersZip(Buffer.concat([z.subarray(0, 10), z.subarray(40)])), /zip:/);
  assert.throws(() => T.readSupportedTickersZip(Buffer.alloc(3)), /too small/);
});

test('parseSupportedTickersCsv validates the header, counts malformed rows, keeps empty endDate as null', () => {
  const { rows, malformed } = T.parseSupportedTickersCsv(CSV);
  assert.equal(malformed, 1);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], { ticker: 'AAPL', exchange: 'NASDAQ', assetType: 'Stock', priceCurrency: 'USD', startDate: '1980-12-12', endDate: '2026-10-01' });
  assert.equal(rows.find((r) => r.ticker === 'NOEND').endDate, null);
  assert.throws(() => T.parseSupportedTickersCsv('symbol,foo\nA,B'), /unexpected header/);
});

test('classifyListedUs: dead = endDate older than as-of minus 10 days; boundary day stays active; filters apply', () => {
  const { rows } = T.parseSupportedTickersCsv(CSV);
  assert.equal(T.fileAsOf(rows), '2026-10-01');
  const c = T.classifyListedUs(rows);
  assert.equal(c.asOf, '2026-10-01');
  assert.equal(c.deadBefore, '2026-09-21');
  assert.deepEqual(c.dead.map((r) => r.ticker), ['ATVI', 'DEADX']);
  assert.deepEqual(c.active.map((r) => r.ticker).sort(), ['AAPL', 'EDGEX', 'NOEND']);
  const all = T.classifyListedUs(rows, { commonOnly: false });
  assert.ok(all.dead.some((r) => r.ticker === 'FRC-P-B'), 'preferreds come back without the common filter');
  assert.throws(() => T.classifyListedUs([]), /as-of/);
});

test('delistedFromSecmasterDoc reads both the v1 and the v3 record shapes', () => {
  const v1 = T.delistedFromSecmasterDoc({ records: { ATVI: { delisted: true, delistDate: '2023-10-13' }, AAPL: { delisted: false }, X: { delisted: true } } });
  assert.deepEqual([...v1.entries()], [['ATVI', '2023-10-13'], ['X', null]]);
  const v3 = T.delistedFromSecmasterDoc({ records: { atvi: { delisting: { date: '2023-10-13' } }, AAPL: { delisting: null } } });
  assert.deepEqual([...v3.entries()], [['ATVI', '2023-10-13']]);
  assert.equal(T.delistedFromSecmasterDoc(null).size, 0);
});

test('diffDeadVsSecmaster: missing / in-both / date disagreements / master-only, dot-class normalized', () => {
  const dead = [
    { ticker: 'ATVI', endDate: '2023-10-13' },
    { ticker: 'DEADX', endDate: '2026-09-15' },
    { ticker: 'LATE', endDate: '2024-01-02' },
    { ticker: 'BF-B', endDate: '2022-01-01' },
  ];
  const master = new Map([['ATVI', '2023-10-13'], ['LATE', '2023-06-01'], ['BF.B'.replace('.', '-'), '2022-01-10'], ['GONE', '2021-01-01']]);
  const d = T.diffDeadVsSecmaster(dead, master, { activeRows: [{ ticker: 'GONE' }, { ticker: 'AAPL' }] });
  assert.deepEqual(d.missing.map((r) => r.ticker), ['DEADX']);
  assert.deepEqual(d.inBoth, ['ATVI', 'BF-B', 'LATE']);
  assert.deepEqual(d.dateDisagreements, [{ ticker: 'LATE', tiingoEnd: '2024-01-02', secmasterDelist: '2023-06-01' }]);
  assert.deepEqual(d.masterOnly, ['GONE']);
  assert.deepEqual(d.masterOnlyActiveInTiingo, ['GONE'], 'a master delisting Tiingo still trades is a suspected false delisting');
  assert.deepEqual(dead.map((r) => r.ticker), ['ATVI', 'DEADX', 'LATE', 'BF-B'], 'input not mutated');
});
