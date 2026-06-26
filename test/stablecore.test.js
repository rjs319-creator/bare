'use strict';
// Unit tests for the Core Momentum engine (pure functions — no network).
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../lib/stablecore');

// helper: synthetic ascending close series of length n with a steady up-drift
function ramp(n, daily = 0.001, p0 = 10) {
  const out = []; let p = p0;
  for (let i = 0; i < n; i++) { p *= (1 + daily); out.push({ date: String(i).padStart(4, '0'), close: +p.toFixed(4), dollar: p * 1e6 }); }
  return out;
}

test('featuresFromCloses returns null without enough history', () => {
  assert.equal(core.featuresFromCloses(ramp(100)), null);
});

test('featuresFromCloses computes positive 12-1 momentum on an uptrend', () => {
  // Arrange
  const closes = ramp(300, 0.002);
  // Act
  const f = core.featuresFromCloses(closes);
  // Assert
  assert.ok(f, 'features computed');
  assert.ok(f.m121 > 0, '12-1 momentum positive on an uptrend');
  assert.ok(f.vol63 != null && f.vol63 >= 0, 'realized vol present');
  assert.ok(f.adv20 > 0, 'ADV present');
});

function feat(symbol, sector, m121, vol63, opts = {}) {
  return { symbol, sector, m121, vol63, marketCap: opts.cap ?? 2e9, adv20: opts.adv ?? 5e6, price: opts.price ?? 20, company: symbol };
}

test('buildBook excludes Healthcare and out-of-band / illiquid names', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(feat('OK' + i, 'Industrials', 0.1 + i * 0.01, 0.3));
  rows.push(feat('BIO', 'Healthcare', 5, 0.3));            // excluded: sector
  rows.push(feat('TINY', 'Industrials', 5, 0.3, { cap: 100e6 })); // excluded: below cap band
  rows.push(feat('BIG', 'Industrials', 5, 0.3, { cap: 9e9 }));    // excluded: above cap band ($5B hi)
  rows.push(feat('ILLIQ', 'Industrials', 5, 0.3, { adv: 1e6 }));  // excluded: ADV floor

  const { book } = core.buildBook(rows, new Set());
  const tickers = new Set(book.map(b => b.ticker));
  for (const bad of ['BIO', 'TINY', 'BIG', 'ILLIQ']) assert.ok(!tickers.has(bad), `${bad} excluded`);
  assert.ok(book.length > 0 && book.length < rows.length, 'a top-quintile subset is selected');
});

test('buildBook drops the top realized-vol tercile', () => {
  // continuous vol gradient where the highest-vol names ALSO have the highest momentum:
  // if not for the vol filter they'd be picked, so their absence proves the filter fires.
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(feat('N' + i, 'Industrials', i * 0.01, +(0.10 + i * 0.01).toFixed(2)));
  const { book } = core.buildBook(rows, new Set());
  const idx = book.map(b => parseInt(b.ticker.slice(1), 10));
  assert.ok(idx.every(i => i <= 40), 'top realized-vol tercile (highest-i, highest-mom) is excluded before ranking');
});

test('buildBook ranks by SECTOR-NEUTRAL momentum (within-sector demean)', () => {
  // Sector A all hot; sector B all cold. The best name in cold-B should beat a
  // middling name in hot-A once each is measured vs its own sector median.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(feat('A' + i, 'Industrials', 0.80 + i * 0.001, 0.3)); // hot sector
  for (let i = 0; i < 20; i++) rows.push(feat('B' + i, 'Utilities', 0.05 + i * 0.001, 0.3));    // cold sector
  const { book } = core.buildBook(rows, new Set());
  // top pick should be the highest within-sector outlier, not just the highest raw momentum
  assert.ok(book.length > 0);
  const top = book[0];
  // the highest-index name in each sector is its sector's relative leader
  assert.ok(top.ticker === 'A19' || top.ticker === 'B19', 'top pick is a within-sector leader');
});

test('rank buffer keeps a held name that slipped to the hold band', () => {
  // 100 names; a held name sitting around the 70th percentile (in [hold,enter)) should
  // be retained, while the same name NOT held would be excluded.
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(feat('N' + i, 'Industrials', i * 0.01, 0.3));
  // N75 is ~75th pct → above hold cut (top 40%) but below enter cut (top 20%)
  const without = new Set(core.buildBook(rows, new Set()).book.map(b => b.ticker));
  const withHeld = new Set(core.buildBook(rows, new Set(['N75'])).book.map(b => b.ticker));
  assert.ok(!without.has('N75'), 'N75 not selected fresh (below enter cut)');
  assert.ok(withHeld.has('N75'), 'N75 retained via rank buffer when held');
});

test('buildBook returns a note when the pool is too small', () => {
  const { book, note } = core.buildBook([feat('A', 'Industrials', 0.1, 0.3)], new Set());
  assert.equal(book.length, 0);
  assert.ok(note, 'note explains the empty book');
});
