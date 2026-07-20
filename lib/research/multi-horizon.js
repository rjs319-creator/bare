'use strict';
// MULTI-HORIZON GRADING — one immutable Prediction → a full term structure of outcomes.
//
// grade.js answers "what did the market do over THIS prediction's declared horizon". This
// module answers it over EVERY horizon in a fixed ladder (1/3/5/10/21/63 sessions), from
// the SAME single entry fill. The point is throughput of learning, not a new edge: a
// decision recorded once yields a whole curve of graded outcomes instead of a single
// point, which is the only honest exponential lever the research OS actually has.
//
// It is a strict superset that REUSES grade.js — same entry fill, same side-aware costs,
// same sector-then-market residual, same excursion math — so a slice of this vector at the
// prediction's own horizon reproduces grade.js exactly. It is written to its own Blob
// prefix and never feeds live ranks.
//
// FOUR RULES, inherited from grade.js and enforced PER HORIZON:
//   1. NEVER GRADE EARLY — a horizon whose label has not fully elapsed is `pending`, never
//      a smaller number. Near horizons resolve while far ones stay open.
//   2. ENTRY IS A REAL FILL — a single next-session open fill (execution-policy), shared by
//      every horizon; an unfillable prediction is `unfilled`, not dropped.
//   3. REJECTED CANDIDATES ARE GRADED TOO — the outcome is separate from the selection.
//   4. COSTS ARE SIDE-AWARE — spread both ways plus borrow, accrued over EACH horizon's bars.
//
// Pure: candles in, outcome out. No network, no persistence, no clock.

const S = require('./schemas');
const { windowReturn, excursions, HORIZON_BARS } = require('./grade');
const { planFill, POLICIES, EXECUTION_POLICY_VERSION } = require('../execution-policy');
const { costBreakdown, tierForPick } = require('../costs');

// Charge friction exactly once — see grade.js. Unslipped fill; costs.js is the sole model.
const FILL_POLICY = POLICIES.NEXT_OPEN;

const MULTI_HORIZON_VERSION = 'research-mh-outcome-v1';

// The horizon ladder, in trading sessions. Spans intraday (1) to a quarter (63) so a single
// prediction contributes evidence at every economically distinct holding period.
const HORIZON_LADDER = Object.freeze([1, 3, 5, 10, 21, 63]);

// A realized net loss at or beyond this magnitude is flagged as a severe-loss event
// (Phase 4 target #4). Realized, not excursion-based: MAE is exposed separately.
const SEVERE_LOSS_PCT = 15;

const num = x => (Number.isFinite(x) ? x : null);
const pct = (from, to) => (from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null);

// Grade one prediction across the whole ladder from a single entry fill.
// Returns a frozen MultiHorizonOutcome. `unfilled`/no-candle predictions still return a
// vector (with the no-fill target set) — an unfillable name is evidence about tradability.
function gradePredictionHorizons(prediction, ctx = {}) {
  const { candles = null, benchCandles = null, sectorCandles = null, asOf = null, tier = null, ladder = HORIZON_LADDER } = ctx;
  const side = prediction && prediction.side === 'short' ? 'short' : 'long';
  const primaryHorizon = (prediction && prediction.horizon) || null;
  const liqTier = tier || tierForPick(prediction || {});

  const base = {
    predictionId: prediction && prediction.predictionId,
    ticker: prediction && prediction.ticker,
    side, primaryHorizon,
    outcomeVersion: MULTI_HORIZON_VERSION,
  };

  if (!prediction || !prediction.predictionId || !Array.isArray(candles) || !candles.length) {
    return S.makeMultiHorizonOutcome({
      ...base, fillStatus: 'unfilled', noFill: true,
      fillPolicyVersion: EXECUTION_POLICY_VERSION,
      horizons: ladder.map(bars => ({ bars, status: 'unfilled', reason: 'no-candles' })),
    });
  }

  const fill = planFill(candles, prediction.decisionTs, { side, tier: liqTier, policy: FILL_POLICY });
  if (!fill.filled) {
    return S.makeMultiHorizonOutcome({
      ...base, fillStatus: 'unfilled', noFill: true,
      fillPolicyVersion: fill.version || EXECUTION_POLICY_VERSION,
      horizons: ladder.map(bars => ({ bars, status: 'unfilled', reason: fill.fillReason || 'unfilled' })),
    });
  }

  const fillPrice = fill.fillPrice;
  const startDate = fill.earliestFillDate;
  const horizons = ladder.map(bars => gradeOneHorizon({
    candles, benchCandles, sectorCandles, asOf, side, liqTier,
    fillIdx: fill.fillIdx, fillPrice, startDate, bars,
  }));

  return S.makeMultiHorizonOutcome({
    ...base,
    primaryBars: HORIZON_BARS_FOR(primaryHorizon),
    fillStatus: 'filled', noFill: false,
    fillPolicyVersion: fill.version || EXECUTION_POLICY_VERSION,
    fillTs: startDate, fillPrice,
    horizons,
  });
}

