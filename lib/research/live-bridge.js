'use strict';
// LIVE → RESEARCH BRIDGE — emits the canonical Prediction contract from the live
// decision path.
//
// WHY THIS EXISTS: `lib/research/*` defined a rigorous Prediction/Outcome contract
// (immutable decisions, explicit data cutoff, next-session entry, versioned models)
// but had ZERO callers outside tests. The live path (`lib/decision.js`) ranked names
// and logged its own ad-hoc shapes. So the research machinery was correct and unused,
// while the thing that actually picks stocks was unobserved by it. This module closes
// that gap in the only safe direction: the live path EMITS the contract, the contract
// does not steer the live path.
//
// THREE INVARIANTS, all tested:
//
//  1. OBSERVER ONLY. Nothing here can change a rank. It reads ranked output and
//     returns new frozen records; it never mutates its input and is never consulted
//     by `rankSignals`. If this module threw on every call, the live board would be
//     byte-identical.
//
//  2. FULL CANDIDATE SET. Rejected candidates are emitted too, with the reason. The
//     selection-bias trap the audit calls out is training a learner only on the names
//     the old model already liked — then it can never learn that a rejection was wrong.
//     `state` distinguishes them; nothing is silently dropped.
//
//  3. NO FABRICATED FORECASTS. The live composite is a RANK SCORE — not a probability
//     and not an expected return. It is recorded in `rawOutputs` as exactly that.
//     `calibratedProbabilities` stays EMPTY (none exist) and expectedGross/NetReturn
//     stay null, because an advertised target level is a level, not an expectation.
//     Only `expectedCosts` is populated, because that is genuinely modeled.
//
// Pure: no network, no persistence, no clock. The caller supplies decisionTs and the
// session axis, so the same inputs always produce the same records.

const crypto = require('crypto');
const S = require('./schemas');
const { costBreakdown, tierForPick } = require('../costs');
// The bridge is the one module allowed to know both sides, so it imports the live
// horizon→sessions map rather than mirroring it (a copy would drift silently, and
// a wrong holding period silently mis-prices short borrow).
const { MAX_AGE_BARS } = require('../decision');

const BRIDGE_VERSION = 'live-bridge-v1';

// A live signal that is not actionable is a REJECTION, and the state name should say
// which kind — a learner needs to distinguish "expired" from "never qualified".
const REJECTION_STATES = Object.freeze({
  expired: 'lifecycle-expired',
  invalidated: 'lifecycle-invalidated',
  filled: 'already-filled',
  stopped: 'stopped-out',
});

// Deterministic id: the same decision on the same day under the same model version
// always hashes to the same id, so re-emitting is idempotent rather than duplicating.
function predictionId(parts) {
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

// Earliest legal fill = the next session STRICTLY after the decision. Fail closed:
// with no session axis we return null rather than guessing a calendar date, because a
// fabricated entry timestamp is precisely the look-ahead the contract exists to bar.
function nextSessionAfter(decisionTs, sessionAxis) {
  if (!Array.isArray(sessionAxis) || !sessionAxis.length || !decisionTs) return null;
  for (const d of sessionAxis) if (d > decisionTs) return d;
  return null;   // decision is at/after the last known session — unknown, not assumed
}

// Forward trading-session axis from `fromDate`, exclusive.
//
// Pass `isHoliday` (e.g. lib/stats isMarketHoliday) to get a genuinely holiday-aware
// axis — the caller should then declare sessionAxisKind:'exact'. WITHOUT the predicate
// this is only a weekday roll, which can name a market holiday as the next session; that
// caller must declare 'approximate' so the snapshot carries the caveat. An indicative
// entry date is fine for research bookkeeping and must never pass as a verified fill.
function forwardSessionAxis(fromDate, { n = 10, isHoliday = null } = {}) {
  if (!fromDate) return null;
  const d = new Date(fromDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 5) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (typeof isHoliday === 'function' && isHoliday(iso)) continue;
    out.push(iso);
  }
  return out.length ? out : null;
}

