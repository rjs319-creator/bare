'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { siFlag, SI_HIGH_PCT, SI_ELEVATED_PCT, DTC_HIGH } = require('../lib/shortinterest');

test('siFlag: null record → null', () => {
  assert.equal(siFlag(null, 1e6), null);
});

test('siFlag: nothing knowable (no shares, no dtc) → null', () => {
  assert.equal(siFlag({ si: 500000, dtc: null }, null), null);
});

test('siFlag: high SI%shares → level high', () => {
  const f = siFlag({ si: 25e6, dtc: 3 }, 100e6);   // 25% of shares
  assert.equal(f.pct, 25);
  assert.equal(f.level, 'high');
});

test('siFlag: elevated SI%shares → level elevated', () => {
  const f = siFlag({ si: 12e6, dtc: 2 }, 100e6);   // 12%
  assert.equal(f.pct, 12);
  assert.equal(f.level, 'elevated');
});

test('siFlag: low SI%shares → no level', () => {
  const f = siFlag({ si: 3e6, dtc: 1 }, 100e6);    // 3%
  assert.equal(f.level, null);
});

test('siFlag: high days-to-cover flags high even when shares unknown', () => {
  const f = siFlag({ si: 1e6, dtc: 9 }, null);
  assert.equal(f.pct, null);
  assert.equal(f.dtc, 9);
  assert.equal(f.level, 'high');
});

test('siFlag: thresholds are the exported constants', () => {
  assert.equal(siFlag({ si: SI_HIGH_PCT * 100e6, dtc: 0 }, 100e6).level, 'high');
  assert.equal(siFlag({ si: SI_ELEVATED_PCT * 100e6, dtc: 0 }, 100e6).level, 'elevated');
  assert.equal(siFlag({ si: 1e6, dtc: DTC_HIGH }, 100e6).level, 'high');
});
