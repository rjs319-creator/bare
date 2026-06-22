'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeBrief, classifyMkt, mktLean, fcBull, sign } = require('../lib/brief');

test('sign applies a deadband around zero', () => {
  assert.equal(sign(0.2), 1);
  assert.equal(sign(-0.2), -1);
  assert.equal(sign(0.01), 0);
});

test('classifyMkt tags macro themes', () => {
  assert.equal(classifyMkt('Will the Fed cut rates in July?'), 'ratecut');
  assert.equal(classifyMkt('Will the Fed hike rates?'), 'ratehike');
  assert.equal(classifyMkt('Will CPI rise more than 0.3%?'), 'inflation');
  assert.equal(classifyMkt('US recession in 2026?'), 'recession');
  assert.equal(classifyMkt('Will the VIX close above 25?'), 'volatility');
  assert.equal(classifyMkt('Will it rain tomorrow?'), null);
});

test('mktLean: rate-cut odds rising is risk-on; falling flips', () => {
  assert.ok(mktLean({ title: 'Fed cut in July?', prob: 0.55, probPrev: 0.42 }).lean > 0);
  assert.ok(mktLean({ title: 'Fed cut in July?', prob: 0.30, probPrev: 0.45 }).lean < 0);
});

test('mktLean: recession odds rising is risk-off', () => {
  assert.ok(mktLean({ title: 'US recession in 2026?', prob: 0.40, probPrev: 0.30 }).lean < 0);
});

test('fcBull: SPY up bullish, VIX up bearish, weighted by confidence', () => {
  assert.ok(fcBull({ subject: 'SPY', direction: 'up', confidence: 10 }) > 0);
  assert.ok(fcBull({ subject: '^VIX', direction: 'up', confidence: 10 }) < 0);
  assert.ok(fcBull({ subject: 'XLK', direction: 'outperform', confidence: 8 }) > 0);
  assert.ok(fcBull({ subject: 'XLP', direction: 'outperform', confidence: 8 }) < 0); // defensive leadership = cautious
});

test('computeBrief: risk-on + rate-cut → constructive, cyclicals favored', () => {
  const b = computeBrief(
    { ok: true, open: [{ subject: 'QQQ', direction: 'up', confidence: 7 }, { subject: 'XLF', direction: 'outperform', confidence: 6 }] },
    { ok: true, unusual: [{ title: 'Fed cut in July?', prob: 0.55, probPrev: 0.42, movePts: 13 }], sharp: [{ title: 'Fed cut in July?', prob: 0.55, probPrev: 0.42 }] },
    { ok: true, regime: 'risk-on', condition: 'trending', efficiency: 0.41 });
  assert.equal(b.tone, 'bull');
  assert.equal(b.consensus, 1);
  assert.ok(b.favored.some(f => f.etf === 'XLF'));
  assert.ok(b.themes.includes('ratecut'));
});

test('computeBrief: risk-off + recession → defensive, cyclicals pressured', () => {
  const b = computeBrief(
    { ok: true, open: [{ subject: 'SPY', direction: 'down', confidence: 6 }, { subject: '^VIX', direction: 'up', confidence: 7 }] },
    { ok: true, unusual: [{ title: 'US recession in 2026?', prob: 0.40, probPrev: 0.30, movePts: 10 }], sharp: [] },
    { ok: true, regime: 'risk-off', condition: 'choppy', efficiency: 0.18 });
  assert.equal(b.tone, 'bear');
  assert.equal(b.consensus, -1);
  assert.ok(b.favored.some(f => ['XLP', 'XLU', 'XLV'].includes(f.etf)));
  assert.ok(b.pressured.some(f => ['XLK', 'XLY', 'XLF'].includes(f.etf)));
});

test('computeBrief: agreement counts aligned signals', () => {
  const b = computeBrief(
    { ok: true, open: [{ subject: 'SPY', direction: 'up', confidence: 8 }] },
    { ok: true, unusual: [{ title: 'Fed cut in July?', prob: 0.6, probPrev: 0.4, movePts: 20 }], sharp: [{ title: 'Fed cut in July?', prob: 0.6, probPrev: 0.4 }] },
    { ok: true, regime: 'risk-on', condition: 'trending', efficiency: 0.4 });
  assert.equal(b.agree, 3);   // forecast + crowd + sharp all bullish
});

test('computeBrief tolerates missing/failed inputs', () => {
  const b = computeBrief(null, null, null);
  assert.equal(b.tone, 'neutral');
  assert.equal(b.regime, 'neutral');
});
