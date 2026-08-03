'use strict';
// CANONICAL PATTERN OBJECT (pattern-v2) — the one schema every surface reads.
//
// v2 honesty upgrades:
//   • `plan.action` uses the position-aware vocabulary (actions.js) — never BUY/SELL.
//   • `technicalStatus` (what the chart did) and `recommendationEligibility` (whether the
//     family has validated edge) are separate top-level blocks, never blended.
//   • `probability` is null unless a calibrated artifact backs it, with the reason stated.
//   • `structural` carries featureCoverage / missingRequiredFeatures / validity so the
//     expert view can show exactly why a label was assigned.
//   • Versioned: schema/model/feature versions ride on every object; episode linkage via
//     episodeId/episodeKey when one exists.

const MODEL_VERSION = 'pattern-edge-v2';
const FEATURE_VERSION = 'pattern-features-v2';
const ANALOG_INDEX_VERSION = 'pattern-analogs-v1';
const SCHEMA_VERSION = 'pattern-v2';

const isNum = v => typeof v === 'number' && isFinite(v);
const money = v => (isNum(v) ? `$${v.toFixed(2)}` : '—');

// Assemble the canonical object from the stage outputs.
function buildPatternPrediction({ ticker, detection, decision, prediction = null, analog = null, context = {}, freshness = null, now, displayRank = null, episode = null }) {
  const sim = detection.similarity || {};
  const plan = detection.plan || {};
  const reasonCodes = buildReasonCodes(detection, decision, prediction, analog);
  const calibrated = !!(prediction && prediction.calibrated === true);

  return {
    schemaVersion: SCHEMA_VERSION,
    ticker,
    direction: detection.direction,
    patternFamily: detection.family,
    patternLabel: detection.label,
    phase: detection.phase,
    timeframe: detection.timeframe,
    horizon: detection.horizon || null,
    detectedAt: now,
    detectedPrice: detection.geometry ? detection.geometry.lastClose : null,
    currentPrice: detection.currentPrice ?? (detection.geometry ? detection.geometry.lastClose : null),
    patternStart: detection.patternStart,
    patternAsOf: detection.patternAsOf,
    episodeId: episode ? episode.episodeId : null,
    episodeKey: episode ? episode.key : null,
    episodeState: episode ? episode.state : (decision ? decision.state : null),

    structural: detection.structural ? {
      validity: detection.structural.validity,
      pass: detection.structural.pass,
      featureCoverage: detection.structural.featureCoverage,
      requiredFeatures: detection.structural.requiredFeatures,
      missingRequiredFeatures: detection.structural.missingRequiredFeatures,
      violatedFeatures: detection.structural.violatedFeatures || [],
      perFeature: detection.structural.perFeature,
    } : null,
    pivotsUsed: detection.pivotsUsed || [],
    measurements: detection.measurements || {},

    similarity: {
      pathCorrelation: sim.pathCorrelation ?? null,
      geometrySimilarity: sim.geometrySimilarity ?? null,
      dtwSimilarity: sim.dtwSimilarity ?? null,
      volumeSimilarity: sim.volumeSimilarity ?? null,
      contextSimilarity: sim.contextSimilarity ?? null,
      embeddingSimilarity: null,          // learned-shape channel — not implemented (honest null)
      combined: sim.combined ?? null,
      matchTier: sim.matchTier || 'NONE',
      calibratedThreshold: sim.calibratedThreshold === true,
      note: 'similarity is descriptive shape agreement, NOT a probability and NOT the ranking basis',
    },

    confirmation: detection.confirmation || null,
    technicalStatus: decision ? decision.technicalStatus : null,
    recommendationEligibility: decision ? decision.recommendationEligibility : null,

    analogs: analog ? {
      rawCount: analog.rawCount ?? 0,
      effectiveSampleSize: analog.effectiveSampleSize ?? 0,
      resolvedCount: analog.resolvedCount ?? 0,
      sufficient: analog.sufficient === true,
      note: 'analog sufficiency is sample size only — it can never mark a family proven',
      successExamples: analog.successExamples || [],
      failureExamples: analog.failureExamples || [],
    } : { rawCount: 0, effectiveSampleSize: 0, resolvedCount: 0, sufficient: false, successExamples: [], failureExamples: [] },

    // Honest probability contract: null unless calibrated, and the UI must say why.
    probability: calibrated && prediction ? prediction.probability ?? null : null,
    probabilityNote: prediction && prediction.available
      ? (calibrated ? prediction.probabilityNote : 'No calibrated probability — this family has not passed leakage-safe validation.')
      : 'No probability — no model output for this setup.',

    prediction: prediction && prediction.available ? {
      modelEstimateOnly: !calibrated,
      targetBeforeStop: prediction.targetBeforeStop,
      stopBeforeTarget: prediction.stopBeforeTarget,
      timeout: prediction.timeout,
      expectedNetReturnPct: prediction.expectedNetReturnPct,
      failureProbability: prediction.failureProbability,
      baselineTargetFirst: prediction.baselineTargetFirst,
      incrementalLift: prediction.incrementalLift,
      confidenceInterval: prediction.confidenceInterval,
      effectiveSampleSize: prediction.effectiveSampleSize,
      calibrated,
      calibrationStatus: prediction.calibrationStatus,
    } : { available: false, calibrated: false, note: prediction ? prediction.reason : 'insufficient-data' },

    context: {
      marketRegime: context.marketRegime || 'UNKNOWN',
      sectorRegime: context.sectorRegime || 'UNKNOWN',
      relativeStrength: context.relativeStrength || 'UNKNOWN',
      liquidity: context.liquidity || 'UNKNOWN',
      volPercentile: context.volPercentile ?? null,
    },

    plan: {
      action: decision.action,
      trigger: plan.trigger ?? null,
      stop: plan.stop ?? null,
      target: plan.target ?? null,
      rewardRisk: plan.rr ?? null,
      quality: plan.quality || null,
      triggerType: plan.triggerType || null,
      invalidationType: plan.invalidationType || null,
      targetMethod: plan.targetMethod || null,
      timeStop: detection.timeStop || null,
      planAsOf: now,
    },

    freshness: freshness || null,
    lifecycleState: decision.lifecycleState,
    thesisValid: decision.thesisValid,
    planValid: decision.planValid,
    currentSessionFresh: decision.currentSessionFresh,
    executionIntent: decision.executionIntent || 'none',
    proven: decision.proven === true,
    reasonCodes,
    noviceExplanation: noviceExplanation(detection, decision, plan),
    expertExplanation: expertExplanation(detection, prediction, analog),
    displayRank,
    modelVersion: MODEL_VERSION,
    featureVersion: FEATURE_VERSION,
    analogIndexVersion: ANALOG_INDEX_VERSION,
  };
}

