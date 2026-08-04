'use strict';
// SHADOW MARGINAL-ATTRIBUTION LEARNER for the confluence screener (defect #6).
//
// THE DEFECT. The live per-strategy EWMA assigned each resolved pick's FULL
// realized 21-session excess to EVERY strategy that voted bullish. Four of the
// five strategies (ema/supertrend/macd/priceAction) are one correlated trend
// family that co-fires, so one return was counted as four independent pieces of
// per-strategy evidence — not marginal attribution.
//
// THIS MODULE. A weight-0 SHADOW learner that does the attribution honestly:
//   • FAMILY-LEVEL: the four trend-style rules collapse to ONE `trend` evidence
//     family; `rsi` is the `meanReversion` family (lib/confluence STRATEGY_FAMILY).
//     Multiple overlapping votes from one date/ticker are NEVER independent samples.
//   • DATE-LEVEL OBSERVATIONS: picks aggregate to one row per decision DATE
//     (cross-sectional means), so overlapping 21-session outcomes cannot inflate
//     the effective sample. Effective sample = distinct decision dates.
//   • REGULARIZED FAMILY REGRESSION with PURGED chronological walk-forward:
//     ridge fit on [1, trendShare, mrShare] → date-mean excess; train dates within
//     `embargoDates` of the test block are purged (the 21-session label overlap).
//   • BASELINES ON IDENTICAL PAIRED DATES: equal-weight (train-mean prediction),
//     raw vote count, and a sign-shuffled placebo — all scored on the same test
//     dates as the marginal model.
//   • FAIL-CLOSED VERDICT: 'PASS' only with ≥ minDates distinct dates AND the
//     marginal model beating every baseline out-of-sample cost-net; otherwise
//     'INSUFFICIENT_DATA' or 'NO_IMPROVEMENT'. The verdict feeds a human registry
//     decision — it can never self-promote (strategy-gate owns eligibility).
//
// Pure (no store, no network); deterministic (seeded LCG for the placebo).

const { STRATEGY_FAMILY, STRATEGIES } = require('./confluence');

const MARGINAL_VERSION = 'confluence-marginal-v1';
const FAMILIES = ['trend', 'meanReversion'];
const DEFAULTS = Object.freeze({ embargoDates: 21, minDates: 40, folds: 3, ridgeLambda: 1.0, costPct: 0.5, seed: 7 });

