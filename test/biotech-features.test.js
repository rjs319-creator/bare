'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeFeatures, findEventBar, closeLocation, anchoredVwap } = require('../lib/biotech-features');

function mk(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c * 0.99, high: c * 1.03, low: c * 0.97, close: c, volume: vols ? vols[i] : 1e6,
  }));
}

test('computeFeatures: null when insufficient history', () => {
  assert.equal(computeFeatures(mk([1, 2, 3])), null);
});

test('computeFeatures: multi-horizon returns + MA structure on a fresh pop', () => {
  const base = Array.from({ length: 55 }, () => 10);
  const f = computeFeatures(mk([...base, 10.5, 11, 11.7, 12.3, 13]));
  assert.ok(f);
  assert.ok(f.ret5 > 20, '5-day pop measured');
  assert.equal(f.aboveSma20, true);
  assert.equal(f.aboveSma50, true);
  assert.ok(f.atrPct > 0);
});

test('closeLocation: 1 = closed on high, 0 = closed on low', () => {
  assert.equal(closeLocation({ high: 10, low: 8, close: 10 }), 1);
  assert.equal(closeLocation({ high: 10, low: 8, close: 8 }), 0);
  assert.equal(closeLocation({ high: 10, low: 10, close: 10 }), null);
});

test('event-anchored features: gap, close-location, gap-retention, anchored VWAP', () => {
  const base = Array.from({ length: 50 }, () => 10);
  // event bar gaps up to ~13 and holds; index 50 is the event.
  const closes = [...base, 13, 13.2, 13.5, 13.1, 13.4];
  const vols = [...Array.from({ length: 50 }, () => 1e6), 5e6, 3e6, 2.5e6, 2e6, 2e6];
  const candles = mk(closes, vols);
  const evIdx = findEventBar(candles, 15);
  assert.equal(evIdx, 50, 'locates the gap/volume event bar');
  const f = computeFeatures(candles, { eventIdx: evIdx });
  assert.ok(f.event, 'event features present');
  assert.ok(f.event.gapPct > 20, 'event gap measured');
  assert.ok(f.event.gapRetain1 >= 1, 'gap retained after 1 session');
  assert.equal(typeof f.event.aboveAnchoredVwap, 'boolean');
  assert.ok(f.event.anchoredVwap > 0);
});

test('findEventBar: returns null on flat drift (no real event)', () => {
  assert.equal(findEventBar(mk(Array.from({ length: 40 }, () => 10)), 15), null);
});

test('XBI residual: computed when XBI supplied, null (not zero) when missing', () => {
  const base = Array.from({ length: 55 }, () => 10);
  const candles = mk([...base, 10.5, 11, 11.7, 12.3, 13]);
  const xbi = mk(Array.from({ length: 60 }, (_, i) => 50 + i * 0.02));
  const withX = computeFeatures(candles, { xbi });
  assert.ok(withX.residual5 != null, 'residual computed with XBI');
  const noX = computeFeatures(candles);
  assert.equal(noX.residual5, null, 'missing XBI → null, never a silent zero');
});
