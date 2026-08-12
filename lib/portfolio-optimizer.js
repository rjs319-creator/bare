// Cost-aware SHADOW portfolio optimizer (optimizer-v1) — pure, weight-0 research.
//
// Everything else in this repo ranks first and subtracts costs afterwards; this
// module solves for weights against one NET economic objective instead:
//
//   maximize Σᵢ wᵢ·[ expectedNetPct_i − uncertaintyPenalty_i − impactPct_i(wᵢ·book) ]
//          − ½·λRISK·Σᵢ σᵢ²·wᵢ²                (idiosyncratic-risk penalty)
//          − λTURNOVER·Σᵢ |wᵢ − priorᵢ|         (trading the book costs money)
//
// subject to: Σwᵢ ≤ grossCap (≤ 1.0 — NEVER levered), wᵢ ≤ maxWeight,
//             Σ_{i∈sector} wᵢ ≤ maxSectorWeight, wᵢ ≥ 0 (long-only book).
//
// Greedy coordinate ascent in fixed slices: each step allocates one slice to the
// candidate with the highest MARGINAL utility; the walk stops the moment the best
// marginal utility is ≤ 0 — the remainder stays in cash. Holding cash is a
// first-class answer, not a failure state.
//
// Impact comes from the central cost model (lib/costs impactBps) at the position's
// actual notional, so "too big for this name" is priced INSIDE the objective, not
// discovered after the fact. Every stop/skip carries a machine-readable reason.
//
// HONESTY: σᵢ is per-name idiosyncratic vol used as a DIAGONAL risk proxy — no
// pairwise covariance matrix exists in this repo, and this module says so rather
// than inventing correlations. Comparisons vs equal-weight and rank-weight books
// are evaluated under the IDENTICAL objective, or the comparison means nothing.

const { impactBps } = require('./costs');

const OPTIMIZER_VERSION = 'optimizer-v1';

const DEFAULTS = Object.freeze({
  grossCap: 1.0,          // ≤100% gross — a shadow book is never levered
  maxWeight: 0.10,
  maxSectorWeight: 0.25,
  slice: 0.01,            // 1% allocation granularity
  lambdaRisk: 2.0,        // ½·λ·σ²·w² with σ in DAILY decimal terms scaled below
  lambdaTurnover: 0.10,   // % objective cost per 100% one-way turnover
  bookUsd: 100e3,         // notional the impact term prices — explicit, never implied
});

const r4 = x => +x.toFixed(4);

// Position-level impact drag in PERCENT for weight w of the book.
function impactPctAt(c, w, bookUsd) {
  return impactBps(c.dollarVol ?? null, w > 0 ? w * bookUsd : null) / 100;
}

// Marginal utility of adding `slice` to candidate i at current weight w.
function marginalUtility(c, w, slice, opts, prior) {
  const { bookUsd, lambdaRisk, lambdaTurnover } = opts;
  const base = (c.expectedNetPct ?? 0) - (c.uncertaintyPenaltyPct ?? 0);
  // Incremental impact: total impact at w+slice minus total at w (both charged on
  // their full notionals — impact is convex in size, so this is the honest delta).
  const impactDelta = ((w + slice) * impactPctAt(c, w + slice, bookUsd) - w * impactPctAt(c, w, bookUsd)) / slice;
  const sigma = c.idioVol ?? 0.02;                       // daily decimal; unknown → conservative default
  const riskDelta = lambdaRisk * (sigma * 100) ** 2 * (w + slice / 2); // d/dw of ½λσ²w², σ in %
  const turnoverDelta = (w + slice) > (prior[c.ticker] || 0) ? lambdaTurnover : 0;
  return base - impactDelta - riskDelta - turnoverDelta;
}

