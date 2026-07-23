'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyIntradayFreshness, shapeIntradayHorizon } = require('../lib/signal');

const liveBuy = () => ({
  action: 'BUY', label: 'Buy', score: 5, confidence: 7, bullish: true,
  reasons: ['Above VWAP'], counter: [], rsi: 60, vwap: 100,
  levels: { entry: '100.00', target: '105.00', stop: '97.00', riskReward: '1:2.5', atr: '2.00' },
});

test('daily fallback can NEVER present an intraday BUY/SELL', () => {
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'stooq', 'CLOSED', 'daily-fallback', '2024-01-05');
  assert.strictEqual(h.available, false);
  assert.strictEqual(h.action, 'UNAVAILABLE');
  assert.strictEqual(h.levels, null, 'no daily-ATR levels shown as intraday');
  // legacy live is demoted in place so the shared chart renderer cannot paint BUY
  assert.strictEqual(live.action, 'HOLD');
  assert.strictEqual(live.levels, null);
});

test('stale intraday data is explicitly marked and demoted', () => {
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'yahoo', 'REGULAR', 'stale', '2024-01-05');
  assert.strictEqual(h.freshness, 'stale');
  assert.ok(h.reasons.some(r => /stale/i.test(r)));
  assert.strictEqual(live.action, 'HOLD', 'demoted so no green BUY renders');
});

test('a fresh live BUY is preserved with its intraday levels', () => {
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'yahoo', 'REGULAR', 'live', '2024-01-05');
  assert.strictEqual(h.action, 'BUY');
  assert.ok(h.levels && h.levels.entry, 'intraday levels intact');
  assert.strictEqual(h.available, true);
});

test('premarket / after-hours sessions are explicit', () => {
  const now = 1_700_000_000;
  assert.strictEqual(classifyIntradayFreshness('yahoo', 'PRE', now - 60, now), 'premarket');
  assert.strictEqual(classifyIntradayFreshness('yahoo', 'POST', now - 60, now), 'afterhours');
});

test('regular-session bar older than the threshold is stale, fresh bar is live', () => {
  const now = 1_700_000_000;
  assert.strictEqual(classifyIntradayFreshness('yahoo', 'REGULAR', now - 5 * 60, now), 'live');
  assert.strictEqual(classifyIntradayFreshness('yahoo', 'REGULAR', now - 40 * 60, now), 'stale');
});

test('non-yahoo source is always daily-fallback', () => {
  const now = 1_700_000_000;
  assert.strictEqual(classifyIntradayFreshness('stooq', 'REGULAR', now, now), 'daily-fallback');
});

test('intraday evidence is strength, never a labeled probability', () => {
  const live = liveBuy();
  const h = shapeIntradayHorizon(live, 'yahoo', 'REGULAR', 'live', '2024-01-05');
  assert.strictEqual(h.calibrated, false);
  assert.strictEqual(h.evidenceStrength, 7);
  assert.ok(!('probability' in h), 'no probability field');
  assert.strictEqual(live.evidenceStrength, 7, 'legacy live carries the renamed framing');
});
