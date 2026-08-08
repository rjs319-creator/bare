'use strict';
// OPTIONS TRADE GATE v2 — the INDEPENDENT price-confirmation gate.
//
// Unusual options activity NEVER creates an actionable signal by itself. The gate
// joins three independent inputs — (1) the anomaly event, (2) the cautious
// interpretation, (3) the chart-math stock setup (lib/stock-setup, price only) —
// and emits ONE trade status per event, the exact gate version stamped on it.
//
// PRICE_CONFIRMED requires ALL of (configurable in lib/options-config-v2, and
// explicitly labeled initial hypotheses, not proven thresholds):
//   anomalyScore ≥ 80, dataQuality ≥ 80, acceptable liquidity, a non-UNKNOWN /
//   non-MIXED direction, no unresolved spread/hedge read, an independently VALID
//   stock setup whose direction the options lean does not contradict, the price
//   trigger actually reached, fresh data, no disqualifying event risk, a complete
//   plan (entry/invalidation/target/time stop), and acceptable extension + R:R.
//
// STOCK vs OPTION execution: the gate's plan is for the UNDERLYING. Trading an
// option instead runs a separate contract-selection pass with its own liquidity/
// DTE/theta rules; when no responsible contract exists we SAY SO. We never
// recommend naked short options.
//
// Pure + deterministic; session/config injected.

const { TRADE_STATUS, TRADE_LABEL, TRADE_GATE, CONTRACT_SELECT, INTERPRETATION } = require('./options-config-v2');
const { interpretationSide } = require('./options-interpret-v2');

const r2 = v => (v == null ? null : +(+v).toFixed(2));

function setupSideOf(setup) {
  if (!setup || !setup.valid) return null;
  return setup.direction === 'long' ? 'bullish' : setup.direction === 'short' ? 'bearish' : null;
}

// Has the price trigger been reached (with the spot the SETUP was computed from)?
function triggerReached(setup) {
  if (!setup || !setup.valid || setup.trigger == null || setup.spot == null) return false;
  return setup.direction === 'long' ? setup.spot >= setup.trigger : setup.spot <= setup.trigger;
}

function triggerProximityPct(setup) {
  if (!setup || setup.trigger == null || setup.spot == null || setup.spot <= 0) return null;
  return +((Math.abs(setup.trigger - setup.spot) / setup.spot) * 100).toFixed(2);
}

// Extension past the trigger in ATRs — chase risk when large.
function extensionAtr(setup) {
  if (!setup || !setup.valid || setup.trigger == null || setup.spot == null || !setup.atr) return null;
  const past = setup.direction === 'long' ? setup.spot - setup.trigger : setup.trigger - setup.spot;
  return past > 0 ? +(past / setup.atr).toFixed(2) : 0;
}

function planComplete(setup) {
  return !!(setup && setup.valid && setup.trigger != null && setup.invalidation != null && setup.target != null && setup.rr != null);
}

/**
 * Decide the trade status for one event.
 * @param {{anomalyScore:number, dataQuality:number, liquidityQuality:number,
 *          activityStatus:string}} anomaly
 * @param {{state:string, confidence:number}} interpretation
 * @param {object|null} setup evaluateSetup() output
 * @param {{earningsInDays?:number|null, sessionsSinceSeen?:number, dataStale?:boolean,
 *          gate?:object}} ctx
 */
