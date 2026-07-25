// CANONICAL PATTERN PREDICTION — the one schema every surface reads.
//
// Adapts the prompt's canonical shape to repo conventions (camelCase, version strings,
// separated similarity vs prediction, honest null-when-unknown). Also produces the layered
// novice/expert explanations so the UI never has to invent prose.

const MODEL_VERSION = 'pattern-edge-v1';
const FEATURE_VERSION = 'pattern-features-v1';
const ANALOG_INDEX_VERSION = 'pattern-analogs-v1';
const SCHEMA_VERSION = 'pattern-v1';

const isNum = v => typeof v === 'number' && isFinite(v);
const pct = v => (isNum(v) ? `${(v * 100).toFixed(0)}%` : '—');
const money = v => (isNum(v) ? `$${v.toFixed(2)}` : '—');

// Assemble the canonical object from the stage outputs.
function buildPatternPrediction({ ticker, detection, decision, prediction = null, analog = null, context = {}, freshness = null, now, displayRank = null }) {
  const sim = detection.similarity || {};
  const plan = detection.plan || {};
  const reasonCodes = buildReasonCodes(detection, decision, prediction, analog);

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

    similarity: {
      pathCorrelation: sim.pathCorrelation ?? null,
      geometrySimilarity: sim.geometrySimilarity ?? null,
      dtwSimilarity: sim.dtwSimilarity ?? null,
      volumeSimilarity: sim.volumeSimilarity ?? null,
      contextSimilarity: sim.contextSimilarity ?? null,
      embeddingSimilarity: null,      // learned-shape channel — not implemented in v1 (honest null)
      combined: sim.combined ?? null,
      matchTier: sim.matchTier || 'NONE',
      calibratedThreshold: sim.calibratedThreshold === true,
      note: 'similarity is descriptive shape agreement, NOT a probability',
    },

    analogs: analog ? {
      rawCount: analog.rawCount ?? 0,
      effectiveSampleSize: analog.effectiveSampleSize ?? 0,
      resolvedCount: analog.resolvedCount ?? 0,
      sufficient: analog.sufficient === true,
      successExamples: analog.successExamples || [],
      failureExamples: analog.failureExamples || [],
    } : { rawCount: 0, effectiveSampleSize: 0, resolvedCount: 0, sufficient: false, successExamples: [], failureExamples: [] },

    prediction: prediction && prediction.available ? {
      targetBeforeStop: prediction.targetBeforeStop,
      stopBeforeTarget: prediction.stopBeforeTarget,
      timeout: prediction.timeout,
      expectedNetReturnPct: prediction.expectedNetReturnPct,
      failureProbability: prediction.failureProbability,
      baselineTargetFirst: prediction.baselineTargetFirst,
      incrementalLift: prediction.incrementalLift,
      confidenceInterval: prediction.confidenceInterval,
      effectiveSampleSize: prediction.effectiveSampleSize,
      calibrated: prediction.calibrated === true,
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
      timeStop: detection.timeStop || null,
      planAsOf: now,
    },

    freshness: freshness || null,
    lifecycleState: decision.lifecycleState,
    thesisValid: decision.thesisValid,
    planValid: decision.planValid,
    currentSessionFresh: decision.currentSessionFresh,
    proven: decision.proven,
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
  if (!decision.currentSessionFresh) codes.push('NOT_CURRENT_SESSION_FRESH');
  if (decision.action === 'RESEARCH_ONLY') codes.push('UNPROVEN_EDGE');
  if (decision.action === 'DO_NOT_CHASE') codes.push('OVER_EXTENDED');
  if (analog && !analog.sufficient) codes.push('INSUFFICIENT_ANALOGS');
  if (prediction && prediction.available && !prediction.calibrated) codes.push('MODEL_ESTIMATE_ONLY');
  if (detection.similarity && detection.similarity.calibratedThreshold === false) codes.push('DESCRIPTIVE_MATCH_TIER');
  return codes;
}

// Plain-English novice card: setup, what to wait for, invalidation, simple action.
function noviceExplanation(detection, decision, plan) {
  const dir = detection.direction === 'SHORT' ? 'weakness' : 'strength';
  const actionWord = {
    ACTIONABLE_NOW: 'Buy triggered — live and confirmed right now.',
    RESEARCH_ONLY: 'Research only — the shape is strong but its edge is not yet proven. Do not size it like a validated setup.',
    WAIT_FOR_TRIGGER: `Wait. A move ${detection.direction === 'SHORT' ? 'below' : 'above'} ${money(plan.trigger)} would confirm it.`,
    FORMING: 'Watch — the pattern is still forming. Do not buy yet.',
    WATCH: 'Watch only — too early to act.',
    NO_ACTION_STALE: 'No action — this is prior-session data, not a live setup.',
    DO_NOT_CHASE: 'Do not chase — most of the expected move is already gone.',
    STALLING: 'Losing momentum — stand aside.',
    FAILED: 'This setup failed. It is kept here so you can see why.',
    EXIT_INVALIDATED: 'The thesis broke — exit / avoid.',
    EXPIRED: 'The setup aged out without triggering.',
    MANAGE_POSITION: 'In a position — manage it against the plan.',
  }[decision.action] || 'Watch.';
  const inval = detection.invalidation || (isNum(plan.stop) ? `It fails ${detection.direction === 'SHORT' ? 'above' : 'below'} ${money(plan.stop)}.` : '');
  return `${detection.label} showing ${dir}. ${actionWord} ${inval}`.replace(/\s+/g, ' ').trim();
}

function expertExplanation(detection, prediction, analog) {
  const sim = detection.similarity || {};
  const bits = [
    `combinedSim=${sim.combined ?? '—'} (path=${sim.pathCorrelation ?? '—'}, geom=${sim.geometrySimilarity ?? '—'}, vol=${sim.volumeSimilarity ?? '—'}, ctx=${sim.contextSimilarity ?? '—'})`,
    detection.geometry ? `depthATR=${detection.geometry.baseDepthAtr}, contraction=${detection.geometry.contraction}, posInRange=${detection.geometry.posInRange}, extATR=${detection.extensionAtr}` : '',
    prediction && prediction.available ? `barrier: tgtFirst=${pct(prediction.targetBeforeStop)}, stopFirst=${pct(prediction.stopBeforeTarget)}, timeout=${pct(prediction.timeout)}, ENR=${prediction.expectedNetR} (${prediction.calibrationStatus})` : 'no barrier estimate',
    analog ? `analogs: raw=${analog.rawCount}, effN=${analog.effectiveSampleSize}, resolved=${analog.resolvedCount}, lift=${analog.incrementalLift ?? 'n/a'}, calibrated=${analog.calibrated === true}` : 'no analogs',
  ].filter(Boolean);
  return bits.join(' | ');
}

module.exports = {
  buildPatternPrediction, noviceExplanation, expertExplanation, buildReasonCodes,
  MODEL_VERSION, FEATURE_VERSION, ANALOG_INDEX_VERSION, SCHEMA_VERSION,
};
