'use strict';
// BULK-QUOTE FALLBACK CONTRACT.
//
// PRODUCTION FAILURE (2026-08-05) this file guards against: every one of the 125 in-session
// discovery scans reported `insufficient-coverage` — provider `yahoo-spark`, 1% of 767
// requested symbols. The volume-capable provider (yahoo-quote) partially failed under the
// rate limits it meets from a datacenter IP, and the old fallback chain treated "partial" as
// "nothing": it DISCARDED every volume-carrying row it had already fetched and re-requested
// the whole universe from the keyless price-only endpoint, which is capped at 20 symbols and
// answered ~8 rows. Three of the seven discovery lanes went dark and the Day Trade board's
// Actionable Now section was fed nothing by discovery for a full session.
//
// The contract: partial success is KEPT and only the GAP is refilled; missing symbols get one
// repair pass; the transport retries retryable statuses; and the coverage report carries
// enough diagnostics to tell an auth failure from a rate limit without a redeploy.

const { test } = require('node:test');
const assert = require('node:assert');
const qp = require('../lib/quote-provider');

// ── fakes ───────────────────────────────────────────────────────────────────────
const symbolsOf = url => decodeURIComponent(String(url).split('symbols=')[1].split('&')[0]).split(',');
const quoteBody = syms => ({
  quoteResponse: {
    result: syms.map((s, i) => ({
      symbol: s, regularMarketPrice: 10 + i, regularMarketPreviousClose: 9 + i,
      regularMarketVolume: 1_000_000 + i, regularMarketTime: 1770000000,
    })),
  },
});
const sparkBody = syms => ({
  spark: {
    result: syms.map((s, i) => ({
      symbol: s, response: [{ meta: { regularMarketPrice: 20 + i, chartPreviousClose: 19 + i, regularMarketTime: 1770000000 } }],
    })),
  },
});
const okResponse = body => ({ ok: true, status: 200, json: async () => body });
const errResponse = status => ({ ok: false, status, json: async () => ({}) });
const fakeAuth = async () => ({ cookie: 'c=1', crumb: 'abc' });
const tickersFor = n => Array.from({ length: n }, (_, i) => `T${i}`);

// ── pure helpers ────────────────────────────────────────────────────────────────
test('missingFrom names exactly the symbols no provider returned', () => {
  // Arrange
  const wanted = ['AAPL', 'MSFT', 'NVDA'];
  const rows = [{ ticker: 'aapl' }, { ticker: 'NVDA' }];

  // Act
  const missing = qp.missingFrom(wanted, rows);

  // Assert
  assert.deepStrictEqual(missing, ['MSFT']);
});

test('mergeRows keeps the volume-carrying row when both providers answer for a ticker', () => {
  // The gap-fill provider must never overwrite a richer row — that would silently delete the
  // share count the relative-volume / volume-acceleration / turnover lanes depend on.
  const primary = [{ ticker: 'AAPL', price: 10, dayVolume: 5_000_000 }];
  const fill = [{ ticker: 'AAPL', price: 10.1, dayVolume: null }, { ticker: 'MSFT', price: 20, dayVolume: null }];

  const merged = qp.mergeRows(primary, fill);

  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find(r => r.ticker === 'AAPL').dayVolume, 5_000_000);
  assert.deepStrictEqual(primary, [{ ticker: 'AAPL', price: 10, dayVolume: 5_000_000 }], 'inputs must not be mutated');
});

test('volumeAvailable reports the majority of the snapshot, not a single lucky row', () => {
  // REGRESSION GUARD: `rows.some(r => r.dayVolume != null)` would call a snapshot of 1 volume
  // row + 700 price-only rows "volume available", and the scan-health degraded check keys off
  // exactly that flag — so a materially blind scan would have read healthy.
  const mostlyBlind = [{ dayVolume: 5e6 }, ...Array.from({ length: 9 }, () => ({ dayVolume: null }))];
  const mostlyFull = [...Array.from({ length: 9 }, () => ({ dayVolume: 5e6 })), { dayVolume: null }];

  assert.strictEqual(qp.volumeStats(mostlyBlind).volumeAvailable, false);
  assert.strictEqual(qp.volumeStats(mostlyBlind).volumeCoveragePct, 10);
  assert.strictEqual(qp.volumeStats(mostlyFull).volumeAvailable, true);
});

