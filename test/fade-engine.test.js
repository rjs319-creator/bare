'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emptyState, load, serialize, betaBucket, groupKey, betaVsSpy, summary } = require('../lib/fade-engine');

test('betaBucket classifies low / mid / high', () => {
  assert.equal(betaBucket(null), 'mid');
  assert.equal(betaBucket(0.5), 'low');
  assert.equal(betaBucket(1.0), 'mid');
  assert.equal(betaBucket(1.5), 'high');
});

test('groupKey combines sector and beta bucket', () => {
  assert.equal(groupKey('Tech', 1.5), 'Tech|high');
  assert.equal(groupKey(null, null), '?|mid');
});

test('betaVsSpy recovers a 2x beta', () => {
  const candles = [], spyClose = {}; let sp = 100, st = 100;
  for (let i = 0; i < 40; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    candles.push({ date, close: st }); spyClose[date] = sp;
    const r = i % 2 ? 0.02 : 0.01;               // varying returns so variance > 0
    sp *= 1 + r; st *= 1 + 2 * r;                 // stock moves exactly 2x SPY
  }
  assert.equal(betaVsSpy(candles, spyClose, 252), 2);
});

test('betaVsSpy defaults to 1 with too few overlapping bars', () => {
  assert.equal(betaVsSpy([{ date: '2026-01-01', close: 100 }], {}, 252), 1);
});

test('emptyState → serialize → load round-trips', () => {
  const s = emptyState();
  const restored = load(serialize(s));
  assert.equal(restored.global.W, 0);
  assert.deepEqual(Object.keys(restored.stocks), []);
});

test('load re-seeds a legacy (v1) state shape', () => {
  const legacy = { global: { a: 1, b: 2 } };     // no .W → must reset
  assert.equal(load(legacy).global.W, 0);
});

test('summary reports zeroed stats for a fresh state', () => {
  const sm = summary(emptyState());
  assert.equal(sm.effObs, 0);
  assert.equal(sm.beatRate, 0.5);
});
