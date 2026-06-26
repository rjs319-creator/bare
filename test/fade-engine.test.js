'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emptyState, load, serialize, betaBucket, groupKey, betaVsSpy, summary, update, recommend } = require('../lib/fade-engine');
const { tradeLevels } = require('../lib/vreversal');

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

// --- tradeLevels: the measured-move "expired" guard ---
test('tradeLevels flags an expired short (target already above entry)', () => {
  const lv = tradeLevels('short', 125.82, 206.28, 155.82);   // the live ACN case
  assert.equal(lv.expired, true);
  assert.ok(lv.rr == null || lv.rr <= 0, 'no positive reward left');
});

test('tradeLevels accepts a fresh short (target below entry)', () => {
  const lv = tradeLevels('short', 53.29, 57.30, 39.41);      // the live ARE case
  assert.equal(lv.expired, false);
  assert.ok(lv.rr > 0);
});

test('tradeLevels flags an expired long (price already past the target)', () => {
  const lv = tradeLevels('long', 100, 90, 95);               // target below entry → done
  assert.equal(lv.expired, true);
});

// --- recommend: geometry gate over the per-stock posterior ---
function strongFadeState() {
  // 30 winning short outcomes → high expAlpha / pPos / wEff for TEST.
  const outs = Array.from({ length: 30 }, () => ({ ticker: 'TEST', alpha: 3, sector: 'Tech', beta: 1.0 }));
  return update(emptyState(), outs);
}

test('recommend issues SHORT when the posterior is strong AND the setup is fresh', () => {
  const r = recommend(strongFadeState(), {
    ticker: 'TEST', regime: 'neutral', sector: 'Tech', beta: 1,
    signal: { side: 'short', entry: 100, stop: 108, target: 80, rr: 2.5, expired: false },
  });
  assert.equal(r.action, 'SHORT');
  assert.ok(r.sizePct > 0);
  assert.equal(r.freshLevels, true);
});

test('recommend demotes an EXPIRED setup to WATCH despite a strong posterior', () => {
  const r = recommend(strongFadeState(), {
    ticker: 'TEST', regime: 'neutral', sector: 'Tech', beta: 1,
    signal: { side: 'short', entry: 100, stop: 160, target: 120, rr: -0.33, expired: true },
  });
  assert.equal(r.action, 'WATCH');
  assert.equal(r.sizePct, 0);          // no size on a played-out setup
  assert.equal(r.expired, true);
});
