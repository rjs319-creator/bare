'use strict';
// 📡 MARKET PULSE v2 — SEPARATE FRESHNESS CLOCKS.
//
// v1 conflated two very different clocks into one `freshness` field derived from the
// narrative snapshot's age — a 3.9-hour-old story list was labeled "live". v2 keeps
// TWO independent clocks and never lets one masquerade as the other:
//   • the NARRATIVE clock — how old the LLM-collected story snapshot is;
//   • the MARKET-DATA clock — how old the deterministic market-state data is,
//     interpreted through the exchange session (a 2-hour-old close on a Saturday
//     is fine; a 20-minute-old bar mid-session is stale).
//
// Pure: no network, no store; `now` injectable. Session context comes from the
// central lib/market-session service — never re-derived here.

const { SESSION, FRESHNESS } = require('./market-session');

const MODEL_VERSION = 'pulse2-2.0.0';

// ── Narrative freshness ─────────────────────────────────────────────────────
// A narrative snapshot is an editorial artifact — its clock is wall-minutes since
// generation, bucketed honestly. "CURRENT" is intentionally tight: the collection
// cadence target is 15-60 min, so anything older than an hour is merely RECENT.
const NARRATIVE_FRESHNESS = Object.freeze({
  CURRENT: 'CURRENT_NARRATIVE',        // within one collection cycle (≤60 min)
  RECENT: 'RECENT_NARRATIVE',          // ≤4h — usable, but not "now"
  STALE: 'STALE_NARRATIVE',            // ≤12h — clearly aged
  LAST_KNOWN_GOOD: 'LAST_KNOWN_GOOD',  // older still, served only as a fallback
  UNAVAILABLE: 'UNAVAILABLE',
});

const NARRATIVE_CURRENT_MAX_MIN = 60;
const NARRATIVE_RECENT_MAX_MIN = 240;
const NARRATIVE_STALE_MAX_MIN = 720;

function narrativeFreshnessOf(ageMinutes) {
  if (ageMinutes == null || !Number.isFinite(ageMinutes)) return NARRATIVE_FRESHNESS.UNAVAILABLE;
  if (ageMinutes <= NARRATIVE_CURRENT_MAX_MIN) return NARRATIVE_FRESHNESS.CURRENT;
  if (ageMinutes <= NARRATIVE_RECENT_MAX_MIN) return NARRATIVE_FRESHNESS.RECENT;
  if (ageMinutes <= NARRATIVE_STALE_MAX_MIN) return NARRATIVE_FRESHNESS.STALE;
  return NARRATIVE_FRESHNESS.LAST_KNOWN_GOOD;
}

// ── Market-data freshness ───────────────────────────────────────────────────
// v2 vocabulary, mapped from the central session service's verdict so the two
// never diverge. REALTIME is reserved for in-session data inside the freshness
// threshold with no provider-declared delay.
const MARKET_DATA_FRESHNESS = Object.freeze({
  REALTIME: 'REALTIME',
  DELAYED: 'DELAYED',
  STALE: 'STALE',
  DAILY_ONLY: 'DAILY_ONLY',
  MARKET_CLOSED: 'MARKET_CLOSED',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Map a lib/market-session assessFreshness() verdict into the v2 market-data
 * freshness state. Pure.
 * @param {object|null} assessed  result of assessFreshness(), or null
 */
function marketDataFreshnessOf(assessed) {
  if (!assessed || !assessed.freshnessState) return MARKET_DATA_FRESHNESS.UNAVAILABLE;
  switch (assessed.freshnessState) {
    case FRESHNESS.LIVE:
    case FRESHNESS.LIVE_EXTENDED:
      return assessed.delayed ? MARKET_DATA_FRESHNESS.DELAYED : MARKET_DATA_FRESHNESS.REALTIME;
    case FRESHNESS.STALE: return MARKET_DATA_FRESHNESS.STALE;
    case FRESHNESS.DAILY_ONLY: return MARKET_DATA_FRESHNESS.DAILY_ONLY;
    case FRESHNESS.CLOSED: return MARKET_DATA_FRESHNESS.MARKET_CLOSED;
    default: return MARKET_DATA_FRESHNESS.UNAVAILABLE;
  }
}

/**
 * Build the complete, honest clock block for a served payload. Pure.
 *
 * @param {object} p
 * @param {string|null} p.narrativeGeneratedAt  ISO time of the narrative snapshot
 * @param {string|null} p.marketDataAsOf        ISO time of the newest market data
 * @param {object|null} p.assessed              assessFreshness() verdict for the market data
 * @param {object}      p.sessionInfo           sessionInfoAt(now) descriptor
 * @param {string|null} p.sourceCoverageAsOf    ISO time of the last source-collection sweep
 * @param {string|null} p.sectorDataAsOf        ISO time of the sector-state read
 * @param {Date}        p.now
 * @param {string}      p.dataMode              'live' | 'degraded' | 'unavailable'
 */
function buildClocks({
  narrativeGeneratedAt = null,
  marketDataAsOf = null,
  assessed = null,
  sessionInfo = null,
  sourceCoverageAsOf = null,
  sectorDataAsOf = null,
  now = new Date(),
  dataMode = 'live',
} = {}) {
  const nowMs = now.getTime();
  const narAgeMin = narrativeGeneratedAt
    ? Math.max(0, Math.round((nowMs - Date.parse(narrativeGeneratedAt)) / 60000)) : null;
  const mdAgeSec = marketDataAsOf
    ? Math.max(0, Math.round((nowMs - Date.parse(marketDataAsOf)) / 1000)) : null;
  return {
    narrativeGeneratedAt,
    narrativeAgeMinutes: narAgeMin,
    narrativeFreshness: narrativeFreshnessOf(narAgeMin),
    marketDataAsOf,
    marketDataAgeSeconds: mdAgeSec,
    marketDataFreshness: marketDataFreshnessOf(assessed),
    sessionState: sessionInfo ? sessionInfo.marketSession : SESSION.CLOSED,
    isTradingDay: sessionInfo ? sessionInfo.isTradingDay : null,
    etDate: sessionInfo ? sessionInfo.etDate : null,
    sourceCoverageAsOf,
    sectorDataAsOf,
    modelVersion: MODEL_VERSION,
    dataMode,
  };
}

module.exports = {
  MODEL_VERSION,
  NARRATIVE_FRESHNESS, MARKET_DATA_FRESHNESS,
  NARRATIVE_CURRENT_MAX_MIN, NARRATIVE_RECENT_MAX_MIN, NARRATIVE_STALE_MAX_MIN,
  narrativeFreshnessOf, marketDataFreshnessOf, buildClocks,
};
