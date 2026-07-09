// Tests for the free universe ingestion + mechanical filter (lib/universe-expand.js).
const test = require('node:test');
const assert = require('node:assert');
const { parseListed, classify, mechanicalFilter, isBiotechName } = require('../lib/universe-expand');

const NASDAQ = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N',
  'QQQ|Invesco QQQ Trust|Q|N|N|100|Y|N',                          // ETF flag
  'BADW|SomeCo - Warrants|Q|N|N|100|N|N',                          // warrant name
  'SICK|Distressed Inc. Common Stock|Q|N|D|100|N|N',               // delinquent
  'TSTU|Test Issue Co|Q|Y|N|100|N|N',                              // test issue
  'File Creation Time: 0707202621:32|||||||',                      // footer
].join('\n');

const OTHER = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'BRK.A|Berkshire Hathaway Class A|N|BRK.A|N|1|N|',              // dotted symbol → skip
  'JPM|JPMorgan Chase & Co. Common Stock|N|JPM|N|100|N|',          // keep, NYSE
  'ACME|Acme Acquisition Corp|N|ACME|N|100|N|',                    // SPAC
  'RATE|BigBank 5.50% Notes due 2030|N|RATE|N|100|N|',             // rate security
].join('\n');

test('parseListed: nasdaq + other formats map to a common shape', () => {
  const n = parseListed(NASDAQ, 'nasdaq');
  assert.equal(n.find(r => r.symbol === 'AAPL').exchange, 'NASDAQ');
  const o = parseListed(OTHER, 'other');
  assert.equal(o.find(r => r.symbol === 'JPM').exchange, 'NYSE');
  assert.ok(!n.some(r => r.symbol.startsWith('File Creation')));   // footer skipped
});

test('classify: keeps common stock, drops the junk with the right reason', () => {
  assert.equal(classify({ symbol: 'AAPL', name: 'Apple Inc. Common Stock', testIssue: 'N', finStatus: 'N', etf: 'N' }), null);
  assert.equal(classify({ symbol: 'QQQ', name: 'Invesco QQQ Trust', etf: 'Y' }), 'etf');
  assert.equal(classify({ symbol: 'BADW', name: 'SomeCo - Warrants', etf: 'N' }), 'non-common');
  assert.equal(classify({ symbol: 'SICK', name: 'Distressed Inc.', finStatus: 'D' }), 'delinquent');
  assert.equal(classify({ symbol: 'TSTU', name: 'x', testIssue: 'Y' }), 'test-issue');
  assert.equal(classify({ symbol: 'BRK.A', name: 'x' }), 'symbol');
  assert.equal(classify({ symbol: 'ACME', name: 'Acme Acquisition Corp' }), 'non-common');
  assert.equal(classify({ symbol: 'RATE', name: 'BigBank 5.50% Notes due 2030' }), 'rate-security');
});

test('mechanicalFilter: end-to-end keeps only tradeable common stock', () => {
  const rows = [...parseListed(NASDAQ, 'nasdaq'), ...parseListed(OTHER, 'other')];
  const { kept, dropped, total } = mechanicalFilter(rows);
  const keptSyms = kept.map(k => k.symbol);
  assert.deepEqual(keptSyms.sort(), ['AAPL', 'JPM']);
  assert.equal(total, 9);
  assert.ok(dropped.etf >= 1 && dropped['non-common'] >= 1 && dropped.delinquent >= 1);
});

test('mechanicalFilter: dedupes repeated symbols', () => {
  const { total, kept } = mechanicalFilter([
    { symbol: 'AAA', name: 'Alpha Inc Common Stock', testIssue: 'N', finStatus: 'N', etf: 'N' },
    { symbol: 'AAA', name: 'Alpha Inc Common Stock', testIssue: 'N', finStatus: 'N', etf: 'N' },
  ]);
  assert.equal(total, 1);
  assert.equal(kept.length, 1);
});

test('isBiotechName: classifies drug-development names (stem matches with suffixes)', () => {
  // Real names of top biotech movers — stems must match despite plural/suffix.
  for (const n of [
    'Crinetics Pharmaceuticals, Inc. - Common Stock',
    'Edgewise Therapeutics, Inc. - Common Stock',
    'BridgeBio Pharma, Inc. - Common Stock',
    'Syndax Pharmaceuticals, Inc. - Common Stock',
    'MBX Biosciences, Inc. - Common Stock',
    'REGENXBIO Inc. - Common Stock',            // "bio" embedded in a single token
    'Agios Pharmaceuticals, Inc. - Common Stock',
  ]) assert.equal(isBiotechName(n), true, n);
});

test('isBiotechName: rejects non-biotech names', () => {
  for (const n of [
    'Apple Inc. - Common Stock',
    'JPMorgan Chase & Co. - Common Stock',
    'Bandwidth Inc. - Class A Common Stock',
    'Akamai Technologies, Inc. - Common Stock',
  ]) assert.equal(isBiotechName(n), false, n);
});

test('isBiotechName: safe on empty/nullish', () => {
  assert.equal(isBiotechName(''), false);
  assert.equal(isBiotechName(null), false);
  assert.equal(isBiotechName(undefined), false);
});
