'use strict';
// PERFORMANCE METRICS — portfolio statistics at EXACT precision (no rounding anywhere;
// display rounding is the renderer's job — the evidence-stats lesson: a 2dp field fed
// back into arithmetic turns a real 0.003 into 0.00).
//
// DEFINITIONS are ported from stefan-jansen/empyrical-reloaded (Apache-2.0, the
// zipline/pyfolio metric library — https://github.com/stefan-jansen/empyrical-reloaded),
// re-implemented here from the published formulas; no code is copied:
//   cum_returns_final   Π(1+r) − 1
//   annual_return       (1+total)^(periods/n) − 1
//   annual_volatility   std(r, ddof=1) · √periods
//   downside_risk       √(mean(min(r − required, 0)²)) · √periods   (mean over ALL n)
//   sortino_ratio       mean(r − required) · periods / downside_risk
//   max_drawdown        min over t of (cum_t − running_max_t) / running_max_t, curve seeded at 1
//   calmar_ratio        annual_return / |max_drawdown|
//   omega_ratio         Σ(r − rf − θ)⁺ / Σ(r − rf − θ)⁻,  θ = (1+required)^(1/periods) − 1
//   beta                Σ(f_dev · r_dev) / Σ f_dev²   (deviations from the respective means)
//   roll_beta           beta over a trailing window
// Where empyrical returns ±inf or nan (zero downside, zero losses, flat factor, too few
// observations) this module returns null — a card must print "–", never "Infinity".
//
// Pure. No I/O, no clock, no mutation of inputs.

const VERSION = 'perf-metrics-v1';
const DEFINITIONS = 'empyrical-reloaded (Apache-2.0) formula definitions, re-implemented; null where empyrical yields inf/nan';
const TRADING_PERIODS_PER_YEAR = 252;
const DEFAULT_ROLLING_WINDOW = 63;   // ~one quarter of sessions

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (arr) => (Array.isArray(arr) ? arr.filter(isNum) : []);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const mean = (arr) => (arr.length ? sum(arr) / arr.length : null);

// Fractional close-to-close returns of a price/equity series. A missing or non-positive
// point is skipped (the return spans it), never treated as zero.
function simpleReturns(prices) {
  const p = (Array.isArray(prices) ? prices : []).filter((v) => isNum(v) && v > 0);
  const out = [];
  for (let i = 1; i < p.length; i++) out.push(p[i] / p[i - 1] - 1);
  return out;
}

function cumReturnsFinal(returns) {
  const r = clean(returns);
  if (!r.length) return null;
  return r.reduce((acc, x) => acc * (1 + x), 1) - 1;
}

