'use strict';
// CFL — COUNTERFACTUAL OPPORTUNITY & FORECASTABILITY LAB · versioned configuration.
//
// Every threshold the Lab uses lives HERE, frozen and versioned, so an opportunity
// label or a failure attribution can always be traced to the exact definition that
// produced it. Changing a definition means bumping the version, never silently
// re-labeling history. Pure data — no network, no store.
//
// Design notes:
//  · Barriers are VOLATILITY-ADJUSTED: multiples of the decision-time ATR% (a
//    fact available at the decision timestamp), never fixed percentages, so a
//    +15% bar on a 60%-vol biotech and a 12%-vol staple are not the same claim.
//  · The intraday horizon is DELEGATED, not faked: EOD candles cannot support
//    sub-day path labels, and the day-trade lane already runs a real miss audit
//    (lib/large-mover-audit.js). CFL refuses to fabricate intraday paths.

const CFL_VERSION = 'cfl-v1';
const LABEL_VERSION = 'cfl-label-v1';
const ATTRIBUTION_VERSION = 'cfl-attribution-v1';
const FORECASTABILITY_VERSION = 'cfl-forecastability-v1';

// Opportunity horizons. `sessions` = trading sessions from the decision session.
// kUp/kDown: barrier distances as multiples of decision-time ATR% (per-session
// volatility scaled by sqrt(horizon) — a standard diffusion scaling).
// bigMoveAtr: forward MFE (in ATR%·sqrt(sessions) units) above which a move
// counts as a "significant opportunity" for the missed-winner sweep.
const HORIZONS = Object.freeze({
  intraday: Object.freeze({
    key: 'intraday', sessions: 0, dataSupport: 'delegated',
    delegatedTo: 'large-mover-audit',
    note: 'Sub-day paths need intraday bars; the day-trade lane audits these (op=largemoveraudit). CFL will not fabricate intraday labels from daily candles.',
  }),
  h5: Object.freeze({ key: 'h5', sessions: 5, dataSupport: 'full', kUp: 1.6, kDown: 1.0, bigMoveAtr: 2.0 }),
  h21: Object.freeze({ key: 'h21', sessions: 21, dataSupport: 'full', kUp: 1.8, kDown: 1.1, bigMoveAtr: 2.2 }),
  h63: Object.freeze({ key: 'h63', sessions: 63, dataSupport: 'full', kUp: 2.0, kDown: 1.2, bigMoveAtr: 2.4 }),
});
const SUPPORTED_HORIZONS = Object.freeze(['h5', 'h21', 'h63']);

// Barrier fallbacks when ATR% is unavailable at the decision (reported, never silent).
const FALLBACK_ATR_PCT = 2.0;          // % per session — median large-cap ATR
const MIN_BARRIER_UP_PCT = 2.0;        // floors so barriers never collapse to noise
const MIN_BARRIER_DOWN_PCT = 1.25;

// Cross-sectional opportunity definitions.
const CROSS_SECTION = Object.freeze({
  topPercentile: 0.90,            // residual-return rank at/above this = cross-sectional winner
  largestWinnerCount: 10,         // "one of the period's largest liquid winners"
  minDollarVol: 3_000_000,        // liquid enough for the executability claim
  gapDominantShare: 0.60,         // >60% of the move earned overnight ⇒ gap-dominant
  minGapPctForClass: 3.0,         // below this an overnight gap is 'minor'
});

// Detection / warning-time definitions.
const DETECTION = Object.freeze({
  moveFractions: Object.freeze([0.25, 0.5, 0.75]),  // "detected before X% of the move"
  lateDetectionFraction: 0.5,     // first detection after 50% of the final MFE ⇒ LATE_DETECTION
  generatedStatuses: Object.freeze(['selected', 'near-miss']),  // engine surfaced it
});

// Duds: what counts as stagnation / severe loss on a graded pick.
const DUDS = Object.freeze({
  stagnantAbsPct: 3.0,            // |closing return| below this with neither barrier ⇒ STAGNATION
  immediateFailureSessions: 3,    // stop hit within N sessions of entry ⇒ IMMEDIATE_FAILURE
  failedBreakoutMfeFrac: 0.5,     // reached ≥50% of the way to target, then stopped ⇒ FAILED_BREAKOUT
  severeLossMult: 1.5,            // realized loss ≥1.5× the planned stop distance ⇒ SEVERE_LOSS_MODEL_FAILURE
  exhaustionPreRunPct: 25,        // entry after a ≥25% 21-session run-up that then fails ⇒ EXHAUSTED_MOVE
  marketReversalPct: -5,          // SPY move over the hold worse than this ⇒ MARKET_REVERSAL evidence
  sectorReversalPct: -7,          // sector proxy move worse than this ⇒ SECTOR_REVERSAL evidence
  catalystGapAgainstPct: -5,      // overnight gap against the position ⇒ CATALYST_REVERSAL evidence
});

// Forecastability scoring (evidence-based; see lib/cfl/forecastability.js).
const FORECASTABILITY = Object.freeze({
  minAnalogues: 30,               // resolved comparable observations below this ⇒ thin evidence
  strongAnalogues: 150,
  minCalibrationBinN: 40,         // calibration-bin support below this ⇒ no displayed probability
  oodZ: 3.0,                      // |z| vs cohort distribution beyond this ⇒ OUT_OF_DISTRIBUTION
  staleClasses: Object.freeze(['stale', 'ahead-of-benchmark', 'future-dated', 'missing']),
  actionableScore: 70,
  watchScore: 45,
  wilsonZ: 1.645,
});

// Reconstruction sweep bounds (serverless-safe).
const SWEEP = Object.freeze({
  checkpointStepSessions: 5,      // one checkpoint per 5 benchmark sessions
  traceCheckpoints: 6,            // checkpoints of rank history kept per episode trace
  deadlineMs: 45_000,             // in-route wall budget (under the 60s/300s walls)
  maxEpisodesPerDay: 700,         // per (scope,horizon,date) doc cap — fits the ~515-name large scope; reported when hit
  maxMissedPerDay: 60,            // attributed missed-winner records kept per day doc
});

module.exports = {
  CFL_VERSION, LABEL_VERSION, ATTRIBUTION_VERSION, FORECASTABILITY_VERSION,
  HORIZONS, SUPPORTED_HORIZONS,
  FALLBACK_ATR_PCT, MIN_BARRIER_UP_PCT, MIN_BARRIER_DOWN_PCT,
  CROSS_SECTION, DETECTION, DUDS, FORECASTABILITY, SWEEP,
};
