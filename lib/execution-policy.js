'use strict';
// EXECUTION POLICY — canonical, versioned fill model for daily close-derived signals.
//
// WHY: a signal computed from day T's CLOSE cannot be filled at that same close — you only
// learn the features after the close, so the earliest tradeable price is the NEXT session's
// open. Historically resolveTrade/backtests entered at the signal-day close (`entry ||
// candles[idx].close`), which quietly credits a fill nobody could get. This module makes the
// execution assumption explicit, named, and testable, so every backtest can share ONE honest
// entry model instead of each re-deriving (or omitting) it.
//
// Pure & dependency-free of network/clock. Slippage/spread magnitudes are REUSED from
// lib/costs.js so there is a single source of truth for friction (no parallel numbers).
//
// This module ONLY plans the entry fill. Barrier resolution (stops/targets after the fill)
// stays in lib/outcome.js — the fill this returns is what a resolver should enter on.

const { TIERS } = require('./costs');

const EXECUTION_POLICY_VERSION = 'exec-v1';

// Named policies. Each decides WHICH bar and WHAT price a signal fills at (or that it does
// not fill). NEXT_OPEN_PLUS_SLIPPAGE is the honest default for daily research.
const POLICIES = Object.freeze({
  NEXT_OPEN: 'NEXT_OPEN',                                   // next session's open, no friction
  NEXT_OPEN_PLUS_SLIPPAGE: 'NEXT_OPEN_PLUS_SLIPPAGE',       // next open, adverse entry-side slippage
  NEXT_SESSION_VWAP: 'NEXT_SESSION_VWAP',                   // next session VWAP proxy (typical price) — inferred
  BREAKOUT_STOP: 'BREAKOUT_STOP',                           // stop-entry: fills only if the trigger is touched
  PULLBACK_LIMIT: 'PULLBACK_LIMIT',                         // limit-entry: fills only if price pulls back to the limit
  MARKET_ON_CLOSE_PRECOMMITTED: 'MARKET_ON_CLOSE_PRECOMMITTED', // same-close, ONLY for a pre-committed MOC order
});
const DEFAULT_POLICY = POLICIES.NEXT_OPEN_PLUS_SLIPPAGE;

// Entry-side (one-leg) friction as a FRACTION of price, from the cost tiers. Half of the
// round-trip charged by lib/costs.js — the exit leg is charged at resolution, never here, so
// the two layers do not double-count.
function perSideSlippagePct(tier) {
  const t = TIERS[tier] || TIERS.liquid;
  return (t.halfSpreadBps + t.slippageBps) / 10000;
}
function halfSpreadPct(tier) {
  const t = TIERS[tier] || TIERS.liquid;
  return t.halfSpreadBps / 10000;
}

// Index of the signal bar: the last bar on/before the signal date (features are known at its
// close). -1 if the date precedes all candles.
function signalBarIndex(candles, signalDate) {
  let idx = -1;
  for (let k = candles.length - 1; k >= 0; k--) {
    if (candles[k].date <= signalDate) { idx = k; break; }
  }
  return idx;
}

const px = (bar, field) => (bar && Number.isFinite(bar[field]) && bar[field] > 0 ? bar[field] : null);
const openOf = (bar) => px(bar, 'open') != null ? bar.open : px(bar, 'close'); // fall back to close if no open

// An outcome shape for "did not fill" — never fabricate a price.
function unfilled(base, reason) {
  return { ...base, filled: false, fillIdx: null, fillPrice: null, referencePrice: null, fillReason: reason };
}

