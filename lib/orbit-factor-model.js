// ORBIT factor model (orbit-factor-v1) — interpretable rolling, regularised
// factor-exposure estimation used to strip broad-market, sector, size, and
// volatility effects from a stock's daily returns, leaving an *idiosyncratic
// residual* return series.
//
// Method: rolling ridge regression estimated ONLY on past-and-current data.
//   r_t = α + β_mkt·f_mkt,t + β_sec·f_sec,t + β_size·f_size,t + β_vol·f_vol,t + ε_t
// The residual ε_t is what ORBIT's drift state and features are built on.
//
// Why ridge (not OLS): betas over ~120 daily bars with correlated factors are
// unstable; a small L2 penalty shrinks them toward zero and prevents numerical
// blow-ups. The intercept is NOT penalised. Betas are additionally hard-capped.
//
// Causality: the residual at bar t uses betas fitted on the window ENDING at t
// (past + contemporaneous factor returns, all known at t's close). Appending a
// FUTURE bar never changes an earlier residual — proven in the test suite. A
// Kalman dynamic-beta challenger is deliberately kept out of the baseline; if
// added it lives separately and must beat this on OOS residual quality.

const M = require('./orbit-math');

const FACTOR_MODEL_VERSION = 'orbit-factor-v1';

// Tradeable factor proxies (documented; the backfill fetches these series).
//   market = SPY, size = IWM−SPY (small-minus-big), vol = ^VIX daily change.
// Sector uses the SPDR sector ETF for the name's (approximate, current) sector.
const SECTOR_ETF = Object.freeze({
  'Technology': 'XLK',
  'Communication Services': 'XLC',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  'Health Care': 'XLV',
  'Financials': 'XLF',
  'Industrials': 'XLI',
  'Energy': 'XLE',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Materials': 'XLB',
});
function sectorEtfFor(sector) { return SECTOR_ETF[sector] || null; }

// Factor proxy tickers the backfill needs to fetch alongside each name.
const FACTOR_TICKERS = Object.freeze(['SPY', 'IWM', '^VIX']);
const FACTOR_ORDER = Object.freeze(['market', 'sector', 'size', 'vol']);

const DEFAULTS = Object.freeze({
  window: 120,     // ~6 months of trading days for exposure estimation
  minObs: 40,      // minimum finite rows or we declare `insufficient`
  lambda: 1.0,     // ridge penalty in STANDARDISED factor space (scale-invariant);
                   // with Σz²≈nObs this is a mild shrink (~1/nObs), not a heavy one
  betaCap: 3.5,    // hard cap on |β| to prevent numeric explosions
});

// Simple daily returns from a close series (first element null). Pure.
function toReturns(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    out[i] = (a != null && b != null && a > 0) ? (b / a - 1) : null;
  }
  return out;
}

// Build the point-in-time residual window as-of the last supplied bar.
//
// stockRet : number[]  daily returns of the stock (index-aligned, may hold nulls)
// factors  : { market:number[], sector?:number[], size?:number[], vol?:number[] }
//            each index-aligned to stockRet; omit or pass null to drop a factor.
// Returns:
//   { version, sufficient, reason?, exposures:{alpha,market,sector,size,vol},
//     residuals:number[]  (aligned to the trailing window, oldest→newest),
//     residualDates? , nObs, r2, factorsUsed:string[] }
function residualWindow(stockRet, factors, opts = {}) {
  const { window, minObs, lambda, betaCap } = { ...DEFAULTS, ...opts };
  const L = stockRet.length;
  const present = FACTOR_ORDER.filter(k => Array.isArray(factors[k]) && factors[k].length === L);
  if (!present.length) return insufficient('no factor series supplied');

  // Trailing window of rows where the stock and every present factor are finite.
  const rows = [];
  for (let i = Math.max(0, L - window); i < L; i++) {
    const y = stockRet[i];
    if (y == null || !Number.isFinite(y)) continue;
    const fv = present.map(k => factors[k][i]);
    if (fv.some(v => v == null || !Number.isFinite(v))) continue;
    rows.push({ i, y, fv });
  }
  if (rows.length < minObs) return insufficient(`only ${rows.length} usable rows (<${minObs})`, present);

  // Standardise each factor column (mean 0, unit std) BEFORE the ridge, so the
  // penalty is scale-invariant — a raw daily-return factor (σ≈0.01) and a VIX
  // proxy (σ≈1) get shrunk equally. Coefficients are converted back to raw units
  // afterwards. A near-constant factor column (σ≈0) is dropped.
  const y = rows.map(r => r.y);
  const colMean = [], colStd = [], useCol = [];
  for (let j = 0; j < present.length; j++) {
    const col = rows.map(r => r.fv[j]);
    const mu = M.mean(col), sd = M.std(col);
    colMean.push(mu); colStd.push(sd); useCol.push(sd != null && sd > M.EPS);
  }
  const activeIdx = present.map((_, j) => j).filter(j => useCol[j]);
  // Standardised design: [1, z1, z2, ...] for active columns only.
  const X = rows.map(r => [1, ...activeIdx.map(j => (r.fv[j] - colMean[j]) / colStd[j])]);
  const penalty = [0, ...activeIdx.map(() => lambda)];
  const gamma = M.ridgeSolve(X, y, lambda, penalty);
  if (!gamma) return insufficient('singular design matrix', present);

  // Convert standardised coefficients back to raw-unit betas and intercept.
  const rawBeta = new Array(present.length).fill(0);
  let alpha = gamma[0];
  activeIdx.forEach((j, k) => {
    const b = gamma[k + 1] / colStd[j];
    rawBeta[j] = M.clamp(b, -betaCap, betaCap);
    alpha -= gamma[k + 1] * colMean[j] / colStd[j];
  });

  const exposures = { alpha: +alpha.toFixed(6), market: 0, sector: 0, size: 0, vol: 0 };
  present.forEach((k, idx) => { exposures[k] = +rawBeta[idx].toFixed(6); });
  const capped = [alpha, ...rawBeta];   // raw-unit coefficients for residual calc

  // Residual series over the window + fit quality (R²).
  const residuals = [];
  let ssRes = 0, ssTot = 0;
  const ybar = M.mean(y);
  for (let r = 0; r < rows.length; r++) {
    let pred = capped[0];
    for (let j = 0; j < present.length; j++) pred += capped[j + 1] * rows[r].fv[j];
    const e = rows[r].y - pred;
    residuals.push(+e.toFixed(8));
    ssRes += e * e; ssTot += (rows[r].y - ybar) * (rows[r].y - ybar);
  }
  const r2 = ssTot > M.EPS ? +(1 - ssRes / ssTot).toFixed(4) : 0;

  return {
    version: FACTOR_MODEL_VERSION,
    sufficient: true,
    exposures,
    residuals,
    residualIdx: rows.map(r => r.i),
    nObs: rows.length,
    r2,
    factorsUsed: present,
  };
}

function insufficient(reason, factorsUsed = []) {
  return {
    version: FACTOR_MODEL_VERSION,
    sufficient: false,
    reason,
    exposures: null,
    residuals: [],
    residualIdx: [],
    nObs: 0,
    r2: null,
    factorsUsed,
  };
}

module.exports = {
  FACTOR_MODEL_VERSION, SECTOR_ETF, FACTOR_TICKERS, FACTOR_ORDER, DEFAULTS,
  sectorEtfFor, toReturns, residualWindow,
};
