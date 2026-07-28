// ═══════════════════════════════════════════════════════════════════════════
// RLT — Relative Leadership Transition: versions, policy, feature flags, store.
//
// RLT finds stocks BEGINNING to outperform (a) the market, (b) their sector,
// (c) comparable peers inside their sector — before the move is obviously
// extended. It is an ATLAS-X expert plus a shadow inventory, NOT another
// disconnected production screener.
//
// Governance identity: strategy id 'rlt', registered shadow/weight-0 in
// lib/strategy-registry.js. Shadow output MUST NOT originate, boost or
// suppress a live trade. Promotion is a human registry flip, never code.
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGY_ID = 'rlt';

// One immutable stamp per layer. Any change to a layer's semantics REQUIRES a
// bump here — governance treats a version change as an evidence reset.
const VERSIONS = Object.freeze({
  config: 'rlt-config-v1',
  universe: 'rlt-universe-v1',        // peer grouping policy
  features: 'rlt-features-v1',        // leadership/path/turnover feature schema
  sectorState: 'rlt-sector-state-v1',
  states: 'rlt-states-v1',            // DISCOVERED..COMPLETED machine
  stageA: 'rlt-stage-a-v1',           // transition-before-invalidation model
  stageB: 'rlt-stage-b-v1',           // trigger acceptance / conditional model
  utility: 'rlt-utility-v1',
  labels: 'rlt-labels-v1',
  scoring: 'rlt-v1',                  // registry scoringVersion
});

// ─── Mode flag ──────────────────────────────────────────────────────────────
// RLT_MODE=off|shadow|enforce, default shadow. `enforce` STILL fails closed:
// live influence additionally requires a valid, current, version-matched
// governance artifact (see rltGate below). Configuration alone can never
// promote the model.
const MODES = Object.freeze(['off', 'shadow', 'enforce']);
const DEFAULT_MODE = 'shadow';

function resolveRltMode(raw = process.env.RLT_MODE) {
  const v = String(raw || '').trim().toLowerCase();
  return MODES.includes(v) ? v : DEFAULT_MODE;
}

// Versions a live artifact must match, field for field. Mirrors the
// premove-flags pattern: mismatch ⇒ artifact invalid ⇒ shadow behavior.
const LIVE_VERSIONS = Object.freeze({
  featureVersion: VERSIONS.features,
  labelVersion: VERSIONS.labels,
  executionPolicyVersion: 'exec-v1',   // lib/execution-policy.js
  universePolicy: VERSIONS.universe,
});

const REQUIRED_ARTIFACT_FIELDS = Object.freeze([
  'kind', 'modelVersion', 'featureVersion', 'labelVersion',
  'executionPolicyVersion', 'universePolicy', 'trainedThrough', 'status',
]);

/** Validate a model/calibration artifact. Never throws; returns {valid, reasons}. */
function validateArtifact(artifact, { liveVersions = LIVE_VERSIONS, kind = null } = {}) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return Object.freeze({ valid: false, reasons: ['no artifact present'] });
  }
  for (const f of REQUIRED_ARTIFACT_FIELDS) {
    if (artifact[f] == null || artifact[f] === '') reasons.push(`missing required field '${f}'`);
  }
  if (kind && artifact.kind !== kind) reasons.push(`kind '${artifact.kind}' does not match required '${kind}'`);
  for (const [f, want] of Object.entries(liveVersions)) {
    if (artifact[f] != null && artifact[f] !== want) reasons.push(`${f} '${artifact[f]}' does not match live '${want}'`);
  }
  if (artifact.status !== 'validated') reasons.push(`status '${artifact.status}' is not 'validated'`);
  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}

// Even a fully-earned promotion starts as a CANARY: the largest live weight an
// enforce-mode, artifact-valid, registry-approved RLT is permitted. Widening it
// is a human registry/config decision, never something evidence accrual does.
const CANARY_CAP = 0.10;

/**
 * The fail-closed gate. mayAffectLive requires ALL THREE of: enforce mode, a
 * valid version-matched artifact, AND the human registry flip to production
 * (strategy-gate statusOf). showProbabilities requires a valid artifact in ANY
 * mode. `enforce` without the artifact or without the registry flip behaves
 * exactly as shadow and says so — an env var plus a hand-written JSON blob must
 * never be a promotion path.
 */