// Evaluate a whole weight vector under the SAME objective (for comparisons).
function evaluateBook(weights, candidates, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prior = o.priorWeights || {};
  const byTicker = new Map(candidates.map(c => [c.ticker, c]));
  let value = 0, gross = 0, turnover = 0;
  for (const [t, w] of Object.entries(weights)) {
    const c = byTicker.get(t);
    if (!c || !(w > 0)) continue;
    const sigma = c.idioVol ?? 0.02;
    value += w * ((c.expectedNetPct ?? 0) - (c.uncertaintyPenaltyPct ?? 0) - impactPctAt(c, w, o.bookUsd))
           - 0.5 * o.lambdaRisk * (sigma * 100) ** 2 * w * w;
    gross += w;
    turnover += Math.abs(w - (prior[t] || 0));
  }
  for (const [t, pw] of Object.entries(prior)) if (!(weights[t] > 0) && pw > 0) turnover += pw;
  value -= o.lambdaTurnover * turnover;
  return { value: r4(value), gross: r4(gross), cash: r4(Math.max(0, 1 - gross)), turnover: r4(turnover) };
}

// Solve. candidates: [{ticker, sector?, expectedNetPct, uncertaintyPenaltyPct?,
// idioVol?, dollarVol?}]. Returns weights + reasons + same-objective comparisons.
function optimizeBook(candidates, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prior = o.priorWeights || {};
  const rows = (candidates || []).filter(c => c && c.ticker && Number.isFinite(c.expectedNetPct));
  const weights = {};
  const sectorGross = {};
  const reasons = {};
  let gross = 0, steps = 0;
  const stepCap = Math.ceil(o.grossCap / o.slice) + rows.length; // hard bound on the walk

  while (gross + 1e-9 < o.grossCap && steps++ < stepCap * 4) {
    let best = null, bestMu = 0;
    for (const c of rows) {
      const w = weights[c.ticker] || 0;
      if (w + o.slice > o.maxWeight + 1e-9) { reasons[c.ticker] = reasons[c.ticker] || 'at-name-cap'; continue; }
      const sec = c.sector || 'Unknown';
      if ((sectorGross[sec] || 0) + o.slice > o.maxSectorWeight + 1e-9) { reasons[c.ticker] = reasons[c.ticker] || 'at-sector-cap'; continue; }
      const mu = marginalUtility(c, w, o.slice, o, prior);
      if (mu > bestMu) { bestMu = mu; best = c; }
    }
    if (!best) break;                                    // best marginal ≤ 0 ⇒ rest stays cash
    weights[best.ticker] = r4((weights[best.ticker] || 0) + o.slice);
    sectorGross[best.sector || 'Unknown'] = (sectorGross[best.sector || 'Unknown'] || 0) + o.slice;
    gross = r4(gross + o.slice);
    reasons[best.ticker] = 'allocated';
  }
  for (const c of rows) if (!(weights[c.ticker] > 0) && !reasons[c.ticker]) reasons[c.ticker] = 'negative-marginal-utility';

  // Same-objective comparison books over the SAME candidates and caps.
  const positive = rows.filter(c => c.expectedNetPct > 0);
  const ewW = Math.min(o.maxWeight, positive.length ? o.grossCap / positive.length : 0);
  const equalWeight = Object.fromEntries(positive.map(c => [c.ticker, r4(ewW)]));
  const ranked = positive.slice().sort((a, b) => b.expectedNetPct - a.expectedNetPct);
  const rankSum = ranked.reduce((a, _, i) => a + (ranked.length - i), 0) || 1;
  const rankWeight = Object.fromEntries(ranked.map((c, i) => [c.ticker, r4(Math.min(o.maxWeight, o.grossCap * (ranked.length - i) / rankSum))]));

  return {
    version: OPTIMIZER_VERSION,
    shadow: true, liveWeight: 0,
    config: { grossCap: o.grossCap, maxWeight: o.maxWeight, maxSectorWeight: o.maxSectorWeight, slice: o.slice, lambdaRisk: o.lambdaRisk, lambdaTurnover: o.lambdaTurnover, bookUsd: o.bookUsd },
    weights, reasons,
    book: evaluateBook(weights, rows, o),
    comparisons: {
      objectiveBasis: 'identical objective/caps/candidates — differences are the weighting scheme only',
      equalWeight: { weights: equalWeight, ...evaluateBook(equalWeight, rows, o) },
      rankWeight: { weights: rankWeight, ...evaluateBook(rankWeight, rows, o) },
    },
    riskModel: 'DIAGONAL idio-vol proxy — no pairwise covariance matrix exists in this repo; correlations are NOT modeled and this field says so',
  };
}

module.exports = { OPTIMIZER_VERSION, DEFAULTS, optimizeBook, evaluateBook, marginalUtility };
