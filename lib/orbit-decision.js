// ORBIT decision layer (orbit-decision-v1) — turns per-horizon model + calibration
// + scenario outputs into the versioned ORBIT prediction contract and a
// classification. SHADOW-ONLY, always: every prediction carries shadow:true,
// affectsLiveRank:false, deploymentWeight:0. It never mutates its inputs.
//
// Classifications:
//   ORBIT_EARLY      strongest, qualifying at the 5-day horizon
//   ORBIT_SWING      strongest, qualifying at the 21-day horizon
//   ORBIT_COMPOUNDER strongest, qualifying at the 63-day horizon
//   ORBIT_ALIGNED    qualifies across ALL horizons (evidence AND, not a product of
//                    dependent probabilities)
//   WATCH            some positive evidence but a qualifier fails
//   ABSTAIN          gate failure, no calibrated support, or negative net edge
//
// A candidate qualifies at a horizon only when it is CALIBRATED, its scenario-worst
// robustUp clears the hurdle, expected net return is positive after costs, and
// severe-loss probability is acceptable. ORBIT may return zero picks.

const DECISION_VERSION = 'orbit-decision-v1';

const CLASSES = Object.freeze(['ORBIT_EARLY', 'ORBIT_SWING', 'ORBIT_COMPOUNDER', 'ORBIT_ALIGNED', 'WATCH', 'ABSTAIN']);

const DEFAULT_HURDLES = Object.freeze({
  robustUp: 0.52,        // scenario-worst calibrated P(up) must clear this
  severeMax: 0.35,       // reject if severe-loss probability exceeds this
  minExpectedNet: 0,     // expected net return must be positive after costs
});

const HORIZON_KEYS = Object.freeze(['days5', 'days21', 'days63']);
const HORIZON_CLASS = Object.freeze({ days5: 'ORBIT_EARLY', days21: 'ORBIT_SWING', days63: 'ORBIT_COMPOUNDER' });

function horizonQualifies(h, hurdles) {
  if (!h || !h.calibrated) return false;
  if (h.robustUp == null || h.robustUp < hurdles.robustUp) return false;
  if (h.expectedNet == null || h.expectedNet <= hurdles.minExpectedNet) return false;
  if (h.severe != null && h.severe > hurdles.severeMax) return false;
  return true;
}

