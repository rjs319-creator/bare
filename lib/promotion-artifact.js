'use strict';
// PROMOTION-ARTIFACT SCHEMA + SEMANTIC VALIDATION (non-daytrade redesign 2026-08, Phase 3).
//
// THE DEFECT THIS CLOSES. gov-v2.1 verified that the required FIELDS were present and
// non-empty. Presence is not evidence: an artifact carrying
// `validationResults: { passed: false }`, `costStress: { passed: false, note: 'fails at 2x' }`
// and `survivorshipStatus: { safe: false }` satisfied every check and promoted the model.
// This module reads the VALUES: a gate is passed only when the artifact says, in machine-
// readable form, that it was passed — and every failure comes back as a code a test or a UI
// can join on, never as prose to be re-parsed.
//
// FAIL CLOSED EVERYWHERE. Unknown, missing, unparseable, contradictory or out-of-range ⇒
// fail. `true` must be the boolean true, not 'true', not 1, not 'yes'.
//
// Pure data + validators. No network, no state, injectable clock.

const ARTIFACT_SCHEMA_VERSION = 'promotion-artifact-v2';

// ── Lifecycle classes (Phase 3 item 6) ──────────────────────────────────────
// A registry `maturity: 'production'` is an OPERATIONAL fact ("this runs live"), never an
// evidence claim. These three classes must stay separable everywhere they are displayed.
const LIFECYCLE_CLASS = Object.freeze({
  LEGACY_OPERATIONAL: 'LEGACY_OPERATIONAL',   // live by history, NOT validated by evidence
  RESEARCH_PROMISING: 'RESEARCH_PROMISING',   // evidence trending positive, not promotable
  VALIDATED_EXECUTABLE: 'VALIDATED_EXECUTABLE', // earned grade + complete, current artifact
});
const LIFECYCLE_META = Object.freeze({
  LEGACY_OPERATIONAL: { label: 'Legacy operational', icon: '🏚', blurb: 'Runs live because it always has — its evidence has NOT cleared the promotion gates. Reduce/hold only; it cannot originate new positions and expires without renewed evidence.' },
  RESEARCH_PROMISING: { label: 'Research (promising)', icon: '🟡', blurb: 'Positive but unproven. Visible, tracked, never sized.' },
  VALIDATED_EXECUTABLE: { label: 'Validated executable', icon: '✅', blurb: 'Earned grade on executable, cost-net, out-of-sample evidence AND a complete, current, human-approved promotion artifact.' },
});

// ── Required fields (superset of docs/model-promotion-policy.md) ────────────
const REQUIRED_FIELDS = Object.freeze([
  'version', 'approve', 'approvedAt', 'approvedBy', 'codeCommit',
  'datasetHash', 'universeHash', 'featureHash',
  'trainingCutoff', 'foldDefinition', 'primaryMetric',
  'validationResults', 'costStress', 'survivorshipStatus', 'calibration', 'tailRisk',
  'prospectiveEvidence', 'negativeControls', 'limitations', 'evidenceHash', 'expiresAt',
]);

// Version fields that must ALL match the strategy's current identity. A promotion approved
// against a different label/execution/benchmark contract is an approval of a different
// experiment (see lib/evidence-identity.js).
const IDENTITY_FIELDS = Object.freeze(['version', 'labelVersion', 'executionPolicyVersion', 'benchmarkVersion']);

// Statistical floors the artifact must ASSERT and satisfy.
const MIN_SAMPLE = 50;              // resolved executable episodes
const MIN_EFFECTIVE_SAMPLE = 20;    // dependence-adjusted effective sample size
const MIN_POSITIVE_BLOCKS = 3;      // independent chronological/regime blocks
const MAX_ARTIFACT_AGE_DAYS = 120;  // an approval older than this is stale even if unexpired

const isTrue = (v) => v === true;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const parseTs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

const problem = (code, detail, field = null) => ({ code, field, detail });

