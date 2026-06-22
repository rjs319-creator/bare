'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcEMA, calcRSI, calcMACD, calcVWAP, calcATR } = require('../lib/signal');

test('calcEMA: nulls before the period, SMA seed, flat series stays flat', () => {
  assert.deepEqual(calcEMA([5, 5, 5, 5], 2), [null, 5, 5, 5]);
  assert.deepEqual(calcEMA([5], 2), [null]);   // too short
});

test('calcEMA: rising series produces a rising line', () => {
  const e = calcEMA([1, 2, 3, 4, 5], 2);
  assert.equal(e[1], 1.5);                      // SMA(1,2)
  assert.ok(e[4] > e[3] && e[3] > e[2]);
});

test('calcRSI: a relentless uptrend pins RSI at 100', () => {
  const closes = Array.from({ length: 16 }, (_, i) => i + 1);   // strictly rising
  assert.equal(calcRSI(closes, 14)[14], 100);
});

test('calcRSI: too-short input is all null', () => {
  assert.deepEqual(calcRSI([1, 2, 3], 14).every(v => v === null), true);
});

test('calcMACD: flat series has a ~zero histogram', () => {
  const closes = new Array(40).fill(100);
  const { histogram } = calcMACD(closes);
  const last = histogram[histogram.length - 1];
  assert.ok(last !== null && Math.abs(last) < 1e-9);
});

test('calcVWAP: weights by volume and resets each day', () => {
  const v = calcVWAP([
    { date: '2026-01-01', high: 11, low: 9, close: 10, volume: 100 },   // typical 10
    { date: '2026-01-01', high: 13, low: 11, close: 12, volume: 100 },  // typical 12 → cum 11
    { date: '2026-01-02', high: 21, low: 19, close: 20, volume: 50 },   // new day resets → 20
  ]);
  assert.equal(v[0], 10);
  assert.equal(v[1], 11);
  assert.equal(v[2], 20);
});

test('calcATR: constant range converges to that range', () => {
  const candles = Array.from({ length: 15 }, () => ({ high: 102, low: 100, close: 101 }));
  const atr = calcATR(candles, 14);
  assert.equal(atr[13], 2);
  assert.equal(atr[14], 2);
});
