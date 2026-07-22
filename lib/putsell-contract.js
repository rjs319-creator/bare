'use strict';
// REAL LISTED CASH-SECURED-PUT SELECTION.
//
// The price-action screen (lib/putsell.js) finds quality uptrends pulled back to support
// and proposes a MODELED strike. This module turns that into an ACTUAL tradeable
// recommendation using REAL listed contracts from the option chain — never a synthetic
// strike. If no real, liquid contract fits, it returns no contract (the caller shows no
// trade rather than fabricating one).
//
// HONESTY: free chains carry no Greeks, so delta is UNAVAILABLE. We compute a clearly
// LABELED moneyness+IV proxy for the OTM probability and never present it as real delta.
// The executable credit is conservative (the bid, or a configurable fraction inside the
// spread) — you cannot assume you get filled at the mid.
//
// Pure functions — the chain is passed in (no network), the clock is injected.

const DTE_MIN = 25, DTE_MAX = 45, DTE_TARGET = 35;   // preferred CSP expiry window
const DELTA_LO = 0.15, DELTA_HI = 0.25;              // preferred |delta| band (via proxy)
const MIN_OI = 50, MIN_VOLUME = 0;                   // liquidity floors
const MAX_REL_SPREAD = 0.15;                         // 15% bid/ask spread ceiling
const DEFAULT_CREDIT_FRACTION = 0;                   // 0 = conservative bid; up to 1 = mid

// Standard-normal CDF (Abramowitz-Stegun 7.1.26 erf approximation). Deterministic.
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  const cdf = 0.5 * (1 + Math.sign(x) * y);
  return Math.min(1, Math.max(0, cdf));
}

// LABELED proxy for a short OTM put's |delta| ≈ risk-neutral P(finish ITM). Uses
// moneyness, IV and DTE only. NOT a real greek — always carried with isProxy:true.
function deltaProxy({ spot, strike, iv, dte } = {}) {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(dte > 0)) return { value: null, isProxy: true, basis: 'insufficient-data' };
  const t = dte / 365;
  const sigma = iv * Math.sqrt(t);
  if (!(sigma > 0)) return { value: null, isProxy: true, basis: 'insufficient-data' };
  // d2 of Black-Scholes with zero drift; P(S_T < K) = N(-d2). For a put that's ~|delta|.
  const d2 = (Math.log(spot / strike)) / sigma - 0.5 * sigma;
  const value = normCdf(-d2);
  return { value: +value.toFixed(3), isProxy: true, basis: 'moneyness+IV (no listed greeks)' };
}

