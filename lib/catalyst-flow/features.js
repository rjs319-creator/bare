'use strict';
// CATALYST–FLOW — FEATURE BUILDER (families B and D from observed bars).
//
// Everything here is computed from bars at or before the CONFIRMATION SESSION CLOSE, which
// is the feature cutoff. The builder takes an index into an ascending bar series and never
// looks past it — there is no date arithmetic that could accidentally reach forward,
// because the only forward-capable operation (slicing) is done once, here, by index.
//
// Family A (fundamental catalyst) is assembled by the ingestion layer from the event
// ledger, because its availability depends on provider timestamps rather than on bars.
// Family C is supplied by the signed-options interface and is null without a licensed feed.
//
// EVERY value may be null. A null is emitted whenever the input window is incomplete —
// never a zero, never a carried-forward value. `missingFeatureShare` then reports how much
// of the row was actually measured, so a mostly-empty row cannot pass as a confident one.
//
// Pure module: no network, no clock, no fs.

const { NAMES_BY_FAMILY, FAMILY, BY_NAME } = require('./registry');
const { trailingMedianDollarVolume } = require('./eligibility');
const { tierOf } = require('./labels');
const { roundTripCostPct } = require('../costs');

const FEATURE_BUILDER_VERSION = 'catalyst-features-v1';
const SESSIONS_PER_YEAR = 252;

