// ═══════════════════════════════════════════════════════════════════════════
// RLT expected utility + abstention (rlt-utility-v1).
//
// Outputs stay SEPARATE — marketResidualStrength, sectorResidualStrength,
// withinSectorPercentile, leadershipAcceleration, transitionRank,
// pTriggerBeforeInvalidation, pFillGivenTrigger, pTargetBeforeStopGivenFill,
// expectedNetRGivenFill, severeLossProbability, remainingOpportunity,
// expectedNetUtility, uncertainty, calibrationStatus — never one confidence
// number. The waterfall itself is computed by the shared utilityWaterfall
// (premove-stage-b) inside Stage B.
//
// The system is ALLOWED to produce no picks: abstention with reasons is a
// first-class outcome, not a failure.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, HURDLES } = require('./rlt-config');
const { STATES } = require('./rlt-states');

const ABSTAIN = Object.freeze({
  NO_TRIGGER: 'no valid trigger exists — watch only',
  NO_FILL: 'fill unrealistic (gap beyond max entry / not executable)',
  INSUFFICIENT_REWARD: 'remaining reward after costs below hurdle',
  STALE_DATA: 'data stale beyond tolerance (fail closed)',
  THIN_LIQUIDITY: 'liquidity below governed floor',
  NO_ARTIFACT: 'model artifact missing or incompatible (fail closed)',
  UNCERTAIN: 'conservative uncertainty band does not clear the hurdle',
  SEVERE_LOSS: 'severe-loss probability exceeds governed limit',
  MOVE_CONSUMED: 'move excessively consumed — remaining opportunity insufficient',
  INVALIDATED: 'episode invalidated',
  SHADOW: 'shadow strategy — may never originate a live trade (weight 0)',
});

/**
 * The actionability decision for ONE candidate. Fail-closed: every reason to
 * abstain is collected; a candidate is actionable only when NONE apply AND the
 * governance gate explicitly permits live influence (it never does in shadow).
 */
function decideRlt({
  state = null, stageB = null, leadership = null, features = null,
  stageARow = null, gate = null, staleSessions = null, dollarVol = null,
} = {}) {
  const reasons = [];

  if (state === STATES.INVALIDATED) reasons.push(ABSTAIN.INVALIDATED);
  if (state !== STATES.TRIGGERED && state !== STATES.ACCEPTED) reasons.push(ABSTAIN.NO_TRIGGER);
  if (stageB && stageB.state === 'NO_FILL') reasons.push(ABSTAIN.NO_FILL);
  if (staleSessions != null && staleSessions > HURDLES.maxDataStaleSessions) reasons.push(ABSTAIN.STALE_DATA);
  if (dollarVol != null && dollarVol < HURDLES.minLiquidityDollarVol) reasons.push(ABSTAIN.THIN_LIQUIDITY);

  const setup = features ? features.setup : null;
  if (setup && setup.remainingRR != null && setup.remainingRR < HURDLES.minRemainingRR) {
    reasons.push(ABSTAIN.INSUFFICIENT_REWARD);
  }
  if (setup && setup.consumedRangePosition != null && setup.consumedRangePosition > 0.9
    && (setup.remainingRR == null || setup.remainingRR < HURDLES.minRemainingRR)) {
    reasons.push(ABSTAIN.MOVE_CONSUMED);
  }

  const probs = stageB && stageB.probabilities ? stageB.probabilities : null;
  if (probs && Number.isFinite(probs.severeLossProbability)
    && probs.severeLossProbability > HURDLES.maxSevereLossProb) {
    reasons.push(ABSTAIN.SEVERE_LOSS);
  }
  const netBps = stageB && stageB.waterfall ? stageB.waterfall.expectedNetUtilityBps : null;
  if (netBps != null && netBps < HURDLES.minNetUtilityBps) reasons.push(ABSTAIN.INSUFFICIENT_REWARD);

  // Uncertainty: percentile standard error must not swallow the leadership signal.
  if (leadership && leadership.pctile != null && leadership.pctileUncertainty != null
    && leadership.pctile - 2 * leadership.pctileUncertainty < 0.5) {
    reasons.push(ABSTAIN.UNCERTAIN);
  }

  if (!gate || !gate.mayAffectLive) reasons.push(ABSTAIN.SHADOW);
  if (gate && gate.mode === 'enforce' && !gate.artifactValid) reasons.push(ABSTAIN.NO_ARTIFACT);

  const unique = [...new Set(reasons)];
  const ph10 = leadership && leadership.byHorizon ? leadership.byHorizon[10] : null;
  return Object.freeze({
    version: VERSIONS.utility,
    action: unique.length === 0 ? 'ACTIONABLE_CANDIDATE' : 'ABSTAIN',
    abstainReasons: Object.freeze(unique),
    // The separate, named outputs (never collapsed):
    outputs: Object.freeze({
      marketResidualStrength: ph10 ? ph10.marketResidual : null,
      sectorResidualStrength: ph10 ? ph10.sectorResidual : null,
      withinSectorPercentile: leadership ? leadership.pctile : null,
      leadershipAcceleration: leadership ? leadership.rankAccel : null,
      transitionRank: stageARow ? stageARow.transitionRank : null,
      pTriggerBeforeInvalidation: stageARow ? stageARow.pTriggerBeforeInvalidation : null,
      pFillGivenTrigger: probs ? probs.pFillGivenTrigger : null,
      pTargetBeforeStopGivenFill: probs ? probs.pTargetBeforeStopGivenFill : null,
      expectedNetRGivenFill: probs ? probs.expectedNetRGivenFill : null,
      severeLossProbability: probs ? probs.severeLossProbability : null,
      remainingOpportunity: stageB ? stageB.remainingOpportunity : null,
      expectedNetUtilityBps: netBps,
      uncertainty: leadership ? leadership.pctileUncertainty : null,
      calibrationStatus: stageARow ? stageARow.calibrationStatus : 'unavailable',
    }),
    waterfall: stageB ? stageB.waterfall : null,
  });
}

module.exports = { decideRlt, ABSTAIN, HURDLES };
