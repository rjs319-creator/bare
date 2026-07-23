'use strict';
// ATLAS-X — independent failure PROSECUTOR (`atlasx-prosecutor-v1`).
// SHADOW / NON-BINDING: `binding` is ALWAYS false. It can never veto a candidate while
// unproven — mirroring failure-model.js, which stays shadow until a validation proves the
// names it rejects actually do worse out-of-sample.
//
// Job: argue the OTHER side. Not the winner score inverted — it reads its own failure
// evidence and returns the modes with severity + a plain-English EVIDENCE string, an
// overall failureScore (0..1), a qualitative severity band and a NON-BINDING suggested
// action. It wraps the existing failure-v1 read (lib/failure-model.assessSignal) and
// augments it with ATLAS-X-specific structural modes (gap dependence, upper-wick
// rejection, negative remaining R:R).
//
// A source OUTAGE (missing data) is NOT failure: it returns a LOW failureScore plus a
// 'data-unavailable' note. Absence of evidence must never read as evidence of failure.

const { VERSIONS, MAX_CHASE_GAP, HURDLES } = require('./atlasx-config');
const { assessSignal, FAILURE_MODES } = require('./failure-model');

const CALIBRATION_STATUS = 'uncalibrated';
const OUTAGE_SCORE = 0.05;                 // low — an outage is uncertainty, not failure
const MAX_SCORE = 0.95;                     // never claim certainty of failure
const DATA_UNAVAILABLE_NOTE = 'data-unavailable';

// Severity band cut points for the combined failureScore.
const BANDS = Object.freeze([
  { at: HURDLES.maxFailureScore, band: 'high' },   // 0.65
  { at: 0.40, band: 'moderate' },
  { at: 0.20, band: 'low' },
  { at: 0, band: 'none' },
]);

// Noisy-OR weights for the ATLAS-X structural modes layered on top of the failure-v1 read.
const EXTRA_WEIGHTS = Object.freeze({ gapDependence: 0.20, upperWickRejection: 0.12, negativeRemainingRR: 0.15 });

// Evidence copy for every prosecutable mode (mapped from failure-v1 keys + ATLAS-X extras).
const MODE_EVIDENCE = Object.freeze({
  repeatedFailedBreakouts: 'prior pokes above the 20-bar high closed back below it (supply overhead)',
  upperWickRejection: 'long upper wicks — sellers rejecting higher prices intrabar',
  volumeClimax: 'a volume-climax spike on an outsized single-bar move (exhaustion risk)',
  distribution: 'high range with little net drift — churn / distribution, no follow-through',
  gapDependence: 'entry depends on an already-large gap that is unsafe to chase',
  sectorRollover: "the name's sector is weakening — the tide is going out",
  breadthDeterioration: 'price advancing while market breadth deteriorates',
  binaryEventRisk: 'a binary print (earnings / FDA) lands inside the hold window',
  liquidityProblems: 'thin liquidity — both the fill and the stop are unreliable',
  excessiveExtension: 'price stretched well past a clean entry / its SMA20',
  negativeRemainingRR: 'remaining reward-to-risk is below the actionable hurdle',
});

// Which failure-v1 feature key backs each ATLAS-X prosecutor mode (when present).
const FROM_FAILURE_FEATURE = Object.freeze({
  repeatedFailedBreakouts: 'failedBreakouts',
  volumeClimax: 'volClimax',
  distribution: 'volWithoutPersistence',
  excessiveExtension: 'extended',
  sectorRollover: 'sectorWeak',
  breadthDeterioration: 'breadthWeak',
  binaryEventRisk: 'earningsBinary',
  liquidityProblems: 'illiquid',
});

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function num(v) { return isNum(v) ? v : null; }
function clamp01(v) { return Math.max(0, Math.min(1, isNum(v) ? v : 0)); }
function round2(v) { return isNum(v) ? Math.round(v * 100) / 100 : v; }
function round3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : v; }

// A source outage: the caller flagged missing data, or the signal carries no usable state.
function isDataOutage(sig, ctx) {
  if (ctx && ctx.dataUnavailable === true) return true;
  if (sig && (sig.dataUnavailable === true || sig.sourceOutage === true)) return true;
  return false;
}

