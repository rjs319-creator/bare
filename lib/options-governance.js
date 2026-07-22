'use strict';
// OPTIONS SHADOW-LAYER GOVERNANCE — promotion readiness, calibration gate, and
// champion/challenger state. Reuses the app-wide PROMOTION_GATE, purged walk-forward, and
// bootstrap CI. Everything here is HONEST about "not enough evidence yet": the options-flow
// layer stays SHADOW (weight 0, cannot originate or boost a live trade) until leakage-
// resistant, cost-aware, prospective evidence clears EVERY gate criterion — and even then a
// human/governance step flips the registry; nothing here auto-promotes. Pure.

const { PROMOTION_GATE } = require('./strategy-gate');
const { purgedWalkForward, bootstrapMeanCI } = require('./challenger-eval');

const DEFAULT_HORIZON = 21;

function excessValues(graded, horizon, metric = 'excessVsSpy') {
  return (graded || [])
    .filter(g => g && g.graded && g.horizons && g.horizons[horizon] && g.horizons[horizon][metric] != null)
    .map(g => ({ date: g.decisionDate, excess: g.horizons[horizon][metric], score: g.score }));
}

// Promotion READINESS: measure each PROMOTION_GATE criterion against the graded episodes
// and report met/not-met with the real numbers. The verdict stays 'shadow' unless EVERY
// criterion is met; it never flips the registry (that is a deliberate governance action).
function promotionReadiness(graded, { horizon = DEFAULT_HORIZON, gate = PROMOTION_GATE } = {}) {
  const rows = excessValues(graded, horizon);
  const n = rows.length;
  const independentDates = new Set(rows.map(r => r.date)).size;
  const vals = rows.map(r => r.excess);
  const ci = bootstrapMeanCI(vals);
  const meanExcess = ci.mean;

  const criteria = {
    minResolvedEpisodes: { met: n >= gate.minResolvedEpisodes, actual: n, required: gate.minResolvedEpisodes },
    minIndependentDates: { met: independentDates >= gate.minIndependentDates, actual: independentDates, required: gate.minIndependentDates },
    incrementalExcessReturn: { met: meanExcess != null && meanExcess > 0, actual: meanExcess,
      note: 'measured vs SPY (de-beta); a full base-model comparison (price/momentum/sector/regime) is the stronger test and not yet wired' },
    calibrationBeatsBaseRate: { met: false, actual: null,
      note: 'no out-of-sample calibrated probability model exists — probabilities are suppressed (see calibrationGate)' },
    costAware: { met: true, actual: true, note: 'grading nets a round-trip cost/slippage assumption' },
    regimeRobust: { met: false, actual: null, note: 'per-regime split of episode excess not yet computed' },
    confidenceInterval: { met: ci.lo != null && ci.lo > 0, actual: ci.lo != null ? [ci.lo, ci.hi] : null,
      note: 'CI (bootstrap) must exclude zero incremental value on the positive side' },
  };
  const allMet = Object.values(criteria).every(c => c.met);
  return {
    verdict: allMet ? 'eligible-for-review' : 'shadow',
    canPromote: false,   // governance is advisory here — the registry flip is a separate deliberate act
    n, independentDates, meanExcess, ci: { lo: ci.lo, hi: ci.hi },
    criteria,
    note: allMet
      ? 'All promotion criteria are met on the current evidence — a human governance review may consider promotion. It is NOT auto-promoted.'
      : 'Promotion criteria not met — the options-flow layer stays shadow (weight 0). This is expected until the episode ledger matures.',
  };
}

// CALIBRATION GATE: may a probability be displayed? Only when an out-of-sample calibrated
// model beats a base-rate benchmark on enough independent mature episodes. Until then,
// probabilities are suppressed and the UI shows evidence score/tier/sample instead.
function calibrationGate(graded, { horizon = DEFAULT_HORIZON, minMature = PROMOTION_GATE.minResolvedEpisodes } = {}) {
  const mature = excessValues(graded, horizon).length;
  return {
    probabilityAllowed: false,   // no OOS-calibrated model is fitted yet — hard off
    reason: mature < minMature
      ? `Probability unavailable — insufficient prospective evidence (${mature}/${minMature} mature episodes).`
      : 'Probability unavailable — a frozen, out-of-sample calibrated model (Brier beating base rate) is not yet fitted.',
    matureEpisodes: mature,
    minRequired: minMature,
    showInstead: ['evidence score', 'evidence tier', 'sample size', 'validation status'],
  };
}

// Time-robustness of the signal: purged, embargoed walk-forward of signal SCORE vs realized
// excess. Reuses the app-wide harness (embargo = the label horizon so overlapping outcomes
// can't leak across the train/test boundary). Returns the per-fold IC blocks + verdict.
function incrementalWalkForward(graded, { horizon = DEFAULT_HORIZON, folds = 4 } = {}) {
  const preds = excessValues(graded, horizon)
    .map(r => ({ predDate: r.date, residualScore: r.score, outcome: r.excess }))
    .filter(p => p.predDate != null && typeof p.residualScore === 'number' && typeof p.outcome === 'number');
  const wf = purgedWalkForward(preds, { folds, embargoDays: horizon });
  return {
    ...wf,
    interpretation: !wf.ready
      ? 'Not enough independently-dated episodes for a purged walk-forward yet.'
      : (wf.positiveBlocks > wf.testedBlocks / 2
        ? 'Signal strength predicts excess in a majority of out-of-sample blocks — promising, not yet conclusive.'
        : 'Signal strength does NOT robustly predict excess out-of-sample — no durable edge shown.'),
  };
}

// Champion/challenger state for the options scoring layer. The champion is the current
// honest mechanical read (itself SHADOW — it never reaches a live trade). Challenger
// scoring variants register here and run in shadow; each carries an explicit lifecycle
// state so the UI can show production/shadow/experimental/rejected.
function championChallengerState({ challengers = [] } = {}) {
  return {
    champion: {
      id: 'optionsflow-honest-v1',
      label: 'Honest mechanical + provisional-direction read',
      state: 'shadow',   // even the champion is shadow — the whole layer is weight 0
      note: 'The production behavior. It cannot originate or boost a live trade while the layer is shadow.',
    },
    challengers: (challengers || []).map(c => ({
      id: c.id, label: c.label,
      state: ['production', 'shadow', 'experimental', 'rejected'].includes(c.state) ? c.state : 'experimental',
      note: c.note || 'Evaluated prospectively on independent episodes; promotion requires clearing the full gate. No auto-promotion on a short winning streak.',
    })),
    policy: 'A challenger may only be promoted after clearing every PROMOTION_GATE criterion on independent, prospective, cost-aware, regime-robust evidence with a CI excluding zero. It is auto-demoted if data quality fails or monitored performance materially degrades.',
  };
}

// One combined governance report for the options episode grader to attach.
function governanceReport(graded, opts = {}) {
  return {
    promotion: promotionReadiness(graded, opts),
    calibration: calibrationGate(graded, opts),
    walkForward: incrementalWalkForward(graded, opts),
    championChallenger: championChallengerState(opts),
  };
}

module.exports = {
  promotionReadiness, calibrationGate, incrementalWalkForward, championChallengerState, governanceReport,
};
