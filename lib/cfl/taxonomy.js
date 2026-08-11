'use strict';
// CFL — DETERMINISTIC FAILURE TAXONOMY. Pure; precedence-ordered; evidence-first.
//
// The classifier walks an ORDERED list of checks and stops at the first that
// fires — precedence is the contract, so two graders can never disagree about a
// record. Every verdict carries the deterministic evidence that produced it.
// No LLM participates in classification (one may later phrase the structured
// evidence for a reader, never invent the cause).
//
// Preventability: categories 1-10 are pipeline-addressable ("preventable" with
// stated caveats); 11-13 mean the move was not reasonably forecastable from the
// information available beforehand — the honest "we could not have known" bucket.

const { REJECT } = require('../swing-candidate-schema');
const CFG = require('./config');

const MISS = Object.freeze({
  UNIVERSE_EXCLUSION: 'UNIVERSE_EXCLUSION',
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
  DATA_STALE_OR_FAILED: 'DATA_STALE_OR_FAILED',
  CANDIDATE_GENERATION_FAILURE: 'CANDIDATE_GENERATION_FAILURE',
  RANKING_FAILURE: 'RANKING_FAILURE',
  LATE_DETECTION: 'LATE_DETECTION',
  RISK_VETO: 'RISK_VETO',
  ALERT_FAILURE: 'ALERT_FAILURE',
  PRESENTATION_FAILURE: 'PRESENTATION_FAILURE',
  LIQUIDITY_OR_EXECUTION_FAILURE: 'LIQUIDITY_OR_EXECUTION_FAILURE',
  INFORMATION_ARRIVED_AFTER_MOVE: 'INFORMATION_ARRIVED_AFTER_MOVE',
  OUT_OF_DISTRIBUTION: 'OUT_OF_DISTRIBUTION',
  NO_PREMOVE_EVIDENCE: 'NO_PREMOVE_EVIDENCE',
});
const MISS_PRECEDENCE = Object.freeze(Object.values(MISS));
const UNPREVENTABLE = Object.freeze(new Set([
  MISS.INFORMATION_ARRIVED_AFTER_MOVE, MISS.OUT_OF_DISTRIBUTION, MISS.NO_PREMOVE_EVIDENCE,
]));

const DUD = Object.freeze({
  IMMEDIATE_FAILURE: 'IMMEDIATE_FAILURE',
  SLOW_DETERIORATION: 'SLOW_DETERIORATION',
  STAGNATION: 'STAGNATION',
  FAILED_BREAKOUT: 'FAILED_BREAKOUT',
  EXHAUSTED_MOVE: 'EXHAUSTED_MOVE',
  CATALYST_REVERSAL: 'CATALYST_REVERSAL',
  MARKET_REVERSAL: 'MARKET_REVERSAL',
  SECTOR_REVERSAL: 'SECTOR_REVERSAL',
  LIQUIDITY_FAILURE: 'LIQUIDITY_FAILURE',
  DATA_FAILURE: 'DATA_FAILURE',
  OUT_OF_DISTRIBUTION: 'OUT_OF_DISTRIBUTION',
  SEVERE_LOSS_MODEL_FAILURE: 'SEVERE_LOSS_MODEL_FAILURE',
  EXIT_OR_RETENTION_FAILURE: 'EXIT_OR_RETENTION_FAILURE',
});