// Validate ONE artifact against a strategy identity. Returns [] when promotable.
//   identity — { version, labelVersion, executionPolicyVersion, benchmarkVersion }
//              (only the fields the caller knows are enforced; a KNOWN mismatch fails)
//   opts     — { nowMs, evidenceHash, requiresProbability, requiresProspective }
function validateArtifact(artifact, identity = {}, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const problems = [];
  if (!artifact || typeof artifact !== 'object') return [problem('MISSING_ARTIFACT', 'no promotion artifact on record')];
  if (artifact.revoked === true) problems.push(problem('REVOKED', 'the artifact is explicitly revoked', 'revoked'));

  // 1. Structural completeness.
  for (const f of REQUIRED_FIELDS) {
    const v = artifact[f];
    if (v === undefined || v === null || v === '') problems.push(problem('MISSING_FIELD', `missing required field '${f}'`, f));
  }

  // 2. Explicit human approval (the boolean, not a truthy string).
  if ('approve' in artifact && !isTrue(artifact.approve)) {
    problems.push(problem('NOT_APPROVED', `approve must be boolean true (got ${JSON.stringify(artifact.approve)})`, 'approve'));
  }
  if (artifact.approvedBy && typeof artifact.approvedBy !== 'string') {
    problems.push(problem('BAD_APPROVER', 'approvedBy must name the approving human', 'approvedBy'));
  }

  // 3. Identity: every KNOWN version axis must match exactly.
  for (const f of IDENTITY_FIELDS) {
    const want = identity[f];
    if (want == null) continue;                       // caller does not track this axis
    const got = artifact[f];
    if (got == null) { problems.push(problem('IDENTITY_UNSTATED', `artifact does not state '${f}' (current ${want}) — evidence identity unprovable`, f)); continue; }
    if (got !== want) problems.push(problem('IDENTITY_MISMATCH', `${f} mismatch (artifact ${got} vs current ${want}) — the approval is for a different experiment`, f));
  }

  // 4. Evidence binding: the approval must be about the evidence we hold now.
  if (opts.evidenceHash && artifact.evidenceHash && artifact.evidenceHash !== opts.evidenceHash) {
    problems.push(problem('EVIDENCE_HASH_MISMATCH', 'evidenceHash does not match the current Scoreboard evidence — the approval was judged on different evidence', 'evidenceHash'));
  }

  // 5. Timestamps: parseable, ordered, unexpired, not stale.
  const approvedAt = artifact.approvedAt ? parseTs(artifact.approvedAt) : null;
  if (artifact.approvedAt && approvedAt == null) problems.push(problem('BAD_TIMESTAMP', 'approvedAt is not a parseable timestamp', 'approvedAt'));
  const expiresAt = artifact.expiresAt ? parseTs(artifact.expiresAt) : null;
  if (artifact.expiresAt && expiresAt == null) problems.push(problem('BAD_TIMESTAMP', 'expiresAt is not a parseable timestamp', 'expiresAt'));
  if (expiresAt != null && expiresAt <= nowMs) problems.push(problem('EXPIRED', `the approval expired at ${artifact.expiresAt}`, 'expiresAt'));
  if (approvedAt != null && expiresAt != null && expiresAt <= approvedAt) problems.push(problem('BAD_WINDOW', 'expiresAt is not after approvedAt', 'expiresAt'));
  if (approvedAt != null && (nowMs - approvedAt) > MAX_ARTIFACT_AGE_DAYS * 86400_000) {
    problems.push(problem('STALE_APPROVAL', `the approval is older than ${MAX_ARTIFACT_AGE_DAYS} days — renewal requires an explicit re-review`, 'approvedAt'));
  }
  const cutoff = artifact.trainingCutoff ? parseTs(artifact.trainingCutoff) : null;
  if (artifact.trainingCutoff && cutoff == null) problems.push(problem('BAD_TIMESTAMP', 'trainingCutoff is not a parseable timestamp', 'trainingCutoff'));
  if (cutoff != null && approvedAt != null && cutoff > approvedAt) problems.push(problem('BAD_WINDOW', 'trainingCutoff is AFTER the approval — the evaluation could not have been out-of-sample', 'trainingCutoff'));

  // 6. SEMANTIC gates — the values, not the keys.
  const vr = artifact.validationResults;
  if (vr && typeof vr === 'object') {
    if (!isTrue(vr.passed)) problems.push(problem('VALIDATION_FAILED', `validationResults.passed is ${JSON.stringify(vr.passed)} — the validation did not pass`, 'validationResults.passed'));
    if (!isNum(vr.sampleSize) || vr.sampleSize < MIN_SAMPLE) problems.push(problem('SAMPLE_TOO_SMALL', `sampleSize ${vr.sampleSize} < required ${MIN_SAMPLE}`, 'validationResults.sampleSize'));
    if (!isNum(vr.effectiveSampleSize) || vr.effectiveSampleSize < MIN_EFFECTIVE_SAMPLE) {
      problems.push(problem('EFFECTIVE_SAMPLE_TOO_SMALL', `effectiveSampleSize ${vr.effectiveSampleSize} < required ${MIN_EFFECTIVE_SAMPLE} (correlated observations are not independent evidence)`, 'validationResults.effectiveSampleSize'));
    }
    if (!isNum(vr.positiveBlocks) || vr.positiveBlocks < MIN_POSITIVE_BLOCKS) {
      problems.push(problem('BLOCK_STABILITY_FAILED', `only ${vr.positiveBlocks} positive chronological/regime blocks (need ≥${MIN_POSITIVE_BLOCKS})`, 'validationResults.positiveBlocks'));
    }
    if (!isTrue(vr.multipleTestingCorrected)) {
      problems.push(problem('NO_MULTIPLE_TESTING_CORRECTION', 'validationResults.multipleTestingCorrected is not true — the result is not corrected across attempted hypotheses', 'validationResults.multipleTestingCorrected'));
    }
    if (isNum(vr.correctedPValue) && isNum(vr.alpha) && vr.correctedPValue > vr.alpha) {
      problems.push(problem('NOT_SIGNIFICANT', `corrected p-value ${vr.correctedPValue} > alpha ${vr.alpha}`, 'validationResults.correctedPValue'));
    }
    if (vr.ci95 && (!isNum(vr.ci95.lo) || vr.ci95.lo <= 0)) {
      problems.push(problem('CI_INCLUDES_ZERO', `the 95% interval [${vr.ci95.lo}, ${vr.ci95.hi}] does not exclude zero`, 'validationResults.ci95'));
    }
  }

  const cs = artifact.costStress;
  if (cs && typeof cs === 'object') {
    if (!isTrue(cs.passed)) problems.push(problem('COST_STRESS_FAILED', `costStress.passed is ${JSON.stringify(cs.passed)} — the edge does not survive its own cost assumptions`, 'costStress.passed'));
    if ('doubledCostNet' in cs && isNum(cs.doubledCostNet) && cs.doubledCostNet <= 0) {
      problems.push(problem('COST_STRESS_FAILED', `doubled-cost net result ${cs.doubledCostNet} is not positive`, 'costStress.doubledCostNet'));
    }
    if ('stressedCostNet' in cs && isNum(cs.stressedCostNet) && cs.stressedCostNet <= 0) {
      problems.push(problem('COST_STRESS_FAILED', `stressed-cost net result ${cs.stressedCostNet} is not positive`, 'costStress.stressedCostNet'));
    }
  }

  const ss = artifact.survivorshipStatus;
  if (ss && typeof ss === 'object' && !isTrue(ss.safe)) {
    problems.push(problem('SURVIVORSHIP_UNSAFE', `survivorshipStatus.safe is ${JSON.stringify(ss.safe)} — a survivorship-unsafe study can never promote (hard blocker, docs/model-promotion-policy.md)`, 'survivorshipStatus.safe'));
  }

  // NEGATIVE CONTROLS (graduation-league F-11). The adversarial battery existed
  // (shuffled labels, placebo dates, frozen-inverse, orbit-controls, prosecutor) but
  // the human promotion path never required it — cost stress, survivorship and
  // multiple testing were mandatory, falsification was not. An artifact must now
  // assert, in machine-readable form, that its negative controls RAN and PASSED
  // (i.e. the controls came back null — a "signal" that survives label shuffling is
  // leakage, not alpha). Fail closed on absence, non-boolean, or an empty battery.
  const nc = artifact.negativeControls;
  if (nc !== undefined && nc !== null && nc !== '') {
    if (typeof nc !== 'object') {
      problems.push(problem('NEGATIVE_CONTROLS_MISSING', 'negativeControls must be an object { passed, controls: [...] }', 'negativeControls'));
    } else {
      if (!isTrue(nc.passed)) {
        problems.push(problem('NEGATIVE_CONTROLS_FAILED', `negativeControls.passed is ${JSON.stringify(nc.passed)} — falsification must run and come back clean before a promotion`, 'negativeControls.passed'));
      }
      const controls = Array.isArray(nc.controls) ? nc.controls : [];
      if (!controls.length) {
        problems.push(problem('NEGATIVE_CONTROLS_FAILED', 'negativeControls.controls names no controls — an empty battery is not a passed battery', 'negativeControls.controls'));
      } else {
        for (const c of controls) {
          if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !isTrue(c.passed)) {
            problems.push(problem('NEGATIVE_CONTROLS_FAILED', `control ${JSON.stringify(c && c.name)} did not record a boolean-true pass`, 'negativeControls.controls'));
            break;
          }
        }
      }
    }
  }

  // Calibration is required only when the strategy DISPLAYS probabilities.
  const cal = artifact.calibration;
  if (opts.requiresProbability) {
    if (!cal || typeof cal !== 'object' || !isTrue(cal.passed)) {
      problems.push(problem('CALIBRATION_FAILED', 'this strategy displays probabilities, so an out-of-fold calibration PASS is required', 'calibration.passed'));
    }
  } else if (cal && typeof cal === 'object' && cal.passed === false && isTrue(cal.required)) {
    problems.push(problem('CALIBRATION_FAILED', 'calibration is declared required and did not pass', 'calibration.passed'));
  }

  if (opts.requiresProspective !== false) {
    const pe = artifact.prospectiveEvidence;
    if (!pe || typeof pe !== 'object' || !isTrue(pe.passed)) {
      problems.push(problem('NO_PROSPECTIVE_EVIDENCE', 'prospective (paper/shadow) validation has not passed — retrospective evidence alone cannot promote', 'prospectiveEvidence.passed'));
    } else if (isNum(pe.episodes) && pe.episodes < MIN_EFFECTIVE_SAMPLE) {
      problems.push(problem('PROSPECTIVE_TOO_THIN', `only ${pe.episodes} prospective episodes (need ≥${MIN_EFFECTIVE_SAMPLE})`, 'prospectiveEvidence.episodes'));
    }
  }

  // 7. Unresolved data-quality blockers veto regardless of statistics.
  const blockers = Array.isArray(artifact.dataQualityBlockers) ? artifact.dataQualityBlockers.filter(b => b && b.resolved !== true) : [];
  if (blockers.length) {
    problems.push(problem('DATA_QUALITY_BLOCKER', `${blockers.length} unresolved data-quality blocker(s): ${blockers.map(b => b.id || b.note || 'unnamed').join(', ')}`, 'dataQualityBlockers'));
  }
  return problems;
}

