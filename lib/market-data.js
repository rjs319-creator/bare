'use strict';
// MARKET-DATA integrity + normalization.
//
// Reality check (verified against Yahoo v8): the `quote` OHLC this app fetches is ALREADY
// split-adjusted — a 10:1 split shows NO 90% crash — so research already runs on split-adjusted
// prices. `adjClose` adds the DIVIDEND leg (split+dividend adjusted). This module therefore does
// NOT re-adjust the price series by default; it provides:
//   1. validateSeries  — catch provider DATA ERRORS: an UNADJUSTED split (a real ~50% discontinuity
//      where a split event exists), duplicate/non-monotonic dates, non-positive prices, close
//      outside [low,high], missing volume, a stale last bar.
//   2. totalReturnSeries — dividend-aware TOTAL-RETURN closes from adjClose, for research paths
//      that explicitly want dividends included (never the default — execution stays on raw).
//   3. applySplitAdjustment — repair an UNADJUSTED series from split events (utility + the
//      invariance-test counterpart), so a caller can fix a flagged series deterministically.
//
// Pure. No network, no clock (asOf is injected).

const DATA_QUALITY_VERSION = 'dq-v1';

const isFinitePos = (x) => Number.isFinite(x) && x > 0;

// Validate a candle series. Returns { ok, version, issues:[...], warnings:[...], bars }.
// `issues` are correctness-breaking (a strategy should not trust the series); `warnings` are
// advisory (may be legitimate). Split events are cross-referenced so an ALREADY-adjusted split
// (continuous price) passes clean, while a discontinuity AT a split date is flagged as unadjusted.
function validateSeries(candles, { corporateActions = null, discontinuity = 0.35, staleDays = 5, asOf = null } = {}) {
  const issues = [];
  const warnings = [];
  const push = (arr, type, extra) => arr.push({ type, ...extra });

  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, version: DATA_QUALITY_VERSION, issues: [{ type: 'empty' }], warnings: [], bars: 0 };
  }

  const splitDates = new Set((corporateActions && corporateActions.splits || []).map((s) => s.date));
  const seen = new Set();
  let prevDate = null, prevClose = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] || {};
    const { date, open, high, low, close, volume } = c;

    if (!date) { push(issues, 'missing-date', { index: i }); continue; }
    if (seen.has(date)) push(issues, 'duplicate-date', { index: i, date });
    seen.add(date);
    if (prevDate && date <= prevDate) push(issues, 'non-monotonic-date', { index: i, date, prevDate });

    if (![open, high, low, close].every(isFinitePos)) push(issues, 'non-positive-price', { index: i, date, open, high, low, close });
    else {
      if (high < low) push(issues, 'high-below-low', { index: i, date, high, low });
      if (close > high + 1e-9 || close < low - 1e-9) push(issues, 'close-outside-range', { index: i, date, close, high, low });
    }

    if (!(Number.isFinite(volume) && volume > 0)) push(warnings, 'missing-volume', { index: i, date });

    // Single-bar discontinuity: a large close-to-close move. If a split event lands on this bar,
    // an ADJUSTED series is continuous — so a discontinuity here means the split was NOT adjusted.
    if (isFinitePos(prevClose) && isFinitePos(close)) {
      const ratio = close / prevClose;
      if (ratio > 1 + discontinuity || ratio < 1 - discontinuity) {
        if (splitDates.has(date)) push(issues, 'unadjusted-split', { index: i, date, ratio: +ratio.toFixed(4) });
        else push(warnings, 'price-discontinuity', { index: i, date, ratio: +ratio.toFixed(4) });
      }
    }
    prevDate = date;
    if (isFinitePos(close)) prevClose = close;
  }

  if (asOf) {
    const last = candles[candles.length - 1].date;
    const ageDays = (Date.parse(asOf + 'T00:00:00Z') - Date.parse(last + 'T00:00:00Z')) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > staleDays) push(warnings, 'stale-last-bar', { last, ageDays: +ageDays.toFixed(1) });
  }

  return { ok: issues.length === 0, version: DATA_QUALITY_VERSION, issues, warnings, bars: candles.length };
}

// Dividend-aware TOTAL-RETURN close series from adjClose. Returns [{date, close}] where close is
// the adjusted (total-return) close, falling back to the raw close on any bar lacking adjClose
// (never fabricated). `basis` reports whether every bar had adjClose.
function totalReturnSeries(candles) {
  if (!Array.isArray(candles) || !candles.length) return { series: [], basis: 'empty', covered: 0 };
  let covered = 0;
  const series = candles.map((c) => {
    const adj = isFinitePos(c.adjClose) ? c.adjClose : null;
    if (adj != null) covered++;
    return { date: c.date, close: adj != null ? adj : c.close };
  });
  const basis = covered === candles.length ? 'total-return' : covered === 0 ? 'price-return-fallback' : 'partial-total-return';
  return { series, basis, covered };
}

// Cumulative split factor per bar to make an UNADJUSTED raw series continuous with its latest
// bar. A split with ratio R on date D scales every bar STRICTLY BEFORE D by 1/R (prices) — Yahoo
// already does this, so on Yahoo data every factor is 1. Exposed for repairing a provider that
// does not adjust, and as the invariance-test counterpart.
function splitFactors(candles, splits) {
  const n = candles.length;
  const factors = new Array(n).fill(1);
  if (!Array.isArray(splits) || !splits.length) return factors;
  const valid = splits.filter((s) => s && s.date && isFinitePos(s.ratio));
  for (let i = 0; i < n; i++) {
    let f = 1;
    for (const s of valid) if (candles[i].date < s.date) f *= s.ratio;   // bars before the split shrink by the ratio
    factors[i] = f;
  }
  return factors;
}

// Apply split adjustment to an UNADJUSTED raw series (prices ÷ cumulative factor, volume ×). No-op
// on already-adjusted data whose factors are all 1. Returns NEW candles (immutable).
function applySplitAdjustment(candles, splits) {
  const factors = splitFactors(candles, splits);
  return candles.map((c, i) => {
    const f = factors[i];
    if (f === 1) return { ...c };
    return { ...c, open: c.open / f, high: c.high / f, low: c.low / f, close: c.close / f, volume: c.volume * f, splitAdjusted: true };
  });
}

module.exports = {
  DATA_QUALITY_VERSION,
  validateSeries, totalReturnSeries, splitFactors, applySplitAdjustment,
};
