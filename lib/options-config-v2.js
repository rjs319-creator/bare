'use strict';
// OPTIONS INTELLIGENCE ENGINE v2 — VERSIONED CONFIGURATION.
//
// Every tunable the v2 pipeline uses lives here, stamped with a version, so each
// persisted event/observation records EXACTLY which model produced it and challenger
// weight-sets can be evaluated against the champion without rewriting history.
//
// HONESTY CONTRACT: the anomaly weights below are INITIAL HYPOTHESES, not proven
// truth. They ship as the discovery champion because discovery must be visible from
// day one, but their predictive value is evaluated prospectively by
// lib/options-evaluate-v2.js and they carry `hypothesis: true` until that evaluation
// says otherwise. Nothing in this file may be described as validated.

const MODEL_VERSION = 'options-v2.0.0';
const GATE_VERSION = 'trade-gate-v2.0.0';

// ── Activity status (unusualness ONLY — never direction) ─────────────────────
const ACTIVITY_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  UNUSUAL: 'UNUSUAL',
  HIGHLY_UNUSUAL: 'HIGHLY_UNUSUAL',
  EXCEPTIONAL: 'EXCEPTIONAL',
  UNUSUAL_LOW_QUALITY: 'UNUSUAL_LOW_QUALITY',
});
const ACTIVITY_LABEL = Object.freeze({
  NORMAL: 'Normal activity',
  UNUSUAL: 'Unusual activity',
  HIGHLY_UNUSUAL: 'Highly unusual activity',
  EXCEPTIONAL: 'Exceptional activity',
  UNUSUAL_LOW_QUALITY: 'Unusual activity (low data quality)',
});

// ── Trade status (actionability ONLY — never unusualness) ────────────────────
const TRADE_STATUS = Object.freeze({
  NO_DIRECTION: 'NO_DIRECTION',
  ACTIVITY_ONLY: 'ACTIVITY_ONLY',
  POSSIBLE_HEDGE: 'POSSIBLE_HEDGE',
  POSSIBLE_SPREAD: 'POSSIBLE_SPREAD',
  MIXED: 'MIXED',
  WATCH_FOR_PRICE_TRIGGER: 'WATCH_FOR_PRICE_TRIGGER',
  READY: 'READY',
  PRICE_CONFIRMED: 'PRICE_CONFIRMED',
  CONTRADICTS_SETUP: 'CONTRADICTS_SETUP',
  AVOID_EVENT_RISK: 'AVOID_EVENT_RISK',
  INVALIDATED: 'INVALIDATED',
  STALE: 'STALE',
});
const TRADE_LABEL = Object.freeze({
  NO_DIRECTION: 'No direction inferable',
  ACTIVITY_ONLY: 'Activity only — no independent stock setup',
  POSSIBLE_HEDGE: 'Possible hedge',
  POSSIBLE_SPREAD: 'Possible spread / multi-leg',
  MIXED: 'Mixed two-sided activity',
  WATCH_FOR_PRICE_TRIGGER: 'Watching for price trigger',
  READY: 'Setup ready — trigger nearby',
  PRICE_CONFIRMED: 'Price-confirmed setup',
  CONTRADICTS_SETUP: 'Options lean contradicts the price setup',
  AVOID_EVENT_RISK: 'Avoid — binary event risk',
  INVALIDATED: 'Invalidated',
  STALE: 'Stale',
});

// ── Interpretation states (directional/structure reading, always cautious) ───
const INTERPRETATION = Object.freeze({
  BULLISH_PROVISIONAL: 'BULLISH_PROVISIONAL',
  BEARISH_PROVISIONAL: 'BEARISH_PROVISIONAL',
  POSSIBLE_HEDGE: 'POSSIBLE_HEDGE',
  POSSIBLE_SPREAD: 'POSSIBLE_SPREAD',
  MIXED: 'MIXED',
  UNKNOWN: 'UNKNOWN',
});
const INTERPRETATION_LABEL = Object.freeze({
  BULLISH_PROVISIONAL: 'Provisional bullish (unverified)',
  BEARISH_PROVISIONAL: 'Provisional bearish (unverified)',
  POSSIBLE_HEDGE: 'Possible hedge',
  POSSIBLE_SPREAD: 'Possible spread / multi-leg',
  MIXED: 'Mixed',
  UNKNOWN: 'Direction unknown',
});