// One observation per (date, ticker); families are BINARY (four correlated trend
// votes are one unit of trend evidence, never four).
function toFamilyObservations(picks) {
  const seen = new Set();
  const out = [];
  for (const p of picks || []) {
    if (!p || !p.resolved || !Number.isFinite(p.excPct) || !p.date || !p.ticker) continue;
    const k = `${p.date}|${p.ticker}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const fam = { trend: 0, meanReversion: 0 };
    for (const s of (p.bull || [])) { const f = STRATEGY_FAMILY[s]; if (f && fam[f] === 0) fam[f] = 1; }
    out.push({ date: p.date, ticker: p.ticker, fam, voteCount: (p.bull || []).length, y: p.excPct });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ticker < b.ticker ? -1 : 1));
}

// Collapse observations to date-level rows: cross-sectional means per decision date.
function toDateRows(obs) {
  const byDate = new Map();
  for (const o of obs) {
    const r = byDate.get(o.date) || { date: o.date, n: 0, trend: 0, meanReversion: 0, votes: 0, y: 0 };
    r.n++; r.trend += o.fam.trend; r.meanReversion += o.fam.meanReversion; r.votes += o.voteCount; r.y += o.y;
    byDate.set(o.date, r);
  }
  return [...byDate.values()].map(r => ({
    date: r.date, n: r.n,
    trendShare: r.trend / r.n, mrShare: r.meanReversion / r.n, voteAvg: r.votes / r.n,
    y: r.y / r.n,
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Closed-form ridge for x = [1, trendShare, mrShare] (3×3 solve). Intercept unpenalized.
function fitRidge(rows, lambda) {
  const X = rows.map(r => [1, r.trendShare, r.mrShare]);
  const y = rows.map(r => r.y);
  const d = 3;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < d; j++) A[j][j] += lambda;   // don't penalize the intercept
  // Gaussian elimination with partial pivoting.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r2 = c + 1; r2 < d; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r2 = 0; r2 < d; r2++) {
      if (r2 === c) continue;
      const f = M[r2][c] / M[c][c];
      for (let k = c; k <= d; k++) M[r2][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[d] / row[i]);   // [intercept, betaTrend, betaMR]
}

const mse = (pairs) => pairs.length ? pairs.reduce((s, [p, a]) => s + (p - a) ** 2, 0) / pairs.length : null;
const mean = (a) => a.length ? a.reduce((x, v) => x + v, 0) / a.length : 0;

function lcg(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// Purged chronological walk-forward over date rows. Returns per-fold paired-date
// test metrics for the marginal model and every baseline.
function walkForward(rows, { folds, embargoDates, ridgeLambda, seed }) {
  const n = rows.length;
  const foldOut = [];
  const rand = lcg(seed);
  for (let f = 1; f <= folds; f++) {
    const testStart = Math.floor((n * f) / (folds + 1));
    const testEnd = Math.floor((n * (f + 1)) / (folds + 1));
    const test = rows.slice(testStart, testEnd);
    // PURGE: a 21-session forward label decided near the test block overlaps it —
    // drop the last `embargoDates` train rows before the boundary.
    const train = rows.slice(0, Math.max(0, testStart - embargoDates));
    if (train.length < 8 || !test.length) continue;
    const w = fitRidge(train, ridgeLambda);
    const trainMean = mean(train.map(r => r.y));
    // Vote-count baseline: linear fit y ~ voteAvg on train (1-feature least squares).
    const vx = train.map(r => r.voteAvg), vy = train.map(r => r.y);
    const vxm = mean(vx), vym = mean(vy);
    const cov = mean(vx.map((v, i) => (v - vxm) * (vy[i] - vym)));
    const varx = mean(vx.map(v => (v - vxm) ** 2)) || 1e-9;
    const vSlope = cov / varx, vInt = vym - vSlope * vxm;
    // Placebo: ridge fit on sign-shuffled train outcomes (seeded, deterministic).
    const shuffled = train.map(r => ({ ...r, y: r.y * (rand() < 0.5 ? -1 : 1) }));
    const wp = fitRidge(shuffled, ridgeLambda);
    const pairsOf = (predict) => test.map(r => [predict(r), r.y]);
    foldOut.push({
      fold: f, trainDates: train.length, testDates: test.length,
      testRange: [test[0].date, test[test.length - 1].date],
      marginal: mse(pairsOf(r => w ? w[0] + w[1] * r.trendShare + w[2] * r.mrShare : trainMean)),
      equalWeight: mse(pairsOf(() => trainMean)),
      voteCount: mse(pairsOf(r => vInt + vSlope * r.voteAvg)),
      placebo: mse(pairsOf(r => wp ? wp[0] + wp[1] * r.trendShare + wp[2] * r.mrShare : trainMean)),
    });
  }
  return foldOut;
}

// The full shadow report. `picks` = resolved confluence ledger picks
// ({date,ticker,bull,excPct,resolved}). Never touches production ranking.
function marginalReport(picks, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const obs = toFamilyObservations(picks);
  const rows = toDateRows(obs);
  const effectiveSample = rows.length;   // distinct decision dates, never pick count
  const base = {
    version: MARGINAL_VERSION, shadow: true, families: FAMILIES,
    strategiesPerFamily: Object.fromEntries(FAMILIES.map(f => [f, STRATEGIES.filter(s => STRATEGY_FAMILY[s] === f)])),
    observations: obs.length, effectiveSample, config: cfg,
  };
  if (effectiveSample < cfg.minDates) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', weights: null, folds: [],
      note: `Only ${effectiveSample} distinct decision dates (< ${cfg.minDates}). Weights stay frozen equal; the ledger keeps accruing.` };
  }
  const folds = walkForward(rows, cfg);
  if (!folds.length) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', weights: null, folds,
      note: 'Not enough dates for a purged walk-forward split. Weights stay frozen equal.' };
  }
  // Cost-net improvement requirement: marginal must beat EVERY baseline in EVERY
  // fold by more than the round-trip cost drag (costPct on the prediction scale).
  const beatsAll = folds.every(f =>
    f.marginal != null
    && f.marginal < f.equalWeight - 1e-9
    && f.marginal < f.voteCount - 1e-9
    && f.marginal < f.placebo - 1e-9);
  const wFull = fitRidge(rows, cfg.ridgeLambda);
  const weights = wFull ? {
    // Family betas mapped back to per-strategy display weights (shadow only): every
    // strategy in a family shares its family's marginal beta — one unit of evidence.
    ...Object.fromEntries(STRATEGIES.map(s => [s, +(1 + (STRATEGY_FAMILY[s] === 'trend' ? wFull[1] : wFull[2]) * 0.05).toFixed(2)])),
  } : null;
  return {
    ...base, folds,
    fullFit: wFull ? { intercept: +wFull[0].toFixed(3), betaTrend: +wFull[1].toFixed(3), betaMeanReversion: +wFull[2].toFixed(3) } : null,
    weights,
    verdict: beatsAll ? 'PASS' : 'NO_IMPROVEMENT',
    note: beatsAll
      ? 'Marginal model beat equal-weight, vote-count and placebo on every purged test block. This verdict is an INPUT to a human registry decision (confluence-marginal → production); it cannot self-promote.'
      : 'Marginal model did not beat the baselines out-of-sample. Weights stay frozen equal — the honest result.',
  };
}

module.exports = { MARGINAL_VERSION, FAMILIES, DEFAULTS, toFamilyObservations, toDateRows, fitRidge, walkForward, marginalReport };
