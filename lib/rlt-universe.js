// ═══════════════════════════════════════════════════════════════════════════
// RLT peer universe — deterministic, point-in-time sector-peer grouping.
//
// Primary grouping: sector × liquidity/cap band. Fallback hierarchy (labeled):
//   1. sector × band   2. sector only   3. market-wide residual rank
// A peer group smaller than PEER_POLICY.minPeers falls back rather than emit a
// false-precision percentile. A missing sector does NOT exclude a stock — it
// becomes a clearly labeled market-only shadow observation when every other
// eligibility requirement passes. Nothing here fabricates a sector.
//
// Pure module: no I/O, no clocks. All inputs arrive as data.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto');
const { VERSIONS, PEER_POLICY } = require('./rlt-config');
const { toBars, asOfSlice } = require('./atlasx-residual');

const GROUPING = Object.freeze({
  SECTOR_BAND: 'sector-band',
  SECTOR: 'sector',
  MARKET: 'market',
});

// Fail-closed exclusion reason codes (stable strings — tests anchor on them).
const EXCLUSION = Object.freeze({
  NO_BARS: 'insufficient-candle-history',
  STALE: 'stale-bars',
  NO_PRICE: 'unknown-price',
  NO_LIQUIDITY: 'unknown-or-thin-liquidity',
  ANOMALY: 'unresolved-split-or-bad-bar-anomaly',
  NON_TRADABLE: 'non-tradable-security',
});

function num(v) { return Number.isFinite(v) ? v : null; }

/** Sessions of the reference calendar strictly after `date` and <= asOf. */
function staleSessionsOf(lastDate, calendarDates) {
  if (!lastDate || !calendarDates || !calendarDates.length) return null;
  let n = 0;
  for (let i = calendarDates.length - 1; i >= 0; i--) {
    if (calendarDates[i] > lastDate) n++;
    else break;
  }
  return n;
}

/** Detect an unresolved split/bad-bar anomaly: an extreme 1-day move. */
function hasBarAnomaly(bars, threshold) {
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c, cur = bars[i].c;
    if (!(prev > 0) || !(cur > 0)) continue;
    const move = Math.abs(cur / prev - 1);
    if (move >= threshold) return true;
  }
  return false;
}

/**
 * Assess one security fail-closed. Returns { eligible, exclusions, missing,
 * bars, price, dollarVol, staleSessions }.
 */
function assessEligibility(row, { asOf, calendarDates, policy = PEER_POLICY } = {}) {
  const exclusions = [];
  const missing = [];
  const bars = asOfSlice(toBars(row.bars || row.raw || []), asOf);

  if (bars.length < policy.minBars) exclusions.push(EXCLUSION.NO_BARS);

  const lastDate = bars.length ? bars[bars.length - 1].date : null;
  const staleSessions = staleSessionsOf(lastDate, calendarDates);
  if (staleSessions == null) {
    // No calendar reference — cannot prove freshness ⇒ fail closed.
    if (bars.length) exclusions.push(EXCLUSION.STALE);
  } else if (staleSessions > policy.maxStaleSessions) {
    exclusions.push(EXCLUSION.STALE);
  }

  const price = num(row.price) ?? (bars.length ? num(bars[bars.length - 1].c) : null);
  if (price == null || price < policy.minPrice) exclusions.push(EXCLUSION.NO_PRICE);

  const dollarVol = num(row.dollarVol);
  if (dollarVol == null || dollarVol < policy.minDollarVol) exclusions.push(EXCLUSION.NO_LIQUIDITY);

  if (bars.length >= 2 && hasBarAnomaly(bars.slice(-policy.minBars), policy.anomalyDayMove)) {
    exclusions.push(EXCLUSION.ANOMALY);
  }

  if (row.nonTradable === true) exclusions.push(EXCLUSION.NON_TRADABLE);

  // Missing sector is a MASK, not an exclusion — market-only shadow observation.
  if (!row.sector) missing.push('sector');

  return {
    eligible: exclusions.length === 0,
    exclusions, missing, bars, price, dollarVol, staleSessions, lastDate,
  };
}

function bandOf(row) {
  return row.capGroup || 'unknown';
}

/**
 * Build the point-in-time peer universe.
 *
 * @param rows      [{ticker, sector, sectorSource?, sectorEtf?, price, dollarVol,
 *                    capGroup, bars|raw, securityId?, industry?, nonTradable?}]
 * @param asOf      New York market date 'YYYY-MM-DD' (data cutoff, inclusive)
 * @param calendarDates ascending session dates of the reference calendar (SPY bars)
 * @param decisionTs ISO timestamp of the decision (provenance only)
 */
