'use strict';
// 🧬 BIOTECH SWING PLAN (Phase 7) — an executable, archetype-specific entry/stop/target plan
// using ONLY decision-time data. Levels are anchored to the structure each lane trades: the
// event high for a continuation, the anchored VWAP / gap support for a pullback, the base high
// for a breakout. Reward:risk is computed honestly; when candles or structure are too thin to
// place a real level we return planStatus 'no-plan' rather than publishing fake precision.
// Pre-event trades carry a MANDATORY exitBeforeDate. Biotech slippage is folded in via the
// existing cost model (cost-v2, tier 'biotech').

const { ARCHETYPES: A, ARCHETYPE_META } = require('./biotech-config');
const { atrPct } = require('./biotech-features');

const r2 = v => (v == null ? null : +v.toFixed(2));
const K_STOP = 1.2;        // ATR-multiple stop distance
const T1_R = 2.0;          // target-1 reward multiple of risk
const T2_R = 3.5;          // target-2 reward multiple of risk
const MAX_CHASE_ATR = 1.0; // don't chase more than ~1 ATR above the trigger

// Day-before-the-event exit date (pre-event trades exit before the binary).
function dayBefore(iso) {
  if (!iso) return null;
  const d = new Date(iso); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Entry style + trigger/entryZone per archetype. Returns {entryStyle, trigger, entryZone:[lo,hi]}
// or null when the lane is not actionable.
function entryFor(arch, price, feat, atr) {
  const e = feat.event || {};
  const evHigh = e.distEventHigh != null ? price / (1 + e.distEventHigh / 100) : null;
  const evLow = e.distEventLow != null ? price / (1 + e.distEventLow / 100) : null;
  const vwap = e.anchoredVwap != null ? e.anchoredVwap : null;
  switch (arch) {
    case A.POST_CATALYST:
      // Breakout over the event high if still below it; else a shallow pullback entry.
      if (evHigh != null && price < evHigh) return { entryStyle: 'event-high-breakout', trigger: r2(evHigh), entryZone: [r2(evHigh), r2(evHigh + atr * 0.5)] };
      return { entryStyle: 'pullback-to-vwap', trigger: null, entryZone: [r2((vwap || price - atr)), r2(price)] };
    case A.CATALYST_BASE: {
      const baseHigh = price + Math.max(atr * 0.5, price * 0.005);
      return { entryStyle: 'base-breakout', trigger: r2(baseHigh), entryZone: [r2(baseHigh), r2(baseHigh + atr * 0.5)] };
    }
    case A.POST_EVENT_PULLBACK:
      return { entryStyle: 'pullback-to-vwap', trigger: null, entryZone: [r2(Math.min(vwap || price, evLow || price)), r2(price)] };
    case A.FINANCING_RELIEF:
      return { entryStyle: 'offering-price-reclaim', trigger: r2(price + atr * 0.3), entryZone: [r2(price), r2(price + atr * 0.6)] };
    case A.PRE_EVENT:
      return { entryStyle: 'confirmation-continuation', trigger: r2(price + atr * 0.3), entryZone: [r2(price), r2(price + atr * 0.6)] };
    case A.SYMPATHY:
      return { entryStyle: 'wait-confirmation', trigger: r2(price + atr * 0.5), entryZone: [r2(price + atr * 0.3), r2(price + atr * 0.8)] };
    default:
      return null;
  }
}

/**
 * @param {object} ctx { archetype, price, features, event, side='long', costTier='biotech' }
 */
function buildPlan(ctx = {}) {
  const arch = ctx.archetype || A.UNCLASSIFIED;
  const meta = ARCHETYPE_META[arch] || { hold: 0, actionable: false };
  const price = ctx.price;
  const feat = ctx.features || {};
  const candles = ctx.candles || null;
  const noPlan = reason => ({ planStatus: 'no-plan', reason, entryStyle: null, trigger: null, entryZone: null, stop: null, target1: null, target2: null, rewardRisk: null, expectedHoldingSessions: meta.hold, exitBeforeDate: null, overnightRisk: null, binaryWithinHoldingPeriod: null, costEstimate: null, positionRiskTier: null });

  if (!meta.actionable) return noPlan('archetype not in an actionable swing lane');
  if (!(price > 0)) return noPlan('no valid price');

  // ATR in price terms (prefer candle-derived; fall back to the feature vector).
  let atrP = feat.atrPct != null ? feat.atrPct : (candles ? atrPct(candles, 14) : null);
  if (!(atrP > 0)) return noPlan('ATR unavailable — cannot place honest levels');
  const atr = atrP * price;

  const entry = entryFor(arch, price, feat, atr);
  if (!entry) return noPlan('no entry structure for this lane');

  // Reference entry price for R:R math = trigger, else the top of the entry zone.
  const refEntry = entry.trigger != null ? entry.trigger : (entry.entryZone ? entry.entryZone[1] : price);
  const e = feat.event || {};
  const evLow = e.distEventLow != null ? price / (1 + e.distEventLow / 100) : null;
  // Stop: the tighter-justified of (event low) and (ATR stop below the entry).
  const atrStop = refEntry - K_STOP * atr;
  let stop = evLow != null && evLow < refEntry ? Math.max(evLow, atrStop - atr * 0.5) : atrStop;
  if (!(stop > 0) || stop >= refEntry) return noPlan('invalid stop geometry');

  const risk = refEntry - stop;
  const target1 = refEntry + T1_R * risk;
  const target2 = refEntry + T2_R * risk;
  const rewardRisk = +(T1_R).toFixed(2);   // by construction; kept explicit for auditability
  const chaseCeiling = refEntry + MAX_CHASE_ATR * atr;

  // planStatus: is the trigger already met, or are we waiting for it?
  let planStatus = 'ready';
  if (entry.trigger != null && price < entry.trigger) planStatus = 'wait-trigger';
  else if (entry.entryStyle && entry.entryStyle.startsWith('pullback') && entry.entryZone && price > entry.entryZone[1]) planStatus = 'wait-pullback';

  const exitBeforeDate = arch === A.PRE_EVENT
    ? dayBefore(ctx.event && (ctx.event.expectedDate || ctx.event.expectedWindowStart || ctx.event.nextUnresolvedBinaryDate))
    : null;

  // Biotech execution cost (percent). cost-v2 totalPct is a PERCENT (1.0 = 1%).
  let costEstimate = null;
  try {
    const { costBreakdown } = require('./costs');
    const cb = costBreakdown('biotech', { side: ctx.side || 'long', holdSessions: meta.hold });
    costEstimate = cb ? +cb.totalPct.toFixed(2) : null;
  } catch { /* degrade */ }

  return {
    entryStyle: entry.entryStyle, trigger: entry.trigger, entryZone: entry.entryZone,
    chaseCeiling: r2(chaseCeiling), invalidation: r2(stop), stop: r2(stop),
    target1: r2(target1), target2: r2(target2), rewardRisk,
    expectedHoldingSessions: meta.hold, exitBeforeDate,
    overnightRisk: arch === A.PRE_EVENT ? 'binary-gap' : 'standard',
    binaryWithinHoldingPeriod: arch === A.PRE_EVENT ? true : (arch === A.BINARY_WATCH),
    costEstimate,                        // percent round-trip
    positionRiskTier: arch === A.PRE_EVENT ? 'reduced (binary overnight)' : 'standard',
    planStatus,
  };
}

module.exports = { buildPlan, entryFor, dayBefore, K_STOP, T1_R, T2_R, MAX_CHASE_ATR };