function rltGate({ mode = resolveRltMode(), artifact = null, kind = 'rlt-model', liveVersions = LIVE_VERSIONS, registryStatus } = {}) {
  if (mode === 'off') {
    return Object.freeze({
      version: VERSIONS.config, mode, active: false, artifactValid: false,
      mayAffectLive: false, canaryCap: 0, showProbabilities: false, reasons: Object.freeze(['RLT_MODE=off']),
    });
  }
  // Lazy require: strategy-gate has no rlt imports, but keeping it out of the
  // top-level graph lets pure tests inject registryStatus without the registry.
  const status = registryStatus !== undefined
    ? registryStatus
    : require('./strategy-gate').statusOf('rlt');
  const check = validateArtifact(artifact, { liveVersions, kind });
  const reasons = [...check.reasons];
  if (mode === 'enforce' && !check.valid) {
    reasons.push('enforce requested but artifact invalid — behaving as shadow (fail closed)');
  }
  if (mode === 'enforce' && check.valid && status !== 'production') {
    reasons.push(`enforce requested with a valid artifact but registry maturity is '${status}' — human registry flip required (fail closed)`);
  }
  const mayAffectLive = mode === 'enforce' && check.valid && status === 'production';
  return Object.freeze({
    version: VERSIONS.config, mode, active: true, artifactValid: check.valid,
    registryStatus: status,
    mayAffectLive,
    canaryCap: mayAffectLive ? CANARY_CAP : 0,
    showProbabilities: check.valid,
    reasons: Object.freeze(reasons),
  });
}

// ─── Horizons ───────────────────────────────────────────────────────────────
// Swing-mechanism horizons (sessions). 1-session information is retained only
// as a TRANSITION feature — it never defines a swing trend by itself.
const HORIZONS = Object.freeze([3, 5, 10, 21, 63]);
const STAGE_A_HORIZONS = Object.freeze([5, 10, 21]);

// ─── Peer-universe policy (versioned with VERSIONS.universe) ────────────────
const PEER_POLICY = Object.freeze({
  version: VERSIONS.universe,
  // Primary grouping: sector × liquidity/cap band. Below minPeers the group
  // falls back (labeled) rather than emit a false-precision percentile.
  minPeers: 8,
  // Fallback hierarchy, in order. Every fallback is labeled on the row.
  fallbacks: Object.freeze(['sector-band', 'sector', 'market']),
  // Eligibility (fail closed on each)
  minBars: 40,                 // insufficient candle history
  maxStaleSessions: 2,         // stale bars
  minPrice: 1.0,               // unknown/penny price
  minDollarVol: 2_000_000,     // unknown/thin liquidity
  // Split/bad-bar anomaly guard: a 1-day |raw return| beyond this without
  // volume support marks the row unresolved-anomaly (fail closed).
  anomalyDayMove: 0.75,
});

// ─── Leadership thresholds (versioned with VERSIONS.states) ─────────────────
const LEADERSHIP = Object.freeze({
  version: VERSIONS.states,
  topQuintile: 0.80,           // within-sector percentile for "leader"
  upperTercile: 0.667,         // "entering the upper portion of the peer group"
  medianPct: 0.50,
  minRankVelocity: 0.03,       // per-session percentile velocity for DISCOVERED
  minRankRise10: 0.15,         // 10-session percentile rise for EMERGING_LEADER
  maxExtensionAtr20: 3.0,      // distance above 20d MA in ATR units before "extended"
  maxConsumedMove: 0.85,       // share of expected move already consumed
  armedProximity: 0.02,        // within 2% below trigger ⇒ ARMED candidate
});

// ─── Actionability hurdles (mirror ATLAS-X HURDLES semantics) ───────────────
const HURDLES = Object.freeze({
  minRemainingRR: 1.2,
  minNetUtilityBps: 25,
  maxSevereLossProb: 0.25,
  maxDataStaleSessions: 2,
  minLiquidityDollarVol: 2_000_000,
});

// ─── Calibration display policy ─────────────────────────────────────────────
const CALIBRATION = Object.freeze({
  minSamplesForBands: 30,
  minSamplesForPercent: 200,   // never display % below this AND without a passing artifact
});

// ─── Storage — own namespace so RLT never collides with swing/* or atlasx/* ─
const STORE = Object.freeze({
  ns: 'rlt',
  latest: 'rlt/latest.json',
  episodes: 'rlt/episodes.json',
  board: 'rlt/board.json',
  resolved: 'rlt/resolved.json',
  predictions: 'rlt/predictions.json',
  capture: 'rlt/capture.json',
  health: 'rlt/health.json',
  calibration: 'rlt/calibration.json',
  sectorState: 'rlt/sector-state.json',
  crossSectionPrefix: 'rlt/cross-section/',   // + <date>.json, write-once immutable
  ledgerStream: 'rlt',
});

module.exports = {
  STRATEGY_ID, VERSIONS, MODES, DEFAULT_MODE, resolveRltMode,
  LIVE_VERSIONS, REQUIRED_ARTIFACT_FIELDS, validateArtifact, rltGate, CANARY_CAP,
  HORIZONS, STAGE_A_HORIZONS, PEER_POLICY, LEADERSHIP, HURDLES, CALIBRATION, STORE,
};
