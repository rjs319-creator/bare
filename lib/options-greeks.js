'use strict';
// OPTIONS GREEKS — model-derived Black-Scholes greeks + implied volatility.
//
// WHY THIS EXISTS. Free delayed chains (Yahoo) carry an implied volatility per contract but
// no greeks, so `greeksCapability()` used to refuse. CBOE's delayed chain supplies vendor
// greeks; when a row lacks them this module derives delta/gamma/vega/theta/rho from the
// QUOTED IV with plain Black-Scholes — and stamps every output so nothing downstream can
// mistake a model number for a vendor one:
//
//   greeksSource: 'vendor'                    — supplied by the chain provider
//   greeksSource: 'model-bsm-from-quoted-iv'  — computed here from the quoted IV
//   greeksSource: 'model-bsm-from-mid'        — IV itself was solved from the mid price
//
// HONESTY: model greeks inherit the quoted IV's staleness (15-min delayed chains) and the
// flat-rate assumption. They are a Black-Scholes CONVENTION, not a measurement of dealer
// books. Conventions match vollib/py_vollib: vega per 1 vol point, theta per calendar day,
// rho per 1% rate move.
//
// Math: lib/vendor/lets-be-rational.js (MIT port of vollib's TypeScript packages).
// Pure; no I/O, no clock — the caller injects nowMs where a DTE must be derived.

const LBR = require('./vendor/lets-be-rational');

const GREEKS_VERSION = 'options-greeks-v1';
const GREEKS_SOURCE = Object.freeze({
  VENDOR: 'vendor',
  MODEL: 'model-bsm-from-quoted-iv',
  MODEL_FROM_MID: 'model-bsm-from-mid',
});
// Flat risk-free rate — rates barely move greeks at these horizons; the same 4% the
// gexarchive stream has used since 2026-08 so the two never disagree on convention.
const DEFAULT_RATE = 0.04;
const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;
// Chain feeds stamp an expiry as 00:00 UTC of its date, but the contract settles at the 4 pm
// ET close (20:00/21:00 UTC). Measuring time-to-expiry to that settlement keeps a same-day
// contract alive during the session and marks it EXPIRED once the close has passed.
const EXPIRY_SETTLE_UTC_HOURS = 21;
// Degenerate chain IVs (the ~0 prints Yahoo reports on illiquid strikes, or >500%) are
// rejected rather than turned into greeks — the same band options-observe-v2 uses.
const IV_MIN = 0.05;
const IV_MAX = 5;
const PER_PERCENT = 0.01;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n, d) => (isNum(n) ? +n.toFixed(d) : null);

function normalizeType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'call' || t === 'c') return 'call';
  if (t === 'put' || t === 'p') return 'put';
  return null;
}

function usableIv(iv) { return isNum(iv) && iv >= IV_MIN && iv <= IV_MAX; }

function yearsFromDte(dte) { return isNum(dte) && dte > 0 ? dte / DAYS_PER_YEAR : null; }

// Days to SETTLEMENT from a unix-seconds expiration date and an injected clock (fractional
// days are kept — a 0DTE contract at noon still has a few hours of time value; a contract
// whose close has passed comes back negative).
function dteFromExpiration(expirationSec, nowMs) {
  if (!isNum(expirationSec) || !isNum(nowMs)) return null;
  return (expirationSec * 1000 + EXPIRY_SETTLE_UTC_HOURS * 3_600_000 - nowMs) / MS_PER_DAY;
}

function d1d2(F, K, t, sigma) {
  const sT = sigma * Math.sqrt(t);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / sT;
  return { d1, d2: d1 - sT };
}

/**
 * Black-Scholes price + greeks from a QUOTED implied volatility. Pure.
 * @param {{spot:number, strike:number, dte:number, r?:number, iv:number, type:string}} p
 *   dte in calendar days; iv as a decimal (0.25 = 25%); type 'call'|'put'|'C'|'P'.
 * @returns {object|null} { price, delta, gamma, vega, theta, rho, greeksSource, model } or null
 *   when any input is outside the domain (no greeks are ever fabricated from bad inputs).
 */