// One slice of the term structure. Pending when the label has not elapsed (RULE 1).
function gradeOneHorizon({ candles, benchCandles, sectorCandles, asOf, side, liqTier, fillIdx, fillPrice, startDate, bars }) {
  const exitIdx = fillIdx + bars;
  const exitBar = candles[exitIdx];
  if (!exitBar) return { bars, status: 'pending', reason: `horizon-not-elapsed:need-${bars}-sessions-after-${startDate}` };
  if (asOf && exitBar.date > asOf) return { bars, status: 'pending', reason: `horizon-not-elapsed:label-ends-${exitBar.date}` };

  const exitPrice = num(exitBar.close);
  if (exitPrice == null) return { bars, status: 'pending', reason: 'no-exit-price' };

  const rawPct = pct(fillPrice, exitPrice);
  const grossReturn = rawPct == null ? null : +(side === 'short' ? -rawPct : rawPct).toFixed(3);
  const costs = costBreakdown(liqTier, { side, holdSessions: bars }).totalPct;
  const netReturn = grossReturn == null ? null : +(grossReturn - costs).toFixed(3);

  const endDate = exitBar.date;
  const benchmarkReturn = num(windowReturn(benchCandles, startDate, endDate));
  const sectorReturn = num(windowReturn(sectorCandles, startDate, endDate));
  const benchForResidual = sectorReturn != null ? sectorReturn : benchmarkReturn;
  const residualReturn = (netReturn == null || benchForResidual == null)
    ? null
    : +(netReturn - (side === 'short' ? -benchForResidual : benchForResidual)).toFixed(3);

  const { mfe, mae } = excursions(candles, fillIdx, exitIdx, fillPrice, side);

  return {
    bars, status: 'resolved', exitTs: endDate,
    grossReturn, costs, netReturn,
    benchmarkReturn: benchmarkReturn == null ? null : +benchmarkReturn.toFixed(3),
    sectorReturn: sectorReturn == null ? null : +sectorReturn.toFixed(3),
    residualReturn, mfe, mae,
    // Targets #2/#3/#4 — decided only when the underlying number exists.
    beatBenchmark: residualReturn == null ? null : residualReturn > 0,
    positiveNet: netReturn == null ? null : netReturn > 0,
    severeLoss: netReturn == null ? null : netReturn <= -SEVERE_LOSS_PCT,
  };
}

// Session count for the prediction's declared horizon — the ladder rung grade.js would use
// (reuses grade.js HORIZON_BARS so the two can never drift).
function HORIZON_BARS_FOR(h) { return HORIZON_BARS[h] ?? null; }

// Grade a whole DecisionSnapshot into a batch of vectors. RULE 3: rejects graded too.
function gradeSnapshotHorizons(snapshot, priceLookup, ctx = {}) {
  const preds = (snapshot && snapshot.predictions) || [];
  const ladder = ctx.ladder || HORIZON_LADDER;
  const vectors = [];
  const invalid = [];

  for (const p of preds) {
    const candles = typeof priceLookup === 'function' ? priceLookup(p.ticker) : null;
    const v = gradePredictionHorizons(p, { ...ctx, ladder, candles });
    const chk = S.validateMultiHorizonOutcome(v);
    if (!chk.valid) { invalid.push({ predictionId: p.predictionId, errors: chk.errors }); continue; }
    vectors.push(v);
  }

  const filled = vectors.filter(v => v.fillStatus === 'filled');
  // Per-rung resolved counts — how much of the term structure has come due.
  const resolvedByBar = {};
  for (const bars of ladder) {
    resolvedByBar[bars] = filled.reduce((n, v) => n + (v.horizons.some(h => h.bars === bars && h.status === 'resolved') ? 1 : 0), 0);
  }

  return Object.freeze({
    schema: 'MultiHorizonBatch', version: MULTI_HORIZON_VERSION,
    decisionTs: (snapshot && snapshot.decisionTs) || null,
    gradedAsOf: ctx.asOf || null,
    ladder: Object.freeze([...ladder]),
    nPredictions: preds.length,
    nFilled: filled.length,
    nUnfilled: vectors.length - filled.length,
    resolvedByBar: Object.freeze(resolvedByBar),
    vectors: Object.freeze(vectors),
    invalid: Object.freeze(invalid),
    mutatesPredictions: false,
  });
}

module.exports = {
  MULTI_HORIZON_VERSION, HORIZON_LADDER, SEVERE_LOSS_PCT,
  gradePredictionHorizons, gradeSnapshotHorizons,
};
