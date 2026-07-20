'use strict';
// GRADING — turns a stored Prediction into an ExecutableOutcome.
//
// This is the second half of the research loop. `live-bridge.js` emits immutable
// predictions; this module answers what the market actually did, in a SEPARATE
// document. The separation is the point: ingestion must never overwrite grading and
// grading must never mutate a prediction, or the record stops being evidence.
//
// FOUR RULES, all tested:
//
//  1. NEVER GRADE EARLY. An outcome is produced only once the full holding period has
//     elapsed as of the grading date. A partially-elapsed horizon returns `pending`
//     with a reason — it does not return a smaller number. Grading a 63-session
//     prediction at day 5 and calling it an outcome is how a loser becomes a "winner".
//
//  2. ENTRY IS A REAL FILL. The fill comes from execution-policy (next session open +
//     adverse slippage), never the decision-day close. An unfillable prediction is
//     recorded as `unfilled` WITH the reason, not silently dropped — dropping unfilled
//     names is survivorship bias inside the grader.
//
//  3. REJECTED CANDIDATES ARE GRADED TOO. The outcome answers "what did the market
//     do"; the prediction's own `state` answers "did we select it". Keeping those
//     separate is what lets a learner discover that a rejection was wrong. Skipping
//     rejects would rebuild the selection-bias trap one layer down.
//
//  4. COSTS ARE SIDE-AWARE. Net return charges spread AND short borrow (cost-v2) over
//     the actual holding period, so a short is never scored as if borrow were free.
//
// Pure: candles in, outcome out. No network, no persistence, no clock.

const S = require('./schemas');
const { planFill, POLICIES, EXECUTION_POLICY_VERSION } = require('../execution-policy');
const { costBreakdown, tierForPick } = require('../costs');

// FRICTION IS CHARGED EXACTLY ONCE. execution-policy's default policy
// (NEXT_OPEN_PLUS_SLIPPAGE) bakes entry slippage into the fill PRICE, while costs.js
// separately charges 2 × (halfSpread + slippage). Using both double-counts the entry
// leg. We take the unslipped NEXT_OPEN fill and let costs.js be the single friction
// model — which also keeps a research outcome directly comparable to a Scoreboard net
// return, since that path applies costs.js to raw price moves too.
const FILL_POLICY = POLICIES.NEXT_OPEN;

const OUTCOME_VERSION = 'research-outcome-v1';

// Holding period per trading horizon, in sessions. Aligned to the Scoreboard's
// 1w/1m/3m convention so a research outcome and a board statistic mean the same thing.
const HORIZON_BARS = Object.freeze({ intraday: 1, swing: 5, position: 21, portfolio: 63 });

const idxOnOrBefore = (candles, date) => {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) idx = k; else break; }
  return idx;
};
const num = x => (Number.isFinite(x) ? x : null);
const pct = (from, to) => (from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null);

// Benchmark/sector return over the SAME economic window as the position.
//
// Entry-timing alignment matters: the position enters at the fill session's OPEN, so a
// close-to-close benchmark is measured over a different window and biases the residual
// by one bar's open-to-close move. Both legs therefore run open(entry) → close(exit).
function windowReturn(candles, startDate, endDate) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const a = idxOnOrBefore(candles, startDate), b = idxOnOrBefore(candles, endDate);
  if (a < 0 || b < 0 || b <= a) return null;
  const entry = num(candles[a].open) ?? num(candles[a].close);
  return pct(entry, candles[b].close);
}

// Max favourable / adverse excursion between fill and exit, expressed side-correctly:
// for a SHORT, favourable means the price fell.
function excursions(candles, fillIdx, exitIdx, fillPrice, side) {
  if (!(fillPrice > 0) || exitIdx <= fillIdx) return { mfe: null, mae: null };
  let mfe = 0, mae = 0;
  for (let k = fillIdx; k <= exitIdx && k < candles.length; k++) {
    const hi = num(candles[k].high), lo = num(candles[k].low);
    if (hi == null || lo == null) continue;
    const up = ((hi - fillPrice) / fillPrice) * 100;
    const dn = ((lo - fillPrice) / fillPrice) * 100;
    if (side === 'short') { mfe = Math.max(mfe, -dn); mae = Math.max(mae, up); }
    else { mfe = Math.max(mfe, up); mae = Math.max(mae, -dn); }
  }
  return { mfe: +mfe.toFixed(3), mae: +mae.toFixed(3) };
}