function buildPeerUniverse({ rows = [], asOf = null, calendarDates = [], decisionTs = null, policy = PEER_POLICY } = {}) {
  const assessed = [];
  for (const row of rows) {
    if (!row || !row.ticker) continue;
    const a = assessEligibility(row, { asOf, calendarDates, policy });
    assessed.push({
      securityId: row.securityId || null,
      ticker: row.ticker,
      decisionTs,
      marketDate: asOf,
      dataCutoff: asOf,
      sector: row.sector || null,
      sectorEtf: row.sectorEtf || null,
      sectorSource: row.sector ? (row.sectorSource || 'universe-static') : null,
      sectorAsOf: row.sectorAsOf || null,
      industry: row.industry || null,
      band: bandOf(row),
      price: a.price,
      dollarVol: a.dollarVol,
      staleSessions: a.staleSessions,
      lastDate: a.lastDate,
      membershipSource: row.scope || row.membershipSource || 'unknown',
      membershipConfidence: row.sector ? (row.sectorSource === 'provider' ? 'provider' : 'curated') : 'market-only',
      eligible: a.eligible,
      exclusions: a.exclusions,
      missing: a.missing,
      bars: a.bars,
    });
  }

  const eligible = assessed.filter(r => r.eligible);

  // ── Peer grouping with labeled fallback ──────────────────────────────────
  const bySectorBand = new Map();
  const bySector = new Map();
  for (const r of eligible) {
    if (r.sector) {
      const kb = `${r.sector}|${r.band}`;
      if (!bySectorBand.has(kb)) bySectorBand.set(kb, []);
      bySectorBand.get(kb).push(r);
      if (!bySector.has(r.sector)) bySector.set(r.sector, []);
      bySector.get(r.sector).push(r);
    }
  }

  const groups = {};
  for (const r of eligible) {
    let level = GROUPING.MARKET;
    let members = eligible;
    if (r.sector) {
      const sb = bySectorBand.get(`${r.sector}|${r.band}`) || [];
      const s = bySector.get(r.sector) || [];
      if (sb.length >= policy.minPeers) { level = GROUPING.SECTOR_BAND; members = sb; }
      else if (s.length >= policy.minPeers) { level = GROUPING.SECTOR; members = s; }
    }
    const peerGroupId = level === GROUPING.SECTOR_BAND ? `${r.sector}|${r.band}`
      : level === GROUPING.SECTOR ? r.sector
      : 'MARKET';
    r.peerGroupId = peerGroupId;
    r.groupingLevel = level;
    r.peerGroupSize = members.length;
    r.groupingFallback = r.sector
      ? (level === GROUPING.SECTOR_BAND ? null : `fell back to ${level} (sector-band peers < ${policy.minPeers})`)
      : 'market-only: sector metadata missing (shadow observation)';
    if (!groups[peerGroupId]) groups[peerGroupId] = members.map(m => m.ticker);
  }

  const snapshotBasis = `${VERSIONS.universe}|${asOf}|${eligible.map(r => r.ticker).sort().join(',')}`;
  const universeSnapshotId = 'rltu-' + crypto.createHash('sha256').update(snapshotBasis).digest('hex').slice(0, 16);
  for (const r of assessed) r.universeSnapshotId = universeSnapshotId;

  return Object.freeze({
    version: VERSIONS.universe,
    asOf,
    decisionTs,
    universeSnapshotId,
    policy: { minPeers: policy.minPeers, minBars: policy.minBars, maxStaleSessions: policy.maxStaleSessions },
    rows: assessed,
    groups,
    coverage: Object.freeze({
      total: assessed.length,
      eligible: eligible.length,
      excluded: assessed.length - eligible.length,
      marketOnly: eligible.filter(r => r.groupingLevel === GROUPING.MARKET && !r.sector).length,
      sectorBandGroups: [...bySectorBand.keys()].filter(k => bySectorBand.get(k).length >= policy.minPeers).length,
      exclusionCounts: countBy(assessed.filter(r => !r.eligible).flatMap(r => r.exclusions)),
    }),
  });
}

function countBy(items) {
  const out = {};
  for (const it of items) out[it] = (out[it] || 0) + 1;
  return out;
}

module.exports = {
  buildPeerUniverse, assessEligibility, staleSessionsOf, hasBarAnomaly,
  GROUPING, EXCLUSION,
};