const fin = (v) => (Number.isFinite(v) ? v : null);
const ret = (a, b) => (a > 0 && b > 0 ? b / a - 1 : null);

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function median(a) {
  const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Daily log returns over the `n` sessions ending at `idx` inclusive; null if incomplete.
function logReturns(bars, idx, n) {
  if (idx - n < 0) return null;
  const out = [];
  for (let k = idx - n + 1; k <= idx; k++) {
    const a = bars[k - 1], b = bars[k];
    if (!(a && b && a.close > 0 && b.close > 0)) return null;
    out.push(Math.log(b.close / a.close));
  }
  return out;
}

// Corwin-Schultz style high/low spread PROXY in basis points. Declared a proxy in the
// registry and in the artifact — the app has no NBBO feed, and calling this a quoted
// spread would be the sort of quiet upgrade this codebase keeps having to undo.
function spreadProxyBps(bars, idx) {
  if (idx < 1) return null;
  const a = bars[idx - 1], b = bars[idx];
  if (!(a && b && a.high > 0 && a.low > 0 && b.high > 0 && b.low > 0)) return null;
  const beta = Math.log(a.high / a.low) ** 2 + Math.log(b.high / b.low) ** 2;
  const hi2 = Math.max(a.high, b.high), lo2 = Math.min(a.low, b.low);
  const gamma = Math.log(hi2 / lo2) ** 2;
  const k = 3 - 2 * Math.SQRT2;
  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / k - Math.sqrt(gamma / k);
  const s = 2 * (Math.exp(alpha) - 1) / (1 + Math.exp(alpha));
  return Number.isFinite(s) ? Math.max(0, s) * 10000 : null;
}

// ── Family B ────────────────────────────────────────────────────────────────
// `confIdx` indexes the CONFIRMATION session in `bars`. `announcementIdx` is the last
// session at or before the announcement — the pre-event window ends there, so an event's
// own reaction never contaminates its "pre-event momentum".
function familyB({ bars, confIdx, announcementIdx, spy, spyConfIdx, sector, sectorBars, sectorConfIdx }) {
  const out = Object.fromEntries(NAMES_BY_FAMILY[FAMILY.B].map((n) => [n, null]));
  if (!Array.isArray(bars) || confIdx < 1 || confIdx > bars.length - 1) return out;

  const c = bars[confIdx], prior = bars[confIdx - 1];
  if (!(c && prior && c.close > 0 && prior.close > 0)) return out;

  out.overnightGap = fin(ret(prior.close, c.open));
  out.firstSessionReturn = fin(ret(c.open, c.close));

  const spyRet = (spy && spyConfIdx > 0 && spy[spyConfIdx] && spy[spyConfIdx - 1])
    ? ret(spy[spyConfIdx - 1].close, spy[spyConfIdx].close) : null;
  const dayRet = ret(prior.close, c.close);
  out.firstSessionVsSpy = (dayRet != null && spyRet != null) ? dayRet - spyRet : null;

  const secRet = (sectorBars && sectorConfIdx > 0 && sectorBars[sectorConfIdx] && sectorBars[sectorConfIdx - 1])
    ? ret(sectorBars[sectorConfIdx - 1].close, sectorBars[sectorConfIdx].close) : null;
  out.firstSessionVsSector = (dayRet != null && secRet != null) ? dayRet - secRet : null;

  const gapAbs = c.open - prior.close;
  out.gapRetention = Math.abs(gapAbs) > 1e-9 ? Math.max(-3, Math.min(3, (c.close - prior.close) / gapAbs)) : null;

  const range = c.high - c.low;
  out.closeLocationValue = range > 0 ? (2 * c.close - c.high - c.low) / range : null;
  out.intradayReversal = c.high > 0 ? (c.close - c.high) / c.high : null;

  // Abnormal volume vs the trailing 20-session MEDIAN, ending the session BEFORE the
  // confirmation session (the event's own volume must not set its own baseline).
  const volWindow = [], dolWindow = [];
  for (let k = confIdx - 20; k < confIdx; k++) {
    const b = bars[k];
    if (!b || !(b.volume >= 0) || !(b.close > 0)) { volWindow.length = 0; break; }
    volWindow.push(b.volume); dolWindow.push(b.close * b.volume);
  }
  const medVol = volWindow.length === 20 ? median(volWindow) : null;
  const medDol = dolWindow.length === 20 ? median(dolWindow) : null;
  out.abnormalShareVolume = (medVol > 0 && c.volume > 0) ? Math.log(c.volume / medVol) : null;
  out.abnormalDollarVolume = (medDol > 0 && c.close * c.volume > 0) ? Math.log((c.close * c.volume) / medDol) : null;

  // Pre-event momentum ends at the announcement anchor, NOT at the confirmation close.
  const ai = Number.isFinite(announcementIdx) ? announcementIdx : confIdx - 1;
  if (ai - 5 >= 0 && bars[ai] && bars[ai - 5]) out.preEventReturn5 = fin(ret(bars[ai - 5].close, bars[ai].close));
  if (ai - 20 >= 0 && bars[ai] && bars[ai - 20]) out.preEventReturn20 = fin(ret(bars[ai - 20].close, bars[ai].close));

  if (confIdx - 19 >= 0) {
    const closes = [];
    for (let k = confIdx - 19; k <= confIdx; k++) { if (!(bars[k] && bars[k].close > 0)) { closes.length = 0; break; } closes.push(bars[k].close); }
    if (closes.length === 20) {
      const sma = mean(closes);
      out.distanceFromSma20 = sma > 0 ? c.close / sma - 1 : null;
      const hi20 = Math.max(...closes);
      out.distanceFrom20dHigh = hi20 > 0 ? c.close / hi20 - 1 : null;
    }
  }

  const lr = logReturns(bars, confIdx, 20);
  const sd = lr ? stdev(lr) : null;
  out.realizedVol20 = sd != null ? sd * Math.sqrt(SESSIONS_PER_YEAR) : null;

  // Idiosyncratic vol = stdev of market-model residuals over the same window.
  const slr = (spy && spyConfIdx != null) ? logReturns(spy, spyConfIdx, 20) : null;
  if (lr && slr && lr.length === slr.length) {
    const mx = mean(slr), my = mean(lr);
    let cov = 0, varx = 0;
    for (let i = 0; i < lr.length; i++) { cov += (slr[i] - mx) * (lr[i] - my); varx += (slr[i] - mx) ** 2; }
    const beta = varx > 0 ? cov / varx : null;
    if (beta != null) {
      const resid = lr.map((v, i) => v - (my - beta * mx) - beta * slr[i]);
      const rsd = stdev(resid);
      out.idiosyncraticVol20 = rsd != null ? rsd * Math.sqrt(SESSIONS_PER_YEAR) : null;
    }
  }

  out.spreadProxyBps = spreadProxyBps(bars, confIdx);

  const adv = trailingMedianDollarVolume(bars, confIdx);
  out.advDollar20 = adv > 0 ? Math.log10(adv) : null;

  if (slr) { const ssd = stdev(slr); out.marketVolRegime = ssd != null ? ssd * Math.sqrt(SESSIONS_PER_YEAR) : null; }
  out.sectorId = sector || null;
  return out;
}

// ── Family D ────────────────────────────────────────────────────────────────
// `shortInterest` must already be resolved to what was PUBLISHED by the cutoff. This
// function does not know settlement dates and deliberately cannot recover one — passing an
// unpublished figure here is a caller bug the ingestion layer is responsible for refusing.
function familyD({ bars, confIdx, shortInterest = null, dilutionEvent = null, borrow = null }) {
  const out = Object.fromEntries(NAMES_BY_FAMILY[FAMILY.D].map((n) => [n, null]));

  if (shortInterest && Number.isFinite(shortInterest.daysToCover) && shortInterest.publishedByCutoff === true) {
    out.daysToCover = shortInterest.daysToCover;
    out.extremeCrowdingFlag = shortInterest.daysToCover >= 7 ? 1 : 0;
  }
  if (dilutionEvent && typeof dilutionEvent.observedByCutoff === 'boolean') {
    out.dilutionEventFlag = dilutionEvent.observedByCutoff ? 1 : 0;
  }
  // No neutral borrow vendor is wired; `borrow` is null in every current path and the
  // feature stays missing rather than defaulting to "available".
  if (borrow && typeof borrow.available === 'boolean') out.borrowAvailable = borrow.available ? 1 : 0;

  const adv = Array.isArray(bars) ? trailingMedianDollarVolume(bars, confIdx) : null;
  out.estRoundTripCostPct = adv != null ? roundTripCostPct(tierOf(adv)) : null;
  return out;
}

// Provenance ordinal — the WEAKEST source backing any populated value on the row.
// A row whose only populated fundamentals are reconstructed cannot score better than
// its reconstruction.
const SOURCE_QUALITY = Object.freeze({ IMMUTABLE_PIT: 2, RECONSTRUCTED_EXPLORATORY: 1, NONE: 0 });

// Assemble one row across all four families and stamp its completeness.
function buildFeatureRow({ familyAValues = {}, familyBValues = {}, familyCValues = {}, familyDValues = {}, pitClass = 'RECONSTRUCTED_EXPLORATORY' }) {
  const row = { ...familyAValues, ...familyBValues, ...familyCValues, ...familyDValues };

  const declared = Object.keys(BY_NAME).filter((n) => n !== 'missingFeatureShare' && n !== 'sourceQualityScore');
  const missing = declared.filter((n) => row[n] === null || row[n] === undefined).length;
  row.missingFeatureShare = declared.length ? missing / declared.length : 1;

  const anyFamilyA = NAMES_BY_FAMILY[FAMILY.A].some((n) => row[n] !== null && row[n] !== undefined);
  row.sourceQualityScore = anyFamilyA ? (SOURCE_QUALITY[pitClass] ?? 0) : SOURCE_QUALITY.IMMUTABLE_PIT;
  return row;
}

module.exports = {
  FEATURE_BUILDER_VERSION, SOURCE_QUALITY,
  mean, stdev, median, logReturns, spreadProxyBps,
  familyB, familyD, buildFeatureRow,
};
