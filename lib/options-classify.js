'use strict';
// OPTIONS HONEST CLASSIFICATION — the normalized, defensible read of per-contract
// activity from FREE, DELAYED Yahoo option chains. This is the server-side source of
// truth: it produces one normalized observation model per contract and one honest
// directional state, so no downstream screen (or the browser) reconstructs a different,
// more-confident interpretation from raw rows.
//
// SCIENTIFIC HONESTY (the whole point of this module):
//   • Free chain data is DELAYED and has NO trade-level (OPRA) tape. We cannot know if a
//     trade opened or closed, was bought or sold, was a hedge, or was one leg of a
//     spread. So we never assert "smart money", "sweep", or "call buying" as fact.
//   • Calls are NOT bullish and puts are NOT bearish by themselves. A last price near the
//     ASK is supporting (provisional) evidence of aggressive buying; near the BID it is
//     UNKNOWN (could be selling, closing, a spread, or liquidity). Mid/absent = UNKNOWN.
//   • Directional states are PROVISIONAL and reversible, never probabilities.
//
// Pure functions only — no network, no Date.now() in the classifiers (a data timestamp
// is injected). Fully unit-tested.

// ── Honest labels (replace the unsupported tape vocabulary) ──────────────────
// Internal `kind` keys ('sweep'/'block'/'large') are retained by lib/optionsflow for
// back-compat; these are the DISPLAY labels the UI must use instead.
const KIND_LABELS = Object.freeze({
  sweep: 'High-turnover contract',      // was "Sweep" — we only see turnover, not tape
  block: 'Large estimated notional',    // was "Block" — estimated size, not a confirmed print
  large: 'Estimated premium activity',  // was "Large premium"
});
function kindLabel(kind) { return KIND_LABELS[kind] || 'Unusual options activity'; }

// ── Directional states (per contract) ────────────────────────────────────────
const DIRECTION = Object.freeze({
  BULLISH: 'PROVISIONAL_BULLISH',
  BEARISH: 'PROVISIONAL_BEARISH',
  MIXED: 'MIXED',
  UNKNOWN: 'DIRECTION_UNKNOWN',
});
const DIRECTION_LABEL = Object.freeze({
  PROVISIONAL_BULLISH: 'Provisional bullish',
  PROVISIONAL_BEARISH: 'Provisional bearish',
  MIXED: 'Mixed',
  DIRECTION_UNKNOWN: 'Direction unknown',
});

// DTE buckets tuned to swing horizons (the app's primary use). Nearest-expiry activity
// must not dominate a multi-week thesis, so buckets are first-class.
const DTE_BUCKETS = [
  { key: '0-7', label: '0–7 DTE (event/very short-term)', max: 7 },
  { key: '8-20', label: '8–20 DTE (short swing)', max: 20 },
  { key: '21-45', label: '21–45 DTE (primary swing)', max: 45 },
  { key: '46-75', label: '46–75 DTE (position)', max: 75 },
  { key: '75+', label: '> 75 DTE (long-duration context)', max: Infinity },
];
function dteBucket(dte) {
  if (dte == null || !Number.isFinite(dte)) return null;
  for (const b of DTE_BUCKETS) if (dte <= b.max) return b.key;
  return '75+';
}

// ── Numeric helpers ──────────────────────────────────────────────────────────
// Volume vs open interest, BOUNDED. Volume on zero prior OI is genuinely-new
// positioning, but Infinity/null must never reach scoring — we cap it and carry a
// separate flag so the "new on zero OI" fact is preserved without a degenerate number.
const VOLOI_ZERO_OI_CAP = 10;   // bounded stand-in for "vol>0 on zero OI"
const VOLOI_MAX = 50;           // hard ceiling so one illiquid contract can't dominate
function volOiBounded(volume, openInterest) {
  const v = Number.isFinite(volume) ? Math.max(0, volume) : 0;
  const oi = Number.isFinite(openInterest) ? Math.max(0, openInterest) : 0;
  if (oi > 0) return Math.min(v / oi, VOLOI_MAX);
  return v > 0 ? VOLOI_ZERO_OI_CAP : 0;
}
function isNewOnZeroOi(volume, openInterest) {
  const oi = Number.isFinite(openInterest) ? openInterest : 0;
  const v = Number.isFinite(volume) ? volume : 0;
  return oi === 0 && v > 0;
}