// Map the engine's canonical rejection codes onto pipeline stages.
const REJECTION_STAGE = Object.freeze({
  [REJECT.LIQUIDITY]: MISS.UNIVERSE_EXCLUSION,           // an eligibility floor, not an execution claim
  [REJECT.MISSING_HISTORY]: MISS.DATA_UNAVAILABLE,
  [REJECT.MISSING_SCOPE_CACHE]: MISS.DATA_UNAVAILABLE,
  [REJECT.STALE_DATA]: MISS.DATA_STALE_OR_FAILED,
  [REJECT.FUTURE_DATED_DATA]: MISS.DATA_STALE_OR_FAILED,
  [REJECT.MISSING_BENCHMARK]: MISS.DATA_STALE_OR_FAILED,
  [REJECT.DEADLINE_TRUNCATED]: MISS.DATA_STALE_OR_FAILED,
  [REJECT.NO_QUALIFYING_SETUP]: MISS.CANDIDATE_GENERATION_FAILURE,
  [REJECT.LIVE_TREND_GATE]: MISS.CANDIDATE_GENERATION_FAILURE,
  [REJECT.RELATIVE_STRENGTH_GATE]: MISS.CANDIDATE_GENERATION_FAILURE,
  [REJECT.BELOW_SELECTION_CAP]: MISS.RANKING_FAILURE,
  [REJECT.RISK_OFF]: MISS.RISK_VETO,
  [REJECT.GOVERNANCE]: MISS.RISK_VETO,
  [REJECT.EVENT_RISK]: MISS.RISK_VETO,
  [REJECT.INVALID_TRADE_PLAN]: MISS.CANDIDATE_GENERATION_FAILURE,
  [REJECT.DUPLICATE]: MISS.PRESENTATION_FAILURE,
});

const ev = (check, value, detail) => ({ check, value, detail });

// Deterministic missed-winner attribution. ctx:
//   inUniverse        symbol was in the scope's point-in-time universe/dataset
//   insufficientHistory  had <60 usable bars at the checkpoint
//   rejectionCode     engine rejection code at the checkpoint (canonical)
//   trace             DetectionTrace (rank history, warning, detection fraction)
//   episode           OpportunityEpisode (gap class, executability, OOD inputs)
//   oodZ              max |z| of decision-time features vs the cohort (may be null)
//   premoveEvidence   {maxPctile, anyCriteria} strongest pre-move signal observed
//   alertLayerExists  whether this lane has an alert layer at all (screener: false)
function attributeMiss(ctx = {}) {
  const {
    inUniverse = false, insufficientHistory = false, rejectionCode = null,
    trace = null, episode = null, oodZ = null, premoveEvidence = null,
    alertLayerExists = false,
  } = ctx;
  const evidence = [];
  const secondary = [];
  const verdict = (primary, confidence = 'high') => ({
    kind: 'missed-winner', primaryFailure: primary,
    secondaryFailures: secondary.filter(s => s !== primary),
    evidence, confidence,
    preventable: !UNPREVENTABLE.has(primary),
  });

  // Not-forecastable checks are collected as evidence first so they can surface
  // as secondaries even when a pipeline stage takes precedence.
  const gapDominant = episode && episode.gap && episode.gap.class === 'gap-dominant';
  if (gapDominant) {
    evidence.push(ev('gap.overnightShare', episode.gap.overnightShare, 'majority of the move occurred across overnight gaps'));
    secondary.push(MISS.INFORMATION_ARRIVED_AFTER_MOVE);
  }
  if (Number.isFinite(oodZ) && Math.abs(oodZ) >= CFG.FORECASTABILITY.oodZ) {
    evidence.push(ev('oodZ', oodZ, 'decision-time features outside supported historical distribution'));
    secondary.push(MISS.OUT_OF_DISTRIBUTION);
  }

  // 1-2. Universe / data availability.
  if (!inUniverse) {
    evidence.push(ev('inUniverse', false, 'symbol absent from the point-in-time scope universe'));
    return verdict(MISS.UNIVERSE_EXCLUSION);
  }
  if (insufficientHistory) {
    evidence.push(ev('insufficientHistory', true, 'fewer than 60 usable bars at the checkpoint'));
    return verdict(MISS.DATA_UNAVAILABLE);
  }
  // 3-7. Engine-recorded rejection reason at the checkpoint.
  const stage = rejectionCode ? REJECTION_STAGE[rejectionCode] : null;
  if (stage && stage !== MISS.PRESENTATION_FAILURE) {
    evidence.push(ev('rejectionCode', rejectionCode, 'engine rejection at the decision checkpoint'));
    if (stage === MISS.CANDIDATE_GENERATION_FAILURE || stage === MISS.RANKING_FAILURE) {
      // A generation/ranking miss on a move with no pre-move evidence is honestly
      // the latter — do not blame the screener for an unforecastable move.
      if (premoveEvidence && premoveEvidence.maxPctile != null && premoveEvidence.maxPctile < 0.5 && !premoveEvidence.anyCriteria) {
        evidence.push(ev('premove.maxPctile', premoveEvidence.maxPctile, 'no pre-move checkpoint showed supported advance evidence'));
        return verdict(MISS.NO_PREMOVE_EVIDENCE, 'medium');
      }
    }
    return verdict(stage);
  }
  // 6. Generated but late: first detection after most of the move.
  if (trace && trace.candidateGenerated) {
    const frac = trace.detectedBeforeMoveFrac;
    if (frac != null && frac > CFG.DETECTION.lateDetectionFraction) {
      evidence.push(ev('detectedBeforeMoveFrac', frac, 'first surfaced only after most of the executable move'));
      return verdict(MISS.LATE_DETECTION);
    }
    // 8-9. Surfaced in time but never alerted / never displayed.
    if (!alertLayerExists) {
      evidence.push(ev('alertLayer', false, 'this lane has no alert layer — qualifying names cannot notify'));
      return verdict(MISS.ALERT_FAILURE);
    }
    if (trace.displayHistory && trace.displayHistory.length === 0) {
      evidence.push(ev('displayed', false, 'qualified but never shown within the display cap'));
      return verdict(MISS.PRESENTATION_FAILURE);
    }
  }
  // 10. Move existed but was not realistically tradable.
  if (episode && episode.crossSection && episode.crossSection.executable === false) {
    evidence.push(ev('executable', false, 'move not available at the assumed execution price/size'));
    return verdict(MISS.LIQUIDITY_OR_EXECUTION_FAILURE);
  }
  // 11-13. Unforecastable buckets (already evidenced above), in precedence order.
  if (secondary.includes(MISS.INFORMATION_ARRIVED_AFTER_MOVE)) return verdict(MISS.INFORMATION_ARRIVED_AFTER_MOVE);
  if (secondary.includes(MISS.OUT_OF_DISTRIBUTION)) return verdict(MISS.OUT_OF_DISTRIBUTION);
  evidence.push(ev('premove', premoveEvidence || null, 'no stage failed and no supported advance evidence existed'));
  return verdict(MISS.NO_PREMOVE_EVIDENCE, 'medium');
}

