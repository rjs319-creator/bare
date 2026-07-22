'use strict';
// OMEGA-SWING CANONICAL RESEARCH CONTRACT (omega-contract-v1) — Phase 1 / Phase 2.
//
// One versioned, immutable, self-describing record for EVERY OMEGA observation, whether it
// was produced live (prospective) or reconstructed from history. The point is that training,
// backtesting, the Scoreboard, and the live UI can never silently disagree about what an
// OMEGA pick WAS: its provenance, the funnel it came through, the exact executable fill it
// assumes, and the versions of every component that produced it.
//
// Design rules honored here:
//   • Immutable — every factory returns a frozen NEW object; no in-place mutation.
//   • Honest by omission — provenance is REQUIRED (no default to "live"); research validity
//     defaults to NOT production-grade; a missing benchmark/fill is null, never a fake number.
//   • Separate signal price from executable fill — `signalReferencePrice` (the signal-day
//     close OMEGA was computed from) and `assumedFillPrice`/`assumedFillDate` (the earliest
//     tradeable fill) are DISTINCT fields. The old single `entry` that conflated them is gone.
//   • The causal guarantee — a fill may not precede/equal the signal close unless it is an
//     explicitly pre-committed market-on-close order.
//
// Pure & dependency-free (no network, no clock, no store). Timestamps come from the caller.

const { researchValidity } = require('./research/schemas');

const OMEGA_CONTRACT_VERSION = 'omega-contract-v1';

// ── PROVENANCE ────────────────────────────────────────────────────────────────────────────
// Only PROSPECTIVE_LIVE (and explicitly-approved PAPER_TRADE) records may contribute to the
// DISPLAYED live track record. Reconstructed history may inform research but is always shown
// separately and can never earn "validated"/"production" status on its own.
const PROVENANCE = Object.freeze({
  PROSPECTIVE_LIVE: 'prospective_live',
  HISTORICAL_RECONSTRUCTION: 'historical_reconstruction',
  PAPER_TRADE: 'paper_trade',
  MIGRATED_LEGACY: 'migrated_legacy',
  SYNTHETIC_TEST: 'synthetic_test',
});
const PROVENANCE_SET = new Set(Object.values(PROVENANCE));
// The only provenances that may feed the displayed live track record.
const LIVE_TRACK_PROVENANCE = new Set([PROVENANCE.PROSPECTIVE_LIVE, PROVENANCE.PAPER_TRADE]);
const contributesToLiveTrack = (prov) => LIVE_TRACK_PROVENANCE.has(prov);

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const orNull = (v) => (v === undefined ? null : v);

