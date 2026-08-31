'use strict';
// POINT-IN-TIME UNIVERSE CONSTRUCTION (forecast-universe-v1)
//
// Membership is decided PER DECISION DATE from bars at or before that date only, and every
// admitted AND rejected name carries a reason. Two properties matter more than the filters:
//
//   * NO LOOK-AHEAD MEMBERSHIP. Eligibility at date t uses price/volume/history observed at or
//     before t. A name that later becomes liquid is not eligible earlier; a name that later
//     delists is still eligible while its bars exist (its label then resolves or is excluded as
//     unobservable, which is the honest treatment of a delisting).
//   * SURVIVORSHIP IS REDUCED, NOT PROVEN SAFE. The local cache contains delisted names whose
//     bars simply stop, so the per-date staleness gate removes them going forward — but the
//     cache was assembled from a present-day symbol list, so `survivorshipSafe` is FALSE and
//     stays false. Nothing in this system may claim otherwise.
//
// Pure: bars in, membership out. The loader lives in lib/forecast/panel.js.

const UNIVERSE_VERSION = 'forecast-universe-v1';

const REASONS = Object.freeze({
  OK: 'eligible',
  NO_BAR: 'no-bar-at-or-before-decision-date',
  STALE: 'stale-price',
  SHORT_HISTORY: 'insufficient-history',
  LOW_PRICE: 'below-min-price',
  ILLIQUID: 'below-min-avg-dollar-volume',
  EXCLUDED_SECTOR: 'sector-excluded-by-config',
  SECTOR_UNKNOWN: 'sector-unknown-and-required',
  CORP_ACTION: 'suspected-unadjusted-corporate-action',
  NOT_TRADABLE: 'no-next-session-open',
});

/** Index of the last bar at or before `date`; -1 when none. Binary search over ascending bars. */
function barIndexAtOrBefore(candles, date) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Trailing average dollar volume over `lookback` bars ending at idx (inclusive). */
function avgDollarVolume(candles, idx, lookback) {
  let sum = 0, n = 0;
  for (let i = Math.max(0, idx - lookback + 1); i <= idx; i++) {
    const c = candles[i];
    if (c && Number.isFinite(c.close) && Number.isFinite(c.volume)) { sum += c.close * c.volume; n++; }
  }
  return n ? sum / n : null;
}

/**
 * Did any single-session close-to-close move in the trailing `lookback` bars exceed the
 * configured threshold? Such a jump is the signature of an UNADJUSTED split/dividend in this
 * vendor's data, and a feature vector built across it is fiction.
 */
function hasExtremeMove(candles, idx, lookback, threshold) {
  for (let i = Math.max(1, idx - lookback + 1); i <= idx; i++) {
    const a = candles[i - 1], b = candles[i];
    if (a && b && a.close > 0 && b.close > 0 && Math.abs(b.close / a.close - 1) > threshold) return true;
  }
  return false;
}

/**
 * Eligibility of one name at one decision date.
 * `sessionIndex` maps an ISO date → ordinal on the study's trading-session axis, so staleness
 * is measured in real SESSIONS (holidays never distort it).
 */
function eligibilityAt(entry, date, cfg, { sector = null, sessionIndex = null } = {}) {
  const u = cfg.universe;
  const out = { eligible: false, reason: REASONS.NO_BAR, barIndex: -1, price: null, adv: null, staleSessions: null, historySessions: null, sector };

  const candles = entry && entry.candles;
  if (!candles || !candles.length) return out;
  const idx = barIndexAtOrBefore(candles, date);
  if (idx < 0) return out;
  out.barIndex = idx;

  const bar = candles[idx];
  out.price = Number.isFinite(bar.close) ? bar.close : null;
  out.historySessions = idx + 1;

  if (sessionIndex) {
    const here = sessionIndex.get(date);
    const there = sessionIndex.get(bar.date);
    out.staleSessions = (here != null && there != null) ? here - there : null;
    if (out.staleSessions != null && out.staleSessions > u.maxStaleSessions) { out.reason = REASONS.STALE; return out; }
  }
  if (out.historySessions < u.minHistorySessions) { out.reason = REASONS.SHORT_HISTORY; return out; }
  if (!(out.price >= u.minPrice)) { out.reason = REASONS.LOW_PRICE; return out; }

  out.adv = avgDollarVolume(candles, idx, u.advLookback);
  if (!(out.adv >= u.minAvgDollarVolume)) { out.reason = REASONS.ILLIQUID; return out; }

  if (sector && u.excludedSectors.includes(sector)) { out.reason = REASONS.EXCLUDED_SECTOR; return out; }
  if (!sector && u.requireSector) { out.reason = REASONS.SECTOR_UNKNOWN; return out; }

  if (hasExtremeMove(candles, idx, u.advLookback, u.extremeOneDayMove)) { out.reason = REASONS.CORP_ACTION; return out; }

  // Tradability under the next-open convention: the entry bar must exist.
  if (idx + 1 > candles.length - 1) { out.reason = REASONS.NOT_TRADABLE; return out; }

  out.eligible = true;
  out.reason = REASONS.OK;
  return out;
}

/**
 * Universe snapshot for one decision date: members (with their eligibility detail) and
 * exclusions (with reasons). `survivorshipSafe` is hard-coded FALSE — see the header.
 */
function buildUniverseSnapshot(panel, date, cfg, { recordExclusions = true } = {}) {
  const members = [];
  const exclusions = [];
  const counts = Object.create(null);

  for (const [ticker, entry] of panel.dataset) {
    const sector = panel.sectorOf(ticker);
    const e = eligibilityAt(entry, date, cfg, { sector, sessionIndex: panel.sessionIndex });
    counts[e.reason] = (counts[e.reason] || 0) + 1;
    if (e.eligible) members.push({ ticker, securityId: panel.securityIdOf(ticker), sector, barIndex: e.barIndex, price: e.price, adv: e.adv, historySessions: e.historySessions, staleSessions: e.staleSessions });
    else if (recordExclusions) exclusions.push({ ticker, reason: e.reason });
  }
  members.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));

  return Object.freeze({
    schema: 'ForecastUniverseSnapshot', version: UNIVERSE_VERSION,
    decisionDate: date,
    policy: Object.freeze({ ...cfg.universe }),
    members: Object.freeze(members),
    exclusions: Object.freeze(exclusions),
    exclusionCounts: Object.freeze(counts),
    size: members.length,
    survivorshipSafe: false,
    limitations: Object.freeze([
      'Cache assembled from a present-day symbol list: survivorship is REDUCED (per-date staleness gate) but NOT proven safe.',
      'Sector classification is the current vendor mapping, not point-in-time — see docs/FORECAST-RANKING-SYSTEM.md.',
    ]),
  });
}

module.exports = { UNIVERSE_VERSION, REASONS, barIndexAtOrBefore, avgDollarVolume, hasExtremeMove, eligibilityAt, buildUniverseSnapshot };