function greeksFromQuotedIV({ spot, strike, dte, r = DEFAULT_RATE, iv, type } = {}) {
  const side = normalizeType(type);
  const t = yearsFromDte(dte);
  if (!side || !isNum(spot) || spot <= 0 || !isNum(strike) || strike <= 0 || t == null || !usableIv(iv) || !isNum(r)) return null;
  const F = spot * Math.exp(r * t);
  const discount = Math.exp(-r * t);
  const { d1, d2 } = d1d2(F, strike, t, iv);
  const pdf1 = LBR.normPdf(d1);
  const isCall = side === 'call';
  const price = LBR.black(F, strike, iv, t, isCall ? 1 : -1) * discount;
  const delta = isCall ? LBR.normCdf(d1) : LBR.normCdf(d1) - 1;
  const gamma = pdf1 / (spot * iv * Math.sqrt(t));
  const vega = spot * pdf1 * Math.sqrt(t) * PER_PERCENT;
  const decay = -spot * pdf1 * iv / (2 * Math.sqrt(t));
  const carry = r * strike * discount * (isCall ? LBR.normCdf(d2) : LBR.normCdf(-d2));
  const theta = (isCall ? decay - carry : decay + carry) / DAYS_PER_YEAR;
  const rho = (isCall ? t * strike * discount * LBR.normCdf(d2) : -t * strike * discount * LBR.normCdf(-d2)) * PER_PERCENT;
  return {
    price, delta, gamma, vega, theta, rho,
    greeksSource: GREEKS_SOURCE.MODEL,
    model: { version: GREEKS_VERSION, rate: r, yearsToExpiry: t, iv },
  };
}

/**
 * Implied Black-Scholes volatility from a mid price (Jäckel's "Let's Be Rational"). Pure.
 * @returns {{iv:number|null, greeksSource:string, reason?:string}}
 */
function impliedVolFromMid({ spot, strike, dte, r = DEFAULT_RATE, mid, type } = {}) {
  const side = normalizeType(type);
  const t = yearsFromDte(dte);
  const out = { iv: null, greeksSource: GREEKS_SOURCE.MODEL_FROM_MID };
  if (!side || !isNum(spot) || spot <= 0 || !isNum(strike) || strike <= 0 || t == null || !isNum(mid) || mid <= 0 || !isNum(r)) {
    return { ...out, reason: 'inputs outside the model domain (spot, strike, dte, mid must be positive; type call|put)' };
  }
  const discount = Math.exp(-r * t);
  const F = spot / discount;
  try {
    const iv = LBR.impliedVolatilityFromATransformedRationalGuess(mid / discount, F, strike, t, side === 'call' ? 1 : -1);
    return isNum(iv) && iv > 0 ? { ...out, iv } : { ...out, reason: 'solver returned a non-positive volatility' };
  } catch (e) {
    const name = e && e.name;
    if (name === 'BelowIntrinsicError') return { ...out, reason: 'mid price is below intrinsic value — no implied volatility exists' };
    if (name === 'AboveMaximumError') return { ...out, reason: 'mid price exceeds the maximum option value — no implied volatility exists' };
    throw e;
  }
}

function hasVendorGreeks(row) {
  return !!row && isNum(row.delta) && isNum(row.gamma);
}

/**
 * Return a NEW row with greeks filled from the quoted IV when the provider supplied none.
 * Vendor greeks are kept untouched and labelled; rows without a usable IV stay greek-less
 * with greeksSource null (never guessed). Immutable.
 * @param {object} row  normalized contract row ({ side|type, strike, dte?, expiration?, iv|impliedVolatility, delta?, gamma?, ... })
 * @param {{spot:number, nowMs?:number, r?:number}} ctx
 */
function fillGreeks(row, { spot, nowMs = null, r = DEFAULT_RATE } = {}) {
  if (!row) return row;
  if (hasVendorGreeks(row)) return { ...row, greeksSource: row.greeksSource || GREEKS_SOURCE.VENDOR };
  const iv = isNum(row.iv) ? row.iv : row.impliedVolatility;
  const dte = isNum(row.dte) && row.dte > 0 ? row.dte : dteFromExpiration(row.expiration, nowMs);
  const g = greeksFromQuotedIV({ spot, strike: row.strike, dte, r, iv, type: row.side || row.type });
  if (!g) return { ...row, greeksSource: null };
  return {
    ...row,
    delta: round(g.delta, 4), gamma: round(g.gamma, 6), vega: round(g.vega, 4), theta: round(g.theta, 4), rho: round(g.rho, 4),
    greeksSource: GREEKS_SOURCE.MODEL,
  };
}

module.exports = {
  GREEKS_VERSION, GREEKS_SOURCE, DEFAULT_RATE, DAYS_PER_YEAR, IV_MIN, IV_MAX, EXPIRY_SETTLE_UTC_HOURS,
  greeksFromQuotedIV, impliedVolFromMid, fillGreeks, hasVendorGreeks,
  normalizeType, usableIv, yearsFromDte, dteFromExpiration,
};