// ── Source modes (the active data feed, disclosed on every payload) ──────────
const SOURCE_MODE = Object.freeze({
  DELAYED_CHAIN: 'DELAYED_CHAIN',            // free Yahoo chain snapshots (current provider)
  REALTIME_TRADE_QUOTE: 'REALTIME_TRADE_QUOTE', // consolidated trades+NBBO (env-gated, not configured)
  COMPLEX_ORDER: 'COMPLEX_ORDER',            // linked-leg complex order feed (env-gated, not configured)
});
const SOURCE_MODE_LABEL = Object.freeze({
  DELAYED_CHAIN: 'Delayed chain snapshots (aggregate, not tick tape)',
  REALTIME_TRADE_QUOTE: 'Real-time trades + synchronized quotes',
  COMPLEX_ORDER: 'Complex-order feed (linked legs)',
});

// DTE buckets the scan must cover fairly (superset of the classify buckets —
// same keys where they overlap, so legacy consumers keep working).
const DTE_BUCKETS_V2 = Object.freeze([
  { key: '0-7', min: 0, max: 7, targetDte: 3 },
  { key: '8-20', min: 8, max: 20, targetDte: 14 },
  { key: '21-45', min: 21, max: 45, targetDte: 32 },
  { key: '46-75', min: 46, max: 75, targetDte: 58 },
  { key: '76+', min: 76, max: Infinity, targetDte: 100 },
]);

// ── Champion anomaly configuration (versioned; weights are HYPOTHESES) ───────
const ANOMALY_CONFIG = Object.freeze({
  id: 'anomaly-v2-champion',
  version: MODEL_VERSION,
  hypothesis: true,   // weights are initial hypotheses — never present as proven
  weights: Object.freeze({
    volumePercentile: 0.30,       // time-of-session-adjusted volume vs own baseline
    relNotionalPercentile: 0.20,  // notional vs the ticker's normal option activity
    volOiPercentile: 0.15,        // volume/open-interest vs own baseline
    concentration: 0.15,          // strike/expiry concentration (coherent vs scattered)
    ivSkewChange: 0.10,           // IV level + skew shift vs baseline
    persistence: 0.10,            // persistence + acceleration across scans
  }),
  // Robust-statistics knobs
  minBaselineSessions: 6,     // below this a ticker's relative score is UNSCORED (absolute path only)
  fullBaselineSessions: 12,   // at/above this the baseline is considered mature
  winsorPct: 0.02,            // clip the top/bottom 2% of baseline history
  // Data-quality multiplier (applied AFTER unusualness — never mixed into it)
  minDataQuality: 60,         // below this an otherwise-unusual event is UNUSUAL_LOW_QUALITY
  // Activity thresholds on the 0-100 anomaly score
  thresholds: Object.freeze({ unusual: 65, highlyUnusual: 80, exceptional: 92 }),
  // Absolute-size admission (the second door into discovery): a very large event
  // may enter even with an immature baseline, but ONLY with acceptable quality.
  absoluteTiers: Object.freeze([
    { key: 'exceptional', minNotional: 25_000_000 },
    { key: 'very-large', minNotional: 5_000_000 },
    { key: 'large', minNotional: 1_000_000 },
    { key: 'moderate', minNotional: 250_000 },
    { key: 'small', minNotional: 0 },
  ]),
  absoluteAdmitTier: 'very-large',   // ≥ this tier may enter discovery on size alone
  absoluteAdmitMinQuality: 70,       // …but only above this data quality
});

