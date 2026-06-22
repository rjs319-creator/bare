'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStudyEvents, summarizeCrowdStudy, THEME_PRIMARY } = require('../lib/cstudy');

const mkt = o => Object.assign({ venue: 'Kalshi', vol24: 5000, prob: 0.5, probPrev: 0.5, movePts: 15, closeTime: new Date(Date.now() + 10 * 86400000).toISOString() }, o);

test('buildStudyEvents: rate-cut odds rising → XLRE expected up', () => {
  const [e] = buildStudyEvents([mkt({ id: 'k1', title: 'Will the Fed cut rates in July?', prob: 0.55, probPrev: 0.42 })], '2026-06-22');
  assert.equal(e.etf, 'XLRE');
  assert.equal(e.dir, 1);
  assert.equal(e.theme, 'ratecut');
});

test('buildStudyEvents: odds falling flips the expected direction', () => {
  const [e] = buildStudyEvents([mkt({ id: 'k1', title: 'Will the Fed cut rates in July?', prob: 0.30, probPrev: 0.45 })], '2026-06-22');
  assert.equal(e.dir, -1);
});

test('buildStudyEvents: skips thin money, small moves, far-dated, off-theme', () => {
  const events = buildStudyEvents([
    mkt({ id: 'a', title: 'Fed cut?', prob: 0.55, probPrev: 0.42, vol24: 100 }),            // ~$55 — too thin
    mkt({ id: 'b', title: 'Fed cut?', prob: 0.50, probPrev: 0.49, movePts: 1 }),               // tiny move
    mkt({ id: 'c', title: 'Fed cut?', prob: 0.55, probPrev: 0.42, closeTime: new Date(Date.now() + 400 * 86400000).toISOString() }), // far-dated
    mkt({ id: 'd', title: 'Will it rain in NYC?', prob: 0.55, probPrev: 0.42 }),              // no theme
  ], '2026-06-22');
  assert.equal(events.length, 0);
});

test('summarizeCrowdStudy: aggregates graded events, counts pending', () => {
  const days = [{ events: [
    { theme: 'ratecut', grades: { 5: { hit: true }, 10: { hit: true } } },
    { theme: 'recession', grades: { 5: { hit: false } } },
    { theme: 'ratecut', grades: {} },   // pending
  ] }];
  const s = summarizeCrowdStudy(days);
  assert.equal(s.n, 3);                  // 2 + 1 graded horizons
  assert.equal(s.hits, 2);
  assert.equal(s.pending, 1);
  assert.deepEqual(s.byTheme.ratecut, { n: 2, hits: 2 });
});

test('THEME_PRIMARY covers the five directional themes', () => {
  assert.deepEqual(Object.keys(THEME_PRIMARY).sort(), ['inflation', 'ratecut', 'ratehike', 'recession', 'volatility']);
});
