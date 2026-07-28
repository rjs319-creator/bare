// ═══════════════════════════════════════════════════════════════════════════
// RLT governance — health, promotion view, shadow invariant, redundancy.
//
// Mirrors lib/atlasx-governance.js. Nothing here promotes anything: promotion
// requires an explicit, reviewable registry maturity flip by a human.
// Automatic DEMOTION signals are permitted; automatic promotion is prohibited.
// ═══════════════════════════════════════════════════════════════════════════

const { statusOf } = require('./strategy-gate');
const { VERSIONS, HURDLES } = require('./rlt-config');

const STRATEGY_ID = 'rlt';

// Redundancy: RLT's evidence overlaps these existing detectors. Raw momentum,
// SPY-relative momentum, sector-relative momentum, peer rank and trend are NOT
// five independent confirmations — they share the stock's own price path.
const REDUNDANCY_OVERLAPS = Object.freeze([
  'momentum', 'breakout (screener)', 'ghost', 'coil',
  'atlasx residual momentum', 'sector rotation (informational)',
]);

// The registered causal hypothesis and bars — the reviewable contract.
const REGISTRATION = Object.freeze({
  strategyId: STRATEGY_ID,
  hypothesis: 'Stocks entering the top of their sector peer group on residual (market- and sector-adjusted) returns, with accelerating rank, constructive path and confirmed participation, continue outperforming over 5–21 sessions more often than peers — BEFORE the move is obviously extended.',
  horizons: [5, 10, 21],
  featureFamilies: ['leadership', 'path-quality', 'turnover-interaction', 'absorption-proxy (experimental)', 'setup-extension', 'sector-state'],
  dataProviders: ['candle-cache (Yahoo daily)', 'universe static sector map (present-day, NOT point-in-time — labeled limitation)'],
  targets: 'Stage A: competing-risk up-trigger vs invalidation vs timeout (lead-time v2 labels). Stage B: target-before-stop conditional on verified executable fill (exec-v1).',
  executionPolicy: 'exec-v1',
  evidenceState: 'shadow — no out-of-sample edge demonstrated yet',
  shadowWeight: 0,
  promotionBar: 'see PROMOTION_GATE',
  demotionBar: 'automatic demotion signals: drift, calibration failure, incomplete data, realized-cost erosion',
  knownLimitations: [
    'sector metadata is present-day (no validFrom/validTo) — survivorship/reclassification unsafe for backtests',
    'expanded-universe names have no sector — market-only shadow observations',
    'absorption features are OHLCV proxies, not institutional flow',
    'GBM/GAM/Bayesian challengers blocked: dependency-free runtime (external blocker, recorded not faked)',
  ],
  ownerModules: ['lib/rlt-*.js'],
  storageArtifacts: ['rlt/latest.json', 'rlt/episodes.json', 'rlt/resolved.json', 'rlt/predictions.json', 'rlt/capture.json', 'rlt/sector-state.json', 'rlt/cross-section/<date>.json', 'ledger/rlt/*'],
  gradingRoute: 'op=rltresolve',
  redundancyOverlaps: REDUNDANCY_OVERLAPS,
});

const PROMOTION_GATE = Object.freeze({
  minIndependentDates: 60,
  minRegimes: 2,
  requiresPositiveCostNetResidual: true,
  requiresConservativeLowerBoundAboveZero: true,
  requiresAcceptableOofCalibration: true,
  requiresBeatsSimpleBaselines: true,          // rank level, rank accel, residual momentum
  requiresBeatsCurrentBaselines: true,         // Coil, Ghost, ATLAS-X
  requiresIncrementalAfterRedundancy: true,
  requiresCostAndDelayRobustness: true,
  requiresNoCatastrophicSubgroup: true,
  requiresUntouchedConfirmation: true,
  requiresProspectiveConsistency: true,
  requiresLiveFunnelParity: true,
});

/** Descriptive health over accumulated shadow evidence. NEVER promotes. */
function modelHealth(metrics = {}) {
  const n = metrics.resolvedEpisodes ?? 0;
  if (n < 10) return { state: 'INSUFFICIENT_DATA', reasons: [`only ${n} resolved episodes`] };
  if (n < 30) return { state: 'BUILDING', reasons: [`${n} resolved episodes — below verdict minimum`] };
  const broken = [];
  if (Number.isFinite(metrics.rankIC) && metrics.rankIC < 0) broken.push('negative rank IC');
  if (Number.isFinite(metrics.calibrationError) && metrics.calibrationError > 0.25) broken.push('calibration badly off');
  if (broken.length) return { state: 'BROKEN', reasons: broken };
  const degrading = [];
  if (Number.isFinite(metrics.rankIC) && metrics.rankIC < 0.03) degrading.push('rank IC near zero');
  if (Number.isFinite(metrics.netUtility) && metrics.netUtility <= 0) degrading.push('cost-net utility non-positive');
  if (Number.isFinite(metrics.calibrationError) && metrics.calibrationError > 0.12) degrading.push('calibration drifting');
  if (Number.isFinite(metrics.featureDrift) && metrics.featureDrift > 0.3) degrading.push('feature drift');
  if (Number.isFinite(metrics.dataFreshSessions) && metrics.dataFreshSessions > HURDLES.maxDataStaleSessions) degrading.push('stale data');
  if (degrading.length) return { state: 'DEGRADING', reasons: degrading };
  return { state: 'HEALTHY', reasons: [] };
}

/** Fail-closed promotion view: eligible ONLY when every criterion is met. */
function promotionView(evidence = {}) {
  const checks = Object.entries(PROMOTION_GATE).map(([k, want]) => {
    const have = evidence[k];
    const met = want === true ? have === true : Number.isFinite(have) && have >= want;
    return { criterion: k, required: want, observed: have ?? null, met };
  });
  return Object.freeze({
    version: VERSIONS.config,
    eligible: checks.every(c => c.met),
    checks: Object.freeze(checks),
    note: 'promotion requires an explicit, reviewable registry maturity flip — code never auto-promotes',
  });
}

/** Invariant: RLT must never be registered production. Throws when violated. */
function assertShadow() {
  const status = statusOf(STRATEGY_ID);
  if (status === 'production') {
    throw new Error('RLT invariant violated: registered production but must be shadow/weight-0');
  }
  return status;
}

module.exports = {
  STRATEGY_ID, REGISTRATION, PROMOTION_GATE, REDUNDANCY_OVERLAPS,
  modelHealth, promotionView, assertShadow,
};