// Relative bid/ask spread as a % of the mid. null when there is no usable two-sided
// quote (which itself is a data-quality flag).
function spreadPct(bid, ask) {
  if (bid == null || ask == null || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return +(((ask - bid) / mid) * 100).toFixed(1);
}

// Aggressor is treated as RELIABLE only with a real two-sided quote AND a non-degenerate
// spread. A crossed/zero-width/absent quote makes the last-price location meaningless.
function aggressorReliable(bid, ask) {
  if (bid == null || ask == null) return false;
  if (ask <= bid) return false;
  return true;
}

// ── The honest per-contract directional state ────────────────────────────────
// Only aggressive BUYING at the ask, on a reliable quote, earns a provisional
// directional lean (call → bullish, put → bearish). Everything else is UNKNOWN, because
// selling/closing/hedging/spreads are indistinguishable on free data. Ambiguity flags
// (e.g. suspected multi-leg, far-OTM lottery) also force UNKNOWN.
function directionState({ side, aggressor, bid, ask, ambiguous } = {}) {
  if (ambiguous) return DIRECTION.UNKNOWN;
  if (!aggressorReliable(bid, ask)) return DIRECTION.UNKNOWN;
  if (aggressor !== 'ask') return DIRECTION.UNKNOWN;   // bid/mid = selling/closing/liquidity → unknown
  if (side === 'call') return DIRECTION.BULLISH;
  if (side === 'put') return DIRECTION.BEARISH;
  return DIRECTION.UNKNOWN;
}

// Absolute distance from the money as a fraction (0 = ATM). Used for far-OTM detection.
function moneynessAbs(strike, underlying) {
  if (strike == null || underlying == null || underlying <= 0) return null;
  return Math.abs(strike - underlying) / underlying;
}

const WIDE_SPREAD_PCT = 25;   // > this = illiquid / untradeable quote
const FAR_OTM_FRAC = 0.30;    // > 30% from spot = lottery-like
const VERY_SHORT_DTE = 2;     // ≤ this = gamma/expiry noise, not a swing read
const INDEX_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'VXX', 'UVXY', 'TLT', 'HYG', 'GLD', 'SLV', 'XLF', 'XLE', 'XLK', 'SMH']);

// Data-quality + ambiguity flags for one contract. These are the PENALTIES the score
// and the UI must reflect — never silently dropped.
function contractFlags(c = {}) {
  const flags = [];
  const sp = spreadPct(c.bid, c.ask);
  if (c.bid == null || c.ask == null) flags.push('noQuote');
  else if (sp != null && sp > WIDE_SPREAD_PCT) flags.push('wideSpread');
  const mAbs = moneynessAbs(c.strike, c.underlying);
  if (mAbs != null && mAbs > FAR_OTM_FRAC) flags.push('farOtm');
  if (c.dte != null && c.dte <= VERY_SHORT_DTE) flags.push('veryShortDte');
  if (isNewOnZeroOi(c.volume, c.openInterest)) flags.push('newOnZeroOi');
  if (INDEX_ETFS.has(c.ticker)) flags.push('indexHedge');
  if (!aggressorReliable(c.bid, c.ask)) flags.push('unreliableAggressor');
  return flags;
}

// ── Multi-leg / spread cluster detection (aggregate) ─────────────────────────
// We cannot see order linkage on free data, but coordinated contracts on the SAME
// ticker + SAME expiry with opposing types or paired strikes and similar volume are a
// classic spread/complex-order footprint. We MARK them ambiguous rather than force a
// bullish/bearish label. Conservative: only flags when there is a genuine pairing.
function detectMultiLeg(contracts = []) {
  const byExpiry = new Map();
  for (const c of contracts) {
    if (!c || !c.expiry) continue;
    (byExpiry.get(c.expiry) || byExpiry.set(c.expiry, []).get(c.expiry)).push(c);
  }
  const flagged = new Set();
  for (const group of byExpiry.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const volA = a.volume || 0, volB = b.volume || 0;
        if (volA <= 0 || volB <= 0) continue;
        const similarVol = Math.min(volA, volB) / Math.max(volA, volB) >= 0.6;
        if (!similarVol) continue;
        const opposingTypes = a.side !== b.side;           // e.g. call+put = combo/collar
        const differentStrikes = a.strike != null && b.strike != null && a.strike !== b.strike;
        const sameTypeSpread = a.side === b.side && differentStrikes;  // vertical footprint
        if (opposingTypes || sameTypeSpread) { flagged.add(a); flagged.add(b); }
      }
    }
  }
  return flagged;
}

