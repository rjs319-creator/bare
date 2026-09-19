'use strict';
// CFR PROSPECTIVE SHADOW LEDGER — pure logic (weight 0; ledger + display only).
//
// The walk-forward benchmark behind PR #405 (cfr-walkforward-2026-08, data cutoff
// 2026-07-06, FMP research snapshot) found a small but statistically distinguishable
// cross-sectional signal in the `ridge` arm's residual-return point forecast — and NO
// demonstrated after-cost profitable strategy. This lane accrues the survivorship-free
// prospective evidence that decides whether that signal survives contact with live
// data. It changes NO ranking, selection, sizing, alerts or governance.
//
// TWO ARMS, DECLARED APART (the serving path's ranker is NOT the evidenced arm):
//   * primary  — `ridge-point`: the board ordered by expectedResidualReturn, which at
//     capability tier 5 (no Python sidecar; the production tier) is exactly the `ridge`
//     arm the benchmark measured. Confirmation family.
//   * secondary — `ridge-xs`: the rankerScore ordering runInference actually serves at
//     tier 5. It never executed in the benchmark (LightGBM was always available there),
//     so it has NO historical evidence. First-evidence family, gated separately.
//
// OUTCOME CONSTRUCTION (frozen): raw leg = lib/forecast/targets.forwardWindow (next-open
// fill → decision+h close); residual = targets.neutralize('residual-mkt-sector-v1') with
// the betas FROZEN INTO THE WRITE-ONCE SHARD at decision time. The resolver reads them
// and never recomputes — recomputing betas from post-decision data would leak the future
// into a "prospective" ledger and void the lane.

const TARGETS = require('./forecast/targets');

const FROZEN = Object.freeze({
  version: 'forecast-shadow-v1',
  experimentId: 'cfr-prospective-2026-09',
  candidates: 'lib/universe.js LARGE (S&P 500 + themes, ~517 names; realized per-date size recorded in every shard)',
  universe: Object.freeze({ minAvgDollarVolume: 2e7, minHistorySessions: 300 }),
  horizons: Object.freeze([1, 3, 5, 10]),
  inference: Object.freeze({
    trainSessions: 500, dateStride: 5,
    geometry: 'research/88 buildConfig verbatim: embargo maxH+2, minTrainSessions 100, testSessions 25, innerFolds 3 — the geometry the benchmark actually measured (lib/forecast-shadow-routes CFG_OVERRIDES)',
  }),
  arms: Object.freeze({
    primary: Object.freeze({
      arm: 'ridge-point',
      ordering: 'expectedResidualReturn desc (eligible rows only; ties broken by ticker)',
      lineage: 'cfr-walkforward-2026-08 ridge arm (PR #405; data cutoff 2026-07-06); this family CONFIRMS existing evidence',
    }),
    secondary: Object.freeze({
      arm: 'ridge-xs',
      ordering: 'served rankerScore rank at capability tier 5 (metaBackend ridge-xs)',
      lineage: 'NO backtest evidence — the ridge-xs branch never executed in the benchmark; this family is FIRST evidence',
    }),
  }),
  outcome: Object.freeze({
    definition: 'residual-mkt-sector-v1',
    rawLeg: 'lib/forecast/targets.forwardWindow: next-session-open fill to decision+h close',
    betas: 'frozen into the write-once day shard at decision time; the resolver never recomputes',
  }),
  book: Object.freeze({
    topK: 20,
    noTradeBand: 2.0,
    weighting: 'equal',
    maxWeightPerSector: 0.35,
    switchCostTest: false,
    rebalance: 'every-trading-day (sessionsPerPeriod 1)',
    cost: '0.5 x sum|w_new - w_old| x round trip (lib/forecast/backtest turnover convention)',
    role: 'DESCRIPTIVE ONLY — comparability with the benchmark net numbers; explicitly NOT the gate',
  }),
  prospectiveGate: Object.freeze({
    metric: 'per-decision-date Spearman rank IC of the arm ordering vs realized frozen-beta residual returns',
    minResolvedDates: 80,
    fdrAlpha: 0.1,
    fdrFamily: 'the 4 horizons WITHIN each arm family; the two arm families are separately declared trials',
    ci: 'widest of Newey-West Student-t and seeded moving-block bootstrap, clear of zero',
    minPositiveBlocks: 3,
    promotion: 'manual reviewed registry change; the first permitted step is an annotation, never selection',
  }),
  providerSplit: 'benchmark evidence: FMP research snapshot (cutoff 2026-07-06); this ledger: live Yahoo bars via lib/screener fetchDailyHistory — a genuine data-source change, disclosed here rather than discovered later',
});