// Grade one prediction. Returns { outcome } when the horizon has fully elapsed,
// or { pending: reason } when it has not. Never both.
function gradePrediction(prediction, ctx = {}) {
  const { candles = null, benchCandles = null, sectorCandles = null, asOf = null, tier = null } = ctx;
  if (!prediction || !prediction.predictionId) return { pending: 'no-prediction-id' };
  const side = prediction.side === 'short' ? 'short' : 'long';
  const bars = HORIZON_BARS[prediction.horizon] ?? HORIZON_BARS.swing;
  const liqTier = tier || tierForPick(prediction);

  if (!Array.isArray(candles) || !candles.length) return { pending: 'no-candles' };

  // Entry: a real next-session fill, never the decision close.
  const fill = planFill(candles, prediction.decisionTs, { side, tier: liqTier, policy: FILL_POLICY });
  if (!fill.filled) {
    // Recorded, not dropped — an unfillable name is evidence about tradability.
    return {
      outcome: S.makeExecutableOutcome({
        predictionId: prediction.predictionId,
        fillPolicyVersion: fill.version || EXECUTION_POLICY_VERSION,
        fillStatus: 'unfilled', exitReason: fill.reason || 'unfilled',
        outcomeVersion: OUTCOME_VERSION,
      }),
    };
  }

  const exitIdx = fill.fillIdx + bars;
  const exitBar = candles[exitIdx];
  // RULE 1: the horizon must have fully elapsed, both in the data and vs the grading date.
  if (!exitBar) return { pending: `horizon-not-elapsed:need-${bars}-sessions-after-${fill.earliestFillDate}` };
  if (asOf && exitBar.date > asOf) return { pending: `horizon-not-elapsed:label-ends-${exitBar.date}` };

  const fillPrice = fill.fillPrice;
  const exitPrice = num(exitBar.close);
  if (exitPrice == null) return { pending: 'no-exit-price' };

  const rawPct = pct(fillPrice, exitPrice);
  const grossReturn = rawPct == null ? null : +(side === 'short' ? -rawPct : rawPct).toFixed(3);

  // RULE 4: side-aware costs — spread both ways, plus borrow for the short leg.
  const costs = costBreakdown(liqTier, { side, holdSessions: bars }).totalPct;
  const netReturn = grossReturn == null ? null : +(grossReturn - costs).toFixed(3);

  const startDate = fill.earliestFillDate;
  const endDate = exitBar.date;
  const benchmarkReturn = num(windowReturn(benchCandles, startDate, endDate));
  const sectorReturn = num(windowReturn(sectorCandles, startDate, endDate));
  // Residual vs the tightest available benchmark: sector if we have it, else market.
  // A SHORT's residual is the negative of the benchmark's contribution.
  const benchForResidual = sectorReturn != null ? sectorReturn : benchmarkReturn;
  const residualReturn = (netReturn == null || benchForResidual == null)
    ? null
    : +(netReturn - (side === 'short' ? -benchForResidual : benchForResidual)).toFixed(3);

  const { mfe, mae } = excursions(candles, fill.fillIdx, exitIdx, fillPrice, side);

  return {
    outcome: S.makeExecutableOutcome({
      predictionId: prediction.predictionId,
      fillPolicyVersion: fill.version || EXECUTION_POLICY_VERSION,
      fillTs: startDate, fillPrice, fillStatus: 'filled',
      exitTs: endDate, exitPrice, exitReason: 'time',
      grossReturn, costs, netReturn,
      benchmarkReturn: benchmarkReturn == null ? null : +benchmarkReturn.toFixed(3),
      sectorReturn: sectorReturn == null ? null : +sectorReturn.toFixed(3),
      residualReturn,
      barrier: null,           // the live heuristic exits on time, not on a barrier
      mfe, mae,
      labelEndTs: endDate,     // exact label end — what exactPurge() needs
      outcomeVersion: OUTCOME_VERSION,
    }),
  };
}

// Grade a whole stored DecisionSnapshot. `priceLookup(ticker)` returns candles (or null).
// RULE 3: rejected predictions are graded exactly like selected ones.
function gradeSnapshot(snapshot, priceLookup, ctx = {}) {
  const preds = (snapshot && snapshot.predictions) || [];
  const outcomes = [];
  const pending = [];
  const invalid = [];

  for (const p of preds) {
    const candles = typeof priceLookup === 'function' ? priceLookup(p.ticker) : null;
    // Sector candles resolve PER TICKER (each name maps to its own sector ETF), so the
    // residual is sector-relative not market-relative. Falls back to a fixed ctx.sectorCandles
    // and then null, preserving the pre-sectorLookup behavior for existing callers.
    const sectorCandles = typeof ctx.sectorLookup === 'function' ? ctx.sectorLookup(p.ticker) : (ctx.sectorCandles || null);
    const r = gradePrediction(p, { ...ctx, candles, sectorCandles });
    if (r.pending) { pending.push({ predictionId: p.predictionId, ticker: p.ticker, reason: r.pending }); continue; }
    const v = S.validateExecutableOutcome(r.outcome);
    if (!v.valid) { invalid.push({ predictionId: p.predictionId, errors: v.errors }); continue; }
    outcomes.push(r.outcome);
  }

  const filled = outcomes.filter(o => o.fillStatus === 'filled');
  return Object.freeze({
    schema: 'OutcomeBatch', version: OUTCOME_VERSION,
    decisionTs: (snapshot && snapshot.decisionTs) || null,
    gradedAsOf: ctx.asOf || null,
    nPredictions: preds.length,
    nGraded: outcomes.length,
    nFilled: filled.length,
    nUnfilled: outcomes.length - filled.length,
    nPending: pending.length,
    outcomes: Object.freeze(outcomes),
    pending: Object.freeze(pending),
    invalid: Object.freeze(invalid),
    // Grading observes; it never edits the predictions it read.
    mutatesPredictions: false,
  });
}

module.exports = {
  OUTCOME_VERSION, HORIZON_BARS,
  windowReturn, excursions, gradePrediction, gradeSnapshot,
};