// ── OMEGA observation ──────────────────────────────────────────────────────────────────────
// A superset of the canonical research Prediction, specialized to OMEGA's candidate funnel,
// setup state machine, executable entry policy, and residual-return labels.
function makeOmegaObservation(input = {}) {
  return Object.freeze({
    schema: 'OmegaObservation', version: OMEGA_CONTRACT_VERSION,
    // identity & versions
    observationId: orNull(input.observationId),
    strategyId: input.strategyId || 'omega',
    strategyVersion: orNull(input.strategyVersion),
    featureVersion: orNull(input.featureVersion),
    modelVersion: orNull(input.modelVersion),
    calibrationVersion: orNull(input.calibrationVersion),
    executionPolicyVersion: orNull(input.executionPolicyVersion),
    costModelVersion: orNull(input.costModelVersion),
    // timing
    signalDate: orNull(input.signalDate),
    featureCutoffTs: orNull(input.featureCutoffTs),      // regular-session close on the signal day
    earliestExecutableTs: orNull(input.earliestExecutableTs), // next tradeable session
    // security identity — ticker is time-varying; securityId (when known) is permanent
    ticker: orNull(input.ticker),
    securityId: orNull(input.securityId),
    // candidate funnel provenance (Phase 4)
    candidateSource: orNull(input.candidateSource),       // source screener family/id
    sourceStrategyVersion: orNull(input.sourceStrategyVersion),
    sourceRawScore: orNull(input.sourceRawScore),
    sourcePercentile: orNull(input.sourcePercentile),     // within-strategy percentile
    sourceRank: orNull(input.sourceRank),
    universeSnapshotId: orNull(input.universeSnapshotId),
    marketBenchmarkId: orNull(input.marketBenchmarkId),
    sectorBenchmarkId: orNull(input.sectorBenchmarkId),
    regime: orNull(input.regime),
    historicalLiveParity: input.historicalLiveParity === undefined ? null : !!input.historicalLiveParity,
    survivorshipSafe: input.survivorshipSafe === undefined ? null : !!input.survivorshipSafe,
    // features
    featureVector: Object.freeze({ ...(input.featureVector || {}) }),
    featureQualityFlags: Object.freeze([...(input.featureQualityFlags || [])]),
    // OMEGA outputs
    omegaScore: orNull(input.omegaScore),
    tier: orNull(input.tier),
    setup: orNull(input.setup),
    setupState: orNull(input.setupState),
    stage: orNull(input.stage),
    // executable entry — signal price and assumed fill are DISTINCT (never conflated)
    entryPolicy: orNull(input.entryPolicy),
    entryTrigger: orNull(input.entryTrigger),
    executableState: orNull(input.executableState),
    signalReferencePrice: orNull(input.signalReferencePrice),   // signal-day close (NOT a fill)
    assumedFillPrice: orNull(input.assumedFillPrice),           // earliest tradeable fill
    assumedFillDate: orNull(input.assumedFillDate),
    fillStatus: orNull(input.fillStatus),                       // filled | unfilled | pending
    noFillReason: orNull(input.noFillReason),
    stop: orNull(input.stop),
    target1: orNull(input.target1),
    target2: orNull(input.target2),
    maxAcceptableEntryPrice: orNull(input.maxAcceptableEntryPrice),
    maxAcceptableGapPct: orNull(input.maxAcceptableGapPct),
    // model / probability outputs (may be a transparent baseline — calibrationMaturity says which)
    modelOutputs: Object.freeze({ ...(input.modelOutputs || {}) }),
    calibrationMaturity: orNull(input.calibrationMaturity),     // see calibration-maturity.js
    // provenance & lineage (Phase 2)
    provenance: orNull(input.provenance),
    episodeId: orNull(input.episodeId),
    // labels / outcomes
    labelEndDates: Object.freeze({ ...(input.labelEndDates || {}) }),
    outcomes: Object.freeze({ ...(input.outcomes || {}) }),
    researchValidity: researchValidity(input.researchValidity || {}),
    generatedAt: orNull(input.generatedAt),
  });
}

// A resolved record's causal + provenance guarantees. Fail CLOSED: unknown provenance, or a
// fill that is not strictly after the signal close (barring a pre-committed MOC), is invalid.
function validateOmegaObservation(r) {
  const filled = r && r.fillStatus === 'filled';
  const moc = r && r.entryPolicy === 'MARKET_ON_CLOSE_PRECOMMITTED';
  const errors = [];
  const req = (ok, msg) => { if (!ok) errors.push(msg); };
  req(isObj(r), 'not an object');
  req(isStr(r && r.provenance) && PROVENANCE_SET.has(r.provenance), 'provenance must be a known PROVENANCE value');
  req(isStr(r && r.signalDate), 'signalDate is required');
  req(isStr(r && r.ticker), 'ticker is required');
  // Causal guarantee: no same-close fill unless a pre-committed MOC order.
  req(!filled || moc || (isStr(r.assumedFillDate) && r.assumedFillDate > r.signalDate),
    'a filled non-MOC observation must fill strictly AFTER the signal date (no same-close fill)');
  req(!filled || isNum(r.assumedFillPrice), 'a filled observation must have a numeric assumedFillPrice');
  return { valid: errors.length === 0, errors };
}

// Deterministic observation id from (provenance, strategyVersion, signalDate, ticker, episode).
function observationId({ provenance, strategyVersion, signalDate, ticker, episodeId }) {
  return [provenance || 'p', strategyVersion || 'v', signalDate || 'd', ticker || 't', episodeId || 'e']
    .map(x => String(x).replace(/[^A-Za-z0-9._-]/g, '_')).join(':');
}

module.exports = {
  OMEGA_CONTRACT_VERSION, PROVENANCE, PROVENANCE_SET, LIVE_TRACK_PROVENANCE, contributesToLiveTrack,
  makeOmegaObservation, validateOmegaObservation, observationId,
};