// Deterministic dud attribution for a graded pick. ctx:
//   resolved   {outcome:'WIN'|'LOSS'|'EXPIRED'|'OPEN', r, hold}
//   path       {mfe, mae, closingReturn, entryPrice, stopPrice, targetPrice} (fill basis)
//   pick       {entry, stop, target, preRunPct?, dollarVol?}
//   context    {spyReturn, sectorReturn, entryGapPct, dataMissing, oodZ}
function classifyDud(ctx = {}) {
  const { resolved = {}, path = {}, pick = {}, context = {} } = ctx;
  const evidence = [];
  const secondary = [];
  const D = CFG.DUDS;
  const verdict = (primary, confidence = 'high') => ({
    kind: 'dud', primaryFailure: primary,
    secondaryFailures: secondary.filter(s => s !== primary),
    evidence, confidence, preventable: null,
  });

  if (context.dataMissing) {
    evidence.push(ev('dataMissing', true, 'candles unavailable — outcome cannot be graded'));
    return verdict(DUD.DATA_FAILURE);
  }
  if (Number.isFinite(context.oodZ) && Math.abs(context.oodZ) >= CFG.FORECASTABILITY.oodZ) {
    evidence.push(ev('oodZ', context.oodZ, 'entry conditions outside supported distribution'));
    secondary.push(DUD.OUT_OF_DISTRIBUTION);
  }
  if (Number.isFinite(context.spyReturn) && context.spyReturn * 100 <= D.marketReversalPct) {
    evidence.push(ev('spyReturn', context.spyReturn, 'broad market fell materially over the hold'));
    secondary.push(DUD.MARKET_REVERSAL);
  }
  if (Number.isFinite(context.sectorReturn) && context.sectorReturn * 100 <= D.sectorReversalPct) {
    evidence.push(ev('sectorReturn', context.sectorReturn, 'sector fell materially over the hold'));
    secondary.push(DUD.SECTOR_REVERSAL);
  }
  if (Number.isFinite(context.entryGapPct) && context.entryGapPct <= D.catalystGapAgainstPct) {
    evidence.push(ev('entryGapPct', context.entryGapPct, 'large overnight gap against the position'));
    secondary.push(DUD.CATALYST_REVERSAL);
  }

  const entry = pick.entry ?? path.entryPrice;
  const stopDist = (entry > 0 && pick.stop > 0 && pick.stop < entry) ? (entry - pick.stop) / entry : null;
  const targetDist = (entry > 0 && pick.target > entry) ? (pick.target - entry) / entry : null;

  if (resolved.outcome === 'LOSS') {
    if (stopDist != null && Number.isFinite(path.mae) && -path.mae >= D.severeLossMult * stopDist) {
      evidence.push(ev('mae', path.mae, `adverse excursion ≥ ${D.severeLossMult}× the planned stop distance`));
      return verdict(DUD.SEVERE_LOSS_MODEL_FAILURE);
    }
    if (Number.isFinite(resolved.hold) && resolved.hold <= D.immediateFailureSessions) {
      evidence.push(ev('hold', resolved.hold, 'stopped within the first sessions after entry'));
      return verdict(DUD.IMMEDIATE_FAILURE);
    }
    if (secondary.includes(DUD.CATALYST_REVERSAL)) return verdict(DUD.CATALYST_REVERSAL);
    if (targetDist != null && Number.isFinite(path.mfe) && path.mfe >= D.failedBreakoutMfeFrac * targetDist) {
      evidence.push(ev('mfe', path.mfe, 'covered most of the distance to target before reversing to the stop'));
      return verdict(DUD.FAILED_BREAKOUT);
    }
    if (Number.isFinite(pick.preRunPct) && pick.preRunPct >= D.exhaustionPreRunPct) {
      evidence.push(ev('preRunPct', pick.preRunPct, 'entered after a large pre-entry run-up that then failed'));
      return verdict(DUD.EXHAUSTED_MOVE);
    }
    if (secondary.includes(DUD.MARKET_REVERSAL)) return verdict(DUD.MARKET_REVERSAL);
    if (secondary.includes(DUD.SECTOR_REVERSAL)) return verdict(DUD.SECTOR_REVERSAL);
    evidence.push(ev('closingReturn', path.closingReturn ?? resolved.r ?? null, 'ground lower without a sharper deterministic cause'));
    return verdict(DUD.SLOW_DETERIORATION, 'medium');
  }
  if (resolved.outcome === 'EXPIRED' || resolved.outcome === 'OPEN') {
    const cr = Number.isFinite(path.closingReturn) ? path.closingReturn : resolved.r;
    if (Number.isFinite(cr) && Math.abs(cr * 100) <= D.stagnantAbsPct) {
      evidence.push(ev('closingReturn', cr, 'neither barrier hit and price went nowhere'));
      return verdict(DUD.STAGNATION);
    }
    if (Number.isFinite(cr) && cr < 0) {
      evidence.push(ev('closingReturn', cr, 'drifted down without hitting the stop'));
      return verdict(secondary[0] || DUD.SLOW_DETERIORATION, secondary.length ? 'high' : 'medium');
    }
    // Positive but expired: the pick worked less than planned — retention question.
    evidence.push(ev('closingReturn', cr ?? null, 'positive drift but the plan never resolved — exit/retention question'));
    return verdict(DUD.EXIT_OR_RETENTION_FAILURE, 'low');
  }
  evidence.push(ev('outcome', resolved.outcome || null, 'not a dud (won) or not yet resolved'));
  return null;
}

module.exports = { MISS, MISS_PRECEDENCE, UNPREVENTABLE, DUD, REJECTION_STAGE, attributeMiss, classifyDud };
