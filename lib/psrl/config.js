'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — Persistent Staircase Relative Leadership: frozen, versioned config.
//
// SHADOW challenger to OMEGA, weight-0 everywhere until the preregistered
// promotion contract passes (see research/PREREGISTRATION-PSRL-2026-08.md).
// Every tunable lives here so a change is a reviewed, versioned diff; nothing
// in lib/psrl/* reads the network, the clock, or the store.
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGY_ID = 'psrl';

const VERSIONS = Object.freeze({
  engine: 'persistent-staircase-relative-leadership-v1',
  features: 'psrl-features-v1',
  score: 'psrl-score-v1',
  arrows: 'psrl-arrows-v1',
  episodes: 'psrl-episodes-v1',
  labels: 'psrl-labels-v1',
  config: 'psrl-config-v1',
});

// Multi-horizon ladder (sessions). 252-session features require ≥253 bars —
// candle-cache docs cap at 300 bars, so 252 support is marginal by design and
// marked unavailable (never imputed) when history is short.
const HORIZONS = Object.freeze([5, 10, 21, 63, 126, 252]);
const RESIDUAL_HORIZONS = Object.freeze([5, 10, 21, 63, 126]);
const CONTINUITY_WINDOWS = Object.freeze([21, 63, 126, 252]);

// Fast / intermediate / slow speed states (addendum §4; in base by design).
const SPEEDS = Object.freeze({
  fast: Object.freeze([5, 10]),
  intermediate: Object.freeze([21, 63]),
  slow: Object.freeze([63, 126]),
});

// ── Eligibility (fail closed; missing data is a downgrade, never neutral) ──
const ELIGIBILITY = Object.freeze({
  version: 'psrl-eligibility-v1',
  minBarsFull: 253,        // full 252-session feature support
  minBarsReduced: 130,     // reduced support: 126-and-shorter horizons only
  minPrice: 3,
  minDollarVol20: 5e6,     // 20-day average dollar volume floor
  maxStaleSessions: 2,     // latest bar must be within 2 sessions of asOf
  splitAnomalyPct: 0.75,   // |1-day move| ≥ 75% ⇒ unresolved corporate action
});

// ── Score weights (versioned with VERSIONS.score; never tuned on holdout) ──
const SCORE_WEIGHTS = Object.freeze({
  combined: Object.freeze({ persistentTrend: 0.40, relativeLeadership: 0.40, setupQuality: 0.20 }),
  relativeLeadership: Object.freeze({
    marketResidualTrend: 0.30,
    sectorResidualTrend: 0.25,
    residualContinuity: 0.20,
    horizonAgreement: 0.15,
    residualAcceleration: 0.10,
  }),
  persistentTrend: Object.freeze({
    multiHorizonTrend: 0.30,
    continuity: 0.25,
    robustFit: 0.15,
    structure: 0.15,   // higher-high / higher-low
    participation: 0.15,
  }),
});

// Independent penalties (points off the 0-100 combined evidence score).
const PENALTIES = Object.freeze({
  jumpPlateau: 30,
  excessiveExtension: 20,
  deterioratingResidual: 20,
  gapDependence: 15,
  adverseExcursion: 20,
  weakParticipation: 10,
  lowBetaSupportHaircut: 0.85,  // multiplicative evidence haircut
});

// ── Hysteresis (arrows/entry states must not flap on one noisy session) ──
const HYSTERESIS = Object.freeze({
  upgradeStreak: 2,          // consecutive qualifying closes for an ordinary upgrade
  downgradeStreak: 2,        // consecutive weak observations for an ordinary downgrade
  minTrajectoryDelta: 5,     // combined-score points before the trajectory arrow moves
  hardInvalidationImmediate: true,
});

// ── Jump / plateau thresholds (versioned with VERSIONS.features) ──
const JUMP = Object.freeze({
  minTop1Share: 0.45,        // concentration floor before "jump" is even considered
  minGapContribution: 0.40,
  plateauMinSessions: 8,     // elapsed sessions post-jump before PLATEAU may be called
  plateauMaxSlope: 0.0,      // post-jump normalized slope at/below this is flat
  retentionFloor: 0.6,       // fraction of the jump retained for HOLDING states
});

// Extension: ATR multiples above SMA20 where penalties engage / max out.
const EXTENSION = Object.freeze({ warnAtr: 3.0, maxAtr: 5.0 });

// ── Blob namespace (day docs keyed by date ⇒ re-runs overwrite themselves) ──
const STORE = Object.freeze({
  prefix: 'psrl/v1/',
  latest: 'psrl/v1/latest.json',
  ledger: 'psrl/v1/ledger.json',
  health: 'psrl/v1/health.json',
  research: 'psrl/v1/research.json',
  dayKey: (date) => `psrl/v1/day/${date}.json`,
});

// Scan bound (disclosed in coverage; liquidity-ranked truncation, no silence).
const SCAN_CAP = 400;

module.exports = {
  STRATEGY_ID, VERSIONS, HORIZONS, RESIDUAL_HORIZONS, CONTINUITY_WINDOWS, SPEEDS,
  ELIGIBILITY, SCORE_WEIGHTS, PENALTIES, HYSTERESIS, JUMP, EXTENSION, STORE, SCAN_CAP,
};