function buildReasonCodes(detection, decision, prediction, analog) {
  const codes = [];
  if (detection.invalidationHit) codes.push('INVALIDATION_HIT');
  if (decision && !decision.freshEnough) codes.push('NOT_FRESH');
  if (decision && decision.action === 'RESEARCH_ONLY') codes.push('UNPROVEN_EDGE');
  if (decision && decision.action === 'AVOID' && detection.plan && detection.plan.quality === 'poor') codes.push('POOR_REWARD_RISK');
  if (detection.structural && detection.structural.missingRequiredFeatures && detection.structural.missingRequiredFeatures.length) codes.push('MISSING_REQUIRED_FEATURES');
  if (analog && !analog.sufficient) codes.push('INSUFFICIENT_ANALOGS');
  if (prediction && prediction.available && !prediction.calibrated) codes.push('MODEL_ESTIMATE_ONLY');
  if (detection.similarity && detection.similarity.calibratedThreshold === false) codes.push('DESCRIPTIVE_MATCH_TIER');
  return codes;
}

// Plain-English novice card. Uses the position-aware novice line from the decision, plus
// the structural invalidation in dollars.
function noviceExplanation(detection, decision, plan) {
  const dir = detection.direction === 'SHORT' ? 'a bearish structure' : 'a bullish structure';
  const inval = isNum(plan.stop)
    ? `It is wrong ${detection.direction === 'SHORT' ? 'above' : 'below'} ${money(plan.stop)}.`
    : (detection.invalidation || '');
  return `${detection.label} — ${dir} on the ${detection.timeframe} view. ${decision.noviceAction || ''} ${inval}`.replace(/\s+/g, ' ').trim();
}

function expertExplanation(detection, prediction, analog) {
  const sim = detection.similarity || {};
  const st = detection.structural || {};
  const pct = v => (isNum(v) ? `${(v * 100).toFixed(0)}%` : '—');
  const bits = [
    `structural validity=${st.validity ?? '—'} coverage=${st.featureCoverage ?? '—'}${st.missingRequiredFeatures && st.missingRequiredFeatures.length ? ` MISSING:${st.missingRequiredFeatures.join(',')}` : ''}`,
    `descriptive sim=${sim.combined ?? '—'} (path=${sim.pathCorrelation ?? '—'}, geom=${sim.geometrySimilarity ?? '—'}, vol=${sim.volumeSimilarity ?? '—'})`,
    detection.plan ? `plan ${detection.plan.triggerType || ''}@${detection.plan.trigger} stop@${detection.plan.stop} tgt@${detection.plan.target} (${detection.plan.targetMethod || ''}) RR=${detection.plan.rr} [${detection.plan.quality}]` : 'no plan',
    prediction && prediction.available ? `barrier(model-estimate): tgtFirst=${pct(prediction.targetBeforeStop)}, timeout=${pct(prediction.timeout)} (${prediction.calibrationStatus})` : 'no barrier estimate',
    analog ? `analogs: effN=${analog.effectiveSampleSize}, resolved=${analog.resolvedCount}, calibrated=${analog.calibrated === true}` : 'no analogs',
  ].filter(Boolean);
  return bits.join(' | ');
}

module.exports = {
  buildPatternPrediction, noviceExplanation, expertExplanation, buildReasonCodes,
  MODEL_VERSION, FEATURE_VERSION, ANALOG_INDEX_VERSION, SCHEMA_VERSION,
};
