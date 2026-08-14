'use strict';
// CATALYST–FLOW — VERSIONED PREDICTION ARTIFACT.
//
// The ONLY thing the serving layer reads. The trainer writes it offline; a request never
// trains, never loads LightGBM, and never recomputes a rank. If the artifact is missing,
// stale, malformed, or was produced by a code/data version this build does not recognise,
// serving reports that state — it does not fall back to a live calculation, because a
// fallback ranking that looks like the model's is worse than no ranking at all.
//
// The artifact carries its own honesty: which arm produced it, whether the evidence behind
// it was point-in-time or reconstructed, the signed-options coverage, the trial count the
// model was selected from, and the code/data hashes. A reader that has the artifact has
// everything needed to know how much to believe it.
//
// Pure module: no network, no clock, no fs. Callers inject `now`.

const { ARTIFACT_VERSION, CATALYST_FLOW_VERSION, ARMS } = require('./config');
const { REGISTRY_VERSION } = require('./registry');
const { payloadHash } = require('./schema');

const MAX_ARTIFACT_AGE_SESSIONS = 3;   // older than this and the artifact is STALE, not "latest"

// Build an artifact from a completed offline run. Everything here is descriptive — this
// function computes no ranking, it records one.
function buildArtifact({
  decisionDate, generatedAt, arm, modelMeta = {}, ranks = [],
  dataQuality = {}, explanations = {}, trainingCutoff = null,
  codeHash = null, dataHash = null, trialCount = null,
  pitClass = 'RECONSTRUCTED_EXPLORATORY', optionsSignedCoverage = false,
  mode = 'shadow', calibration = null, notes = [],
}) {
  const doc = {
    schema: ARTIFACT_VERSION,
    engineVersion: CATALYST_FLOW_VERSION,
    featureRegistryVersion: REGISTRY_VERSION,
    decisionDate,
    generatedAt,
    arm,
    mode,
    // Ranks are ORDINAL. `score` is a LambdaMART relevance score, not a return and not a
    // probability; the field names say so, and the UI is required to repeat it.
    ranks: ranks.map((r, i) => ({
      rank: i + 1,
      symbol: String(r.symbol || '').toUpperCase(),
      score: Number.isFinite(r.score) ? r.score : null,
      scoreMeaning: 'ordinal-lambdamart-relevance',
      sector: r.sector || null,
      estimatedEdge: Number.isFinite(r.estimatedEdge) ? r.estimatedEdge : null,
      estRoundTripCostPct: Number.isFinite(r.estRoundTripCostPct) ? r.estRoundTripCostPct : null,
      missingFeatureShare: Number.isFinite(r.missingFeatureShare) ? r.missingFeatureShare : null,
      topContributors: Array.isArray(r.topContributors) ? r.topContributors.slice(0, 5) : [],
    })),
    modelMeta: {
      objective: modelMeta.objective || null,
      metric: modelMeta.metric || null,
      ndcgEvalAt: modelMeta.ndcgEvalAt || null,
      params: modelMeta.params || null,
      featureSchema: modelMeta.featureSchema || null,
      trainingCutoff,
      trialCount,
      ...modelMeta,
    },
    // Everything a reader needs to discount the numbers appropriately.
    dataQuality: {
      pitClass,
      promotionEligible: pitClass === 'IMMUTABLE_PIT',
      optionsSignedCoverage,
      ...dataQuality,
    },
    calibration,          // null unless a purged out-of-fold calibrator was genuinely fit
    explanations,
    codeHash, dataHash,
    notes: [...notes],
  };
  doc.artifactHash = payloadHash(doc);
  return doc;
}

// Validate an artifact before it is allowed to drive anything. Returns { ok, errors, doc }.
function validateArtifact(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['artifact is not an object'] };
  if (doc.schema !== ARTIFACT_VERSION) errors.push(`schema must be ${ARTIFACT_VERSION}, got ${doc.schema}`);
  if (!doc.decisionDate || !/^\d{4}-\d{2}-\d{2}$/.test(doc.decisionDate)) errors.push('decisionDate must be YYYY-MM-DD');
  if (!ARMS.includes(doc.arm)) errors.push(`arm must be one of ${ARMS.join(', ')}`);
  if (!Array.isArray(doc.ranks)) errors.push('ranks must be an array');
  if (!doc.dataQuality || typeof doc.dataQuality !== 'object') errors.push('dataQuality is required');

  if (Array.isArray(doc.ranks)) {
    const seen = new Set();
    doc.ranks.forEach((r, i) => {
      if (!r.symbol) errors.push(`rank ${i + 1} has no symbol`);
      if (seen.has(r.symbol)) errors.push(`duplicate symbol ${r.symbol}`);
      seen.add(r.symbol);
      if (r.rank !== i + 1) errors.push(`rank field out of order at index ${i}`);
      // A score presented as a probability or a return would be the single most
      // misleading thing this artifact could carry.
      if (r.scoreMeaning !== 'ordinal-lambdamart-relevance') errors.push(`rank ${i + 1} does not declare its score as ordinal`);
    });
  }
  // An artifact claiming signed-options coverage from the E3 arm must say which provider.
  if (doc.arm === 'E3_CATALYST_FLOW_RANKER' && doc.dataQuality && doc.dataQuality.optionsSignedCoverage !== true) {
    errors.push('E3 artifact without signed-options coverage — the arm was not measurable');
  }
  return { ok: errors.length === 0, errors };
}

// Freshness, in SESSIONS rather than calendar days — a Monday artifact is not stale on
// Tuesday just because a weekend elapsed.
function freshness(doc, { sessions, today, maxAgeSessions = MAX_ARTIFACT_AGE_SESSIONS }) {
  if (!doc || !doc.decisionDate) return { fresh: false, ageSessions: null, reason: 'no-artifact' };
  const idxOf = (iso) => {
    let lo = 0, hi = sessions.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (sessions[m] <= iso) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  const a = idxOf(doc.decisionDate), t = idxOf(today);
  if (a < 0 || t < 0) return { fresh: false, ageSessions: null, reason: 'date-off-session-axis' };
  const age = t - a;
  return { fresh: age <= maxAgeSessions, ageSessions: age, reason: age <= maxAgeSessions ? null : 'stale' };
}

module.exports = { ARTIFACT_VERSION, MAX_ARTIFACT_AGE_SESSIONS, buildArtifact, validateArtifact, freshness };