// One live ranked signal → one frozen Prediction.
function predictionFromSignal(sig, ctx = {}) {
  const {
    decisionTs = null, sessionAxis = null, modelVersion = null, featureVersion = null,
    universeSnapshotId = null, regime = null,
  } = ctx;

  const ticker = sig.ticker || sig.symbol || null;
  const horizon = sig.horizon || null;
  const side = sig.side === 'short' ? 'short' : 'long';
  const eligibleEntryTs = nextSessionAfter(decisionTs, sessionAxis);

  // Real modeled cost — including short borrow (cost-v2), which matters here because a
  // short's cost is materially higher than a long's and the contract should say so.
  // NB holdWindow is a human-readable STRING ('Days to ~2 weeks'), not a bar count —
  // reading a `.bars` off it would silently yield 0 borrow on every short.
  const holdSessions = MAX_AGE_BARS[horizon] ?? MAX_AGE_BARS.swing;
  const costs = costBreakdown(tierForPick(sig), { side, holdSessions });

  const rejected = sig.actionable === false;
  const reasons = [];
  if (rejected) reasons.push(REJECTION_STATES[sig.state] || `not-actionable:${sig.state || 'unknown'}`);
  if (!eligibleEntryTs) reasons.push('entry-session-unknown');

  return S.makePrediction({
    predictionId: predictionId([ticker, decisionTs, horizon, modelVersion, side]),
    securityId: ticker,            // no separate security master id on the live path yet
    ticker, decisionTs, eligibleEntryTs, horizon, side,
    modelVersion, featureVersion, universeSnapshotId,
    // The live composite is a rank score. Recorded as such — never as a probability.
    rawOutputs: {
      compositeScore: sig.score != null ? sig.score : null,
      rank: sig.rank != null ? sig.rank : null,
      confidence: sig.confidence != null ? sig.confidence : null,
      expectancyTilt: sig.expectancyTilt != null ? sig.expectancyTilt : null,
      lifecycleState: sig.state || null,
      strategyFamily: sig.strategyFamily || null,
      scoreKind: 'heuristic-rank',   // explicit: not a probability, not an expected return
    },
    calibratedProbabilities: {},     // none exist for the live heuristic — stays empty
    expectedGrossReturn: null,       // an advertised target is a level, not an expectation
    expectedNetReturn: null,
    expectedCosts: costs.totalPct,
    tailRisk: null,
    uncertainty: null,
    regime: regime || null,
    state: rejected ? 'rejected' : 'shadow',   // NEVER 'eligible' — this cannot arm capital
    rejectionReasons: reasons,
  });
}

// The whole cross-section for one decision date, selected AND rejected.
//
// `ranked` should come from rankSignals({ includeInactive: true }) so the rejected
// names are present. Passing only the actionable board still works but records a
// `partial-universe` caveat, because a consumer must be able to tell a full
// cross-section from a survivor-only one.
function buildDecisionSnapshot(ranked, ctx = {}) {
  const rows = Array.isArray(ranked) ? ranked : [];
  const predictions = rows.map(sig => predictionFromSignal(sig, ctx));
  const invalid = predictions
    .map((p, i) => ({ i, v: S.validatePrediction(p) }))
    .filter(x => !x.v.valid);

  const nRejected = predictions.filter(p => p.state === 'rejected').length;
  const caveats = [];
  if (!ctx.sessionAxis) caveats.push('no-session-axis: eligibleEntryTs unknown, entry timing unverifiable');
  else if (ctx.sessionAxisKind === 'approximate') caveats.push('session-axis-approximate: weekday roll, not holiday-aware — entry date is indicative, not a verified session');
  if (!nRejected) caveats.push('partial-universe: no rejected candidates present — selection-bias risk if used for training');
  if (!ctx.universeSnapshotId) caveats.push('no-universe-snapshot: cross-section not pinned to a point-in-time universe');

  return Object.freeze({
    schema: 'DecisionSnapshot', version: BRIDGE_VERSION,
    decisionTs: ctx.decisionTs || null,
    modelVersion: ctx.modelVersion || null,
    nPredictions: predictions.length,
    nSelected: predictions.length - nRejected,
    nRejected,
    predictions: Object.freeze(predictions),
    invalid: Object.freeze(invalid.map(x => ({ index: x.i, errors: x.v.errors }))),
    caveats: Object.freeze(caveats),
    // This snapshot is an observation of the live path, never an instruction to it.
    affectsLiveRank: false,
  });
}

module.exports = {
  BRIDGE_VERSION, REJECTION_STATES,
  predictionId, nextSessionAfter, forwardSessionAxis, predictionFromSignal, buildDecisionSnapshot,
};