function decideTradeStatus(anomaly, interpretation, setup, ctx = {}) {
  const gate = ctx.gate || TRADE_GATE;
  const reasons = [];
  const blockers = [];   // "what would make this tradeable" is derived from these
  const iState = interpretation ? interpretation.state : INTERPRETATION.UNKNOWN;
  const side = interpretationSide(iState);
  const sSide = setupSideOf(setup);

  // Terminal / risk states first.
  if (ctx.dataStale || (ctx.sessionsSinceSeen != null && ctx.sessionsSinceSeen >= gate.staleAfterSessions)) {
    return result(TRADE_STATUS.STALE, ['Event has gone stale — activity no longer observed or data too old.'], [], gate);
  }
  if (setup && setup.valid && setup.invalidation != null && setup.spot != null) {
    const busted = setup.direction === 'long' ? setup.spot < setup.invalidation : setup.spot > setup.invalidation;
    if (busted) return result(TRADE_STATUS.INVALIDATED, [`Spot ${setup.spot} is beyond the invalidation level ${setup.invalidation}.`], [], gate);
  }
  if (ctx.earningsInDays != null && ctx.earningsInDays >= 0 && ctx.earningsInDays <= gate.earningsAvoidDays) {
    return result(TRADE_STATUS.AVOID_EVENT_RISK, [`Earnings in ${ctx.earningsInDays} session(s) — binary event risk disqualifies a fresh entry.`],
      ['Wait until the earnings event has passed.'], gate);
  }

  // Structure/direction states.
  if (iState === INTERPRETATION.POSSIBLE_SPREAD) {
    return result(TRADE_STATUS.POSSIBLE_SPREAD, ['Activity matches a spread/multi-leg footprint — net direction unresolved.'],
      ['Direction evidence that is not explained by paired legs.'], gate);
  }
  if (iState === INTERPRETATION.POSSIBLE_HEDGE) {
    return result(TRADE_STATUS.POSSIBLE_HEDGE, ['Activity matches a hedging footprint — not directional conviction.'],
      ['Evidence the positioning is outright rather than protective.'], gate);
  }
  if (iState === INTERPRETATION.MIXED) {
    return result(TRADE_STATUS.MIXED, ['Two-sided activity — no net read.'], ['One side of the flow clearly dominating.'], gate);
  }

  // Contradiction beats support.
  if (sSide && side !== 'neutral' && side !== sSide) {
    return result(TRADE_STATUS.CONTRADICTS_SETUP,
      [`Options lean (${side}, provisional) opposes the ${setup.direction} price setup.`],
      ['Alignment between the options lean and the price setup.'], gate);
  }

  // No independent setup → the event is context, never actionable.
  if (!setup || !setup.valid) {
    if (side === 'neutral') {
      return result(TRADE_STATUS.NO_DIRECTION, ['Direction unknown and no independent stock setup — activity is context only.'],
        ['A valid price setup AND direction evidence.'], gate);
    }
    return result(TRADE_STATUS.ACTIVITY_ONLY, ['Unusual activity with a provisional lean, but no independent stock setup to confirm it.'],
      ['A valid chart setup in the lean\'s direction, then a price trigger.'], gate);
  }

  // Setup exists but direction unknown → still just watch/context (options add nothing directional).
  if (side === 'neutral') {
    return result(TRADE_STATUS.NO_DIRECTION,
      ['Options direction is unknown — the setup stands on its own; the activity is context only.'],
      ['Direction evidence from the options (or trade the setup on price evidence alone, outside this page).'], gate);
  }

  // Aligned provisional lean + valid setup: gate the remaining quality bars.
  const checks = [
    { ok: (anomaly.anomalyScore ?? 0) >= gate.minAnomalyScore || anomaly.activityStatus === 'EXCEPTIONAL', why: `anomaly score ${anomaly.anomalyScore ?? 'n/a'} below ${gate.minAnomalyScore}` },
    { ok: (anomaly.dataQuality ?? 0) >= gate.minDataQuality, why: `data quality ${anomaly.dataQuality} below ${gate.minDataQuality}` },
    { ok: (anomaly.liquidityQuality ?? 0) >= gate.minLiquidityQuality, why: `liquidity quality ${anomaly.liquidityQuality} below ${gate.minLiquidityQuality}` },
    { ok: planComplete(setup), why: 'incomplete trade plan (trigger/invalidation/target/R:R)' },
    { ok: setup.rr == null || setup.rr >= gate.minRewardRisk, why: `reward:risk ${setup.rr} below ${gate.minRewardRisk}` },
  ];
  for (const c of checks) if (!c.ok) blockers.push(c.why);

  const ext = extensionAtr(setup);
  if (ext != null && ext > gate.maxExtensionAtrMult) blockers.push(`extended ${ext} ATR past the trigger — chase risk`);

  if (blockers.length) {
    reasons.push('Aligned lean and setup, but quality/plan gates are not met.');
    return result(TRADE_STATUS.WATCH_FOR_PRICE_TRIGGER, reasons, blockers, gate);
  }

  if (!triggerReached(setup)) {
    const prox = triggerProximityPct(setup);
    const near = prox != null && prox <= gate.triggerProximityPct;
    reasons.push(`All gates pass; price has ${near ? 'nearly ' : 'not '}reached the trigger (${prox != null ? prox + '% away' : 'distance unknown'}).`);
    return result(near ? TRADE_STATUS.READY : TRADE_STATUS.WATCH_FOR_PRICE_TRIGGER, reasons,
      [`Price ${setup.direction === 'long' ? 'above' : 'below'} the trigger ${setup.trigger}.`], gate);
  }

  reasons.push('Independent price trigger reached with all quality gates met.');
  reasons.push(`Options direction is provisional on delayed data — the SETUP carries the trade; options are supportive, unverified evidence.`);
  return result(TRADE_STATUS.PRICE_CONFIRMED, reasons, [], gate);
}

