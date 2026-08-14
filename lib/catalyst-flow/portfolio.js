'use strict';
// CATALYST–FLOW — PORTFOLIO CONSTRUCTION.
//
// Equal-weight up to ten names, at most three per sector, and — the part that actually
// matters — NO FORCED POSITIONS. If only four candidates clear the eligibility rule, the
// book holds four and the rest is cash. Filling the remaining six slots with the
// least-bad names is how a ranking model's tail gets quietly monetised, and it is the
// difference between "the top of the ranking is informative" and "we always hold ten".
//
// Optional hysteresis: enter at rank ≤ 10; retain while rank ≤ 30 AND estimated edge still
// exceeds round-trip cost. Retention is evaluated only when the strategy is refreshed, so
// a name is never churned by a rank that nobody acted on.
//
// Pure module: no network, no clock, no fs.

const { PORTFOLIO } = require('./config');

const PORTFOLIO_VERSION = 'catalyst-portfolio-v1';

// Positive-edge eligibility: the estimated edge must clear the round-trip cost the name
// would actually pay. A candidate with a positive score but sub-cost edge is not a
// position, it is a fee.
function isEligible(c, { edgeOverCost = 1.0 } = {}) {
  if (!c || !Number.isFinite(c.score)) return { ok: false, reason: 'no-score' };
  if (!Number.isFinite(c.estimatedEdge)) return { ok: false, reason: 'no-edge-estimate' };
  if (!Number.isFinite(c.estRoundTripCostPct)) return { ok: false, reason: 'no-cost-estimate' };
  if (c.estimatedEdge <= 0) return { ok: false, reason: 'non-positive-edge' };
  if (c.estimatedEdge <= edgeOverCost * (c.estRoundTripCostPct / 100)) return { ok: false, reason: 'edge-below-cost' };
  return { ok: true, reason: null };
}

// Select the book for ONE decision date.
//
// `candidates` must already be scored and carry `symbol`, `sector`, `score`,
// `estimatedEdge` (fraction) and `estRoundTripCostPct` (percent). `held` is the previous
// book, keyed by symbol, used only when hysteresis is on.
function selectBook(candidates, { held = new Map(), hysteresis = false, cfg = PORTFOLIO } = {}) {
  const ranked = [...(candidates || [])]
    .filter((c) => c && Number.isFinite(c.score))
    .sort((a, b) => (b.score - a.score) || String(a.symbol).localeCompare(String(b.symbol)))
    .map((c, i) => ({ ...c, rank: i + 1 }));

  const bySector = new Map();
  const book = [];
  const rejected = [];
  const seen = new Set();

  const tryAdmit = (c, via) => {
    if (book.length >= cfg.maxPositions) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'book-full' }); return false; }
    if (seen.has(c.symbol)) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'duplicate-symbol' }); return false; }
    const sec = c.sector || 'UNKNOWN';
    if ((bySector.get(sec) || 0) >= cfg.maxPerSector) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'sector-cap' }); return false; }
    bySector.set(sec, (bySector.get(sec) || 0) + 1);
    seen.add(c.symbol);
    book.push({ ...c, admittedVia: via });
    return true;
  };

  // Retention first, so an existing position is not displaced by a newcomer that merely
  // ranks one place higher — that churn costs a full round trip to buy the same exposure.
  if (hysteresis && held && held.size) {
    for (const c of ranked) {
      if (!held.has(c.symbol)) continue;
      if (c.rank > cfg.retainRank) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'below-retain-rank' }); continue; }
      const e = isEligible(c, { edgeOverCost: cfg.retainEdgeOverCost });
      if (!e.ok) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: `retain:${e.reason}` }); continue; }
      tryAdmit(c, 'retained');
    }
  }

  for (const c of ranked) {
    // A second row for a symbol already in the book is COUNTED, not silently skipped —
    // duplicates in a candidate list mean an upstream join produced them, and a rejection
    // ledger that hides them makes that bug invisible.
    if (seen.has(c.symbol)) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'duplicate-symbol' }); continue; }
    if (c.rank > cfg.enterRank) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: 'below-enter-rank' }); continue; }
    const e = isEligible(c);
    if (!e.ok) { rejected.push({ symbol: c.symbol, rank: c.rank, reason: `enter:${e.reason}` }); continue; }
    tryAdmit(c, 'entered');
  }

  const weight = book.length ? 1 / book.length : 0;
  return {
    version: PORTFOLIO_VERSION,
    positions: book.map((c) => ({ ...c, weight })),
    // Cash is the residual of the CAPACITY, not of the book: holding 4 of 10 slots means
    // 60% cash, and reporting a 4-name book as "fully invested" would hide the abstention
    // that is the whole point of the rule.
    cashWeight: 1 - (book.length / cfg.maxPositions),
    filled: book.length,
    capacity: cfg.maxPositions,
    rejected,
    sectorCounts: Object.fromEntries(bySector),
  };
}

// Equal-weight book return over the hold, minus the predeclared benchmark. An empty book
// returns 0 (cash), never null — abstaining is a decision with a known outcome.
function bookOutcome(book, { realisedReturnOf, benchmarkReturn }) {
  const positions = (book && book.positions) || [];
  if (!Number.isFinite(benchmarkReturn)) return { value: null, reason: 'no-benchmark-return' };
  if (!positions.length) return { value: 0, reason: null, basis: 'cash', n: 0 };

  const rs = positions.map((p) => realisedReturnOf(p)).filter(Number.isFinite);
  if (rs.length !== positions.length) return { value: null, reason: 'unresolved-position-return' };
  const portfolio = rs.reduce((s, v) => s + v, 0) / rs.length;
  return { value: portfolio - benchmarkReturn, reason: null, basis: 'invested', n: rs.length, portfolioReturn: portfolio, benchmarkReturn };
}

module.exports = { PORTFOLIO_VERSION, isEligible, selectBook, bookOutcome };
