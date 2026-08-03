'use strict';
// Persistent episodes: frozen levels, real state machine, strict Failed-Today semantics,
// dedup, amendments, unique keys.
const { test } = require('node:test');
const assert = require('node:assert');
const EP = require('../lib/patterns/episodes');

const NOW = '2026-06-20T12:00:00.000Z';

function det(over = {}) {
  return {
    ticker: 'ABC', family: 'BULL_FLAG', label: 'Bull flag', direction: 'LONG', timeframe: '20d',
    phase: 'NEAR_TRIGGER', structurallyInvalid: false,
    structural: { validity: 0.9, pass: true, featureCoverage: 1, missingRequiredFeatures: [] },
    structuralValidity: 0.9, featureCoverage: 1, missingRequiredFeatures: [],
    pivotsUsed: [{ idx: 3, kind: 'H', price: 105, date: '2026-06-05' }],
    triggerLevel: { price: 100, type: 'flag-boundary', sourceBarIdxs: [3], sourceBarDates: ['2026-06-05'] },
    invalidationLevel: { price: 95, type: 'flag-low' },
    targetLevel: { price: 112, method: 'pole-measured-move' },
    plan: { trigger: 100, stop: 95, target: 112, rr: 2.4, quality: 'good', direction: 'LONG' },
    geometry: { atr: 2, lastClose: 99 },
    similarity: { combined: 0.8 },
    confirmation: { status: 'NONE' },
    breakoutConfirmed: false, invalidationHit: false, retesting: false,
    patternStart: '2026-05-20', patternAsOf: '2026-06-19',
    ...over,
  };
}

function bar(date, o, h, l, c) { return { date, open: o, high: h, low: l, close: c, volume: 1e6 }; }

test('episodes: creation freezes the trigger with provenance and a unique composite key', () => {
  const ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  assert.ok(ep);
  assert.strictEqual(ep.frozen.trigger.price, 100);
  assert.ok(ep.key.includes('ABC|BULL_FLAG|LONG|20d|2026-05-20|flag-boundary@100|mv1'));
  assert.strictEqual(ep.state, 'READY');
  assert.strictEqual(ep.transitions[0].rule, 'DETECTED');
});

test('episodes: an already-invalidated detection never becomes an episode', () => {
  assert.strictEqual(EP.createEpisode(det({ invalidationHit: true }), { now: NOW, date: '2026-06-20' }), null);
});

test('episodes: frozen trigger NEVER drifts as bars advance', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 98, 99.5, 97, 99), now: NOW, date: '2026-06-21' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-22', 99, 105, 98.5, 104), now: NOW, date: '2026-06-22' });
  assert.strictEqual(ep.frozen.trigger.price, 100, 'trigger unchanged after new highs');
});

test('episodes: close through trigger → CONFIRMED; intraday wick → TRIGGERED_PENDING_CONFIRMATION', () => {
  const base = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  const wick = EP.advanceEpisode(base, { bar: bar('2026-06-21', 99, 101, 98, 99.4), now: NOW, date: '2026-06-21' });
  assert.strictEqual(wick.state, 'TRIGGERED_PENDING_CONFIRMATION');
  const confirmed = EP.advanceEpisode(base, { bar: bar('2026-06-21', 99, 101.5, 98.5, 101), now: NOW, date: '2026-06-21' });
  assert.strictEqual(confirmed.state, 'CONFIRMED');
  assert.strictEqual(confirmed.transitions[confirmed.transitions.length - 1].rule, 'CLOSE_CONFIRMED');
});

test('episodes: CONFIRMED then next-bar touch fills the entry; a gap fills at the OPEN', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 99, 101.5, 98.5, 101), now: NOW, date: '2026-06-21' }); // confirm
  const gapped = EP.advanceEpisode(ep, { bar: bar('2026-06-22', 103, 104, 102, 103.5), now: NOW, date: '2026-06-22' });
  assert.strictEqual(gapped.state, 'MANAGING');
  assert.strictEqual(gapped.entry.price, 103, 'gap through trigger fills at the open, not the trigger');
});

test('episodes: same-bar stop+target resolves STOPPED conservatively with the rule recorded', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 99, 101.5, 98.5, 101), now: NOW, date: '2026-06-21' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-22', 100.5, 101, 100.2, 100.8), now: NOW, date: '2026-06-22' }); // fill
  assert.strictEqual(ep.state, 'MANAGING');
  const wild = EP.advanceEpisode(ep, { bar: bar('2026-06-23', 100, 113, 94, 100), now: NOW, date: '2026-06-23' });
  assert.strictEqual(wild.state, 'STOPPED');
  assert.strictEqual(wild.transitions[wild.transitions.length - 1].rule, 'STOP_AND_TARGET_SAME_BAR_CONSERVATIVE');
});

