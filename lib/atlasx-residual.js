'use strict';
// ATLAS-X — point-in-time market/sector/factor residualization.
//
// PURE and TESTABLE. Given a stock's candles plus SPY and (optional) sector-ETF
// candles and an as-of date, strip the market and sector components so what
// remains is the stock's idiosyncratic residual return. Multiple screeners that
// read the same raw price path are NOT independent evidence; residualization is
// what lets ATLAS-X reason about a name's own move rather than the tape's.
//
// HARD PIT RULE: only bars dated <= asOf may influence any number here. A missing
// benchmark is UNKNOWN (coverage flagged, residual null) — never silently 0.

const { RESIDUAL_HORIZONS, VERSIONS } = require('./atlasx-config');

const BETA_LOOKBACK = 60;   // sessions used to estimate beta/sector loading (PIT)
const MIN_BETA_OBS = 20;    // below this, beta is untrustworthy → shrink to 1.0
const SECTOR_LOADING_PRIOR = 0.6; // shrink target when sector data is thin

// ── candle normalization ────────────────────────────────────────────────────
// Accepts candle-cache tuples [date,o,h,l,c,v,adjClose] OR {date,open,high,low,
// close,volume} objects. Returns ascending [{date, o,h,l,c,v}]. Adjusted close is
// preferred for returns when present (Yahoo tuples carry it at index 6).
function toBars(candles) {
  if (!Array.isArray(candles)) return [];
  const out = [];
  for (const row of candles) {
    if (Array.isArray(row)) {
      const [date, o, h, l, c, v, adj] = row;
      if (date == null || c == null) continue;
      const close = adj != null && isFinite(adj) ? Number(adj) : Number(c);
      out.push({ date: String(date), o: num(o), h: num(h), l: num(l), c: close, v: num(v) });
    } else if (row && typeof row === 'object') {
      const date = row.date || row.d || row.t;
      const c = row.adjClose != null ? row.adjClose : (row.close != null ? row.close : row.c);
      if (date == null || c == null) continue;
      out.push({
        date: String(date), o: num(row.open ?? row.o), h: num(row.high ?? row.h),
        l: num(row.low ?? row.l), c: Number(c), v: num(row.volume ?? row.v),
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

const num = x => (x == null || !isFinite(Number(x)) ? 0 : Number(x));

// Bars strictly on/before asOf (PIT slice). asOf null → all bars.
function asOfSlice(bars, asOf) {
  if (!asOf) return bars;
  const cut = String(asOf);
  return bars.filter(b => b.date <= cut);
}

// Simple return over the last `h` sessions of a bar array (ref = last bar).
function retOver(bars, h) {
  if (!bars || bars.length < h + 1) return null;
  const now = bars[bars.length - 1].c;
  const then = bars[bars.length - 1 - h].c;
  if (!(then > 0)) return null;
  return now / then - 1;
}

// Daily simple returns, ascending, aligned to the bar that closes each return.
function dailyReturns(bars) {
  const r = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c, cur = bars[i].c;
    r.push({ date: bars[i].date, r: prev > 0 ? cur / prev - 1 : 0 });
  }
  return r;
}

// Align two daily-return series by date; returns {x:[], y:[]} of matched pairs.
function alignByDate(a, b) {
  const map = new Map(b.map(d => [d.date, d.r]));
  const x = [], y = [];
  for (const d of a) {
    if (map.has(d.date)) { x.push(d.r); y.push(map.get(d.date)); }
  }
  return { x, y };
}

// OLS slope of y on x (beta = cov(x,y)/var(x)). null if degenerate.
function slope(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); varx += (x[i] - mx) ** 2; }
  if (!(varx > 0)) return null;
  return cov / varx;
}

// Beta of stock vs market over the last BETA_LOOKBACK aligned sessions (PIT).
// Shrinks toward 1.0 when observations are thin so a noisy 5-day beta can't
// dominate the residual.
function estimateBeta(stockRets, mktRets) {
  const recentS = stockRets.slice(-BETA_LOOKBACK);
  const recentM = mktRets.slice(-BETA_LOOKBACK);
  const { x, y } = alignByDate(recentM, recentS); // x=market, y=stock
  const n = x.length;
  const raw = slope(x, y);
  if (raw == null) return { beta: 1.0, obs: n, shrunk: true };
  if (n < MIN_BETA_OBS) {
    const w = n / MIN_BETA_OBS;
    return { beta: w * raw + (1 - w) * 1.0, obs: n, shrunk: true };
  }
  // clamp to a sane band — a 6+ beta from 20 obs is estimation noise
  const clamped = Math.max(-1, Math.min(3.5, raw));
  return { beta: clamped, obs: n, shrunk: clamped !== raw };
}

// Realized volatility (daily stdev) over the last `win` sessions, annualized-ish
// left as per-session stdev (callers compare cross-sectionally, units cancel).
function realizedVol(rets, win = 20) {
  const r = rets.slice(-win).map(d => d.r);
  if (r.length < 5) return null;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const varr = r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(varr);
}

// ── main entry ────────────────────────────────────────────────────────────────
/**
 * Residualize a stock against market + sector as of a date.
 * @param {object} p
 * @param {Array} p.stock  stock candles (tuple or object form)
 * @param {Array} p.spy    SPY (market) candles
 * @param {Array} [p.sector] sector-ETF candles (optional)
 * @param {string} [p.asOf] as-of date 'YYYY-MM-DD' (defaults to last stock bar)
 * @param {number[]} [p.horizons]
 * @returns {object} residual feature vector with coverage + version
 */
function residualize({ stock, spy, sector, asOf, horizons = RESIDUAL_HORIZONS } = {}) {
  const sBars = asOfSlice(toBars(stock), asOf);
  const mBars = asOfSlice(toBars(spy), asOf);
  const secBars = sector ? asOfSlice(toBars(sector), asOf) : [];

  const asOfDate = asOf || (sBars.length ? sBars[sBars.length - 1].date : null);
  const haveMkt = mBars.length > MIN_BETA_OBS;
  const haveSector = secBars.length > MIN_BETA_OBS;

  const coverage = Object.freeze({
    spy: haveMkt,
    sector: haveSector,
    stockBars: sBars.length,
    asOf: asOfDate,
  });

  // Degenerate: not enough of the stock's own history → nothing trustworthy.
  if (sBars.length < 6) {
    return frozenResult(asOfDate, coverage, {}, null, null, null, true);
  }

  const sRet = dailyReturns(sBars);
  const mRet = haveMkt ? dailyReturns(mBars) : [];
  const secRet = haveSector ? dailyReturns(secBars) : [];

  const betaInfo = haveMkt ? estimateBeta(sRet, mRet) : { beta: null, obs: 0, shrunk: true };
  // sector loading: regress stock's market-residual daily returns on the sector's
  // market-residual daily returns (both PIT). Thin → shrink to prior.
  let sectorLoading = null, sectorBetaMkt = null;
  if (haveMkt && haveSector) {
    sectorBetaMkt = (estimateBeta(secRet, mRet).beta);
    const sResidDaily = residualDaily(sRet, mRet, betaInfo.beta);
    const secResidDaily = residualDaily(secRet, mRet, sectorBetaMkt);
    const { x, y } = alignByDate(secResidDaily, sResidDaily);
    const raw = slope(x, y);
    if (raw == null) sectorLoading = SECTOR_LOADING_PRIOR;
    else if (x.length < MIN_BETA_OBS) {
      const w = x.length / MIN_BETA_OBS;
      sectorLoading = w * raw + (1 - w) * SECTOR_LOADING_PRIOR;
    } else sectorLoading = Math.max(-1, Math.min(2, raw));
  }

  const byHorizon = {};
  for (const h of horizons) {
    const raw = retOver(sBars, h);
    const spyH = haveMkt ? retOver(mBars, h) : null;
    const secH = haveSector ? retOver(secBars, h) : null;
    if (raw == null) { byHorizon[h] = nullHorizon(); continue; }

    // Expected factor return: market via beta, plus the sector's own residual-
    // vs-market move scaled by the stock's sector loading. Unknown benchmark →
    // that component is null (excluded), residual flagged partial — NOT zero.
    let expected = null, residual = null, partial = false;
    if (haveMkt && spyH != null && betaInfo.beta != null) {
      const mktComp = betaInfo.beta * spyH;
      let secComp = 0;
      if (haveSector && secH != null && sectorBetaMkt != null && sectorLoading != null) {
        const secResidVsMkt = secH - sectorBetaMkt * spyH;
        secComp = sectorLoading * secResidVsMkt;
      } else {
        partial = true; // no sector control available
      }
      expected = mktComp + secComp;
      residual = raw - expected;
    } else {
      partial = true; // no market benchmark → residual is UNKNOWN
    }

    byHorizon[h] = Object.freeze({
      raw, spy: spyH, sector: secH,
      expected, residual,
      partial,
    });
  }

  // Residual acceleration: per-session residual over a short window minus a long
  // window. Positive → residual strength is accelerating. Null if either missing.
  const accel = residualAccel(byHorizon);
  const vol = realizedVol(sRet, 20);

  return frozenResult(asOfDate, coverage, byHorizon, betaInfo.beta, vol, accel, false, {
    betaObs: betaInfo.obs, betaShrunk: betaInfo.shrunk, sectorLoading, sectorBetaMkt,
  });
}

function residualDaily(stockRets, mktRets, beta) {
  const map = new Map(mktRets.map(d => [d.date, d.r]));
  const out = [];
  for (const d of stockRets) {
    if (map.has(d.date)) out.push({ date: d.date, r: d.r - beta * map.get(d.date) });
  }
  return out;
}

function residualAccel(byHorizon) {
  const short = byHorizon[5] && byHorizon[5].residual;
  const long = byHorizon[20] && byHorizon[20].residual;
  if (short == null || long == null) return null;
  return short / 5 - long / 20;
}

function nullHorizon() {
  return Object.freeze({ raw: null, spy: null, sector: null, expected: null, residual: null, partial: true });
}

function frozenResult(asOf, coverage, byHorizon, beta, vol, accel, degenerate, extra = {}) {
  return Object.freeze({
    version: VERSIONS.residual,
    asOf,
    coverage,
    beta,
    vol,
    residualAccel: accel,
    byHorizon: Object.freeze(byHorizon),
    degenerate,
    ...extra,
  });
}

module.exports = {
  residualize,
  toBars,
  asOfSlice,
  retOver,
  dailyReturns,
  estimateBeta,
  realizedVol,
  BETA_LOOKBACK,
};