// Decide one candidate. `input.horizons[h]` = { rawUp, residualUp, robustUp,
// lowerBound, upperBound, pUpper, pLower, pTimeout, expectedNet, severe, calibrated }.
function decideCandidate(input, opts = {}) {
  const hurdles = { ...DEFAULT_HURDLES, ...(input.hurdles || opts.hurdles || {}) };
  const gates = input.gates || {};
  const rejectionReasons = [];
  const warnings = [];

  // Hard gates → ABSTAIN.
  if (gates.dataQualityOk === false) rejectionReasons.push('data-quality-failed');
  if (gates.liquidityOk === false) rejectionReasons.push('liquidity-failed');
  if (gates.regimeVeto === true) rejectionReasons.push('regime-veto');
  if (gates.moveConsumed === true) rejectionReasons.push('move-already-consumed');
  if (gates.incrementalOk === false) rejectionReasons.push('no-incremental-information');
  if (input.sufficient === false) rejectionReasons.push('insufficient-features-or-state');

  const horizons = input.horizons || {};
  const anyCalibrated = HORIZON_KEYS.some(k => horizons[k] && horizons[k].calibrated);
  if (!anyCalibrated) rejectionReasons.push('insufficient-out-of-fold-calibration');

  const qualifying = HORIZON_KEYS.filter(k => horizonQualifies(horizons[k], hurdles));

  let classification, confidence = 0, state = 'shadow';
  if (rejectionReasons.length || !qualifying.length) {
    classification = anyPositiveEvidence(horizons, hurdles) && !hardGate(rejectionReasons) ? 'WATCH' : 'ABSTAIN';
    if (classification === 'ABSTAIN' && !rejectionReasons.length) rejectionReasons.push('no-qualifying-horizon');
  } else if (qualifying.length === HORIZON_KEYS.length) {
    classification = 'ORBIT_ALIGNED';
    confidence = mean(qualifying.map(k => horizons[k].robustUp));
  } else {
    // Strongest qualifying horizon by robustUp.
    const best = qualifying.reduce((a, b) => (horizons[b].robustUp > horizons[a].robustUp ? b : a));
    classification = HORIZON_CLASS[best];
    confidence = horizons[best].robustUp;
  }

  // Warnings (non-blocking).
  if (input.latentState && input.latentState.changeProbability != null && input.latentState.changeProbability > 0.7) warnings.push('recent-state-change');
  for (const k of HORIZON_KEYS) if (horizons[k] && !horizons[k].calibrated) warnings.push(`uncalibrated-${k}`);
  if (input.scenario && input.scenario.uncertainty != null && input.scenario.uncertainty > 0.9) warnings.push('high-scenario-uncertainty');

  return {
    predictionId: input.predictionId || null,
    ticker: input.ticker, securityId: input.securityId || null,
    decisionTs: input.decisionTs || null, dataCutoffTs: input.dataCutoffTs || null,
    eligibleEntryTs: input.eligibleEntryTs || null, universeSnapshotId: input.universeSnapshotId || null,
    ...(input.versions || {}),
    horizonProbabilities: buildHorizonProbabilities(horizons),
    expectedGrossReturn: mapH(horizons, h => h.expectedGross ?? null),
    expectedNetReturn: mapH(horizons, h => h.expectedNet ?? null),
    expectedResidualReturn: mapH(horizons, h => h.expectedResidual ?? null),
    expectedMAE: mapH(horizons, h => h.expectedMAE ?? null),
    severeLossProbability: pickSevere(horizons),
    latentState: input.latentState || null,
    marketScenarios: input.scenario || null,
    classification,
    confidence: +(+confidence).toFixed(4),
    topDrivers: input.topDrivers || [],
    warnings: [...new Set(warnings)],
    state,
    rejectionReasons,
    researchValidity: input.researchValidity || { productionGrade: false, survivorshipSafe: false, reason: 'shadow research output' },
    shadow: true, affectsLiveRank: false, deploymentWeight: 0, governanceStatus: 'paper',
  };
}

function hardGate(reasons) {
  return reasons.some(r => ['data-quality-failed', 'liquidity-failed', 'regime-veto', 'move-already-consumed', 'no-incremental-information', 'insufficient-features-or-state'].includes(r));
}
function anyPositiveEvidence(horizons, hurdles) {
  return HORIZON_KEYS.some(k => { const h = horizons[k]; return h && h.calibrated && h.robustUp != null && h.robustUp >= hurdles.robustUp * 0.9; });
}
function buildHorizonProbabilities(horizons) {
  return mapH(horizons, h => ({
    rawUp: h.calibrated ? nn(h.rawUp) : null,
    residualUp: h.calibrated ? nn(h.residualUp) : null,
    robustUp: h.calibrated ? nn(h.robustUp) : null,
    lowerBound: h.calibrated ? nn(h.lowerBound) : null,
    upperBound: h.calibrated ? nn(h.upperBound) : null,
    pUpperBarrier: nn(h.pUpper), pLowerBarrier: nn(h.pLower), pTimeout: nn(h.pTimeout),
    uncalibratedRankScore: nn(h.rankScore),
  }));
}
function pickSevere(horizons) { const v = HORIZON_KEYS.map(k => horizons[k] && horizons[k].severe).filter(x => x != null); return v.length ? Math.max(...v) : null; }
function mapH(horizons, fn) { const o = {}; for (const k of HORIZON_KEYS) o[k] = horizons[k] ? fn(horizons[k]) : null; return o; }
function nn(x) { return (x == null || Number.isNaN(x)) ? null : x; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

module.exports = { DECISION_VERSION, CLASSES, DEFAULT_HURDLES, HORIZON_KEYS, horizonQualifies, decideCandidate };
