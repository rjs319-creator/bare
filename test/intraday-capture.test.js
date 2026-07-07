'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { etDate, extractSessionBars } = require('../lib/intraday-capture');

const secs = iso => Math.floor(Date.parse(iso) / 1000);

test('etDate: UNIX seconds → ET calendar date, DST-correct', () => {
  // 13:30 UTC on 2025-04-08 = 09:30 EDT (UTC-4) → same ET date
  assert.equal(etDate(secs('2025-04-08T13:30:00Z')), '2025-04-08');
  // 00:30 UTC on 2025-04-08 = 20:30 EDT on 2025-04-07 → prior ET date
  assert.equal(etDate(secs('2025-04-08T00:30:00Z')), '2025-04-07');
  // Winter (EST, UTC-5): 14:30 UTC on 2025-01-10 = 09:30 EST → same ET date
  assert.equal(etDate(secs('2025-01-10T14:30:00Z')), '2025-01-10');
});

test('extractSessionBars: keeps only the target ET session, skips null-OHLC bars', () => {
  const result = {
    timestamp: [
      secs('2025-04-07T14:00:00Z'),   // prior session — excluded
      secs('2025-04-08T13:30:00Z'),   // 09:30 ET — bar 1
      secs('2025-04-08T13:35:00Z'),   // 09:35 ET — bar 2
      secs('2025-04-08T13:40:00Z'),   // null-OHLC gap — skipped
      secs('2025-04-09T13:30:00Z'),   // next session — excluded
    ],
    indicators: { quote: [{
      open:   [10.0, 25.111, 25.6, null, 30.0],
      high:   [10.5, 25.634, 25.6, null, 30.5],
      low:    [ 9.8, 25.10,  25.37, null, 29.9],
      close:  [10.2, 25.6,   25.37, null, 30.2],
      volume: [100,  47,     21,    0,    200],
    }] },
  };
  const bars = extractSessionBars(result, '2025-04-08');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].o, 25.111);
  assert.equal(bars[0].h, 25.634);
  assert.equal(bars[1].c, 25.37);
  assert.equal(bars[1].v, 21);
});

test('extractSessionBars: empty/missing input → empty array (no throw)', () => {
  assert.deepEqual(extractSessionBars(null, '2025-04-08'), []);
  assert.deepEqual(extractSessionBars({}, '2025-04-08'), []);
  assert.deepEqual(extractSessionBars({ timestamp: [] }, '2025-04-08'), []);
});
