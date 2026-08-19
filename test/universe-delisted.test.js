'use strict';
// UNIVERSE ROT — measured 2026-08-19 against the provider, all 876 names in
// lib/universe.js. 13 return a hard 404 ("No data found, symbol may be delisted"),
// every one of them a biotech that was acquired, wound up, or renamed.
//
// They are not free. Every op that scans the universe pays two host attempts per dead
// name, every night, and gets back `no daily data` — the same message a transient miss
// produces. That is what let the rot sit here unnoticed.
//
// A 404 is the provider saying the symbol no longer exists, which was verified as a real
// signal and not a provider quirk: BK 404s and its successor BNY returns 200 (BNY Mellon's
// rebrand). So 404 means "retired", though the right human follow-up is sometimes a RENAME
// rather than a deletion — hence the successor column below where one exists.
//
// DELIBERATELY NOT PRUNED — these fail the `candles.length < 60` guard in
// fetchDailyHistory but their newest bar is CURRENT (2026-08-18), so they are live names
// with short provider history, not dead ones: EA, GREE, GRTX, OLPX. Removing them would
// drop tradable tickers. They are handled by the honest-category change instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/universe');

const DELISTED = [
  'AKRO', 'APLS', 'APLT', 'CDTX', 'DVAX', 'GTHX', 'ITCI',
  'MRUS', 'OMGA', 'ONCT', 'SLNO', 'SWTX', 'VERV',
];

// THEMES is a FLAT ticker array here, not a map of baskets — treat it as one more list.
const LISTS = ['SP500', 'LARGE', 'SMALL_CAPS', 'MICRO_CAPS', 'BIOTECH', 'THEMES'];

test('no delisted ticker survives in any scannable universe list', () => {
  for (const name of LISTS) {
    for (const dead of DELISTED) {
      assert.ok(!U[name].includes(dead), `${dead} is delisted but still in ${name}`);
    }
  }
});

test('SECTOR_GROUPS deliberately KEEPS delisted names — it is a metadata lookup', () => {
  // SECTOR_OF is built from SECTOR_GROUPS and is never scanned; it only labels a
  // ticker. Historical ledger rows for an acquired name still need their sector to
  // resolve, so pruning here would break old records for no scanning benefit.
  assert.equal(U.SECTOR_OF['VERV'], 'Health Care');
});

test('the live short-history names are RETAINED — they are current, not dead', () => {
  // Guards against a future "prune everything fetchDailyHistory returns null for",
  // which would delete tradable tickers whose provider history is merely short.
  const all = new Set([].concat(...LISTS.map(n => U[n])));
  for (const live of ['EA', 'GREE', 'GRTX', 'OLPX']) {
    assert.ok(all.has(live), `${live} is live (bars through 2026-08-18) and must not be pruned`);
  }
});

test('the prune did not gut the universe — lists stay within sane bounds', () => {
  assert.ok(U.BIOTECH.length >= 150, `BIOTECH fell to ${U.BIOTECH.length} — over-pruned`);
  assert.ok(U.SP500.length >= 480, `SP500 fell to ${U.SP500.length} — over-pruned`);
});

test('universe lists contain no duplicates and no blank entries', () => {
  for (const name of LISTS) {
    const list = U[name];
    assert.equal(new Set(list).size, list.length, `${name} has duplicates`);
    assert.ok(list.every(t => typeof t === 'string' && /^[A-Z.-]{1,6}$/.test(t)), `${name} has a malformed ticker`);
  }
});
