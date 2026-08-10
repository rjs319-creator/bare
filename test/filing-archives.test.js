'use strict';
// 8-K + insider feed archives: compaction, dedup identity, paginated sweep.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sweepFeed, compact8kRow, filing8kKey, compactInsiderRow, insiderEventKey, FEED_PAGE_LIMIT, FEED_MAX_PAGES,
  dedupeByKey,
} = require('../lib/filing-archives');
const { CATEGORY } = require('../lib/fmp-client');

const ok = (body) => ({ ok: true, status: 200, category: CATEGORY.OK, body, rows: body.length, error: null });
const fail = (status, category) => ({ ok: false, status, category, body: null, rows: 0, error: `FMP /x HTTP ${status}` });
const noSleep = async () => {};

test('compact8kRow preserves PIT fields and the document URL', () => {
  const e = compact8kRow({
    symbol: 'acme', cik: '0000123', filingDate: '2026-08-07 16:31:00', acceptedDate: '2026-08-07 16:30:12',
    formType: '8-K', hasFinancials: true, link: 'https://sec.gov/idx', finalLink: 'https://sec.gov/doc.htm',
  });
  assert.deepEqual(e, { s: 'ACME', cik: '0000123', fd: '2026-08-07', ad: '2026-08-07 16:30:12', ft: '8-K', fin: true, url: 'https://sec.gov/doc.htm' });
  assert.equal(compact8kRow({ symbol: 'X' }), null);            // no filingDate → not an event
});

test('filing8kKey dedups by document URL, falls back to identity fields', () => {
  const a = { url: 'https://sec.gov/doc.htm', cik: '1', s: 'A', fd: '2026-08-07', ft: '8-K' };
  const b = { ...a, fin: true };                                 // same filing, richer row
  assert.equal(dedupeByKey([a, b], filing8kKey).length, 1);
  const c = { url: null, cik: '1', s: 'A', fd: '2026-08-07', ft: '8-K' };
  const d = { url: null, cik: '1', s: 'A', fd: '2026-08-08', ft: '8-K' };
  assert.equal(dedupeByKey([c, d], filing8kKey).length, 2);
});

test('compactInsiderRow keeps vendor transaction codes verbatim', () => {
  const e = compactInsiderRow({
    symbol: 'acme', filingDate: '2026-08-06 18:02:11', transactionDate: '2026-08-04',
    reportingCik: '0009', companyCik: '0001', transactionType: 'P-Purchase', securitiesOwned: 1000,
    reportingName: 'DOE JANE', typeOfOwner: 'officer: CFO', acquisitionOrDisposition: 'A',
    directOrIndirect: 'D', formType: '4', securitiesTransacted: 500, price: 12.5,
  });
  assert.equal(e.s, 'ACME');
  assert.equal(e.fd, '2026-08-06');
  assert.equal(e.td, '2026-08-04');
  assert.equal(e.tc, 'P-Purchase');                              // code preserved, not normalized
  assert.equal(e.ro, 'officer: CFO');
  assert.equal(e.qty, 500);
  assert.equal(e.px, 12.5);
  assert.equal(compactInsiderRow({ symbol: 'X', transactionDate: '2026-08-04' }), null); // no filingDate
});

test('insiderEventKey separates distinct transactions, merges re-served rows', () => {
  const base = { s: 'A', rc: '9', td: '2026-08-04', tc: 'S-Sale', qty: 100, px: 5, di: 'D' };
  assert.equal(dedupeByKey([base, { ...base, own: 900 }], insiderEventKey).length, 1);
  assert.equal(dedupeByKey([base, { ...base, qty: 200 }], insiderEventKey).length, 2);
});

test('sweepFeed stops on a short page and reports pages fetched', async () => {
  const pages = [Array.from({ length: FEED_PAGE_LIMIT }, (_, i) => ({ filingDate: '2026-08-09', i })), [{ filingDate: '2026-08-09' }]];
  const calls = [];
  const out = await sweepFeed({
    path: '/x', sleep: noSleep,
    request: async (p, params) => { calls.push(params.page); return ok(pages[params.page] || []); },
  });
  assert.equal(out.feedOk, true);
  assert.equal(out.pagesFetched, 2);
  assert.equal(out.rows.length, FEED_PAGE_LIMIT + 1);
  assert.equal(out.pageCapped, false);
  assert.deepEqual(calls, [0, 1]);
});

test('sweepFeed records a page cap when page>0 is rejected, keeps page 0', async () => {
  const out = await sweepFeed({
    path: '/x', sleep: noSleep,
    request: async (p, params) => (params.page === 0
      ? ok(Array.from({ length: FEED_PAGE_LIMIT }, () => ({ filingDate: '2026-08-09' })))
      : fail(402, CATEGORY.PLAN_GATED)),
  });
  assert.equal(out.feedOk, true);
  assert.equal(out.pageCapped, true);
  assert.equal(out.rows.length, FEED_PAGE_LIMIT);
});

test('sweepFeed on gated page 0 reports gated, never fabricates', async () => {
  const out = await sweepFeed({ path: '/x', sleep: noSleep, request: async () => fail(402, CATEGORY.PLAN_GATED) });
  assert.equal(out.gated, true);
  assert.equal(out.feedOk, false);
  assert.equal(out.rows.length, 0);
});

test('sweepFeed on transient page-0 failure is a feed loss (503 upstream)', async () => {
  const out = await sweepFeed({ path: '/x', sleep: noSleep, request: async () => fail(503, CATEGORY.UPSTREAM_ERROR) });
  assert.equal(out.feedOk, false);
  assert.equal(out.gated, false);
});

test('sweepFeed early-exits once a full page is entirely older than the cutoff', async () => {
  const calls = [];
  const oldPage = Array.from({ length: FEED_PAGE_LIMIT }, () => ({ filingDate: '2026-07-01' }));
  const out = await sweepFeed({
    path: '/x', cutoffDate: '2026-08-06', sleep: noSleep,
    request: async (p, params) => { calls.push(params.page); return ok(oldPage); },
  });
  assert.equal(out.pagesFetched, 1);
  assert.deepEqual(calls, [0]);
  assert.equal(out.pageCapped, false);
});

test('sweepFeed flags a cap after a full max-page sweep with a full last page', async () => {
  const full = Array.from({ length: FEED_PAGE_LIMIT }, () => ({ filingDate: '2026-08-09' }));
  const out = await sweepFeed({ path: '/x', sleep: noSleep, request: async () => ok(full) });
  assert.equal(out.pagesFetched, FEED_MAX_PAGES);
  assert.equal(out.pageCapped, true);
});