const isFin = Number.isFinite;

/**
 * Primary ordering: eligible rows with a finite expectedResidualReturn, sorted by the
 * point forecast descending, ties broken by ticker so the ordering is total and
 * deterministic. Returns [{ticker, point, primaryRank}] with 1-based ranks. Pure.
 */
function primaryOrder(rows) {
  return (rows || [])
    .filter((r) => r && r.eligible === true && isFin(r.expectedResidualReturn) && r.ticker)
    .sort((a, b) => (b.expectedResidualReturn - a.expectedResidualReturn) || (a.ticker < b.ticker ? -1 : 1))
    .map((r, i) => ({ ticker: r.ticker, point: r.expectedResidualReturn, primaryRank: i + 1 }));
}

/**
 * Build one horizon's shard rows from runInference scored rows plus the decision-date
 * beta rows (dataset.buildPanelRows output, which carries betaSectorMarket; the scored
 * row carries the same set as sectorMarketBeta/sectorEtf and is the fallback). Both rankings are recorded per row; the point (an expected residual
 * return) and the xs rank (an ordering from a z-score model) are DISTINCT fields and
 * must never be aggregated together. Pure.
 */
function buildShardRows(scoredRows, betaRowsByTicker) {
  const primary = new Map(primaryOrder(scoredRows).map((r) => [r.ticker, r.primaryRank]));
  return (scoredRows || [])
    .filter((r) => r && r.ticker)
    .map((r) => {
      const b = (betaRowsByTicker && betaRowsByTicker.get(r.ticker)) || {};
      return {
        ticker: r.ticker,
        eligible: r.eligible === true,
        exclusionReason: r.exclusionReason || null,
        // primary arm: the evidenced ridge point (an expected RESIDUAL return)
        expectedResidualReturn: isFin(r.expectedResidualReturn) ? r.expectedResidualReturn : null,
        primaryRank: primary.get(r.ticker) || null,
        // secondary arm: the served ridge-xs ordering (a rank from a z-score model, NOT a return)
        xsRank: isFin(r.rank) ? r.rank : null,
        // frozen at decision time; the resolver reads these, never recomputes
        betaMarket: isFin(b.betaMarket) ? b.betaMarket : (isFin(r.marketBeta) ? r.marketBeta : null),
        betaSector: isFin(b.betaSector) ? b.betaSector : (isFin(r.sectorBeta) ? r.sectorBeta : null),
        betaSectorMarket: isFin(b.betaSectorMarket) ? b.betaSectorMarket : (isFin(r.sectorMarketBeta) ? r.sectorMarketBeta : null),
        sector: r.sector || b.sector || null,
        sectorEtf: b.sectorEtf || r.sectorEtf || null,
        estimatedCostFraction: isFin(r.estimatedCostFraction) ? r.estimatedCostFraction : null,
      };
    });
}

/**
 * Prospective no-trade-band sleeve. Reproduces lib/forecast/backtest selectSleeve's
 * member selection EXACTLY (incumbents kept in score order while inside topK*band,
 * fills from the top, sector cap as a count) minus its label requirement — labels do
 * not exist yet on a prospective board. test/forecast-shadow.test.js pins parity
 * against the real selectSleeve so the two cannot drift apart silently.
 *   ordered  [{ticker, sector}] best-first (primary ordering)
 *   previous [tickers] the prior published book
 * Returns { book: [tickers], turnover } with equal weights implied. Pure.
 */
