'use strict';
// FMP company-screener enrichment: the response is hard-capped, so a single call
// silently truncated and left ~20% of the eligible universe with no sector at all.
// Enrichment now queries PER EXCHANGE, keeps partial coverage when one exchange
// fails, and reports truncation instead of trusting a capped page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TU = require('../lib/tradable-universe');

const KEY = 'FMP_API_KEY';
const row = (symbol, extra = {}) => ({ symbol, companyName: `${symbol} Inc`, sector: 'Technology', industry: 'Semiconductors', isActivelyTrading: true, ...extra });

// Swap global fetch for a scripted responder keyed on the `exchange` query param.
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const ex = new URL(String(url)).searchParams.get('exchange');
    return handler(ex, String(url));
  };
  t.after(() => { globalThis.fetch = original; });
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

function withKey(t) {
  const prior = process.env[KEY];
  process.env[KEY] = 'test-key-not-a-real-secret';
  t.after(() => { if (prior === undefined) delete process.env[KEY]; else process.env[KEY] = prior; });
}

test('enrichment queries every supported exchange, not one global page', async (t) => {
  withKey(t);
  const seen = [];
  stubFetch(t, (ex) => { seen.push(ex); return ok([row(`${ex}1`)]); });
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.available, true);
  assert.deepEqual(seen.sort(), [...TU.SUPPORTED_EXCHANGES].sort());
  assert.equal(m.rows.length, 3, 'rows from all three exchanges must be merged');
  assert.equal(m.perExchange.length, 3);
});

test('a symbol listed on two exchanges is merged once, not duplicated', async (t) => {
  withKey(t);
  stubFetch(t, () => ok([row('DUPE'), row('DUPE')]));
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.rows.filter(r => r.symbol === 'DUPE').length, 1);
});

test('ONE exchange failing keeps the others — partial coverage beats nothing', async (t) => {
  withKey(t);
  stubFetch(t, (ex) => (ex === 'NYSE' ? fail(429) : ok([row(`${ex}1`), row(`${ex}2`)])));
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.available, true, 'one bad exchange must not discard the good ones');
  assert.equal(m.rows.length, 4);
  assert.match(m.error, /partial/);
  assert.match(m.error, /NYSE/);
  assert.equal(m.perExchange.find(p => p.exchange === 'NYSE').ok, false);
});

test('EVERY exchange failing reports unavailable with each reason named', async (t) => {
  withKey(t);
  stubFetch(t, () => fail(500));
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.available, false);
  assert.equal(m.rows.length, 0);
  for (const ex of TU.SUPPORTED_EXCHANGES) assert.match(m.error, new RegExp(ex));
});

test('a page returned AT the cap is flagged truncated rather than trusted', async (t) => {
  withKey(t);
  const capped = Array.from({ length: TU.SCREENER_PAGE_CAP }, (_, i) => row(`T${i}`));
  stubFetch(t, (ex) => (ex === 'NASDAQ' ? ok(capped) : ok([row(`${ex}1`)])));
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.truncated, true, 'a capped response is withholding rows and must say so');
  assert.equal(m.perExchange.find(p => p.exchange === 'NASDAQ').truncated, true);
  assert.equal(m.perExchange.find(p => p.exchange === 'AMEX').truncated, false);
});

test('a thrown request is caught per exchange, never fatal', async (t) => {
  withKey(t);
  stubFetch(t, (ex) => { if (ex === 'AMEX') throw new Error('socket hang up'); return ok([row(`${ex}1`)]); });
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.available, true);
  assert.match(m.perExchange.find(p => p.exchange === 'AMEX').error, /socket hang up/);
});

test('no key configured is reported, not thrown', async (t) => {
  const prior = process.env[KEY];
  delete process.env[KEY];
  t.after(() => { if (prior !== undefined) process.env[KEY] = prior; });
  const m = await TU.fetchScreenerMetadata();
  assert.equal(m.available, false);
  assert.match(m.error, /not configured/);
  assert.deepEqual(m.perExchange, []);
});

test('the coverage report counts unmatched securities so a gap cannot hide', async (t) => {
  const eligible = [
    { symbol: 'AAAA', isActivelyTrading: true }, { symbol: 'BBBB', isActivelyTrading: true },
    { symbol: 'CCCC', isActivelyTrading: true },
  ];
  const applied = TU.applyMetadata(eligible, [row('AAAA')]);
  const report = TU.buildCoverageReport({
    totalReceived: 3, eligible: applied.rows, excludedByReason: {}, typeCounts: { COMMON: 3 },
    metadata: { available: true, enriched: applied.enriched, delisted: 0, error: null, perExchange: [], truncated: false },
    providerFailures: [],
  });
  assert.equal(report.metadataEnriched, 1);
  assert.equal(report.metadataUnmatched, 2, 'securities the provider never matched must be counted');
  assert.equal(report.metadataTruncated, false);
});

test('enrichment still never decides eligibility (only an explicit inactive flag does)', async (t) => {
  const eligible = [{ symbol: 'AAAA', isActivelyTrading: true }, { symbol: 'BBBB', isActivelyTrading: true }];
  // BBBB is unmatched by the provider — it must keep its eligibility, just less detail.
  const applied = TU.applyMetadata(eligible, [row('AAAA', { isActivelyTrading: false })]);
  assert.equal(applied.rows.length, 2, 'enrichment must never remove a security');
  assert.equal(applied.rows.find(r => r.symbol === 'AAAA').isActivelyTrading, false);
  assert.equal(applied.rows.find(r => r.symbol === 'BBBB').isActivelyTrading, true);
  assert.equal(applied.delisted, 1);
});
