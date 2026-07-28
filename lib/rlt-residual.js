// ═══════════════════════════════════════════════════════════════════════════
// RLT residual machinery — point-in-time residual returns and series.
//
// The canonical per-horizon residual (fitted beta, shrinkage, caps, PIT
// slicing) is DELEGATED to lib/atlasx-residual.residualize — one residual
// engine, not two. This module adds what leadership ranking needs on top:
//   • an aligned DAILY residual-return series (for percentile history,
//     path quality and persistence features), using the as-of fitted betas
//     held constant across the trailing window — a labeled approximation,
//     never a forward-looking fit (betas come from data ending at the cutoff);
//   • rolling h-session residual sums ending at each recent session;
//   • tie-aware cross-sectional percentiles with small-sample uncertainty.
//
// Pure module: no I/O.
// ═══════════════════════════════════════════════════════════════════════════

const RES = require('./atlasx-residual');
const { VERSIONS, HORIZONS } = require('./rlt-config');

const BETA_BASIS = 'asOf-fit-held-constant';

/** Aligned daily simple returns keyed by date. */
function dailyReturnsByDate(bars) {
  const out = new Map();
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1].c, c = bars[i].c;
    if (p > 0 && c > 0) out.set(bars[i].date, c / p - 1);
  }
  return out;
}

/**
 * Canonical residual bundle for one stock at the cutoff.
 * horizons default to RLT's [3,5,10,21,63] plus 1 as a transition-only extra.
 */
function residualBundle({ bars, spyBars, sectorBars = [], asOf, horizons = [1, ...HORIZONS] } = {}) {
  return RES.residualize({ stock: bars, spy: spyBars, sector: sectorBars, asOf, horizons });
}

/**
 * Daily residual-return series over the trailing window, using constant
 * (as-of fitted) beta/sectorLoading. Returns ascending
 * [{date, raw, mkt, residual, marketResidual, partial}]:
 *   marketResidual = raw − β·mkt          (sector data not required)
 *   residual       = marketResidual − loading·(sec − βsec·mkt)   (sector-aware)
 * When sector data is missing the sector term is 0 and partial=true — labeled,
 * never silently treated as a fitted sector residual.
 */
function residualDailySeries({ bars, spyBars, sectorBars = [], asOf, beta = 1, sectorLoading = 0, sectorBetaMkt = 1, window = 90 } = {}) {
  const s = RES.asOfSlice(RES.toBars(bars), asOf);
  const m = RES.asOfSlice(RES.toBars(spyBars), asOf);
  const sec = RES.asOfSlice(RES.toBars(sectorBars), asOf);
  const mRet = dailyReturnsByDate(m);
  const secRet = dailyReturnsByDate(sec);
  const haveSector = sec.length > 20 && Number.isFinite(sectorLoading);

  const out = [];
  for (let i = Math.max(1, s.length - window); i < s.length; i++) {
    const p = s[i - 1].c, c = s[i].c;
    if (!(p > 0) || !(c > 0)) continue;
    const date = s[i].date;
    const raw = c / p - 1;
    const mkt = mRet.get(date);
    if (mkt == null) continue;                    // require an aligned market bar
    const marketResidual = raw - beta * mkt;
    let residual = marketResidual;
    let partial = true;
    if (haveSector) {
      const sr = secRet.get(date);
      if (sr != null) {
        residual = marketResidual - sectorLoading * (sr - sectorBetaMkt * mkt);
        partial = false;
      }
    }
    out.push({ date, raw, mkt, marketResidual, residual, partial });
  }
  return out;
}

/**
 * Rolling h-session sums of a daily series field, ending at each of the last
 * `k` sessions. Returns ascending [{date, value}] (length ≤ k); null values
 * where the window is incomplete are omitted.
 */
function rollingSums(series, field, h, k) {
  const out = [];
  const start = Math.max(h - 1, series.length - k);
  for (let i = start; i < series.length; i++) {
    if (i - h + 1 < 0) continue;
    let sum = 0, ok = true;
    for (let j = i - h + 1; j <= i; j++) {
      const v = series[j] ? series[j][field] : null;
      if (!Number.isFinite(v)) { ok = false; break; }
      sum += v;
    }
    if (ok) out.push({ date: series[i].date, value: sum });
  }
  return out;
}

/**
 * Tie-aware percentile of `mine` within `values` (its own value included once).
 * Average-rank convention: percentile = (below + 0.5·(ties−1)) / (n−1).
 * n < 2 → null (a group of one has no rank information).
 */
function percentileWithTies(values, mine) {
  if (!Number.isFinite(mine)) return null;
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  if (n < 2) return null;
  let below = 0, ties = 0;
  for (const v of finite) {
    if (v < mine) below++;
    else if (v === mine) ties++;
  }
  if (ties < 1) ties = 1;   // `mine` should be among values; guard if not
  return (below + 0.5 * (ties - 1)) / (n - 1);
}

/** Binomial-style standard error of a percentile for a peer group of size n. */
function percentileUncertainty(p, n) {
  if (!Number.isFinite(p) || !Number.isFinite(n) || n < 2) return null;
  return Math.sqrt(Math.max(p * (1 - p), 0.25 / n) / n);
}

module.exports = {
  VERSION: VERSIONS.features,
  BETA_BASIS,
  residualBundle, residualDailySeries, rollingSums,
  percentileWithTies, percentileUncertainty, dailyReturnsByDate,
};