// Plan the entry fill for a signal.
//
//   candles    : [{date,open,high,low,close,volume}] oldest→newest
//   signalDate : ISO date of the signal bar (features from its close)
//   opts       : { policy, side:'long'|'short', tier, slippagePct?, trigger?, version? }
//
// Returns a fully explicit fill record; `filled:false` (with a reason and null price) when the
// policy's condition is not met or the next session's data is missing — a real backtest must
// treat that as no trade, not a fabricated fill.
function planFill(candles, signalDate, opts = {}) {
  const policy = opts.policy || DEFAULT_POLICY;
  const side = opts.side === 'short' ? 'short' : 'long';
  const tier = opts.tier || 'liquid';
  const version = opts.version || EXECUTION_POLICY_VERSION;

  const base = {
    version, policy, side, signalDate,
    slippagePct: 0, spreadPct: halfSpreadPct(tier),
    participationPct: null, // unknown on an EOD feed — reported honestly, never invented
    timestamps: {
      featureCutoffAt: signalDate,     // regular-session close on the signal day
      signalGeneratedAt: signalDate,
      earliestExecutableAt: null,      // next valid session (filled below)
      assumedFillAt: null,
      basis: 'daily-close-derived',
    },
    assumptions: [],
  };

  if (!Array.isArray(candles) || !candles.length) {
    return unfilled({ ...base, earliestFillDate: null }, 'no-candles');
  }
  const sigIdx = signalBarIndex(candles, signalDate);

  // MARKET_ON_CLOSE_PRECOMMITTED — the ONLY policy that fills at the signal-day close, and only
  // valid if the caller has proven the features were available before the MOC order cutoff.
  if (policy === POLICIES.MARKET_ON_CLOSE_PRECOMMITTED) {
    if (sigIdx < 0) return unfilled({ ...base, earliestFillDate: null }, 'no-signal-bar');
    const sig = candles[sigIdx];
    const ref = px(sig, 'close');
    if (ref == null) return unfilled({ ...base, earliestFillDate: null }, 'no-close-price');
    base.timestamps.earliestExecutableAt = signalDate;
    base.timestamps.assumedFillAt = signalDate;
    base.assumptions.push('fills at signal-day close — VALID ONLY for a pre-committed market-on-close order whose features cleared the order cutoff');
    return { ...base, earliestFillDate: sig.date, fillIdx: sigIdx, filled: true, fillPrice: ref, referencePrice: ref, fillReason: 'moc-precommitted' };
  }

  // All other policies enter no earlier than the NEXT session.
  const nextIdx = sigIdx + 1;
  const next = candles[nextIdx];
  if (sigIdx < 0 || !next) {
    return unfilled({ ...base, earliestFillDate: null }, sigIdx < 0 ? 'no-signal-bar' : 'no-next-session');
  }
  base.earliestFillDate = next.date;
  base.timestamps.earliestExecutableAt = next.date;
  base.timestamps.assumedFillAt = next.date;

  const nextOpen = openOf(next);
  if (nextOpen == null) return unfilled(base, 'no-next-open');

  // Adverse slippage moves the fill AGAINST the trader: a long pays up, a short sells down.
  const applySlip = (price, slip) => side === 'long' ? price * (1 + slip) : price * (1 - slip);

  switch (policy) {
    case POLICIES.NEXT_OPEN: {
      base.assumptions.push('fills at the next session open, no slippage');
      return { ...base, fillIdx: nextIdx, filled: true, referencePrice: nextOpen, fillPrice: +nextOpen.toFixed(4), fillReason: 'next-open' };
    }
    case POLICIES.NEXT_OPEN_PLUS_SLIPPAGE: {
      const slip = Number.isFinite(opts.slippagePct) ? opts.slippagePct : perSideSlippagePct(tier);
      const fill = applySlip(nextOpen, slip);
      base.slippagePct = +slip.toFixed(6);
      base.assumptions.push(`fills at the next session open with ${(slip * 100).toFixed(2)}% adverse entry-side slippage (${tier} tier)`);
      return { ...base, fillIdx: nextIdx, filled: true, referencePrice: nextOpen, fillPrice: +fill.toFixed(4), fillReason: 'next-open+slippage' };
    }
    case POLICIES.NEXT_SESSION_VWAP: {
      const h = px(next, 'high'), l = px(next, 'low'), c = px(next, 'close');
      const typical = (h != null && l != null && c != null) ? (h + l + c) / 3 : nextOpen;
      base.assumptions.push('VWAP approximated by the next session typical price (H+L+C)/3 — inferred, not a true intraday VWAP');
      return { ...base, fillIdx: nextIdx, filled: true, referencePrice: typical, fillPrice: +typical.toFixed(4), fillReason: 'next-session-vwap-proxy' };
    }
    case POLICIES.BREAKOUT_STOP: {
      const trigger = opts.trigger;
      if (!Number.isFinite(trigger) || trigger <= 0) return unfilled(base, 'no-trigger');
      const hi = px(next, 'high'), lo = px(next, 'low');
      const slip = Number.isFinite(opts.slippagePct) ? opts.slippagePct : perSideSlippagePct(tier);
      if (side === 'long') {
        if (hi == null || hi < trigger) return unfilled(base, 'trigger-not-touched'); // never traded above the stop
        // Gap through the trigger fills at the (worse) open; otherwise at the trigger.
        const ref = nextOpen > trigger ? nextOpen : trigger;
        base.slippagePct = +slip.toFixed(6);
        base.assumptions.push(nextOpen > trigger ? 'gapped through the breakout trigger — filled at the next open' : 'filled at the breakout trigger');
        return { ...base, fillIdx: nextIdx, filled: true, referencePrice: ref, fillPrice: +applySlip(ref, slip).toFixed(4), fillReason: nextOpen > trigger ? 'gap-through-trigger' : 'stop-trigger' };
      }
      if (lo == null || lo > trigger) return unfilled(base, 'trigger-not-touched'); // short breakdown-stop
      const ref = nextOpen < trigger ? nextOpen : trigger;
      base.slippagePct = +slip.toFixed(6);
      base.assumptions.push(nextOpen < trigger ? 'gapped through the breakdown trigger — filled at the next open' : 'filled at the breakdown trigger');
      return { ...base, fillIdx: nextIdx, filled: true, referencePrice: ref, fillPrice: +applySlip(ref, slip).toFixed(4), fillReason: nextOpen < trigger ? 'gap-through-trigger' : 'stop-trigger' };
    }
    case POLICIES.PULLBACK_LIMIT: {
      const trigger = opts.trigger;
      if (!Number.isFinite(trigger) || trigger <= 0) return unfilled(base, 'no-limit');
      const hi = px(next, 'high'), lo = px(next, 'low');
      if (side === 'long') {
        if (lo == null || lo > trigger) return unfilled(base, 'limit-not-touched'); // price never pulled back
        // A limit fills at the limit or better; a gap-down open below the limit fills at the open.
        const ref = nextOpen < trigger ? nextOpen : trigger;
        base.assumptions.push('limit entry — filled at the limit or the better gap-down open (no adverse slippage on a resting limit)');
        return { ...base, fillIdx: nextIdx, filled: true, referencePrice: ref, fillPrice: +ref.toFixed(4), fillReason: 'limit-touched' };
      }
      if (hi == null || hi < trigger) return unfilled(base, 'limit-not-touched');
      const ref = nextOpen > trigger ? nextOpen : trigger;
      base.assumptions.push('short limit entry — filled at the limit or the better gap-up open');
      return { ...base, fillIdx: nextIdx, filled: true, referencePrice: ref, fillPrice: +ref.toFixed(4), fillReason: 'limit-touched' };
    }
    default:
      return unfilled(base, `unknown-policy:${policy}`);
  }
}

module.exports = {
  EXECUTION_POLICY_VERSION, POLICIES, DEFAULT_POLICY,
  planFill, signalBarIndex, perSideSlippagePct, halfSpreadPct,
};
