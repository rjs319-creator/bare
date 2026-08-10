'use strict';
// Analyst-estimate vintage archive: compaction, priority universe, same-day merge.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compactEstimateRow, buildEstUniverse, mergeEstDay, EST_MAX_SYMBOLS } = require('../lib/est-archive');

test('compactEstimateRow keeps mean/high/low, counts and period', () => {
  const row = compactEstimateRow({
    symbol: 'AAPL', date: '2027-09-30',
    epsAvg: 8.1, epsHigh: 8.9, epsLow: 7.4,
    revenueAvg: 450e9, revenueHigh: 470e9, revenueLow: 430e9,
    numAnalystsEps: 24, numAnalystsRevenue: 22,
  });
  assert.deepEqual(row, { per: '2027-09-30', eps: 8.1, epsHi: 8.9, epsLo: 7.4, rev: 450e9, revHi: 470e9, revLo: 430e9, nA: 24, nR: 22 });
});

test('compactEstimateRow tolerates field variants and drops empty rows', () => {
  assert.equal(compactEstimateRow(null), null);
  assert.equal(compactEstimateRow({ symbol: 'X' }), null);                       // no period
  assert.equal(compactEstimateRow({ date: '2027-01-01' }), null);               // no figures
  assert.equal(compactEstimateRow({ date: 'not-a-date', epsAvg: 1 }), null);
  const variant = compactEstimateRow({ date: '2027-06-30', estimatedEpsAvg: 2.5 });
  assert.equal(variant.eps, 2.5);
  assert.equal(variant.rev, null);
});

test('buildEstUniverse puts earnings-soon names first, dedups, caps', () => {
  const calendarRows = [
    { s: 'NVDA', d: '2026-08-20' },
    { s: 'AAPL', d: '2026-08-12' },
    { s: 'MSFT', d: '2026-10-30' },              // outside the 21-day window
    { s: 'AAPL', d: '2026-08-12' },              // duplicate
    { s: 'OLD', d: '2026-08-01' },               // already reported
  ];
  const u = buildEstUniverse({ calendarRows, today: '2026-08-09', fill: ['SPY-X', 'AAPL', 'GOOG'], max: 4 });
  assert.deepEqual(u, ['AAPL', 'NVDA', 'SPY-X', 'GOOG']);   // soonest first, fill after, no dupes
});

test('buildEstUniverse degrades to the fill list and honors the default cap', () => {
  const fill = Array.from({ length: 500 }, (_, i) => `T${i}`);
  const u = buildEstUniverse({ calendarRows: [], today: '2026-08-09', fill });
  assert.equal(u.length, EST_MAX_SYMBOLS);
  assert.equal(u[0], 'T0');
});

test('mergeEstDay unions symbols with the fresher pull winning per symbol', () => {
  const prior = { symbols: { AAPL: { a: [{ per: '2026-09-30', eps: 1 }] }, NVDA: { a: [{ per: '2027-01-31', eps: 2 }] } } };
  const fresh = { AAPL: { a: [{ per: '2026-09-30', eps: 1.2 }] }, TSLA: { q: [{ per: '2026-09-30', eps: 0.5 }] } };
  const merged = mergeEstDay(prior, fresh);
  assert.deepEqual(Object.keys(merged).sort(), ['AAPL', 'NVDA', 'TSLA']);
  assert.equal(merged.AAPL.a[0].eps, 1.2);       // fresher wins
  assert.equal(merged.NVDA.a[0].eps, 2);         // earlier capture survives
  // Immutability: inputs untouched.
  assert.equal(prior.symbols.AAPL.a[0].eps, 1);
});

test('mergeEstDay with no prior doc is the fresh capture', () => {
  const fresh = { AAPL: { a: [] } };
  assert.deepEqual(mergeEstDay(null, fresh), fresh);
  assert.deepEqual(mergeEstDay({ notSymbols: true }, fresh), fresh);
});
