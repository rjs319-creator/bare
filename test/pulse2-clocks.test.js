'use strict';
// Market Pulse v2 — SEPARATE FRESHNESS CLOCKS.
// Required behaviors #1 and #2: a four-hour narrative snapshot is never labeled live
// market data, and narrative vs market-data freshness remain separate fields.

const test = require('node:test');
const assert = require('node:assert');
const clocks = require('../lib/pulse2-clocks');
const { assessFreshness } = require('../lib/market-session');

// A Tuesday 14:00 ET (18:00 UTC, EDT) — regular session.
const REGULAR_NOW = new Date('2026-06-09T18:00:00Z');
// A Saturday.
const WEEKEND_NOW = new Date('2026-06-13T18:00:00Z');

test('#1: a 4-hour-old narrative snapshot is NEVER a current/live narrative', () => {
  assert.equal(clocks.narrativeFreshnessOf(239), 'RECENT_NARRATIVE');
  assert.equal(clocks.narrativeFreshnessOf(241), 'STALE_NARRATIVE');
  assert.notEqual(clocks.narrativeFreshnessOf(239), 'CURRENT_NARRATIVE');
});

test('narrative tiers: current ≤60m, recent ≤4h, stale ≤12h, then last-known-good', () => {
  assert.equal(clocks.narrativeFreshnessOf(30), 'CURRENT_NARRATIVE');
  assert.equal(clocks.narrativeFreshnessOf(120), 'RECENT_NARRATIVE');
  assert.equal(clocks.narrativeFreshnessOf(700), 'STALE_NARRATIVE');
  assert.equal(clocks.narrativeFreshnessOf(2000), 'LAST_KNOWN_GOOD');
  assert.equal(clocks.narrativeFreshnessOf(null), 'UNAVAILABLE');
});

test('#2: the two clocks are separate — an old narrative with fresh market data keeps REALTIME market data', () => {
  const assessed = assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: REGULAR_NOW.getTime() - 6 * 60 * 1000, // 6-min-old bar start (complete)
    barIntervalSec: 300,
    now: REGULAR_NOW,
  });
  const out = clocks.buildClocks({
    narrativeGeneratedAt: new Date(REGULAR_NOW.getTime() - 4 * 3600 * 1000).toISOString(),
    marketDataAsOf: new Date(REGULAR_NOW.getTime() - 60 * 1000).toISOString(),
    assessed,
    sessionInfo: { marketSession: 'regular', isTradingDay: true, etDate: '2026-06-09' },
    now: REGULAR_NOW,
  });
  assert.equal(out.narrativeFreshness, 'RECENT_NARRATIVE');   // NOT live
  assert.equal(out.marketDataFreshness, 'REALTIME');          // independent clock
  assert.equal(out.narrativeAgeMinutes, 240);
  assert.equal(out.marketDataAgeSeconds, 60);
});

test('market closed maps to MARKET_CLOSED, never realtime', () => {
  const assessed = assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: WEEKEND_NOW.getTime() - 2 * 24 * 3600 * 1000,
    now: WEEKEND_NOW,
  });
  assert.equal(clocks.marketDataFreshnessOf(assessed), 'MARKET_CLOSED');
});

test('stale in-session bars map to STALE; missing data to UNAVAILABLE', () => {
  const stale = assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: REGULAR_NOW.getTime() - 45 * 60 * 1000,   // 45-min-old bar mid-session
    now: REGULAR_NOW,
  });
  assert.equal(clocks.marketDataFreshnessOf(stale), 'STALE');
  assert.equal(clocks.marketDataFreshnessOf(null), 'UNAVAILABLE');
  const none = assessFreshness({ sourceKind: 'intraday', barTimestamp: null, now: REGULAR_NOW });
  assert.equal(clocks.marketDataFreshnessOf(none), 'UNAVAILABLE');
});

test('provider-declared delay downgrades REALTIME to DELAYED', () => {
  const assessed = assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: REGULAR_NOW.getTime() - 6 * 60 * 1000,
    delayedByMin: 15,
    now: REGULAR_NOW,
  });
  assert.equal(clocks.marketDataFreshnessOf(assessed), 'DELAYED');
});

test('daily-only feeds are labeled DAILY_ONLY, never realtime', () => {
  const assessed = assessFreshness({ sourceKind: 'daily', barTimestamp: REGULAR_NOW.getTime() - 3600 * 1000, now: REGULAR_NOW });
  assert.equal(clocks.marketDataFreshnessOf(assessed), 'DAILY_ONLY');
});

test('buildClocks always carries modelVersion and dataMode', () => {
  const out = clocks.buildClocks({ now: REGULAR_NOW, dataMode: 'degraded' });
  assert.equal(out.modelVersion, clocks.MODEL_VERSION);
  assert.equal(out.dataMode, 'degraded');
  assert.equal(out.narrativeFreshness, 'UNAVAILABLE');
  assert.equal(out.marketDataFreshness, 'UNAVAILABLE');
});
