'use strict';
// 📡 MARKET PULSE v2 — CROSS-ASSET CONFIRMATION MATRIX.
//
// Equities do not trade in isolation. A rally that credit, rates, and the dollar all
// disagree with is a different animal from one they confirm. This module measures each
// cross-asset leg from the SAME deterministic bar data the rest of Pulse uses, and reports
// per-leg CONFIRMS / CONTRADICTS / NEUTRAL against the equity move.
//
// The honesty rules that matter here:
//   • Every leg names the PROXY it actually used. This deployment has ETF bars, not a
//     rates/FX terminal, so 2Y and 10Y yields are read through SHY/IEF/TLT, real yields
//     and breakevens through TIP-vs-IEF, the dollar through UUP, credit through HYG/LQD.
//     Each row says so. A proxy is labelled a proxy, never presented as the underlying.
//   • A leg whose proxy bars are missing is UNAVAILABLE with a reason. It is NEVER counted
//     as neutral, and it never silently improves the confirmation ratio.
//   • Real yields, breakevens, VIX term structure, and skew are only computed when their
//     inputs actually exist; otherwise they report what is missing and why.
//   • The matrix reports a confirmation RATIO over MEASURED legs only, and exposes the
//     denominator so a 2-of-2 read is never mistaken for a 2-of-12 read.
//
// Pure: all bars are pre-fetched and injected. No I/O.

const MATRIX_VERSION = 'pulse2-cross-asset-v1';

const VERDICT = Object.freeze({ CONFIRMS: 'CONFIRMS', CONTRADICTS: 'CONTRADICTS', NEUTRAL: 'NEUTRAL', UNAVAILABLE: 'UNAVAILABLE' });

// The proxy map. `underlying` is what an expert actually wants; `proxy` is what this
// deployment can measure. Every row surfaces both so the gap is explicit.
const PROXIES = Object.freeze({
  rates2y: { underlying: '2-year Treasury yield', proxy: 'SHY', note: 'short-duration Treasury ETF — price moves INVERSELY to the 2Y yield' },
  rates10y: { underlying: '10-year Treasury yield', proxy: 'IEF', note: 'intermediate Treasury ETF — price moves INVERSELY to the 10Y yield' },
  curve: { underlying: '2s10s curve', proxy: 'IEF vs SHY', note: 'relative ETF performance, a directional proxy for curve change only — NOT a basis-point spread' },
  realYields: { underlying: 'real yields', proxy: 'TIP vs IEF', note: 'TIPS-vs-nominal relative performance; a directional proxy for the real-yield/breakeven complex' },
  dollar: { underlying: 'US dollar index', proxy: 'UUP', note: 'dollar-bullish ETF' },
  creditHY: { underlying: 'high-yield credit', proxy: 'HYG', note: 'high-yield corporate ETF' },
  creditIG: { underlying: 'investment-grade credit', proxy: 'LQD', note: 'investment-grade corporate ETF' },
  credit: { underlying: 'credit risk appetite', proxy: 'HYG vs LQD', note: 'high-yield vs investment-grade relative performance' },
  oil: { underlying: 'crude oil', proxy: 'USO', note: 'oil ETF (subject to roll effects vs spot)' },
  copper: { underlying: 'copper', proxy: 'CPER', note: 'copper ETF' },
  gold: { underlying: 'gold', proxy: 'GLD', note: 'gold ETF' },
  volLevel: { underlying: 'VIX level', proxy: '^VIX', note: 'index-level volatility' },
  volCurve: { underlying: 'VIX term structure', proxy: '^VIX vs ^VIX3M', note: 'front-vs-three-month volatility; contango = calm forward pricing' },
  skew: { underlying: 'index skew', proxy: '^SKEW', note: 'CBOE SKEW index' },
  rvIv: { underlying: 'realized vs implied volatility', proxy: 'SPY realized 20d vs ^VIX', note: 'realized volatility computed from SPY closes' },
  smallCaps: { underlying: 'small-cap participation', proxy: 'IWM vs SPY', note: 'relative performance' },
  equalWeight: { underlying: 'equal-weight participation', proxy: 'RSP vs SPY', note: 'relative performance' },
});

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const isNum = v => v != null && Number.isFinite(v);

const unavailableRow = (key, reason) => ({
  key,
  underlying: PROXIES[key] ? PROXIES[key].underlying : key,
  proxy: PROXIES[key] ? PROXIES[key].proxy : null,
  proxyNote: PROXIES[key] ? PROXIES[key].note : null,
  available: false,
  verdict: VERDICT.UNAVAILABLE,
  changePct: null,
  reason,
});