test('episodes: pre-entry invalidation close → FAILED; failedOn is strict about the date', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 96, 97, 93, 94), now: NOW, date: '2026-06-21' });
  assert.strictEqual(ep.state, 'FAILED');
  assert.strictEqual(EP.failedOn(ep, '2026-06-21'), true);
  assert.strictEqual(EP.failedOn(ep, '2026-06-22'), false, '"Failed Today" requires the transition to have happened today');
});

test('episodes: an intraday wick to the stop does NOT fail a pre-entry setup (closing basis)', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 97, 98, 94.5, 97.5), now: NOW, date: '2026-06-21' });
  assert.notStrictEqual(ep.state, 'FAILED');
});

test('episodes: terminal episodes are retained and never re-advanced', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 96, 97, 93, 94), now: NOW, date: '2026-06-21' }); // FAILED
  const again = EP.advanceEpisode(ep, { bar: bar('2026-06-22', 99, 108, 98, 107), now: NOW, date: '2026-06-22' });
  assert.strictEqual(again, ep, 'terminal episode unchanged by later bars');
});

test('episodes: advancing the same bar twice is idempotent (state restored, not recomputed)', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  const b = bar('2026-06-21', 99, 101.5, 98.5, 101);
  const once = EP.advanceEpisode(ep, { bar: b, now: NOW, date: '2026-06-21' });
  const twice = EP.advanceEpisode(once, { bar: b, now: NOW, date: '2026-06-21' });
  assert.strictEqual(twice, once);
});

test('episodes: pre-entry aging out → EXPIRED with the AGED_OUT rule', () => {
  let ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  ep = { ...ep, expiresAfterBars: 2 };
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-21', 98, 99, 97, 98), now: NOW, date: '2026-06-21' });
  ep = EP.advanceEpisode(ep, { bar: bar('2026-06-22', 98, 99, 97, 98), now: NOW, date: '2026-06-22' });
  assert.strictEqual(ep.state, 'EXPIRED');
  assert.strictEqual(ep.transitions[ep.transitions.length - 1].rule, 'AGED_OUT');
});

test('episodes: amendments are versioned, pre-entry only, and can never touch the trigger', () => {
  const ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  const amended = EP.amendEpisode(ep, { field: 'target', value: 110, reason: 'measured move refined', now: NOW, date: '2026-06-20' });
  assert.strictEqual(amended.current.target, 110);
  assert.strictEqual(amended.amendments[0].version, 1);
  assert.strictEqual(EP.amendEpisode(ep, { field: 'trigger', value: 99, reason: 'nope', now: NOW, date: '2026-06-20' }), null);
  const filled = { ...ep, state: 'MANAGING', entry: { state: 'FILLED', date: '2026-06-21', price: 100 } };
  assert.strictEqual(EP.amendEpisode(filled, { field: 'target', value: 111, reason: 'post-entry', now: NOW, date: '2026-06-21' }), null);
});

test('episodes: overlapping detections of the same structure deduplicate to the best', () => {
  const a = det();
  const b = det({ structuralValidity: 0.7, triggerLevel: { price: 100.2, type: 'flag-boundary' } });
  const kept = EP.dedupeDetections([a, b]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].structuralValidity, 0.9);
});

test('episodes: matchEpisode finds the live episode for a re-detected structure (no duplicate)', () => {
  const ep = EP.createEpisode(det(), { now: NOW, date: '2026-06-20', modelVersion: 'mv1' });
  const redetected = det({ patternStart: '2026-05-21', triggerLevel: { price: 100.3, type: 'flag-boundary' } });
  assert.strictEqual(EP.matchEpisode([ep], redetected, 'mv1'), ep);
});

test('episodes: two different structures produce different keys (no collision)', () => {
  const k1 = EP.episodeKeyOf({ ticker: 'ABC', family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d', patternStart: '2026-05-20', triggerLevel: { price: 100, type: 'flag-boundary' }, modelVersion: 'mv1' });
  const k2 = EP.episodeKeyOf({ ticker: 'ABC', family: 'BULL_FLAG', direction: 'LONG', timeframe: '60d', patternStart: '2026-05-20', triggerLevel: { price: 100, type: 'flag-boundary' }, modelVersion: 'mv1' });
  const k3 = EP.episodeKeyOf({ ticker: 'ABC', family: 'BULL_FLAG', direction: 'LONG', timeframe: '20d', patternStart: '2026-05-20', triggerLevel: { price: 104, type: 'flag-boundary' }, modelVersion: 'mv1' });
  assert.notStrictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
});

test('episodes: primaryBucket assigns exactly one bucket per state', () => {
  const seen = new Set();
  for (const state of Object.values(EP.EP_STATES)) {
    const b = EP.primaryBucket({ state, transitions: [{ to: state, from: null, date: '2026-06-20' }] }, { date: '2026-06-21' });
    assert.strictEqual(typeof b, 'string');
    seen.add(b);
  }
  assert.ok(seen.size >= 6, 'states map onto the action-board buckets');
});
