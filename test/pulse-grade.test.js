'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../lib/pulse-grade');
const routes = require('../lib/pulse-routes');

const episode = (over = {}) => ({
  id: 'e1', firstSeenDate: '2026-07-01', tickers: ['XYZ'], category: 'ticker',
  firstSeenState: { category: 'ticker', sentiment: 'bullish', crowding: 'early' },
  firstSeenEnrichment: { ret3: 2 }, snapshots: [{}, {}], lastSeenDate: '2026-07-03', ...over,
});
const forward = (over = {}) => ({ entryOpen: 100, closes: { 1: 102, 3: 106, 5: 110, 10: 112 }, spyRet: { 1: 0.5, 3: 1, 5: 1.5, 10: 2 }, mfe: 14, mae: -3, ...over });

// ── Separable claims ──────────────────────────────────────────────────────────
test('gradeEpisode: grades awareness / continuation / consequence / direction separately', () => {
  const o = g.gradeEpisode(episode(), forward());
  assert.equal(o.gradable, true);
  assert.equal(o.awareness.detectedAhead, true);        // post-move (10) ≥ pre-move (2)
  assert.equal(o.continuation.persisted, true);
  assert.equal(o.consequence.materialMove, true);       // |10%| ≥ 5%
  assert.equal(o.direction.declared, true);
  assert.equal(o.direction.correct, true);              // bullish + positive SPY-excess
});

test('gradeEpisode: direction is NOT graded when no side was declared', () => {
  const o = g.gradeEpisode(episode({ firstSeenState: { category: 'ticker', sentiment: 'mixed', crowding: 'early' } }), forward());
  assert.equal(o.direction.declared, false);
});

test('gradeEpisode: contrarian outcome is separate from direction (crowded ≠ short)', () => {
  const o = g.gradeEpisode(
    episode({ firstSeenState: { category: 'ticker', sentiment: 'bullish', crowding: 'crowded' } }),
    forward({ closes: { 5: 90 }, spyRet: { 5: 2 } }));   // fell while SPY rose → underperformed
  assert.equal(o.contrarian.applicable, true);
  assert.equal(o.contrarian.underperformed, true);
  // still a (wrong) directional call, tracked independently
  assert.equal(o.direction.correct, false);
});

test('gradeEpisode: no tradeable entry → not gradable', () => {
  assert.equal(g.gradeEpisode(episode(), null).gradable, false);
  assert.equal(g.gradeEpisode(episode(), { entryOpen: 0, closes: {} }).gradable, false);
});

// ── Cold start + insufficient-sample suppression ──────────────────────────────
test('summarizePulseOutcomes: cold start → Insufficient history, no probability', () => {
  const sum = g.summarizePulseOutcomes([]);
  assert.equal(sum.total, 0);
  assert.equal(sum.directional.status, 'Insufficient history');
  assert.equal(sum.directional.probability, null);
  assert.equal(sum.directionalValueProven, false);
});

test('summarizePulseOutcomes: below minSample distinct dates → Collecting evidence, no probability', () => {
  const outs = Array.from({ length: 10 }, (_, i) => g.gradeEpisode(episode({ id: 'e' + i, firstSeenDate: '2026-07-0' + (i % 9 + 1) }), forward()));
  const sum = g.summarizePulseOutcomes(outs, { minSample: 20 });
  assert.equal(sum.directional.status, 'Collecting evidence');
  assert.equal(sum.directional.probability, null);
});

test('summarizePulseOutcomes: at/above minSample → Measured with a bounded rate', () => {
  const outs = Array.from({ length: 25 }, (_, i) => g.gradeEpisode(episode({ id: 'e' + i, firstSeenDate: '2026-06-' + String(i + 1).padStart(2, '0') }), forward()));
  const sum = g.summarizePulseOutcomes(outs, { minSample: 20 });
  assert.equal(sum.directional.status, 'Measured');
  assert.equal(typeof sum.directional.probability, 'number');
  assert.ok(sum.directional.lo != null && sum.directional.hi != null);
});

test('wilson: bounds are ordered and within [0,100]', () => {
  const w = g.wilson(7, 10);
  assert.ok(w.lo <= w.rate && w.rate <= w.hi);
  assert.ok(w.lo >= 0 && w.hi <= 100);
});

// ── No same-day lookahead: next-open entry AFTER first-seen ────────────────────
test('buildForward: entry is the NEXT session open (strictly after first-seen — no lookahead)', () => {
  const rows = [
    { date: '2026-07-01', open: 90, close: 91, high: 92, low: 89 },   // first-seen day — must NOT be the entry
    { date: '2026-07-02', open: 100, close: 103, high: 104, low: 99 }, // entry = this open
    { date: '2026-07-03', open: 103, close: 106, high: 107, low: 102 },
    { date: '2026-07-06', open: 106, close: 110, high: 111, low: 105 },
    { date: '2026-07-07', open: 110, close: 112, high: 113, low: 109 },
    { date: '2026-07-08', open: 112, close: 115, high: 116, low: 111 },
    { date: '2026-07-09', open: 115, close: 118, high: 119, low: 114 },
  ];
  const fwd = routes.buildForward(rows, null, '2026-07-01', [1, 3]);
  assert.equal(fwd.entryOpen, 100, 'entry is 2026-07-02 open, not the first-seen 2026-07-01');
  assert.equal(fwd.closes[1], 106);   // +1 session close
});

test('buildForward: no session after first-seen → null (cannot grade)', () => {
  const rows = [{ date: '2026-07-01', open: 90, close: 91 }];
  assert.equal(routes.buildForward(rows, null, '2026-07-01'), null);
});

// ── Stale-state thresholds ────────────────────────────────────────────────────
test('freshnessOf: <4h live, <12h stale, older very-stale', () => {
  assert.equal(routes.freshnessOf(30), 'live');
  assert.equal(routes.freshnessOf(300), 'stale');
  assert.equal(routes.freshnessOf(1000), 'very-stale');
  assert.equal(routes.freshnessOf(null), 'unknown');
});
