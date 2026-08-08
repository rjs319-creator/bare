'use strict';
// OPTIONS INTERPRETATION v2 — cautious directional & structure reading, decoupled
// from unusualness. An event can be EXCEPTIONAL activity and UNKNOWN direction —
// that combination is common, honest, and useful.
//
// DELAYED-CHAIN RULES (the active source mode):
//   • No strong aggressor-side claims. Last price vs the CURRENT delayed quote is
//     weak evidence only, and only on a reliable, tight, recently-traded quote.
//   • Wide spreads or stale last-trade timestamps reject/downgrade direction.
//   • Calls are NOT bullish because they're OTM; puts are NOT bearish because
//     they're OTM. Moneyness contributes zero direction on its own.
//   • Similar volumes across paired contracts → POSSIBLE_SPREAD (a footprint,
//     never a confirmed spread). Put-dominant flow in index ETFs, or dominated by
//     far-OTM puts, → POSSIBLE_HEDGE.
//   • UNKNOWN is the expected, acceptable default.
//
// REALTIME_TRADE_QUOTE / COMPLEX_ORDER: the interface accepts synchronized-NBBO
// evidence when a configured adapter provides it, but nothing here fabricates it.
// Without such a feed, confidence is HARD-CAPPED (DELAYED_CONF_CAP).
//
// Pure; the scan time is injected. Reuses lib/options-classify primitives.

const oc = require('./options-classify');
const { INTERPRETATION, INTERPRETATION_LABEL, SOURCE_MODE } = require('./options-config-v2');

const DELAYED_CONF_CAP = 55;      // delayed chains can never earn "high" direction confidence
const STALE_TRADE_HOURS = 30;     // last trade older than this vs snapshot = stale print
const WIDE_SPREAD_FRAC = 0.25;    // >25% of mid = untradeable quote, direction rejected
const FAR_OTM_FRAC = 0.20;        // wings past this are hedge/lottery territory
const HEDGE_PUT_SHARE = 0.75;     // put share of notional above this (index or far-OTM) = possible hedge
const MIXED_MINOR_SHARE = 0.30;   // both sides above this share = genuinely two-sided

function spreadFracOf(c) {
  if (c.bid == null || c.ask == null || c.ask <= c.bid) return null;
  const mid = (c.bid + c.ask) / 2;
  return mid > 0 ? (c.ask - c.bid) / mid : null;
}

function isStalePrint(c, nowMs) {
  if (!c.lastTradeTs || !nowMs) return true;
  const ts = c.lastTradeTs < 1e12 ? c.lastTradeTs * 1000 : c.lastTradeTs;
  return (nowMs - ts) / 3_600_000 > STALE_TRADE_HOURS;
}

// Per-contract directional evidence under delayed-chain rules. Returns
// { lean: 'bull'|'bear'|null, weight: 0..1, why } — weight is deliberately small.
function contractEvidence(c, nowMs) {
  const spread = spreadFracOf(c);
  if (spread == null) return { lean: null, weight: 0, why: 'no two-sided quote' };
  if (spread > WIDE_SPREAD_FRAC) return { lean: null, weight: 0, why: 'spread too wide for any read' };
  if (isStalePrint(c, nowMs)) return { lean: null, weight: 0, why: 'stale last print vs current quote' };
  const aggressor = oc.aggressorReliable(c.bid, c.ask)
    ? (c.lastPrice != null ? ((c.lastPrice - c.bid) / (c.ask - c.bid) >= 0.6 ? 'ask' : (c.lastPrice - c.bid) / (c.ask - c.bid) <= 0.4 ? 'bid' : 'mid') : null)
    : null;
  if (aggressor !== 'ask') return { lean: null, weight: 0, why: aggressor === 'bid' ? 'last print at/near bid — could be selling, closing, or a leg' : 'midpoint/unknown print — no side inferable' };
  const lean = c.side === 'call' ? 'bull' : 'bear';
  const weight = spread <= 0.08 ? 1 : spread <= 0.15 ? 0.6 : 0.3;   // tighter quote = slightly stronger tell
  return { lean, weight, why: `last print near the ask on a ${(spread * 100).toFixed(0)}%-wide quote (weak ${lean} evidence)` };
}

// Spread/multi-leg footprint via the shared conservative detector.
function spreadFootprint(contracts) {
  const flagged = oc.detectMultiLeg(contracts.map(c => ({ ...c, ticker: c.ticker || 'X' })));
  return { count: flagged.size, flagged };
}

/**
 * Interpret one ticker's ranked contracts.
 * @param {Array} contracts ranked per-ticker rows (options-anomaly-v2 shape)
 * @param {{nowMs:number, isIndex?:boolean, sourceMode?:string}} ctx
 */
