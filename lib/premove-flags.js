'use strict';
// PRE-MOVE v2 FEATURE FLAGS + ARTIFACT GATES (premove-flags-v1) — the central
// governance switchboard for the pre-move transition redesign
// (docs/premove-transition-v2.md). Mirrors the DECISION_ELIGIBILITY_MODE
// pattern (lib/eligibility.js): a single env-resolved mode plus fail-closed
// artifact validation.
//
//   PREMOVE_V2_MODE:
//     'off'     — legacy behavior everywhere (escape hatch).
//     'shadow'  — DEFAULT. The v2 pipeline (two-pass universe, Stage A/B
//                 scoring, inventory states) runs and is fully observable, but
//                 nothing it produces can originate, boost, or re-rank a
//                 production recommendation.
//     'enforce' — v2 outputs MAY affect live surfaces, but ONLY where a valid,
//                 current, version-matched promotion artifact exists for that
//                 specific model. A configuration change alone can never
//                 promote: enforce WITHOUT a valid artifact behaves as shadow
//                 (fail closed), and the gate says so.
//
// Artifact contract (Stage A / Stage B / calibration / promotion): a stored
// JSON doc must carry { kind, modelVersion, featureVersion, labelVersion,
// executionPolicyVersion, universePolicy, trainedThrough, status }. Any
// missing field, version mismatch against the live pipeline, or stale
// calibration ⇒ the artifact is INVALID and the consumer must behave as if no
// model exists (rank/evidence-band only, never a probability).

const PREMOVE_FLAGS_VERSION = 'premove-flags-v1';
const MODES = Object.freeze(['off', 'shadow', 'enforce']);
const DEFAULT_MODE = 'shadow';

function resolvePremoveMode(raw) {
  const m = String(raw ?? process.env.PREMOVE_V2_MODE ?? '').toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

// The versions the LIVE pipeline currently stamps. An artifact must match all
// of the ones it declares scope over — a schema/label/execution/universe change
// invalidates every calibration built before it (never reused across changes).
const LIVE_VERSIONS = Object.freeze({
  featureVersion: 'premove-features-v1',      // lib/premove-features.js
  labelVersion: 'premove-labels-v1',          // Stage A/B label definitions
  executionPolicyVersion: 'exec-v1',          // lib/execution-policy.js
  universePolicy: 'premove-universe-v2',      // two-pass Pass A/B (lib/atlasx-scan.js)
});

const REQUIRED_ARTIFACT_FIELDS = Object.freeze([
  'kind', 'modelVersion', 'featureVersion', 'labelVersion',
  'executionPolicyVersion', 'universePolicy', 'trainedThrough', 'status',
]);

// Validate one artifact against the live pipeline versions. Fail closed: any
// doubt ⇒ { valid: false, reasons }. Never throws.
function validateArtifact(artifact, { liveVersions = LIVE_VERSIONS, kind = null } = {}) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return { valid: false, reasons: ['no artifact (fail closed: no probability, no live influence)'] };
  }
  for (const f of REQUIRED_ARTIFACT_FIELDS) {
    if (artifact[f] == null) reasons.push(`missing required field '${f}'`);
  }
  if (kind && artifact.kind !== kind) reasons.push(`artifact kind '${artifact.kind}' ≠ expected '${kind}'`);
  for (const key of ['featureVersion', 'labelVersion', 'executionPolicyVersion', 'universePolicy']) {
    if (artifact[key] != null && liveVersions[key] != null && artifact[key] !== liveVersions[key]) {
      reasons.push(`${key} mismatch: artifact '${artifact[key]}' vs live '${liveVersions[key]}' — calibration/model must be rebuilt (fail closed)`);
    }
  }
  if (artifact.status !== 'validated') {
    reasons.push(`status '${artifact.status}' is not 'validated' (fail closed)`);
  }
  return { valid: reasons.length === 0, reasons };
}

// The effective gate a consumer must obey. enforce + invalid artifact ⇒ shadow.
function premoveGate({ mode = null, artifact = null, kind = null, liveVersions = LIVE_VERSIONS } = {}) {
  const resolved = resolvePremoveMode(mode);
  if (resolved === 'off') {
    return Object.freeze({ version: PREMOVE_FLAGS_VERSION, mode: 'off', active: false, mayAffectLive: false, showProbabilities: false, reasons: ['PREMOVE_V2_MODE=off — legacy pipeline'] });
  }
  const check = validateArtifact(artifact, { liveVersions, kind });
  const mayAffectLive = resolved === 'enforce' && check.valid;
  return Object.freeze({
    version: PREMOVE_FLAGS_VERSION,
    mode: resolved,
    active: true,
    artifactValid: check.valid,
    mayAffectLive,
    // Probabilities are displayable only with a VALID calibration-bearing artifact —
    // in any mode. Shadow with a valid artifact may SHOW numbers (labeled shadow)
    // but still cannot affect live output.
    showProbabilities: check.valid,
    reasons: mayAffectLive
      ? ['enforce mode with a valid, current, version-matched artifact']
      : resolved === 'enforce'
        ? ['enforce requested but artifact invalid — BEHAVING AS SHADOW (fail closed)', ...check.reasons]
        : ['shadow mode — observable, weight-zero', ...(check.valid ? [] : check.reasons)],
  });
}

module.exports = {
  PREMOVE_FLAGS_VERSION, MODES, DEFAULT_MODE, LIVE_VERSIONS, REQUIRED_ARTIFACT_FIELDS,
  resolvePremoveMode, validateArtifact, premoveGate,
};