function annualReturn(returns, { periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const r = clean(returns);
  if (!r.length) return null;
  const total = cumReturnsFinal(r);
  if (total <= -1) return -1;
  return Math.pow(1 + total, periods / r.length) - 1;
}

function sampleStd(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(sum(values.map((x) => (x - m) ** 2)) / (values.length - 1));
}

function annualVolatility(returns, { periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const sd = sampleStd(clean(returns));
  return sd == null ? null : sd * Math.sqrt(periods);
}

function downsideRisk(returns, { requiredReturn = 0, periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const r = clean(returns);
  if (!r.length) return null;
  const downside = r.map((x) => Math.min(x - requiredReturn, 0) ** 2);
  return Math.sqrt(sum(downside) / r.length) * Math.sqrt(periods);
}

function sortinoRatio(returns, { requiredReturn = 0, periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const r = clean(returns);
  if (!r.length) return null;
  const dr = downsideRisk(r, { requiredReturn, periods });
  if (!(dr > 0)) return null;
  return (mean(r.map((x) => x - requiredReturn)) * periods) / dr;
}

function maxDrawdown(returns) {
  const r = clean(returns);
  if (!r.length) return null;
  let cum = 1, peak = 1, worst = 0;
  for (const x of r) {
    cum *= 1 + x;
    if (cum > peak) peak = cum;
    const dd = (cum - peak) / peak;
    if (dd < worst) worst = dd;
  }
  return worst;
}

function calmarRatio(returns, { periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const dd = maxDrawdown(returns);
  if (dd == null || !(dd < 0)) return null;
  const ar = annualReturn(returns, { periods });
  return ar == null ? null : ar / Math.abs(dd);
}

function omegaRatio(returns, { riskFree = 0, requiredReturn = 0, periods = TRADING_PERIODS_PER_YEAR } = {}) {
  const r = clean(returns);
  if (!r.length) return null;
  if (requiredReturn <= -1) return null;
  const threshold = requiredReturn === 0 ? 0 : Math.pow(1 + requiredReturn, 1 / periods) - 1;
  const less = r.map((x) => x - riskFree - threshold);
  const numer = sum(less.filter((x) => x > 0));
  const denom = -sum(less.filter((x) => x < 0));
  return denom > 0 ? numer / denom : null;
}

// Both series must be aligned (same length, same dates) — a mismatch is refused, not
// trimmed, because a silently shifted benchmark is a wrong beta that looks plausible.
function beta(returns, factorReturns) {
  if (!Array.isArray(returns) || !Array.isArray(factorReturns) || returns.length !== factorReturns.length) return null;
  const pairs = returns.map((r, i) => [r, factorReturns[i]]).filter(([r, f]) => isNum(r) && isNum(f));
  if (pairs.length < 2) return null;
  const mr = mean(pairs.map((p) => p[0]));
  const mf = mean(pairs.map((p) => p[1]));
  const cov = sum(pairs.map(([r, f]) => (f - mf) * (r - mr)));
  const varF = sum(pairs.map(([, f]) => (f - mf) ** 2));
  return varF > 0 ? cov / varF : null;
}

// [{ endIndex, beta }] for every full trailing window; empty when the series is shorter.
function rollingBeta(returns, factorReturns, { window = DEFAULT_ROLLING_WINDOW } = {}) {
  if (!Array.isArray(returns) || !Array.isArray(factorReturns) || returns.length !== factorReturns.length) return [];
  if (!(window >= 2) || returns.length < window) return [];
  const out = [];
  for (let end = window - 1; end < returns.length; end++) {
    const lo = end - window + 1;
    out.push({ endIndex: end, beta: beta(returns.slice(lo, end + 1), factorReturns.slice(lo, end + 1)) });
  }
  return out;
}

// One object, every metric, exact precision. `benchmarkReturns` (aligned) adds beta.
function summarize(returns, { benchmarkReturns = null, periods = TRADING_PERIODS_PER_YEAR, rollingWindow = DEFAULT_ROLLING_WINDOW, requiredReturn = 0 } = {}) {
  const r = clean(returns);
  const hasBench = Array.isArray(benchmarkReturns) && benchmarkReturns.length === (returns || []).length;
  const rolling = hasBench ? rollingBeta(returns, benchmarkReturns, { window: rollingWindow }) : [];
  return {
    version: VERSION,
    definitions: DEFINITIONS,
    n: r.length,
    periodsPerYear: periods,
    totalReturn: cumReturnsFinal(r),
    annualReturn: annualReturn(r, { periods }),
    annualVolatility: annualVolatility(r, { periods }),
    downsideRisk: downsideRisk(r, { requiredReturn, periods }),
    sortino: sortinoRatio(r, { requiredReturn, periods }),
    maxDrawdown: maxDrawdown(r),
    calmar: calmarRatio(r, { periods }),
    omega: omegaRatio(r, { requiredReturn, periods }),
    beta: hasBench ? beta(returns, benchmarkReturns) : null,
    rollingBetaWindow: rollingWindow,
    latestRollingBeta: rolling.length ? rolling[rolling.length - 1].beta : null,
    benchmarkTotalReturn: hasBench ? cumReturnsFinal(benchmarkReturns) : null,
  };
}

module.exports = {
  VERSION, DEFINITIONS, TRADING_PERIODS_PER_YEAR, DEFAULT_ROLLING_WINDOW,
  simpleReturns, cumReturnsFinal, annualReturn, annualVolatility, downsideRisk,
  sortinoRatio, maxDrawdown, calmarRatio, omegaRatio, beta, rollingBeta, summarize,
};
