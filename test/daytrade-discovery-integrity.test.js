'use strict';
// STAGE-A DISCOVERY INTEGRITY (redesign spec):
//   4. a missing quote timestamp cannot update CUSUM (no server-time fallback)
//   5. stale/future/invalid timestamps are excluded AND counted by reason
//   6. mixed-vintage candle baselines cannot share one cohort
//   7. expanded-universe rotation is deterministic and eventually covers the tail
// Providers are stubbed via require.cache BEFORE intraday-discovery loads, so the scan runs
// hermetically (no network, no store).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = p => path.join(__dirname, '..', 'lib', p);

// ── Stub the provider + candle-cache + universe modules BEFORE discovery loads ──
let QUOTE_ROWS = [];
require(LIB('quote-provider.js'));
require.cache[require.resolve(LIB('quote-provider.js'))].exports = {
  fetchBulkQuotes: async () => ({ rows: QUOTE_ROWS, coverage: { requested: QUOTE_ROWS.length, returned: QUOTE_ROWS.length, provider: 'stub', volumeAvailable: true } }),
};

let CACHE_DOCS = {};
require(LIB('candle-cache.js'));
require.cache[require.resolve(LIB('candle-cache.js'))].exports = {
  loadCandleCache: async scope => CACHE_DOCS[scope] || null,
  cacheGet: (doc, t) => (doc && doc.data ? doc.data[t] : null),
};

delete require.cache[require.resolve(LIB('intraday-discovery.js'))];
const disc = require(LIB('intraday-discovery.js'));

// A weekday RTH instant (Wed 2026-07-08 10:30 ET = 14:30 UTC).
const NOW = new Date('2026-07-08T14:30:00.000Z');
const NOW_ISO = NOW.toISOString();

function candlesFor(barDate, { price = 20, vol = 2e6 } = {}) {
  const c = [];
  for (let i = 0; i < 25; i++) {
    c.push({ date: barDate, close: price, high: price * 1.02, low: price * 0.98, volume: vol });
  }
  c[c.length - 1] = { ...c[c.length - 1], date: barDate };
  return c;
}

const entry = (barDate, opts) => ({ candles: candlesFor(barDate, opts), provenance: { lastBarDate: barDate, sourceScope: 'large', sourceFetchedAt: NOW_ISO } });

test('6. mixed-vintage candle baselines cannot share one cohort (counted by reason)', async () => {
  CACHE_DOCS = {
    large: { data: { FRESH1: entry('2026-07-07'), FRESH2: entry('2026-07-07'), STALE1: entry('2026-06-20') } },
    small: null, micro: null, expanded: null,
  };
  const b = await disc.buildBaselines('2026-07-08', { now: NOW });
  assert.equal(b.schema, 'baseline-v2');
  assert.ok(b.byTicker.FRESH1 && b.byTicker.FRESH2, 'current-vintage entries admitted');
  assert.equal(b.byTicker.STALE1, undefined, 'a two-week-old shard is excluded from the cohort');
  assert.ok(b.exclusions.staleVintage >= 1, 'exclusion is COUNTED by reason');
  assert.ok(b.cohortDate, 'one authoritative cohort date resolved');
  // Per-entry provenance is preserved.
  assert.equal(b.byTicker.FRESH1.barDate, '2026-07-07');
  assert.equal(b.byTicker.FRESH1.sourceScope, 'large');
});