/** Trailing % change over `lookback` sessions from daily closes. Null when too short. */
function changePct(candles, lookback = 1) {
  const cs = Array.isArray(candles) ? candles.filter(c => c && isNum(c.close)) : [];
  if (cs.length < lookback + 1) return null;
  const last = cs[cs.length - 1].close, prior = cs[cs.length - 1 - lookback].close;
  if (!prior) return null;
  return round(((last - prior) / prior) * 100);
}

/** Annualized realized volatility from daily closes over `window` sessions. */
function realizedVol(candles, window = 20) {
  const cs = Array.isArray(candles) ? candles.filter(c => c && isNum(c.close)) : [];
  if (cs.length < window + 1) return null;
  const rets = [];
  for (let i = cs.length - window; i < cs.length; i++) {
    const p = cs[i - 1].close, c = cs[i].close;
    if (p > 0) rets.push(Math.log(c / p));
  }
  if (rets.length < window - 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return round(Math.sqrt(varc) * Math.sqrt(252) * 100);
}

/**
 * A single leg. `expectedSignForRiskOn` says which direction of THIS leg is consistent
 * with risk appetite, so the verdict is computed against the equity move rather than
 * asserted. `neutralBand` keeps noise from being read as confirmation.
 */
function legRow(key, candles, { equitySign = 0, expectedSignForRiskOn = 1, lookback = 1, neutralBand = 0.15 } = {}) {
  const p = PROXIES[key] || {};
  const chg = changePct(candles, lookback);
  if (chg == null) {
    return unavailableRow(key, `${p.proxy || key} bars unavailable or too short for a ${lookback}-session change — this leg is NOT counted as neutral`);
  }
  let verdict;
  if (Math.abs(chg) < neutralBand || equitySign === 0) verdict = VERDICT.NEUTRAL;
  else {
    // The leg's risk-appetite sign, compared with the equity move's sign.
    const legRiskSign = Math.sign(chg) * expectedSignForRiskOn;
    verdict = legRiskSign === equitySign ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS;
  }
  return {
    key,
    underlying: p.underlying || key,
    proxy: p.proxy || null,
    proxyNote: p.note || null,
    isProxy: true,
    available: true,
    changePct: chg,
    lookbackSessions: lookback,
    verdict,
  };
}

/**
 * Build the cross-asset confirmation matrix. Pure.
 *
 * @param {object} p
 * @param {object} p.dailyByTicker  { TICKER: candles[] } — pre-fetched daily bars
 * @param {number} p.equityChangePct the equity move being confirmed (e.g. SPY day/period %)
 * @param {number} p.lookback        sessions of change to measure (default 1)
 * @param {object} p.vix             { level, change3mLevel } when available
 */
function buildCrossAssetMatrix({ dailyByTicker = {}, equityChangePct = null, lookback = 1, vix = null } = {}) {
  const bars = t => dailyByTicker[t] || null;
  const equitySign = isNum(equityChangePct) ? (Math.abs(equityChangePct) < 0.1 ? 0 : Math.sign(equityChangePct)) : 0;
  const rows = {};

  // ── Rates. ETF prices move INVERSELY to yields, so a Treasury-ETF rally is falling
  // yields, which is risk-OFF-consistent: expectedSignForRiskOn = -1.
  rows.rates2y = legRow('rates2y', bars('SHY'), { equitySign, expectedSignForRiskOn: -1, lookback, neutralBand: 0.05 });
  rows.rates10y = legRow('rates10y', bars('IEF'), { equitySign, expectedSignForRiskOn: -1, lookback, neutralBand: 0.1 });

  // Curve: relative performance of intermediate vs short duration. Explicitly a DIRECTIONAL
  // proxy — this deployment has no basis-point yield feed, and the row says so.
  const ief = changePct(bars('IEF'), lookback), shy = changePct(bars('SHY'), lookback);
  rows.curve = (ief == null || shy == null)
    ? unavailableRow('curve', 'IEF and/or SHY bars unavailable — no curve proxy can be computed. NOTE: even when available this is a relative-performance proxy, NOT a basis-point 2s10s spread.')
    : { ...legRow('curve', null, {}), available: true, changePct: round(ief - shy), value: round(ief - shy), lookbackSessions: lookback, isProxy: true, verdict: VERDICT.NEUTRAL, key: 'curve', underlying: PROXIES.curve.underlying, proxy: PROXIES.curve.proxy, proxyNote: PROXIES.curve.note, reason: null };

  // Real yields / breakevens: TIPS vs nominals. Only when BOTH legs exist.
  const tip = changePct(bars('TIP'), lookback);
  rows.realYields = (tip == null || ief == null)
    ? unavailableRow('realYields', 'TIP and/or IEF bars unavailable — real yields and breakevens cannot be inferred, and are NOT approximated from nominal rates')
    : { key: 'realYields', underlying: PROXIES.realYields.underlying, proxy: PROXIES.realYields.proxy, proxyNote: PROXIES.realYields.note, isProxy: true, available: true, changePct: round(tip - ief), lookbackSessions: lookback, verdict: Math.abs(tip - ief) < 0.1 ? VERDICT.NEUTRAL : ((Math.sign(tip - ief) === equitySign) ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS), reason: null };

  // Dollar: a stronger dollar is a risk headwind → expectedSignForRiskOn = -1.
  rows.dollar = legRow('dollar', bars('UUP'), { equitySign, expectedSignForRiskOn: -1, lookback, neutralBand: 0.1 });

  // Credit: HY and IG individually, plus the HY-vs-IG risk-appetite spread.
  rows.creditHY = legRow('creditHY', bars('HYG'), { equitySign, expectedSignForRiskOn: 1, lookback, neutralBand: 0.1 });
  rows.creditIG = legRow('creditIG', bars('LQD'), { equitySign, expectedSignForRiskOn: 1, lookback, neutralBand: 0.1 });
  const hyg = changePct(bars('HYG'), lookback), lqd = changePct(bars('LQD'), lookback);
  rows.credit = (hyg == null || lqd == null)
    ? unavailableRow('credit', 'HYG and/or LQD bars unavailable — the credit risk-appetite spread cannot be computed')
    : { key: 'credit', underlying: PROXIES.credit.underlying, proxy: PROXIES.credit.proxy, proxyNote: PROXIES.credit.note, isProxy: true, available: true, changePct: round(hyg - lqd), lookbackSessions: lookback, verdict: Math.abs(hyg - lqd) < 0.1 ? VERDICT.NEUTRAL : ((Math.sign(hyg - lqd) === equitySign) ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS), reason: null };

  // Commodities. Oil and copper are pro-cyclical; gold is the risk-off leg.
  rows.oil = legRow('oil', bars('USO'), { equitySign, expectedSignForRiskOn: 1, lookback, neutralBand: 0.3 });
  rows.copper = legRow('copper', bars('CPER'), { equitySign, expectedSignForRiskOn: 1, lookback, neutralBand: 0.3 });
  rows.gold = legRow('gold', bars('GLD'), { equitySign, expectedSignForRiskOn: -1, lookback, neutralBand: 0.2 });

  // Volatility complex.
  rows.volLevel = legRow('volLevel', bars('^VIX'), { equitySign, expectedSignForRiskOn: -1, lookback, neutralBand: 1 });
  const vixNow = vix && isNum(vix.level) ? vix.level : lastClose(bars('^VIX'));
  const vix3m = vix && isNum(vix.level3m) ? vix.level3m : lastClose(bars('^VIX3M'));
  rows.volCurve = (vixNow == null || vix3m == null)
    ? unavailableRow('volCurve', '^VIX and/or ^VIX3M level unavailable — term structure (contango vs inversion) cannot be determined')
    : { key: 'volCurve', underlying: PROXIES.volCurve.underlying, proxy: PROXIES.volCurve.proxy, proxyNote: PROXIES.volCurve.note, isProxy: false, available: true, slope: round(vix3m - vixNow), contango: vix3m > vixNow, changePct: null, verdict: (vix3m > vixNow) === (equitySign >= 0) ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS, reason: null };
  const skewLevel = lastClose(bars('^SKEW'));
  rows.skew = skewLevel == null
    ? unavailableRow('skew', '^SKEW bars unavailable from this provider — index skew is NOT estimated from anything else')
    : { key: 'skew', underlying: PROXIES.skew.underlying, proxy: PROXIES.skew.proxy, proxyNote: PROXIES.skew.note, isProxy: false, available: true, level: round(skewLevel), changePct: changePct(bars('^SKEW'), lookback), verdict: VERDICT.NEUTRAL, reason: null };

  // Realized vs implied: the volatility-risk-premium read, computed only when both exist.
  const rv = realizedVol(bars('SPY'), 20);
  rows.rvIv = (rv == null || vixNow == null)
    ? unavailableRow('rvIv', 'SPY history and/or a VIX level unavailable — realized-vs-implied volatility cannot be computed')
    : { key: 'rvIv', underlying: PROXIES.rvIv.underlying, proxy: PROXIES.rvIv.proxy, proxyNote: PROXIES.rvIv.note, isProxy: false, available: true, realizedVol20d: rv, impliedVol: round(vixNow), spread: round(vixNow - rv), verdict: VERDICT.NEUTRAL, changePct: null, reason: null };

  // Participation.
  const iwm = changePct(bars('IWM'), lookback), spy = changePct(bars('SPY'), lookback), rsp = changePct(bars('RSP'), lookback);
  rows.smallCaps = (iwm == null || spy == null)
    ? unavailableRow('smallCaps', 'IWM and/or SPY bars unavailable — small-cap participation cannot be measured')
    : { key: 'smallCaps', underlying: PROXIES.smallCaps.underlying, proxy: PROXIES.smallCaps.proxy, proxyNote: PROXIES.smallCaps.note, isProxy: true, available: true, changePct: round(iwm - spy), lookbackSessions: lookback, verdict: Math.abs(iwm - spy) < 0.15 ? VERDICT.NEUTRAL : (Math.sign(iwm - spy) === equitySign ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS), reason: null };
  rows.equalWeight = (rsp == null || spy == null)
    ? unavailableRow('equalWeight', 'RSP and/or SPY bars unavailable — equal-weight participation cannot be measured')
    : { key: 'equalWeight', underlying: PROXIES.equalWeight.underlying, proxy: PROXIES.equalWeight.proxy, proxyNote: PROXIES.equalWeight.note, isProxy: true, available: true, changePct: round(rsp - spy), lookbackSessions: lookback, verdict: Math.abs(rsp - spy) < 0.15 ? VERDICT.NEUTRAL : (Math.sign(rsp - spy) === equitySign ? VERDICT.CONFIRMS : VERDICT.CONTRADICTS), reason: null };

  const all = Object.values(rows);
  const measured = all.filter(r => r.available);
  const confirms = measured.filter(r => r.verdict === VERDICT.CONFIRMS);
  const contradicts = measured.filter(r => r.verdict === VERDICT.CONTRADICTS);
  const unavailable = all.filter(r => !r.available);

  return {
    schema: MATRIX_VERSION,
    available: measured.length > 0,
    equityChangePct: isNum(equityChangePct) ? round(equityChangePct) : null,
    equitySign,
    lookbackSessions: lookback,
    rows,
    summary: {
      legsMeasured: measured.length,
      legsPossible: all.length,
      confirming: confirms.length,
      contradicting: contradicts.length,
      neutral: measured.length - confirms.length - contradicts.length,
      // The DENOMINATOR is exposed: "3 of 4 measured" reads very differently from
      // "3 of 17 possible", and the second number is the honest one.
      confirmationRatio: measured.length ? round(confirms.length / measured.length, 2) : null,
      confirmationRatioNote: `${confirms.length} confirming of ${measured.length} MEASURED legs (${all.length} legs are defined; ${unavailable.length} could not be measured and are excluded from the ratio, NOT counted as neutral).`,
      contradictingLegs: contradicts.map(r => `${r.underlying}: ${r.changePct != null ? (r.changePct >= 0 ? '+' : '') + r.changePct + '%' : 'see row'}`),
    },
    coverage: {
      measured: measured.length,
      possible: all.length,
      fraction: all.length ? round(measured.length / all.length, 2) : 0,
      degraded: unavailable.length > 0,
      unavailable: unavailable.map(r => ({ leg: r.key, underlying: r.underlying, reason: r.reason })),
    },
    // A single, prominent caveat: these are ETF proxies, not the instruments themselves.
    proxyDisclosure: 'Rates, curve, real yields, breakevens, the dollar, credit, and commodities are read through liquid ETF PROXIES, not through a rates/FX/commodity terminal. Proxies carry roll, credit, and duration effects the underlying does not. Every row names its proxy.',
  };
}

function lastClose(candles) {
  const cs = Array.isArray(candles) ? candles.filter(c => c && isNum(c.close)) : [];
  return cs.length ? cs[cs.length - 1].close : null;
}

/** The full ticker set the matrix wants. Callers fetch these once. */
const REQUIRED_TICKERS = Object.freeze([
  'SPY', 'IWM', 'RSP', 'SHY', 'IEF', 'TLT', 'TIP', 'UUP', 'HYG', 'LQD',
  'USO', 'CPER', 'GLD', '^VIX', '^VIX3M', '^SKEW',
]);

module.exports = {
  MATRIX_VERSION, VERDICT, PROXIES, REQUIRED_TICKERS,
  buildCrossAssetMatrix, legRow, changePct, realizedVol, lastClose,
};
