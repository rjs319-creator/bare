'use strict';
// REGRESSION — resolveLedger's first-appearance dedup (lib/apex-routes.js).
//
// Commit f809d22 (2026-07-27) replaced `if (!firstSeen.has(key)) firstSeen.set(key, s)`
// with `firstSeen.add(key, s)` — Map has no .add, so EVERY caller (op=drift,
// op=rankquality, op=recalibrate's live-source path) crashed with a 500 on any non-empty
// ledger for a week. These tests pin BOTH properties of the fix: (1) it runs at all on a
// non-empty ledger, and (2) it keeps the FIRST appearance per ticker:tier — the tempting
// one-char repair (unconditional .set) would keep the LAST appearance under the ascending
// date sort and silently invert the dedup the drift/rank-quality statistics document.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { firstAppearanceDedup } = require('../lib/apex-routes');

test('a non-empty ledger dedups without throwing (the .add-on-a-Map 500)', () => {
  const out = firstAppearanceDedup([{ ticker: 'AAPL', tier: 'Apex', date: '2026-07-01', score: 80 }]);
  assert.equal(out.length, 1);
});

test('keeps the FIRST appearance per ticker:tier, not the last', () => {
  const raw = [
    { ticker: 'AAPL', tier: 'Apex', date: '2026-07-03', score: 90, note: 'later' },
    { ticker: 'AAPL', tier: 'Apex', date: '2026-07-01', score: 70, note: 'first' },
    { ticker: 'AAPL', tier: 'Apex', date: '2026-07-02', score: 80, note: 'middle' },
  ];
  const out = firstAppearanceDedup(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, '2026-07-01', 'first appearance wins');
  assert.equal(out[0].note, 'first');
});

test('distinct tiers of the same ticker are separate signals; input order is irrelevant', () => {
  const raw = [
    { ticker: 'NVDA', tier: 'Loaded', date: '2026-07-05' },
    { ticker: 'NVDA', tier: 'Apex', date: '2026-07-02' },
    { ticker: 'NVDA', tier: 'Apex', date: '2026-07-04' },
  ];
  const out = firstAppearanceDedup(raw);
  assert.equal(out.length, 2);
  const apex = out.find(s => s.tier === 'Apex');
  assert.equal(apex.date, '2026-07-02');
  // Same rows, shuffled → identical result (the sort, not input order, decides).
  const out2 = firstAppearanceDedup([raw[2], raw[0], raw[1]]);
  assert.deepEqual(
    out2.map(s => `${s.ticker}:${s.tier}:${s.date}`).sort(),
    out.map(s => `${s.ticker}:${s.tier}:${s.date}`).sort()
  );
});

test('input is not mutated (the sort works on a copy)', () => {
  const raw = [
    { ticker: 'B', tier: 'Apex', date: '2026-07-02' },
    { ticker: 'A', tier: 'Apex', date: '2026-07-01' },
  ];
  firstAppearanceDedup(raw);
  assert.equal(raw[0].ticker, 'B', 'caller array order untouched');
});