function result(status, reasons, blockers, gate) {
  return {
    tradeStatus: status,
    tradeLabel: TRADE_LABEL[status],
    gateVersion: gate.version || TRADE_GATE.version,
    reasons,
    whatWouldMakeTradeable: blockers,
    actionable: status === TRADE_STATUS.PRICE_CONFIRMED,
  };
}

// The complete UNDERLYING trade plan attached to actionable/near-actionable events.
function stockPlan(setup, { gate = TRADE_GATE } = {}) {
  if (!planComplete(setup)) return null;
  return {
    vehicle: 'stock',
    direction: setup.direction,
    entryTrigger: setup.trigger,
    invalidation: setup.invalidation,
    target: setup.target,
    rewardRisk: setup.rr,
    timeStopSessions: gate.timeStopSessions,
    note: 'Levels are chart math on the underlying — independent of the options activity.',
  };
}

// ── Option-contract selection (only when the user asks "trade the option") ────
// Selects a responsible contract from the observed rows, or honestly refuses.
// NEVER the raw unusual contract by default, and NEVER a naked short option.
function selectOptionContract(contracts, setup, { config = CONTRACT_SELECT } = {}) {
  if (!setup || !setup.valid) return { selected: null, reason: 'no valid underlying setup — no responsible option selection exists' };
  const side = setup.direction === 'long' ? 'call' : 'put';
  const viable = (contracts || []).filter(c => {
    if (c.side !== side) return false;
    if (c.dte == null || c.dte < config.minDte || c.dte > config.maxDte) return false;
    if ((c.openInterest || 0) < config.minOpenInterest) return false;
    if ((c.volume || 0) < config.minVolume) return false;
    if (c.bid == null || c.ask == null || c.ask <= c.bid || c.bid <= 0) return false;
    const spread = ((c.ask - c.bid) / ((c.bid + c.ask) / 2)) * 100;
    if (spread > config.maxSpreadPct) return false;
    if (c.strike == null || !(c.underlying > 0)) return false;
    const m = (c.strike - c.underlying) / c.underlying * (side === 'call' ? 1 : -1);
    // ATM-ish band by moneyness — free chains carry no greeks, so this is a labeled
    // delta PROXY, not a measured delta.
    return m >= config.deltaBandProxy.minMoneyness && m <= config.deltaBandProxy.maxMoneyness;
  });
  if (!viable.length) {
    return {
      selected: null,
      reason: `no listed ${side} passes the liquidity/DTE/moneyness screen (OI ≥ ${config.minOpenInterest}, spread ≤ ${config.maxSpreadPct}%, ${config.minDte}–${config.maxDte} DTE) — trade the stock or stand aside; do not force an illiquid option`,
    };
  }
  viable.sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0));
  const c = viable[0];
  const mid = (c.bid + c.ask) / 2;
  return {
    selected: {
      contractSymbol: c.contractSymbol, side: c.side, strike: c.strike, expiry: c.expiry, dte: c.dte,
      bid: c.bid, ask: c.ask, mid: r2(mid),
      openInterest: c.openInterest, volume: c.volume,
      spreadPct: r2(((c.ask - c.bid) / mid) * 100),
      maxDefinedLossPerContract: r2(mid * 100),
      deltaProxyNote: 'moneyness-based proxy — free chains provide no greeks',
    },
    reason: 'most liquid ATM-ish contract in the swing DTE window; a LONG option only (defined risk)',
  };
}

module.exports = {
  decideTradeStatus, stockPlan, selectOptionContract,
  triggerReached, triggerProximityPct, extensionAtr, planComplete, setupSideOf,
};