// ── ATLAS-X structural severities (0..1), read defensively — unknown → 0 ──────────────
function gapDependence(sig) {
  const gap = num(sig && sig.gapPct) != null ? sig.gapPct : num(sig && sig.gap);
  if (gap == null) return 0;
  const side = (sig && sig.side) === 'short' ? 'short' : 'long';
  const adverse = side === 'long' ? gap : -gap;         // gap already run in the trade's favor
  if (adverse <= MAX_CHASE_GAP) return 0;
  return clamp01((adverse - MAX_CHASE_GAP) / (2 * MAX_CHASE_GAP));
}
function upperWickRejection(sig, ctx) {
  const bar = (sig && sig.lastBar) || (ctx && ctx.lastBar) || null;
  if (!bar) return 0;
  const hi = num(bar.high), lo = num(bar.low), close = num(bar.close), open = num(bar.open);
  if (hi == null || lo == null || close == null || hi <= lo) return 0;
  const wick = (hi - Math.max(close, open == null ? close : open)) / (hi - lo);
  return clamp01((wick - 0.4) / 0.4);                   // >40% upper wick starts to matter
}
function negativeRemainingRR(sig) {
  const rr = num(sig && sig.remainingRR) != null ? sig.remainingRR
    : num(sig && sig.remainingEdge && sig.remainingEdge.remainingRR);
  if (rr == null) return 0;
  const min = HURDLES.minRemainingRR;
  if (rr >= min) return 0;
  return clamp01((min - rr) / min);
}

function severityBand(score) {
  for (const b of BANDS) if (score >= b.at) return b.band;
  return 'none';
}

// Build the explainable failure-mode list from the failure-v1 features + ATLAS-X extras.
function buildFailureModes(sig, ctx, fm) {
  const fv = (fm && fm.features) || {};
  const rows = [];
  const push = (mode, severity) => {
    const s = round2(clamp01(severity));
    if (s > 0) rows.push({ mode, severity: s, evidence: MODE_EVIDENCE[mode] });
  };
  for (const [mode, featureKey] of Object.entries(FROM_FAILURE_FEATURE)) push(mode, fv[featureKey]);
  push('gapDependence', gapDependence(sig));
  push('upperWickRejection', upperWickRejection(sig, ctx));
  push('negativeRemainingRR', negativeRemainingRR(sig));
  rows.sort((a, b) => b.severity - a.severity);
  return rows;
}

// Combine the failure-v1 probability with the ATLAS-X extras via noisy-OR, capped.
function combineScore(baseProb, sig, ctx) {
  let p = clamp01(baseProb);
  const extras = {
    gapDependence: gapDependence(sig),
    upperWickRejection: upperWickRejection(sig, ctx),
    negativeRemainingRR: negativeRemainingRR(sig),
  };
  for (const [k, sev] of Object.entries(extras)) p = 1 - (1 - p) * (1 - EXTRA_WEIGHTS[k] * clamp01(sev));
  return round3(Math.min(MAX_SCORE, p));
}

function suggestedActionFor(failureScore, outage) {
  if (outage) return 'GATHER_DATA';
  if (failureScore >= HURDLES.maxFailureScore) return 'AVOID';
  if (failureScore >= 0.40) return 'REDUCE_SIZE';
  return 'PROCEED';
}

/**
 * Prosecute a candidate for failure. NON-BINDING (shadow) — `binding` is always false.
 * @param {object} sig  enriched signal
 * @param {object} [ctx] { regime, lastBar, dataUnavailable }
 * @returns frozen prosecutor assessment satisfying validateProsecutor
 */
function prosecute(sig = {}, ctx = {}) {
  const outage = isDataOutage(sig, ctx);
  if (outage) {
    return Object.freeze({
      version: VERSIONS.prosecutor,
      binding: false,
      calibrationStatus: CALIBRATION_STATUS,
      failureModes: Object.freeze([]),
      severity: 'none',
      failureScore: OUTAGE_SCORE,           // low — an outage is NOT a failure
      action: suggestedActionFor(OUTAGE_SCORE, true),
      suggestedAction: suggestedActionFor(OUTAGE_SCORE, true),
      notes: Object.freeze([DATA_UNAVAILABLE_NOTE]),
      dataOutage: true,
    });
  }

  const fm = assessSignal(sig, ctx);        // failure-v1 read
  const failureModes = buildFailureModes(sig, ctx, fm).map((m) => Object.freeze(m));
  const failureScore = combineScore(fm.failureProb, sig, ctx);
  const severity = severityBand(failureScore);
  const action = suggestedActionFor(failureScore, false);

  return Object.freeze({
    version: VERSIONS.prosecutor,
    binding: false,                          // NEVER binds while shadow
    calibrationStatus: CALIBRATION_STATUS,
    failureModes: Object.freeze(failureModes),
    severity,
    failureScore,
    action,
    suggestedAction: action,
    notes: Object.freeze([]),
    dataOutage: false,
    baseFailureProb: fm.failureProb,
    sizeMult: fm.sizeMult,
    knownModes: Object.freeze(Object.keys(FAILURE_MODES)),
  });
}

module.exports = {
  OUTAGE_SCORE,
  MODE_EVIDENCE,
  isDataOutage,
  gapDependence,
  upperWickRejection,
  negativeRemainingRR,
  severityBand,
  buildFailureModes,
  combineScore,
  prosecute,
};