function relSpread(bid, ask) {
  if (bid == null || ask == null || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid : null;
}

// Conservative executable credit: the bid, or `fraction` of the way from bid→mid.
function executableCredit(bid, ask, fraction = DEFAULT_CREDIT_FRACTION) {
  if (bid == null || bid <= 0) return null;
  if (ask == null || ask < bid) return bid;
  const mid = (bid + ask) / 2;
  return +(bid + Math.max(0, Math.min(1, fraction)) * (mid - bid)).toFixed(2);
}

// Choose the real expiry closest to the target DTE, preferring the [min,max] window;
// falls back to the closest available expiry when nothing lands in-window.
function selectExpiry(expirationDates = [], nowSec = 0, { min = DTE_MIN, max = DTE_MAX, target = DTE_TARGET } = {}) {
  const cands = expirationDates
    .map(ts => ({ ts, dte: (ts - nowSec) / 86_400 }))
    .filter(c => c.dte > 0);
  if (!cands.length) return null;
  const inWindow = cands.filter(c => c.dte >= min && c.dte <= max);
  const pool = inWindow.length ? inWindow : cands;
  pool.sort((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target));
  return { ts: pool[0].ts, dte: Math.round(pool[0].dte), inWindow: inWindow.length > 0 };
}

// Select the best REAL put contract from a chain's puts[] for this setup. Requires a
// strike below support with an OTM cushion, acceptable liquidity + spread, and prefers the
// proxy-delta band. Returns { contract, proxyDelta, spreadPct, credit } or { contract:null, reason }.
function selectPutContract(puts = [], ctx = {}, opts = {}) {
  const { spot, supportPx, dte, iv } = ctx;
  const creditFraction = opts.creditFraction != null ? opts.creditFraction : DEFAULT_CREDIT_FRACTION;
  const minOi = opts.minOi != null ? opts.minOi : MIN_OI;
  const maxSpread = opts.maxRelSpread != null ? opts.maxRelSpread : MAX_REL_SPREAD;
  if (!(spot > 0)) return { contract: null, reason: 'no-underlying-price' };

  const ceilingStrike = supportPx != null ? Math.min(supportPx, spot) : spot;   // must be below support & spot
  const candidates = [];
  for (const p of puts) {
    if (!p || p.strike == null || p.strike <= 0 || p.strike >= ceilingStrike) continue;   // OTM, below support
    const bid = p.bid ?? null, ask = p.ask ?? null;
    const credit = executableCredit(bid, ask, creditFraction);
    if (credit == null || credit <= 0) continue;                                           // needs a real bid
    const sp = relSpread(bid, ask);
    if (sp == null || sp > maxSpread) continue;                                            // tradeable spread
    const oi = Number.isFinite(p.openInterest) ? p.openInterest : 0;
    if (oi < minOi) continue;                                                              // liquidity floor
    const pd = deltaProxy({ spot, strike: p.strike, iv: p.impliedVolatility ?? iv, dte });
    candidates.push({ contract: p, credit, spreadPct: sp != null ? +(sp * 100).toFixed(1) : null, proxyDelta: pd, oi });
  }
  if (!candidates.length) return { contract: null, reason: 'no-liquid-otm-put-below-support' };

  // Prefer contracts whose proxy delta is in the target band; then closest to band midpoint;
  // then higher credit yield. Contracts with no proxy fall back to closest-to-support.
  const bandMid = (DELTA_LO + DELTA_HI) / 2;
  candidates.sort((a, b) => {
    const ain = a.proxyDelta.value != null && a.proxyDelta.value >= DELTA_LO && a.proxyDelta.value <= DELTA_HI ? 0 : 1;
    const bin = b.proxyDelta.value != null && b.proxyDelta.value >= DELTA_LO && b.proxyDelta.value <= DELTA_HI ? 0 : 1;
    if (ain !== bin) return ain - bin;
    const ad = a.proxyDelta.value != null ? Math.abs(a.proxyDelta.value - bandMid) : 1;
    const bd = b.proxyDelta.value != null ? Math.abs(b.proxyDelta.value - bandMid) : 1;
    if (ad !== bd) return ad - bd;
    return (b.credit / b.contract.strike) - (a.credit / a.contract.strike);
  });
  return candidates[0];
}

// Full cash-secured-put economics for a chosen REAL contract (per one contract = 100 sh).
function putEconomics({ strike, credit }, { spot, supportPx, dte } = {}) {
  if (!(strike > 0) || !(credit > 0)) return null;
  const cashRequired = +(strike * 100).toFixed(2);
  const maxProfit = +(credit * 100).toFixed(2);
  const breakeven = +(strike - credit).toFixed(2);
  const returnOnCash = +((credit / strike) * 100).toFixed(2);            // % on secured cash if it expires worthless
  const annualizedYield = dte > 0 ? +((credit / strike) * (365 / dte) * 100).toFixed(1) : null;
  const distanceToSupportPct = supportPx > 0 ? +(((supportPx - strike) / supportPx) * 100).toFixed(1) : null;
  const distanceToBreakevenPct = spot > 0 ? +(((spot - breakeven) / spot) * 100).toFixed(1) : null;   // cushion before underwater
  return {
    cashRequired, maxProfit, breakeven, returnOnCash, annualizedYield,
    distanceToSupportPct, distanceToBreakevenPct,
    assignmentPrice: strike,                                              // you buy at the strike if assigned
    assignmentDiscountPct: spot > 0 ? +(((spot - strike) / spot) * 100).toFixed(1) : null,
    effectiveCostBasis: breakeven,                                       // strike minus the credit collected
  };
}

// Deterministic management rules for a CSP (not advice — a consistent plan). Earnings
// handling depends on whether the trade crosses a report.
function managementRules({ dte, earningsInDays } = {}) {
  const crossesEarnings = earningsInDays != null && earningsInDays >= 0 && earningsInDays <= (dte || 0);
  return {
    profitTake: 'Close at ~50% of max credit (buy the put back) — most of the theta is captured with time left.',
    maxLoss: 'Exit if the put loses ~2x the credit collected, or the bullish/neutral thesis is invalidated.',
    supportBreak: 'If the underlying closes below the support level, close or roll down-and-out — the setup that justified the strike is gone.',
    exitRollDte: 'Manage at ~21 DTE: close, or roll to the next cycle if the setup still holds — avoid gamma risk into expiry.',
    earningsHandling: crossesEarnings
      ? 'This trade CROSSES an earnings report before expiry — binary IV-crush/gap risk. Treat as an event trade, size down, or avoid.'
      : 'No earnings before expiry — a standard premium-collection trade.',
    crossesEarnings,
  };
}

module.exports = {
  DTE_MIN, DTE_MAX, DTE_TARGET, DELTA_LO, DELTA_HI, MIN_OI, MAX_REL_SPREAD,
  normCdf, deltaProxy, relSpread, executableCredit, selectExpiry, selectPutContract,
  putEconomics, managementRules,
};