function isPromotable(artifact, identity, opts) {
  return validateArtifact(artifact, identity, opts).length === 0;
}

// Which lifecycle class a strategy is in. Kept deliberately separate from the registry's
// operational `maturity` so a static status can never be RENDERED as earned validation.
//   graded   — lib/maturity gradeStrategy() result
//   artifact — its promotion artifact (or null)
function lifecycleClassOf(graded, artifact, identity, opts = {}) {
  const grade = (graded && graded.grade) || 'experimental';
  if (grade === 'validated' && isPromotable(artifact, identity, opts)) return LIFECYCLE_CLASS.VALIDATED_EXECUTABLE;
  if (opts.staticStatus === 'production') return LIFECYCLE_CLASS.LEGACY_OPERATIONAL;
  if (grade === 'validated' || grade === 'promising') return LIFECYCLE_CLASS.RESEARCH_PROMISING;
  return LIFECYCLE_CLASS.RESEARCH_PROMISING;
}

module.exports = {
  ARTIFACT_SCHEMA_VERSION, REQUIRED_FIELDS, IDENTITY_FIELDS,
  MIN_SAMPLE, MIN_EFFECTIVE_SAMPLE, MIN_POSITIVE_BLOCKS, MAX_ARTIFACT_AGE_DAYS,
  LIFECYCLE_CLASS, LIFECYCLE_META,
  validateArtifact, isPromotable, lifecycleClassOf,
};
