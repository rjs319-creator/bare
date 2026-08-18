'use strict';
// SWING CANDIDATE SCHEMA + DETERMINISTIC IDENTITY (Screener Replay v3).
//
// One stable contract for every evaluated swing candidate — selected, rejected,
// near-miss or control — so the live screener, the replay harness and the
// research capture all speak the same record. Pure; deterministic; no store.
//
//   candidateId  = sha256 over the evidence identity:
//                  strategyId|scoringVersion|universeScope|ticker|decisionCutoff|side|horizon
//                  Stable across runs; changes iff the identity changes.
//   candidateSetHash = sha256 over the SORTED candidateId list — the live/replay
//                  parity primitive (any selection mismatch changes the hash).
//   makeObservation  = validated immutable observation record with decision-time
//                  features, missingness mask, status + rejection code, plan,
//                  cohort context, provenance and display fields.

const crypto = require('node:crypto');

const SCHEMA_VERSION = 'swing-candidate-v3';

// Canonical rejection codes (the required set + engine-specific extras).
const REJECT = Object.freeze({
  STALE_DATA: 'stale-data',
  FUTURE_DATED_DATA: 'future-dated-data',
  BENCHMARK_LAG: 'benchmark-lag',
  MISSING_HISTORY: 'missing-history',
  MISSING_BENCHMARK: 'missing-benchmark',
  LIQUIDITY: 'liquidity',
  LIVE_TREND_GATE: 'live-trend-gate',
  RELATIVE_STRENGTH_GATE: 'relative-strength-gate',
  BELOW_SELECTION_CAP: 'below-selection-cap',
  RISK_OFF: 'risk-off',
  EVENT_RISK: 'event-risk',
  INVALID_TRADE_PLAN: 'invalid-trade-plan',
  GOVERNANCE: 'governance',
  DUPLICATE: 'duplicate',
  DEADLINE_TRUNCATED: 'deadline-truncated',
  MISSING_SCOPE_CACHE: 'missing-scope-cache',
  NO_QUALIFYING_SETUP: 'no-qualifying-setup',   // engine extra: passed gates, no pattern status
});
const REJECTION_CODES = Object.freeze(Object.values(REJECT));

const STATUSES = Object.freeze(['selected', 'rejected', 'near-miss', 'control']);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function candidateId({ strategyId, scoringVersion, universeScope, ticker, decisionCutoff, side = 'long', horizon = 'swing' } = {}) {
  for (const [k, v] of Object.entries({ strategyId, scoringVersion, universeScope, ticker, decisionCutoff })) {
    if (!v) throw new Error(`candidateId(): missing required identity field ${k}`);
  }
  return sha([strategyId, scoringVersion, universeScope, String(ticker).toUpperCase(), decisionCutoff, side === 'short' ? 'short' : 'long', horizon].join('|')).slice(0, 24);
}

// Deterministic hash of a candidate SET (parity primitive). Order-independent.
function candidateSetHash(ids) {
  return sha([...(ids || [])].sort().join(','));
}

// Build one immutable observation. Throws on contract violations (an invalid
// observation is a bug, never data). Freezes the result.
function makeObservation({
  strategyId, scoringVersion, universeScope, ticker, decisionCutoff,
  side = 'long', horizon = 'swing',
  status,                     // selected | rejected | near-miss | control
  rejectionCode = null,       // required when status='rejected'
  decisionPrice = null,
  features = null,            // decision-time feature snapshot (pct/quant/factors/metrics)
  missing = [],               // missingness mask — names of absent inputs
  plan = null,                // { entry, stop, target, rr } or null
  rankScore = null, cohortPercentile = null, displayRank = null, displayed = false,
  regime = null, sector = null,
  sourceFreshness = null,     // { lastBarDate, sourceFetchedAt, class }
  modelVersions = null,       // { engineVersion, calibrationVersion, ... }
  evidenceClass = 'RESEARCH',
} = {}) {
  if (!STATUSES.includes(status)) throw new Error(`makeObservation(): invalid status "${status}"`);
  if (status === 'rejected' && !REJECTION_CODES.includes(rejectionCode)) {
    throw new Error(`makeObservation(): rejected requires a canonical rejectionCode (got "${rejectionCode}")`);
  }
  if (status !== 'rejected' && rejectionCode != null) {
    throw new Error('makeObservation(): rejectionCode only belongs on rejected observations');
  }
  const id = candidateId({ strategyId, scoringVersion, universeScope, ticker, decisionCutoff, side, horizon });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    candidateId: id,
    strategyId, scoringVersion, universeScope,
    ticker: String(ticker).toUpperCase(), decisionCutoff, side, horizon,
    status, rejectionCode,
    decisionPrice: Number.isFinite(+decisionPrice) ? +decisionPrice : null,
    features: features || null,
    missing: Object.freeze([...(missing || [])]),
    plan: plan || null,
    rankScore: Number.isFinite(+rankScore) ? +rankScore : null,
    cohortPercentile: Number.isFinite(+cohortPercentile) ? +cohortPercentile : null,
    displayed: !!displayed,
    displayRank: Number.isFinite(+displayRank) ? +displayRank : null,
    regime: regime || null,
    sector: sector || null,
    sourceFreshness: sourceFreshness || null,
    modelVersions: modelVersions || null,
    evidenceClass,
  });
}

module.exports = { SCHEMA_VERSION, REJECT, REJECTION_CODES, STATUSES, candidateId, candidateSetHash, makeObservation };
