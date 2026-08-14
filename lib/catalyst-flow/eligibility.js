'use strict';
// CATALYST–FLOW — UNIVERSE ELIGIBILITY.
//
// The eligible universe is rebuilt INDEPENDENTLY ON EVERY HISTORICAL DATE from the bars
// that existed on that date. It is never seeded from today's constituents — that is the
// survivorship error that makes an event study look profitable for free, because the
// names that stopped trading are exactly the ones that hurt.
//
// v1 admits: US-listed operating-company common shares, unadjusted prior close ≥ $5,
// trailing 20-session MEDIAN dollar volume ≥ $5M, ranked to the most liquid 2,000.
// ETFs, funds, units, warrants, rights and preferreds are excluded by security type.
//
// MEDIAN, not mean, is deliberate: one halt-and-reopen print can carry a mean over a
// liquidity floor that the name does not actually clear on a normal day.
//
// Pure module: no network, no clock, no fs. Callers inject bars and the security type.

const { ELIGIBILITY } = require('./config');

const median = (arr) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Trailing median dollar volume over the `lookback` sessions ending at index `idx`
// INCLUSIVE. Returns null when the history is short — a partial window is not a
// measurement, and admitting one would favour freshly-listed names.
function trailingMedianDollarVolume(bars, idx, lookback = ELIGIBILITY.dollarVolumeLookback) {
  if (!Array.isArray(bars) || idx < lookback - 1 || idx >= bars.length) return null;
  const vals = [];
  for (let k = idx - lookback + 1; k <= idx; k++) {
    const b = bars[k];
    if (!b || !(b.close > 0) || !(b.volume >= 0)) return null;
    vals.push(b.close * b.volume);
  }
  return median(vals);
}

// Security-type screen. `quoteType` comes from the provider; a symbol we cannot classify
// is REJECTED, not admitted on the assumption that it is probably a common share.
function isOperatingCommonShare(symbol, meta) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return { ok: false, reason: 'no-symbol' };
  for (const re of ELIGIBILITY.excludedSuffixPatterns) {
    if (re.test(sym)) return { ok: false, reason: 'instrument-suffix-excluded' };
  }
  const qt = meta && meta.quoteType ? String(meta.quoteType).toUpperCase() : null;
  if (!qt) return { ok: false, reason: 'security-type-unknown' };
  if (!ELIGIBILITY.allowedQuoteTypes.includes(qt)) return { ok: false, reason: `quote-type-${qt.toLowerCase()}` };
  if (meta.isFund === true) return { ok: false, reason: 'fund' };
  return { ok: true, reason: null };
}

// Screen ONE candidate at one date index. `bars[idx]` is the last session at or before the
// eligibility date; `priorCloseUnadjusted` must be the UNADJUSTED close (a $5 floor applied
// to a split-adjusted series silently drops names that traded well above $5 at the time).
function screenCandidate({ symbol, meta, bars, idx, priorCloseUnadjusted }) {
  const type = isOperatingCommonShare(symbol, meta);
  if (!type.ok) return { eligible: false, reason: type.reason, dollarVolume: null };

  // `Number(null)` is 0, so an absent close would otherwise be reported as
  // "price-below-floor" — an attrition ledger claiming a measurement nobody made.
  const px = (priorCloseUnadjusted === null || priorCloseUnadjusted === undefined || priorCloseUnadjusted === '')
    ? NaN : Number(priorCloseUnadjusted);
  if (!Number.isFinite(px)) return { eligible: false, reason: 'no-unadjusted-prior-close', dollarVolume: null };
  if (px < ELIGIBILITY.minPriorClose) return { eligible: false, reason: 'price-below-floor', dollarVolume: null };

  const dv = trailingMedianDollarVolume(bars, idx);
  if (dv == null) return { eligible: false, reason: 'insufficient-liquidity-history', dollarVolume: null };
  if (dv < ELIGIBILITY.minMedianDollarVolume) return { eligible: false, reason: 'dollar-volume-below-floor', dollarVolume: dv };

  return { eligible: true, reason: null, dollarVolume: dv };
}

// Build the eligible universe for ONE date. `candidates` is whatever was listed on that
// date — including names that later delisted. Returns the most liquid `maxUniverse`, with
// a full attrition ledger so exclusions are counted rather than assumed.
function buildEligibleUniverse(candidates, { maxUniverse = ELIGIBILITY.maxUniverse } = {}) {
  const attrition = {};
  const passed = [];
  for (const c of candidates || []) {
    const r = screenCandidate(c);
    if (!r.eligible) { attrition[r.reason] = (attrition[r.reason] || 0) + 1; continue; }
    passed.push({ symbol: String(c.symbol).toUpperCase(), dollarVolume: r.dollarVolume });
  }
  // Deterministic ordering: liquidity desc, then symbol — so a re-run of the same date
  // produces byte-identical membership.
  passed.sort((a, b) => (b.dollarVolume - a.dollarVolume) || a.symbol.localeCompare(b.symbol));
  const admitted = passed.slice(0, maxUniverse);
  if (passed.length > maxUniverse) attrition['beyond-liquidity-rank-cap'] = passed.length - maxUniverse;

  return {
    universe: admitted.map((x) => x.symbol),
    liquidityRank: Object.fromEntries(admitted.map((x, i) => [x.symbol, i + 1])),
    scanned: (candidates || []).length,
    admitted: admitted.length,
    attrition,
  };
}

module.exports = {
  median, trailingMedianDollarVolume, isOperatingCommonShare,
  screenCandidate, buildEligibleUniverse,
};
