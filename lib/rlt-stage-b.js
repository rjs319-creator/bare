// ═══════════════════════════════════════════════════════════════════════════
// RLT Stage B — trigger + acceptance (rlt-stage-b-v1).
//
// Stage B begins ONLY after an objectively defined trigger. The trigger
// evaluation, executable-fill separation, barrier probabilities
// (model-estimate, uncalibrated) and the expected-utility waterfall are
// REUSED from lib/premove-stage-b — one trigger/acceptance engine, not two.
//
// RLT adds on top:
//   • distinct TRIGGER FAMILIES whose outcomes are never pooled without an
//     explicit setup-family control;
//   • sector-residual confirmation recorded alongside (never averaged into)
//     the trigger evidence;
//   • the trigger/fill event taxonomy kept as separate events.
//
// Execution assumptions come from lib/execution-policy (exec-v1): next-session
// entry, gap-through at the worse open, no-fill honest, same-bar ambiguity
// resolves to the stop.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS } = require('./rlt-config');
const PB = require('./premove-stage-b');

// Trigger families — outcomes are recorded per family, never pooled blindly.
const TRIGGER_FAMILIES = Object.freeze([
  'breakout-acceptance',
  'first-pullback',
  'pivot-reclaim',
  'tight-range-continuation',
]);

// Event taxonomy kept separate end-to-end (never collapsed into win/loss):
const TRIGGER_EVENTS = Object.freeze([
  'trigger', 'executable-fill', 'no-fill', 'gap-through-rejection',
  'target-before-stop', 'stop-before-target', 'timeout',
]);

/**
 * Classify which family a candidate's trigger context belongs to.
 * Deterministic and objective — the family is part of the immutable record.
 */
function triggerFamilyFor({ setup = null, leadership = null } = {}) {
  if (!setup || setup.pivot == null) return null;
  const brokeRecently = setup.breakoutAttempts != null && setup.breakoutAttempts > 0
    && setup.distanceToPivotAtr != null && setup.distanceToPivotAtr < 0;
  if (brokeRecently && setup.pullbackDepthOk !== false
    && setup.consumedRangePosition != null && setup.consumedRangePosition < 0.7) {
    return 'first-pullback';
  }
  if (setup.compressionPctile != null && setup.compressionPctile >= 0.7
    && setup.compressionDuration != null && setup.compressionDuration >= 3) {
    return 'tight-range-continuation';
  }
  if (setup.breakoutRejections != null && setup.breakoutRejections >= 2) {
    return 'pivot-reclaim';
  }
  return 'breakout-acceptance';
}

/**
 * Evaluate the objective trigger for one bar against a level.
 * Delegates to the shared engine; annotates the family and the
 * sector-residual confirmation as SEPARATE fields.
 */
function evaluateRltTrigger({ bar, level, base, family = null, sectorResidual5 = null } = {}) {
  const t = PB.evaluateTrigger({ bar, level, base });
  return Object.freeze({
    ...t,
    rltVersion: VERSIONS.stageB,
    family: family || 'breakout-acceptance',
    // Confirmation evidence recorded alongside — NOT folded into `triggered`.
    sectorResidualConfirm: Number.isFinite(sectorResidual5) ? sectorResidual5 > 0 : null,
  });
}

/**
 * Stage-B assessment: given the trigger occurred and was executable, what is
 * the conditional outlook? Wraps the shared assessStageB and stamps RLT
 * versioning + family. All probability fields remain 'model-estimate'
 * (driftless barrier model) until a validated calibration artifact exists.
 */
function assessRltStageB(p = {}) {
  const base = PB.assessStageB(p);
  return Object.freeze({
    ...base,
    rltVersion: VERSIONS.stageB,
    family: (p.trigger && p.trigger.family) || null,
    familyControl: 'outcomes recorded per trigger family; cross-family pooling requires explicit controls',
  });
}

module.exports = {
  STAGE_B_VERSION: VERSIONS.stageB,
  TRIGGER_FAMILIES, TRIGGER_EVENTS,
  triggerFamilyFor, evaluateRltTrigger, assessRltStageB,
  utilityWaterfall: PB.utilityWaterfall,
  TRIGGER_RULES: PB.TRIGGER_RULES,
};