function carrySleeve(ordered, previous, { topK = FROZEN.book.topK, noTradeBand = FROZEN.book.noTradeBand, maxWeightPerSector = FROZEN.book.maxWeightPerSector } = {}) {
  const ranked = (ordered || []).filter((r) => r && r.ticker);
  if (!ranked.length) return { book: [], turnover: null, skipped: 'no ranked rows' };
  const maxPerSector = Math.max(1, Math.ceil(topK * maxWeightPerSector));
  const bySector = new Map();
  const picked = [];
  const takeIfRoom = (r) => {
    if (picked.length >= topK) return false;
    const sec = r.sector || 'UNKNOWN';
    const n = bySector.get(sec) || 0;
    if (n >= maxPerSector) return false;
    bySector.set(sec, n + 1);
    picked.push(r.ticker);
    return true;
  };
  const band = Math.max(1, noTradeBand || 1);
  const prev = (previous || []).filter(Boolean);
  if (prev.length && band > 1) {
    const held = new Set(prev);
    const keepLimit = Math.min(ranked.length, Math.ceil(topK * band));
    for (let i = 0; i < keepLimit; i++) if (held.has(ranked[i].ticker)) takeIfRoom(ranked[i]);
    const inBook = new Set(picked);
    for (const r of ranked) { if (!inBook.has(r.ticker)) takeIfRoom(r); if (picked.length >= topK) break; }
  } else {
    for (const r of ranked) { takeIfRoom(r); if (picked.length >= topK) break; }
  }
  return { book: picked, turnover: bookTurnover(prev, picked) };
}

/** Half the L1 weight change between two equal-weight books — the traded fraction.
 * A first book (no previous) is a full buy: turnover 1. Pure. */
function bookTurnover(prevBook, nextBook) {
  const prev = (prevBook || []).filter(Boolean);
  const next = (nextBook || []).filter(Boolean);
  if (!next.length) return null;
  if (!prev.length) return 1;
  const wPrev = 1 / prev.length, wNext = 1 / next.length;
  const all = new Set([...prev, ...next]);
  const inPrev = new Set(prev), inNext = new Set(next);
  let d = 0;
  for (const t of all) d += Math.abs((inNext.has(t) ? wNext : 0) - (inPrev.has(t) ? wPrev : 0));
  return d / 2;
}

/**
 * Cost charged for moving between two equal-weight books, as a FRACTION of the book:
 * 0.5 x sum over names of |w_new - w_old| x that name's round-trip cost. Reduces to one
 * full round trip on 100% turnover — the corrected accounting from lib/forecast/backtest
 * (the original whole-book charge overstated costs by ~1/turnover). `costOf(ticker)`
 * returns the round-trip cost AS A FRACTION (the scored row's `estimatedCostFraction`).
 * Names it cannot price use the median of those it can (`pricedFraction` records the
 * share priced). Pure.
 */
function chargeFor(prevBook, nextBook, costOf) {
  const prev = (prevBook || []).filter(Boolean);
  const next = (nextBook || []).filter(Boolean);
  if (!next.length) return { chargedCost: null, pricedFraction: null };
  const wPrev = prev.length ? 1 / prev.length : 0, wNext = 1 / next.length;
  const inPrev = new Set(prev), inNext = new Set(next);
  const moves = [];
  for (const t of new Set([...prev, ...next])) {
    const d = Math.abs((inNext.has(t) ? wNext : 0) - (inPrev.has(t) ? wPrev : 0));
    if (d > 0) moves.push({ ticker: t, d });
  }
  if (!moves.length) return { chargedCost: 0, pricedFraction: 1 };
  const known = moves.map((m) => costOf && costOf(m.ticker)).filter(isFin).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : null;
  if (median == null) return { chargedCost: null, pricedFraction: 0 };
  let charge = 0;
  for (const m of moves) {
    const c = costOf(m.ticker);
    charge += 0.5 * m.d * (isFin(c) ? c : median);
  }
  return { chargedCost: +charge.toFixed(8), pricedFraction: +(known.length / moves.length).toFixed(4) };
}

/**
 * Spearman rank IC with average ranks for ties. Inputs are parallel arrays; pairs with
 * a non-finite side are dropped. Returns { ic, n } (ic null when n < 3 or either side
 * is constant). Pure.
 */
function spearmanIC(pred, real) {
  const xs = [], ys = [];
  for (let i = 0; i < (pred || []).length; i++) {
    if (isFin(pred[i]) && isFin((real || [])[i])) { xs.push(pred[i]); ys.push(real[i]); }
  }
  const n = xs.length;
  if (n < 3) return { ic: null, n };
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx, dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { ic: null, n };
  return { ic: sxy / Math.sqrt(sxx * syy), n };
}

