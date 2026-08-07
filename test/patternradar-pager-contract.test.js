'use strict';
// 📐 PATTERN RADAR PAGER CONTRACT.
//
// The first populated radar (2026-08-07) returned ~2,800 episodes; renderPatternRadar built
// every card into one innerHTML pass, which froze the tab on phones. The pager contract:
// each bucket renders at most PR_PAGE_SIZE cards up front, hidden cards are revealed in
// PR_PAGE_SIZE chunks by a "show more" button, and appended cards get the same click wiring
// (ticker lookup, chart loader) as the first page.
//
// SOURCE-SCAN assertions on purpose (the established pattern for frontend checks): the render
// path is string-built client-side, so no data-layer test can reach it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const numFrom = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `could not find constant ${name}`);
  return Number(m[1]);
};

test('PR_PAGE_SIZE bounds the first render to a phone-safe page', () => {
  // Arrange
  const pageSize = numFrom(APP_SRC, 'PR_PAGE_SIZE');

  // Assert: small enough that a 1,000+ item bucket cannot freeze the tab, large enough
  // that a normal day fits without paging.
  assert.ok(pageSize >= 10 && pageSize <= 60,
    `PR_PAGE_SIZE ${pageSize} is outside the sane 10-60 card range`);
});

test('renderPatternRadar renders only the first PR_PAGE_SIZE cards per bucket', () => {
  // Arrange: isolate the bucket-body builder inside renderPatternRadar.
  const idx = APP_SRC.indexOf('function renderPatternRadar');
  assert.ok(idx > -1, 'renderPatternRadar not found');
  const fn = APP_SRC.slice(idx, idx + 3000);

  // Assert: cards must come from a slice, not the full bucket.
  assert.match(fn, /items\.slice\(0,\s*PR_PAGE_SIZE\)\.map\(prCard\)/,
    'renderPatternRadar maps prCard over the whole bucket — the 2,800-card freeze is back');
});

test('buckets larger than one page get a show-more button with a cursor', () => {
  const idx = APP_SRC.indexOf('function renderPatternRadar');
  const fn = APP_SRC.slice(idx, idx + 3000);

  // Assert: the button carries the bucket key and the next-chunk cursor.
  assert.match(fn, /data-pr-more="\$\{k\}"/, 'show-more button missing data-pr-more bucket key');
  assert.match(fn, /data-pr-next=/, 'show-more button missing data-pr-next cursor');
});

test('show-more buttons are wired to prShowMore', () => {
  assert.match(APP_SRC, /\[data-pr-more\]'\)\.forEach\(.{0,120}prShowMore/,
    'no click wiring from [data-pr-more] to prShowMore');
});

test('prShowMore wires appended cards before inserting them', () => {
  // Arrange
  const idx = APP_SRC.indexOf('function prShowMore');
  assert.ok(idx > -1, 'prShowMore not found');
  const fn = APP_SRC.slice(idx, idx + 1500);

  // Assert: new cards get the shared wiring (ticker links + chart buttons) — a chunk
  // appended without prWireCards renders dead links.
  assert.match(fn, /prWireCards\(/, 'prShowMore does not wire the appended cards');
  // And the button retires itself once the bucket is fully revealed.
  assert.match(fn, /btn\.remove\(\)/, 'prShowMore never removes an exhausted show-more button');
});

test('initial render and show-more chunks share one card-wiring helper', () => {
  // Arrange
  const idx = APP_SRC.indexOf('function prWireCards');
  assert.ok(idx > -1, 'prWireCards not found');
  const fn = APP_SRC.slice(idx, idx + 800);

  // Assert: the helper owns both behaviors the cards need.
  assert.match(fn, /data-pr-tk/, 'prWireCards does not wire ticker-lookup links');
  assert.match(fn, /data-pr-chart/, 'prWireCards does not wire chart-load buttons');
});