test('4/5. quote-timestamp integrity: missing/unparseable/stale/future asOf cannot reach CUSUM, ranking or the dataset — and each exclusion is counted', async () => {
  CACHE_DOCS = {
    large: {
      data: {
        GOODQ: entry('2026-07-07'), NOASOF: entry('2026-07-07'), BADASOF: entry('2026-07-07'),
        STALEQ: entry('2026-07-07'), FUTQ: entry('2026-07-07'), WRONGDAY: entry('2026-07-07'),
      },
    },
    small: null, micro: null, expanded: null,
  };
  QUOTE_ROWS = [
    { ticker: 'SPY', price: 500, prevClose: 499, dayVolume: 1e7, asOf: NOW_ISO },
    { ticker: 'GOODQ', price: 21, prevClose: 20, dayVolume: 5e6, asOf: new Date(NOW.getTime() - 30e3).toISOString() },
    { ticker: 'NOASOF', price: 21, prevClose: 20, dayVolume: 5e6, asOf: null },                                     // missing ts
    { ticker: 'BADASOF', price: 21, prevClose: 20, dayVolume: 5e6, asOf: 'not-a-time' },                            // unparseable
    { ticker: 'STALEQ', price: 21, prevClose: 20, dayVolume: 5e6, asOf: new Date(NOW.getTime() - 20 * 60e3).toISOString() }, // 20 min old
    { ticker: 'FUTQ', price: 21, prevClose: 20, dayVolume: 5e6, asOf: new Date(NOW.getTime() + 10 * 60e3).toISOString() },   // future
    { ticker: 'WRONGDAY', price: 21, prevClose: 20, dayVolume: 5e6, asOf: '2026-07-07T15:00:00.000Z' },             // prior session
  ];
  const out = await disc.runDiscoveryScan({ now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.eligible, 1, 'only the valid-timestamp observation is eligible');
  assert.equal(out.excludedByReason.missingAsOf, 1);
  assert.equal(out.excludedByReason.unparseableAsOf, 1);
  assert.equal(out.excludedByReason.staleQuote, 1);
  assert.equal(out.excludedByReason.futureQuote, 1);
  assert.equal(out.excludedByReason.sessionDateMismatch, 1);
  // Display-only sample carries the honest reason, never a predictive role.
  const sample = out.unusableSample.find(s => s.ticker === 'NOASOF');
  assert.ok(sample && sample.note === 'quote timestamp unavailable');
});

test('cusumStep: NaN/invalid inputs carry prior state unchanged (no NaN lastTs poisoning)', () => {
  const prev = { lastPrice: 10, lastTs: 1000, ewmaPmVol: 0.001, cusum: 2 };
  const out = disc.cusumStep(prev, 10.5, NaN);
  assert.equal(out.lastTs, 1000, 'prior timestamp carried, never NaN');
  assert.equal(out.cusum, 2, 'CUSUM unchanged');
  assert.equal(out.z, null);
});

test('7. universe selection: liquidity-ranked core + DETERMINISTIC tail rotation that covers the tail', () => {
  // 60 names, capped at 30 with 10 rotation slots → core = top-20 by dollar volume.
  const byTicker = {};
  for (let i = 0; i < 60; i++) byTicker[`T${String(i).padStart(2, '0')}`] = { avgDollarVol: (60 - i) * 1e6 };
  const at = h => new Date(`2026-07-08T${String(h).padStart(2, '0')}:00:00.000Z`);
  const sel1 = disc.selectScanUniverse(byTicker, at(14), { maxUniverse: 30, rotationSlots: 10 });
  assert.equal(sel1.tickers.length, 30);
  assert.equal(sel1.meta.core, 20);
  // The core is the PIT liquidity ranking, not cache-key order.
  for (let i = 0; i < 20; i++) assert.ok(sel1.tickers.includes(`T${String(i).padStart(2, '0')}`), 'top-liquidity name in core');
  // Deterministic: the same instant yields the identical selection.
  const sel1b = disc.selectScanUniverse(byTicker, at(14), { maxUniverse: 30, rotationSlots: 10 });
  assert.deepEqual(sel1.tickers, sel1b.tickers);
  // Inclusion metadata: core prob 1; rotation prob = slots/tail.
  assert.equal(sel1.inclusion.T00.prob, 1);
  const rotated1 = sel1.tickers.slice(20);
  assert.ok(rotated1.every(t => sel1.inclusion[t].reason === 'rotation' && sel1.inclusion[t].prob === 0.25));
  // Coverage: across CONSECUTIVE 5-minute scan slots the rotation reaches the WHOLE tail
  // (tail 40 / 10 slots per scan → complete coverage within 4 consecutive scans).
  const seen = new Set();
  for (let m = 0; m < 30; m += 5) {
    const s = disc.selectScanUniverse(byTicker, new Date(`2026-07-08T14:${String(m).padStart(2, '0')}:00.000Z`), { maxUniverse: 30, rotationSlots: 10 });
    s.tickers.slice(20).forEach(t => seen.add(t));
  }
  const tail = Object.keys(byTicker).filter(t => !sel1.tickers.slice(0, 20).includes(t));
  assert.ok(tail.every(t => seen.has(t)), `rotation covered the whole tail (${seen.size}/${tail.length})`);
});