/**
 * One name's frozen-beta residual outcome at horizon h.
 *   candles/idx        the name's series and its decision-date bar index
 *   bench/benchIdx     SPY series and its decision-date bar index
 *   sector/sectorIdx   the frozen sector ETF's series and index (null when none)
 *   betas              { betaMarket, betaSector, betaSectorMarket } FROM THE SHARD
 * Returns { residual, raw, sectorApplied, reason } — `reason` non-null means the
 * outcome is unobservable and must be dropped, never coerced to 0. Pure.
 */
function residualOutcome({ candles, idx, h, bench, benchIdx, sector = null, sectorIdx = null, betas = {} }) {
  const fw = TARGETS.forwardWindow(candles, idx, h);
  if (fw.reason) return { residual: null, raw: null, sectorApplied: false, reason: fw.reason };
  const mw = TARGETS.forwardWindow(bench, benchIdx, h);
  if (mw.reason) return { residual: null, raw: fw.ret, sectorApplied: false, reason: `benchmark:${mw.reason}` };
  let fwdSector = null;
  if (sector && sectorIdx != null && sectorIdx >= 0) {
    const sw = TARGETS.forwardWindow(sector, sectorIdx, h);
    if (!sw.reason) fwdSector = sw.ret;
  }
  const residual = TARGETS.neutralize('residual-mkt-sector-v1', {
    fwd: fw.ret, fwdMarket: mw.ret, fwdSector,
    betaMarket: betas.betaMarket, betaSector: betas.betaSector, betaSectorMarket: betas.betaSectorMarket,
  });
  if (!isFin(residual)) return { residual: null, raw: fw.ret, sectorApplied: false, reason: 'no-market-beta' };
  const sectorApplied = isFin(fwdSector) && isFin(betas.betaSector) && isFin(betas.betaSectorMarket);
  return { residual, raw: fw.ret, sectorApplied, reason: null };
}

/**
 * Per-date, per-horizon resolution: rank ICs for both arms plus the descriptive book
 * outcome. `outcomes` maps ticker -> { residual, raw, reason }. Pure.
 */
function resolveHorizon(shardRows, outcomes, book) {
  const rows = (shardRows || []).filter((r) => r && r.eligible === true);
  const resid = (t) => {
    const o = outcomes && outcomes.get(t);
    return o && o.reason == null && isFin(o.residual) ? o.residual : null;
  };
  // Rank ICs correlate an ordering with realized residuals, so BETTER rank (smaller
  // number) must pair with HIGHER residual: negate the rank before correlating.
  const primary = spearmanIC(
    rows.map((r) => (isFin(r.primaryRank) ? -r.primaryRank : null)),
    rows.map((r) => resid(r.ticker)),
  );
  const xs = spearmanIC(
    rows.map((r) => (isFin(r.xsRank) ? -r.xsRank : null)),
    rows.map((r) => resid(r.ticker)),
  );
  const scored = rows.filter((r) => resid(r.ticker) != null).length;
  let bookOut = null;
  if (book && book.book && book.book.length) {
    const vals = book.book.map((t) => {
      const o = outcomes && outcomes.get(t);
      return o && o.reason == null && isFin(o.raw) ? o.raw : null;
    }).filter(isFin);
    if (vals.length) {
      const gross = vals.reduce((a, b) => a + b, 0) / vals.length;
      // Both legs are fractions of the book — no unit conversion needed.
      const charged = isFin(book.chargedCost) ? book.chargedCost : null;
      bookOut = {
        n: vals.length, missing: book.book.length - vals.length,
        grossMeanRaw: +gross.toFixed(6),
        chargedCost: charged,
        netMeanRaw: charged != null ? +(gross - charged).toFixed(6) : null,
      };
    }
  }
  return {
    n: rows.length, scored,
    coverage: rows.length ? +(scored / rows.length).toFixed(4) : null,
    primaryIC: primary.ic != null ? +primary.ic.toFixed(6) : null,
    primaryN: primary.n,
    xsIC: xs.ic != null ? +xs.ic.toFixed(6) : null,
    xsN: xs.n,
    book: bookOut,
  };
}

module.exports = {
  FROZEN,
  primaryOrder, buildShardRows, carrySleeve, bookTurnover, chargeFor,
  spearmanIC, residualOutcome, resolveHorizon,
};
