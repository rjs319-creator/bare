// ═══════════════════════════════════════════════════════════════════════════
// RLT sector-state engine — continuous, point-in-time sector state vector.
//
// The categorical label (LEADING / IMPROVING / NEUTRAL / WEAKENING / RISK_OFF /
// INSUFFICIENT_DATA) is a DISPLAY over the continuous vector — the vector is
// always preserved. Classification never uses future data: every input is
// computed from bars at or before the cutoff.
//
// "Weak sector" is context, not a veto: an exceptional stock in a weak sector
// stays a shadow candidate with increased uncertainty — the consumer decides.
//
// Pure module: no I/O.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, PEER_POLICY } = require('./rlt-config');
const RES = require('./atlasx-residual');

const STATES = Object.freeze({
  LEADING: 'LEADING',
  IMPROVING: 'IMPROVING',
  NEUTRAL: 'NEUTRAL',
  WEAKENING: 'WEAKENING',
  RISK_OFF: 'RISK_OFF',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
});

// Versioned classification thresholds (rlt-sector-state-v1).
const T = Object.freeze({
  minMembers: PEER_POLICY.minPeers,
  leadBreadth50: 0.60,
  leadTrendStability: 0.65,
  riskOffExcess21: -0.04,
  riskOffBreadth20: 0.30,
  improveBreadthAccel: 0.05,
  weakenBreadthAccel: -0.05,
});

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function std(a) {
  if (a.length < 3) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function retOverBars(bars, h) {
  const n = bars.length;
  if (n < h + 1) return null;
  const then = bars[n - 1 - h].c, now = bars[n - 1].c;
  return then > 0 ? now / then - 1 : null;
}
function fracAboveMa(barsList, k, offset = 0) {
  let above = 0, obs = 0;
  for (const bars of barsList) {
    const end = bars.length - offset;
    if (end < k + 1) continue;
    const closes = bars.slice(end - k, end).map(b => b.c);
    const ma = mean(closes);
    const last = bars[end - 1].c;
    if (ma == null || !(last > 0)) continue;
    obs++;
    if (last > ma) above++;
  }
  return obs >= 3 ? { frac: above / obs, obs } : { frac: null, obs };
}

/**
 * Build the state vector for one sector.
 *
 * @param sector       sector name
 * @param memberRows   eligible universe rows of this sector (with .bars, .ticker, .dollarVol)
 * @param leadership   rlt-leadership byTicker map (for residual positives / velocity)
 * @param etfBars      sector-ETF candles (toBars-able), may be []
 * @param spyBars      SPY candles
 * @param asOf         cutoff date
 */
function sectorState({ sector, memberRows = [], leadership = {}, etfBars = [], spyBars = [], asOf = null } = {}) {
  const members = memberRows.filter(r => r && r.bars && r.bars.length);
  const etf = RES.asOfSlice(RES.toBars(etfBars), asOf);
  const spy = RES.asOfSlice(RES.toBars(spyBars), asOf);
  const barsList = members.map(r => r.bars);

  const v = {};   // the continuous vector

  // ── ETF vs market ─────────────────────────────────────────────────────────
  const etfRet21 = retOverBars(etf, 21), spyRet21 = retOverBars(spy, 21);
  const etfRet5 = retOverBars(etf, 5), spyRet5 = retOverBars(spy, 5);
  v.etfVsSpy21 = (etfRet21 != null && spyRet21 != null) ? etfRet21 - spyRet21 : null;
  v.etfVsSpy5 = (etfRet5 != null && spyRet5 != null) ? etfRet5 - spyRet5 : null;
  // Fitted market residual of the ETF (shrunk beta, PIT).
  if (etf.length > 30 && spy.length > 30) {
    const sRet = RES.dailyReturns(etf).slice(-60);
    const mRet = RES.dailyReturns(spy).slice(-60);
    const est = RES.estimateBeta(sRet, mRet);
    v.etfBetaVsSpy = est.beta;
    v.etfMarketResidual21 = (etfRet21 != null && spyRet21 != null && Number.isFinite(est.beta))
      ? etfRet21 - est.beta * spyRet21 : null;
  } else {
    v.etfBetaVsSpy = null;
    v.etfMarketResidual21 = null;
  }

  // ── Breadth ───────────────────────────────────────────────────────────────
  const b20 = fracAboveMa(barsList, 20);
  const b50 = fracAboveMa(barsList, 50);
  const b200 = fracAboveMa(barsList, 200);
  const b20Prev = fracAboveMa(barsList, 20, 5);
  v.breadth20 = b20.frac; v.breadth50 = b50.frac; v.breadth200 = b200.frac;
  v.breadthAcceleration = (b20.frac != null && b20Prev.frac != null) ? b20.frac - b20Prev.frac : null;

  const lead = members.map(r => leadership[r.ticker]).filter(Boolean);
  const resid5 = lead.map(l => l.byHorizon && l.byHorizon[5] ? l.byHorizon[5].sectorResidual : null)
    .filter(Number.isFinite);
  const resid21 = lead.map(l => l.byHorizon && l.byHorizon[21] ? l.byHorizon[21].sectorResidual : null)
    .filter(Number.isFinite);
  const mkt21 = lead.map(l => l.byHorizon && l.byHorizon[21] ? l.byHorizon[21].marketResidual : null)
    .filter(Number.isFinite);
  v.fracPositiveResid5 = resid5.length >= 3 ? resid5.filter(x => x > 0).length / resid5.length : null;
  v.fracPositiveResid21 = resid21.length >= 3 ? resid21.filter(x => x > 0).length / resid21.length : null;

  // ── Highs/lows, dispersion, concentration ────────────────────────────────
  let newHighs = 0, newLows = 0;
  for (const bars of barsList) {
    if (bars.length < 63) continue;
    const w = bars.slice(-63);
    const last = w[w.length - 1].c;
    const hi = Math.max(...w.map(b => b.c)), lo = Math.min(...w.map(b => b.c));
    if (last >= hi) newHighs++;
    if (last <= lo) newLows++;
  }
  v.newHighLowRatio = (newHighs + newLows) > 0 ? newHighs / (newHighs + newLows) : null;
  v.newHighs = newHighs; v.newLows = newLows;

  const ret21s = barsList.map(b => retOverBars(b, 21)).filter(Number.isFinite);
  v.returnDispersion21 = std(ret21s);
  v.residualDispersion21 = std(resid21);

  // Leadership concentration: HHI of positive 21d market-residual shares.
  const positives = mkt21.filter(x => x > 0);
  const posSum = positives.reduce((s, x) => s + x, 0);
  v.leadershipConcentration = (positives.length >= 3 && posSum > 0)
    ? positives.reduce((s, x) => s + (x / posSum) ** 2, 0) : null;

  // Entrants into the top market-relative decile & improving leaders.
  v.topDecileEntrants = lead.filter(l =>
    l.byHorizon && l.byHorizon[10] && l.byHorizon[10].marketPctile != null
    && l.byHorizon[10].marketPctile >= 0.9 && (l.rankVel5 ?? 0) > 0.1).length;
  v.improvingLeaders = lead.filter(l => (l.rankVel5 ?? null) != null && l.rankVel5 > 0.1).length;

  // ── Turnover, trend, coverage ────────────────────────────────────────────
  const turnover = (k) => {
    const vals = [];
    for (const bars of barsList) {
      const w = bars.slice(-k);
      const dv = w.map(b => (b.v > 0 && b.c > 0 ? b.v * b.c : null)).filter(Number.isFinite);
      if (dv.length) vals.push(mean(dv));
    }
    return vals.length >= 3 ? vals.reduce((s, x) => s + x, 0) : null;
  };
  const t5 = turnover(5), t20 = turnover(20);
  v.turnoverChange = (t5 != null && t20 > 0) ? t5 / t20 : null;

  if (etf.length >= 63) {
    const hi63 = Math.max(...etf.slice(-63).map(b => b.c));
    v.distanceFromSectorHigh = hi63 > 0 ? etf[etf.length - 1].c / hi63 - 1 : null;
    const w = etf.slice(-21);
    let above = 0, obs = 0;
    for (let i = 0; i < w.length; i++) {
      const idx = etf.length - 21 + i;
      if (idx < 20) continue;
      const ma = mean(etf.slice(idx - 19, idx + 1).map(b => b.c));
      obs++;
      if (w[i].c > ma) above++;
    }
    v.trendStability = obs >= 10 ? above / obs : null;
  } else {
    v.distanceFromSectorHigh = null;
    v.trendStability = null;
  }

  v.memberCount = members.length;
  v.etfBars = etf.length;
  v.dataCoverage = members.length ? lead.length / members.length : 0;

  // ── Classification (display label over the vector) ───────────────────────
  let state = STATES.NEUTRAL;
  const insufficient = members.length < T.minMembers || v.breadth20 == null;
  if (insufficient) {
    state = STATES.INSUFFICIENT_DATA;
  } else if (v.etfVsSpy21 != null && v.etfVsSpy21 < T.riskOffExcess21 && v.breadth20 < T.riskOffBreadth20) {
    state = STATES.RISK_OFF;
  } else if (v.etfVsSpy21 != null && v.etfVsSpy21 > 0
    && (v.breadth50 ?? 0) > T.leadBreadth50 && (v.trendStability ?? 0) > T.leadTrendStability) {
    state = STATES.LEADING;
  } else if ((v.breadthAcceleration ?? 0) > T.improveBreadthAccel
    && v.etfVsSpy5 != null && v.etfVsSpy5 > 0) {
    state = STATES.IMPROVING;
  } else if ((v.breadthAcceleration ?? 0) < T.weakenBreadthAccel
    || (v.etfVsSpy5 != null && v.etfVsSpy5 < 0 && v.etfVsSpy21 != null && v.etfVsSpy21 < 0
      && (v.breadth20 ?? 1) < 0.5)) {
    state = STATES.WEAKENING;
  }

  return Object.freeze({
    version: VERSIONS.sectorState,
    sector,
    asOf,
    state,
    vector: Object.freeze(v),
    thresholds: T,
  });
}

/** Build states for every sector present in the universe. */
function buildSectorStates({ universe, leadership, sectorBarsFor = () => [], spyBars = [] } = {}) {
  const bySector = new Map();
  for (const r of universe.rows) {
    if (!r.eligible || !r.sector) continue;
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  const out = {};
  for (const [sector, memberRows] of bySector) {
    out[sector] = sectorState({
      sector, memberRows,
      leadership: leadership.byTicker || {},
      etfBars: sectorBarsFor(sector) || [],
      spyBars,
      asOf: universe.asOf,
    });
  }
  return Object.freeze({
    version: VERSIONS.sectorState,
    asOf: universe.asOf,
    states: Object.freeze(out),
  });
}

module.exports = { sectorState, buildSectorStates, STATES, THRESHOLDS: T };