// ── provider chain ──────────────────────────────────────────────────────────────
test('a partial yahoo-quote answer is kept and only the gap is refilled from spark', async () => {
  // THE production bug: 40% of the universe came back with volume and was thrown away.
  const wanted = tickersFor(300);
  const quoteImpl = async syms => ({
    // The provider answers the first chunk and rate-limits the rest.
    rows: syms.slice(0, 100).map((s, i) => ({ ticker: s, price: 10 + i, dayVolume: 1e6, asOf: null })),
    diag: { auth: 'ok', statuses: { 200: 1, 429: 2 } },
  });
  const sparkImpl = async syms => ({ rows: syms.map(s => ({ ticker: s, price: 5, dayVolume: null, asOf: null })), diag: { statuses: { 200: 10 } } });

  const { rows, coverage } = await qp.fetchBulkQuotes(wanted, { quoteImpl, sparkImpl, fmpKey: null });

  assert.strictEqual(coverage.returned, 300, 'every symbol should be covered by the merge');
  assert.strictEqual(rows.filter(r => r.dayVolume != null).length, 100, 'the volume rows must survive the fallback');
  assert.strictEqual(coverage.provider, 'yahoo-quote+spark');
  assert.strictEqual(coverage.volumeAvailable, false, 'a one-third-volume snapshot is honestly degraded');
  assert.strictEqual(coverage.volumeCoveragePct, 33.3);
});

test('a healthy yahoo-quote answer never touches the price-only fallback', async () => {
  const wanted = tickersFor(200);
  let sparkCalls = 0;
  const quoteImpl = async syms => ({ rows: syms.map(s => ({ ticker: s, price: 10, dayVolume: 1e6 })), diag: { auth: 'ok', statuses: { 200: 2 } } });
  const sparkImpl = async syms => { sparkCalls++; return { rows: [], diag: {} }; };

  const { coverage } = await qp.fetchBulkQuotes(wanted, { quoteImpl, sparkImpl, fmpKey: null });

  assert.strictEqual(sparkCalls, 0);
  assert.strictEqual(coverage.provider, 'yahoo-quote');
  assert.strictEqual(coverage.volumeAvailable, true);
  assert.strictEqual(coverage.degraded, false);
});

test('symbols dropped by a failed chunk are recovered by the repair pass', async () => {
  // A rate-limited chunk used to vanish silently: mapChunks swallowed it and coverage only
  // counted what came back. Now the symbols no chunk answered are re-requested once.
  const wanted = tickersFor(250);
  let pass = 0;
  const fetchImpl = async url => {
    const syms = symbolsOf(url);
    pass++;
    // Fail the second chunk of the first pass; answer everything on the repair pass.
    return (pass === 2) ? errResponse(429) : okResponse(quoteBody(syms));
  };

  const { rows, diag } = await qp.yahooQuotes(wanted, { fetchImpl, authImpl: fakeAuth });

  assert.strictEqual(rows.length, 250, 'the repair pass must recover the dropped chunk');
  assert.ok(diag.repair, 'a repair pass should be reported');
  assert.strictEqual(diag.repair.recovered, diag.repair.requested);
  assert.strictEqual(diag.statuses['429'], 1, 'the rate limit is recorded, not hidden');
});

test('chunk fetches ask the transport for bounded retries on retryable statuses', async () => {
  // The retry/backoff itself lives in lib/http (full jitter, retryable-only). This asserts the
  // wiring: a wide-fan-out caller that opts OUT of retries is exactly how a transient 429 turned
  // into a whole-session outage.
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push(opts); return okResponse(quoteBody(symbolsOf(url))); };

  await qp.yahooQuotes(tickersFor(10), { fetchImpl, authImpl: fakeAuth });

  assert.ok(seen.length > 0);
  assert.ok(seen[0].retries >= 1, 'chunk fetches must retry retryable failures');
  assert.ok(seen[0].timeoutMs > 0, 'a hung socket must never consume the whole budget');
});