function interpretTicker(contracts, ctx = {}) {
  const rows = contracts || [];
  const nowMs = ctx.nowMs || 0;
  const mode = ctx.sourceMode || SOURCE_MODE.DELAYED_CHAIN;
  const evidenceFor = [], evidenceAgainst = [];

  if (!rows.length) {
    return { state: INTERPRETATION.UNKNOWN, label: INTERPRETATION_LABEL.UNKNOWN, confidence: 0, evidenceFor, evidenceAgainst: ['no active contracts'], sourceMode: mode };
  }

  const totNotional = rows.reduce((s, c) => s + (c.estNotional || 0), 0) || 1;
  const putNotional = rows.filter(c => c.side === 'put').reduce((s, c) => s + (c.estNotional || 0), 0);
  const callNotional = totNotional - putNotional;
  const putShare = putNotional / totNotional;
  const farOtmPutShare = rows
    .filter(c => c.side === 'put' && c.strike != null && c.underlying > 0 && (c.underlying - c.strike) / c.underlying > FAR_OTM_FRAC)
    .reduce((s, c) => s + (c.estNotional || 0), 0) / totNotional;

  // Structure reads FIRST — they override any directional lean.
  const foot = spreadFootprint(rows);
  const spreadSuspected = foot.count >= 2 && foot.count >= rows.length * 0.5;
  const hedgeSuspected = putShare >= HEDGE_PUT_SHARE && (ctx.isIndex || farOtmPutShare >= 0.4);

  // Directional evidence accumulation (delayed rules).
  let bullW = 0, bearW = 0;
  for (const c of rows) {
    const ev = contractEvidence(c, nowMs);
    if (ev.lean === 'bull') { bullW += ev.weight * (c.estNotional || 1); evidenceFor.push(`${c.side} $${c.strike}: ${ev.why}`); }
    else if (ev.lean === 'bear') { bearW += ev.weight * (c.estNotional || 1); evidenceFor.push(`${c.side} $${c.strike}: ${ev.why}`); }
    else if (ev.why) evidenceAgainst.push(`${c.side} $${c.strike != null ? c.strike : '?'}: ${ev.why}`);
  }
  const dirW = bullW + bearW;
  const dirShare = dirW / totNotional;

  let state, confidence;
  if (spreadSuspected) {
    state = INTERPRETATION.POSSIBLE_SPREAD;
    confidence = 0;
    evidenceAgainst.push(`${foot.count} contracts show paired same-expiry volume — a spread/multi-leg footprint (NOT a confirmed spread)`);
  } else if (hedgeSuspected) {
    state = INTERPRETATION.POSSIBLE_HEDGE;
    confidence = 0;
    evidenceAgainst.push(ctx.isIndex
      ? 'index/ETF put-dominant flow is usually portfolio hedging'
      : 'flow dominated by far-OTM puts — a protective-hedge footprint');
  } else if (dirW === 0 || dirShare < 0.15) {
    state = INTERPRETATION.UNKNOWN;
    confidence = 0;
    evidenceAgainst.push('no reliable ask-side evidence on fresh, tight quotes — direction not inferable from delayed chains');
  } else {
    const bullFrac = bullW / dirW;
    const minorShare = Math.min(bullW, bearW) / dirW;
    if (minorShare >= MIXED_MINOR_SHARE) {
      state = INTERPRETATION.MIXED;
      confidence = 0;
      evidenceAgainst.push('material weak evidence on BOTH sides — two-sided or offsetting activity');
    } else {
      state = bullFrac >= 0.5 ? INTERPRETATION.BULLISH_PROVISIONAL : INTERPRETATION.BEARISH_PROVISIONAL;
      // Confidence: share of notional with directional evidence, hard-capped for
      // delayed data. This is confidence THAT THE LEAN IS RIGHT, not a probability
      // the stock moves.
      confidence = Math.min(mode === SOURCE_MODE.DELAYED_CHAIN ? DELAYED_CONF_CAP : 85,
        Math.round(dirShare * 100));
      evidenceAgainst.push('delayed chain data: buyer/seller side is inferred from last-print position only — unverified');
    }
  }

  return {
    state,
    label: INTERPRETATION_LABEL[state],
    confidence,                              // 0-100, capped at 55 on delayed data
    confidenceCap: mode === SOURCE_MODE.DELAYED_CHAIN ? DELAYED_CONF_CAP : null,
    sourceMode: mode,
    callNotional: Math.round(callNotional),
    putNotional: Math.round(putNotional),
    putShare: +putShare.toFixed(2),
    spreadFlaggedContracts: foot.count,
    evidenceFor: evidenceFor.slice(0, 6),
    evidenceAgainst: evidenceAgainst.slice(0, 6),
  };
}

// Coarse side for lifecycle identity / grading (UNKNOWN-family → 'neutral').
function interpretationSide(state) {
  if (state === INTERPRETATION.BULLISH_PROVISIONAL) return 'bullish';
  if (state === INTERPRETATION.BEARISH_PROVISIONAL) return 'bearish';
  return 'neutral';
}

module.exports = {
  interpretTicker, contractEvidence, interpretationSide, spreadFracOf, isStalePrint,
  DELAYED_CONF_CAP, WIDE_SPREAD_FRAC, STALE_TRADE_HOURS,
};