// ── The normalized observation (the source-of-truth record) ──────────────────
// `raw` is a per-contract row (the shape lib/optionsflow.scanChain emits, or a Yahoo
// contract enriched with side/ticker/underlying). `ctx.dataTs` is the injected scan
// time (ISO string) — Yahoo option data is DELAYED, so we always label it as such and
// never call it "live". `ctx.ambiguous` overrides direction to UNKNOWN (multi-leg).
function normalizeObservation(raw = {}, ctx = {}) {
  const bid = raw.bid ?? null, ask = raw.ask ?? null;
  const flags = contractFlags(raw);
  const ambiguous = !!ctx.ambiguous || flags.includes('farOtm');
  const allFlags = ambiguous && !flags.includes('suspectedMultiLeg') && ctx.ambiguous
    ? [...flags, 'suspectedMultiLeg'] : flags;
  const dir = directionState({ side: raw.side, aggressor: raw.aggressor, bid, ask, ambiguous });
  return {
    ticker: raw.ticker ?? null,
    contractSymbol: raw.contractSymbol ?? null,
    side: raw.side ?? null,                 // 'call' | 'put'
    strike: raw.strike ?? null,
    expiry: raw.expiry ?? null,
    dte: raw.dte ?? null,
    dteBucket: dteBucket(raw.dte),
    underlying: raw.underlying ?? null,
    moneyness: raw.moneyness ?? null,
    moneynessAbs: moneynessAbs(raw.strike, raw.underlying),
    bid, ask,
    lastPrice: raw.lastPrice ?? null,
    volume: raw.volume ?? 0,
    openInterest: raw.openInterest ?? 0,
    volOiBounded: volOiBounded(raw.volume, raw.openInterest),
    newOnZeroOi: isNewOnZeroOi(raw.volume, raw.openInterest),
    estNotional: raw.premium ?? null,       // estimated, not confirmed traded dollars
    spreadPct: spreadPct(bid, ask),
    quoteTs: raw.lastTradeTs ?? null,       // last trade time from the chain (delayed)
    dataTs: ctx.dataTs ?? null,             // when we scanned (injected)
    dataDelayed: true,                      // free Yahoo chains are ALWAYS delayed
    aggressor: raw.aggressor ?? null,       // 'ask' | 'bid' | 'mid' | null
    aggressorReliable: aggressorReliable(bid, ask),
    directionState: dir,
    directionLabel: DIRECTION_LABEL[dir],
    earningsBeforeExpiry: raw.earningsBeforeExpiry ?? null,
    earningsInDays: raw.earningsInDays ?? null,
    ambiguityFlags: allFlags,
    kind: raw.kind ?? null,
    kindLabel: kindLabel(raw.kind),
  };
}

// ── Aggregate directional state for a set of observations (per ticker) ───────
// MIXED emerges here: when both provisional-bullish and provisional-bearish notional are
// material, the honest read is MIXED — not a net lean. If only UNKNOWN evidence exists,
// the read is DIRECTION_UNKNOWN. Weighted by estimated notional (bounded, never null).
function aggregateDirection(observations = []) {
  let bull = 0, bear = 0, unknown = 0;
  for (const o of observations) {
    const w = Math.max(0, o.estNotional || 0) + 1;   // +1 so count matters when notional ~0
    if (o.directionState === DIRECTION.BULLISH) bull += w;
    else if (o.directionState === DIRECTION.BEARISH) bear += w;
    else unknown += w;
  }
  const directional = bull + bear;
  const total = directional + unknown;
  if (total === 0) return { state: DIRECTION.UNKNOWN, bull: 0, bear: 0, unknownShare: 1 };
  const unknownShare = +(unknown / total).toFixed(2);
  // If the directional evidence is a small slice of everything, it's UNKNOWN overall.
  if (directional === 0 || directional / total < 0.2) {
    return { state: DIRECTION.UNKNOWN, bull, bear, unknownShare };
  }
  const lean = bull / directional;
  let state;
  if (lean >= 0.65) state = DIRECTION.BULLISH;
  else if (lean <= 0.35) state = DIRECTION.BEARISH;
  else state = DIRECTION.MIXED;
  return { state, bull, bear, unknownShare, stateLabel: DIRECTION_LABEL[state] };
}

module.exports = {
  KIND_LABELS, kindLabel, DIRECTION, DIRECTION_LABEL, DTE_BUCKETS, INDEX_ETFS,
  VOLOI_ZERO_OI_CAP, VOLOI_MAX, WIDE_SPREAD_PCT, FAR_OTM_FRAC, VERY_SHORT_DTE,
  dteBucket, volOiBounded, isNewOnZeroOi, spreadPct, aggressorReliable, moneynessAbs,
  directionState, contractFlags, detectMultiLeg, normalizeObservation, aggregateDirection,
};