test('a failed crumb handshake is reported as an auth failure, not an empty market', async () => {
  const { rows, diag } = await qp.yahooQuotes(tickersFor(50), { fetchImpl: async () => okResponse(quoteBody([])), authImpl: async () => null });

  assert.deepStrictEqual(rows, []);
  assert.strictEqual(diag.auth, 'unavailable');
});

test('a total yahoo-quote outage still degrades to spark and says so', async () => {
  const wanted = tickersFor(60);
  const quoteImpl = async () => ({ rows: [], diag: { auth: 'unavailable' } });
  const sparkImpl = async syms => ({ rows: syms.map(s => ({ ticker: s, price: 5, dayVolume: null })), diag: { statuses: { 200: 3 } } });

  const { coverage } = await qp.fetchBulkQuotes(wanted, { quoteImpl, sparkImpl, fmpKey: null });

  assert.strictEqual(coverage.provider, 'yahoo-spark');
  assert.strictEqual(coverage.volumeAvailable, false);
  assert.strictEqual(coverage.degraded, true);
  assert.ok(/volume/i.test(coverage.note || ''), 'the note must name the lost capability');
  assert.strictEqual(coverage.diagnostics.yahooQuote.auth, 'unavailable', 'diagnostics must survive into coverage');
});

test('a repair pass is skipped when the provider returned nothing at all', async () => {
  // Re-requesting 767 symbols from a provider that just answered zero is a retry storm against
  // a source that is down — the fallback is the correct move, not more load.
  let calls = 0;
  const fetchImpl = async () => { calls++; return errResponse(429); };

  const { rows, diag } = await qp.yahooQuotes(tickersFor(300), { fetchImpl, authImpl: fakeAuth });

  assert.strictEqual(rows.length, 0);
  assert.strictEqual(diag.repair, null);
  assert.strictEqual(calls, 3, 'one attempt per chunk, no repair pass');
});

test('the gap fill is bounded and reports what it left out', async () => {
  // The keyless endpoint takes 20 symbols per request, so an unbounded gap fill would fan a
  // 2,000-name miss into 100 requests against the most rate-limited source in the chain —
  // trading one outage for another. Truncation is capped AND reported, never silent.
  const wanted = tickersFor(1000);
  const quoteImpl = async () => ({ rows: [], diag: { auth: 'ok', statuses: { 429: 10 } } });
  let asked = 0;
  const sparkImpl = async syms => { asked = syms.length; return { rows: syms.map(s => ({ ticker: s, price: 5, dayVolume: null })), diag: {} }; };

  const { coverage } = await qp.fetchBulkQuotes(wanted, { quoteImpl, sparkImpl, fmpKey: null });

  assert.strictEqual(asked, qp.GAP_FILL_MAX_SYMBOLS);
  assert.strictEqual(coverage.diagnostics.spark.truncated, 1000 - qp.GAP_FILL_MAX_SYMBOLS);
  assert.strictEqual(coverage.degraded, true);
});

test('spark stays inside the provider symbol cap and yahoo-quote inside its measured cap', () => {
  assert.ok(qp.SPARK_CHUNK <= 20, `spark chunk ${qp.SPARK_CHUNK} exceeds the provider cap of 20`);
  assert.ok(qp.YAHOO_QUOTE_CHUNK <= 300, 'measured cap is 300 symbols per request');
  assert.ok(qp.FMP_CHUNK <= 200);
});

test('an empty request short-circuits without contacting any provider', async () => {
  const { rows, coverage } = await qp.fetchBulkQuotes([], { quoteImpl: async () => { throw new Error('must not be called'); } });
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(coverage.requested, 0);
  assert.strictEqual(coverage.provider, null);
});
