'use strict';
// ATLAS-X — shadow portfolio construction (WEIGHT-0).
//
// A shadow book that demotes concentration and EXPLAINS every omission, so we can
// later measure whether ATLAS-X's set-level selection adds anything over the raw
// rank. It reuses lib/decision-portfolio.js for the sector / expert / duplicate /
// size / liquidity greedy admission (one implementation, not two), then adds the
// correlation-cluster cap on the survivors.
//
// TWO INVARIANTS ENFORCED HERE:
//   • Every position has weight 0 — this book never sizes or trades real capital.
//   • NO forced fill: caps only ever REMOVE names; freed slots stay empty rather
//     than pull junk up the list. A short, honest book is the design.
//
// Every excluded name carries a plain reason (sector concentration / correlated /
// liquidity / negative net utility / uncertainty / event risk / no remaining edge /
// better alternative). Pure, frozen output.

const { PORTFOLIO, HURDLES } = require('./atlasx-config');
const { buildPortfolio } = require('./decision-portfolio');

const SHADOW_WEIGHT = 0;

// Map decision-portfolio + actionability reason codes → the ATLAS-X vocabulary the
// excluded panel renders. Unknown codes pass through as 'not-actionable'.
const REASON_MAP = Object.freeze({
  // decision-portfolio codes
  'sector-cap': 'sector-concentration',
  'family-cap': 'expert-concentration',
  'duplicate-underlying': 'duplicate-underlying',
  liquidity: 'liquidity',
  'net-ev': 'negative-net-utility',
  'quality-floor': 'no-remaining-edge',
  size: 'book-full',
  'not-a-position': 'not-a-position',
  // atlasx-utility abstention codes
  'negative-expected-utility': 'negative-net-utility',
  'below-net-utility-hurdle': 'negative-net-utility',
  'prosecutor-failure-score': 'event-risk',
  'insufficient-remaining-rr': 'no-remaining-edge',
  'stale-data': 'stale-data',
  'expert-not-applicable': 'expert-not-applicable',
  'insufficient-liquidity': 'liquidity',
  'regime-not-permitted': 'event-risk',
  'insufficient-calibration': 'uncertainty',
});

const mapReason = (code) => REASON_MAP[code] || (code ? String(code) : 'not-actionable');
const freezeEx = (ticker, reason) => Object.freeze({ ticker: ticker ?? null, reason });

/**
 * Build the ATLAS-X shadow portfolio from ranked candidates.
 * @param {Array} rankedCandidates each {ticker,expert,sector,cluster,rank,score,
 *   liquidity:{dollarVol}, actionable?, abstentionReason?}
 * @param {object} opts cap overrides
 * @returns {{positions,excluded,caps}} frozen
 */
function buildAtlasPortfolio(rankedCandidates, opts = {}) {
  const caps = Object.freeze({
    maxPositions: opts.maxPositions ?? PORTFOLIO.maxPositions,
    maxPerSector: opts.maxPerSector ?? PORTFOLIO.maxPerSector,
    maxPerExpert: opts.maxPerExpert ?? PORTFOLIO.maxPerExpert,
    maxCorrelationCluster: opts.maxCorrelationCluster ?? PORTFOLIO.maxCorrelationCluster,
  });

  const rows = Array.isArray(rankedCandidates) ? rankedCandidates.filter(Boolean) : [];
  const excluded = [];

  // 1. Fail-closed: a candidate explicitly flagged not-actionable never enters the
  //    book; its own abstention reason is preserved.
  const eligible = [];
  for (const c of rows) {
    if (c.actionable === false) {
      excluded.push(freezeEx(c.ticker, mapReason(c.abstentionReason)));
    } else {
      eligible.push(c);
    }
  }

  // 2. Reuse decision-portfolio for sector / expert(as family) / dup / size /
  //    liquidity. Expert maps to strategyFamily so its family cap == maxPerExpert.
  const mapped = eligible.map((c, i) => ({
    id: c.ticker,
    ticker: c.ticker,
    horizon: 'swing',
    score: c.score,
    sector: c.sector,
    strategyFamily: c.expert,
    liquidity: c.liquidity,
    rank: c.rank ?? (i + 1),
  }));
  const book = buildPortfolio(mapped, {
    size: caps.maxPositions,
    maxPerSector: caps.maxPerSector,
    maxPerFamily: caps.maxPerExpert,
    minDollarVol: HURDLES.minLiquidityDollarVol,
    minScore: 0,
  });
  for (const ex of book.excluded) excluded.push(freezeEx(ex.ticker, mapReason(ex.reason)));

  // 3. Correlation-cluster cap on the survivors (NO refill of freed slots).
  const byTicker = new Map(eligible.map((c) => [c.ticker, c]));
  const clusterCount = new Map();
  const positions = [];
  for (const s of book.selected) {
    const orig = byTicker.get(s.ticker) || {};
    const cluster = orig.cluster != null ? orig.cluster : null;
    const held = cluster != null ? (clusterCount.get(cluster) || 0) : 0;
    if (cluster != null && held >= caps.maxCorrelationCluster) {
      excluded.push(freezeEx(s.ticker, 'correlated'));
      continue;
    }
    if (cluster != null) clusterCount.set(cluster, held + 1);
    positions.push(Object.freeze({
      ticker: s.ticker,
      expert: orig.expert ?? null,
      sector: orig.sector ?? null,
      weight: SHADOW_WEIGHT,
      rank: s.rank ?? null,
    }));
  }

  return Object.freeze({
    positions: Object.freeze(positions),
    excluded: Object.freeze(excluded),
    caps,
  });
}

module.exports = { SHADOW_WEIGHT, REASON_MAP, buildAtlasPortfolio };