// Challenger configurations run in SHADOW: their scores are computed and logged for
// prospective evaluation but never change what is displayed as the champion read.
const ANOMALY_CHALLENGERS = Object.freeze([
  Object.freeze({
    id: 'anomaly-v2-flat',
    label: 'Equal-weight challenger',
    hypothesis: true,
    weights: Object.freeze({
      volumePercentile: 1 / 6, relNotionalPercentile: 1 / 6, volOiPercentile: 1 / 6,
      concentration: 1 / 6, ivSkewChange: 1 / 6, persistence: 1 / 6,
    }),
  }),
  Object.freeze({
    id: 'anomaly-v2-volheavy',
    label: 'Volume-dominant challenger',
    hypothesis: true,
    weights: Object.freeze({
      volumePercentile: 0.45, relNotionalPercentile: 0.20, volOiPercentile: 0.20,
      concentration: 0.05, ivSkewChange: 0.05, persistence: 0.05,
    }),
  }),
]);

// ── Ranking fairness ─────────────────────────────────────────────────────────
const RANKING = Object.freeze({
  maxContractsPerTicker: 4,   // best N contracts retained per ticker BEFORE global ranking
  maxEvents: 40,              // page cap applied ONLY after ticker aggregation
});

// ── Trade gate (initial, configurable, NOT proven) ───────────────────────────
const TRADE_GATE = Object.freeze({
  version: GATE_VERSION,
  minAnomalyScore: 80,
  minDataQuality: 80,
  minLiquidityQuality: 50,
  maxSpreadPct: 25,             // options quote spread beyond this disqualifies direction weight
  triggerProximityPct: 1.5,     // within this % of the trigger = READY (else WATCH)
  maxExtensionAtrMult: 2.0,     // spot more than this many ATR past trigger = chase risk
  minRewardRisk: 1.5,
  earningsAvoidDays: 2,         // earnings within this many days = AVOID_EVENT_RISK
  timeStopSessions: 21,         // default swing time stop
  staleAfterSessions: 3,        // event unseen for this many sessions = STALE
});

// ── Option-contract selection for "trade the option" (never auto-recommended) ─
const CONTRACT_SELECT = Object.freeze({
  minOpenInterest: 250,
  minVolume: 20,
  maxSpreadPct: 12,
  deltaBandProxy: Object.freeze({ minMoneyness: -0.10, maxMoneyness: 0.05 }), // ATM-ish band by moneyness (no greeks on free chains)
  minDte: 21, maxDte: 75,       // swing horizon; avoids pure gamma decay
});

// ── Universe / scan budgets ──────────────────────────────────────────────────
const UNIVERSE = Object.freeze({
  scanBudget: 90,           // max tickers fetched per scan (provider-rate-limit bound)
  broadShardSize: 20,       // rotating slice of the broad universe per session
  maxExpiryFetches: 4,      // extra ?date= fetches per ticker (nearest is free)
  concurrency: 8,
});

// Alert cooldowns per transition kind (sessions).
const ALERT_COOLDOWNS = Object.freeze({
  default: 1,
  persistence: 2,
  acceleration: 1,
});

function dteBucketV2(dte) {
  if (dte == null || !Number.isFinite(dte)) return null;
  for (const b of DTE_BUCKETS_V2) if (dte >= b.min && dte <= b.max) return b.key;
  return '76+';
}

function absoluteSizeTier(notional, tiers = ANOMALY_CONFIG.absoluteTiers) {
  const n = Number.isFinite(notional) ? notional : 0;
  for (const t of tiers) if (n >= t.minNotional) return t.key;
  return 'small';
}

module.exports = {
  MODEL_VERSION, GATE_VERSION,
  ACTIVITY_STATUS, ACTIVITY_LABEL, TRADE_STATUS, TRADE_LABEL,
  INTERPRETATION, INTERPRETATION_LABEL, SOURCE_MODE, SOURCE_MODE_LABEL,
  DTE_BUCKETS_V2, ANOMALY_CONFIG, ANOMALY_CHALLENGERS, RANKING,
  TRADE_GATE, CONTRACT_SELECT, UNIVERSE, ALERT_COOLDOWNS,
  dteBucketV2, absoluteSizeTier,
};
