'use strict';
// EVOLVE — DEFLATED SHARPE / MULTIPLE-TESTING GATE  (OMEGA Gap C)
//
// When you evaluate many cells (specialist × regime × horizon) and keep the best, the top
// Sharpe is inflated by selection — with enough trials, noise alone produces an impressive
// winner. This applies Bailey & López de Prado's Deflated Sharpe Ratio: the Probabilistic
// Sharpe (P that the true SR beats a benchmark, given sample length + skew + kurtosis)
// evaluated at the EXPECTED MAXIMUM Sharpe under the null across N trials. A cell is only
// TRADE-eligible if its DSR clears the bar AFTER that deflation — so a cell that looks good
// only because thousands were tried does not survive.
//
// This is the guard the Phase-A prototypes demonstrated the need for live: searching
// 3 horizons × 2 barrier modes × 3 fold-counts surfaced one "pass" that evaporated. It also
// ties into Gap B — the per-cell sample length uses the uniqueness-weighted effective N when
// weights are supplied, so overlapping labels don't inflate the significance here either.
//
// Pure + self-contained (own normal CDF / inverse-CDF). Reports the trial count explicitly.

const EULER_MASCHERONI = 0.5772156649015329;

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf) and inverse (Acklam).
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= phigh) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function moments(returns) {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let s2 = 0, s3 = 0, s4 = 0;
  for (const x of returns) { const dv = x - mean; s2 += dv * dv; s3 += dv * dv * dv; s4 += dv * dv * dv * dv; }
  const variance = s2 / n, sd = Math.sqrt(variance);
  return { n, mean, sd, skew: sd > 0 ? (s3 / n) / (sd ** 3) : 0, kurt: variance > 0 ? (s4 / n) / (variance ** 2) : 3 };
}
function varianceOf(arr) { if (arr.length < 2) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length; }

// Probabilistic Sharpe Ratio: P(true SR > srBenchmark) given per-period SR, sample n,
// skewness and kurtosis (normal kurtosis = 3).
function probabilisticSharpe(sr, n, skew, kurt, srBenchmark = 0) {
  if (!(n > 1) || !Number.isFinite(sr)) return null;
  const denom = Math.sqrt(Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return +normCdf((sr - srBenchmark) * Math.sqrt(n - 1) / denom).toFixed(4);
}

// Expected maximum Sharpe under the null across `trials` strategies whose SRs vary by varSR
// — the multiple-testing deflation benchmark.
function expectedMaxSharpe(trials, varSR) {
  const N = Math.max(2, trials), s = Math.sqrt(Math.max(0, varSR));
  if (s === 0) return 0;
  const g = EULER_MASCHERONI;
  return s * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
}

// Deflated Sharpe Ratio: PSR at the expected-max-under-null benchmark.
function deflatedSharpe(sr, n, skew, kurt, trials, varSR) {
  const sr0 = expectedMaxSharpe(trials, varSR);
  return { dsr: probabilisticSharpe(sr, n, skew, kurt, sr0), sr0: +sr0.toFixed(4) };
}

const regimeOf = (ev) => ev.regimeLabel || (ev.contextKey || '').split('|')[0] || 'neutral';

// Build specialist × regime × horizon cells from labeled events, compute each cell's
// benchmark-relative (SPY-relative) per-trade Sharpe, then the DSR that accounts for how
// many cells were tried. `weights` (Map event→uniqueness, from Gap B) supplies the effective
// sample when provided, so overlapping labels don't inflate significance here either.
function gridDeflatedSharpe(events, { minCellN = 20, passDSR = 0.95, weights = null } = {}) {
  const cells = new Map();
  for (const ev of (events || [])) {
    const ret = ev.spyRelReturn == null ? ev.terminalReturn : ev.spyRelReturn;   // residual (benchmark-relative)
    if (!Number.isFinite(ret)) continue;
    const specs = (ev.specialists && ev.specialists.length) ? ev.specialists : (ev.contribs || []).map(c => c.specialist);
    for (const sp of specs) {
      const key = `${sp}|${regimeOf(ev)}|${ev.horizon}`;
      if (!cells.has(key)) cells.set(key, { specialist: sp, regime: regimeOf(ev), horizon: ev.horizon, rets: [], w: 0 });
      const c = cells.get(key); c.rets.push(ret); c.w += weights ? (weights.get(ev) ?? 1) : 1;
    }
  }
  const rows = [];
  for (const c of cells.values()) {
    if (c.rets.length < 4) continue;
    const m = moments(c.rets);
    const sr = m.sd > 0 ? m.mean / m.sd : 0;
    rows.push({ specialist: c.specialist, regime: c.regime, horizon: c.horizon, n: m.n, effN: +(weights ? c.w : m.n).toFixed(1), sr: +sr.toFixed(4), skew: +m.skew.toFixed(2), kurt: +m.kurt.toFixed(2) });
  }
  const tried = rows.filter(r => r.n >= minCellN);      // a cell needs real sample to count as a trial
  const varSR = varianceOf(tried.map(r => r.sr));
  const N = tried.length;
  for (const r of rows) {
    if (r.n >= minCellN) { const { dsr, sr0 } = deflatedSharpe(r.sr, r.effN, r.skew, r.kurt, N, varSR); r.dsr = dsr; r.sr0 = sr0; r.pass = dsr != null && dsr >= passDSR; }
    else { r.dsr = null; r.pass = false; r.tooSmall = true; }
  }
  rows.sort((a, b) => b.sr - a.sr);
  const survivors = rows.filter(r => r.pass).map(r => `${r.specialist}|${r.regime}|${r.horizon}`);
  return {
    trials: N, varSR: +varSR.toFixed(5), expectedMaxSharpeNull: +expectedMaxSharpe(N, varSR).toFixed(4), passDSR,
    passing: survivors.length, survivors, cells: rows,
    verdict: N < 2 ? 'insufficient-grid' : survivors.length ? 'cell(s) survive multiple-testing' : 'no cell survives multiple-testing',
    note: `Per-cell SPY-relative per-trade Sharpe; DSR = P(true SR > expected max of ${N} trials under the null). A cell is TRADE-eligible only if DSR >= ${passDSR}. effN uses Gap-B uniqueness weights when supplied.`,
  };
}

module.exports = { normCdf, normInv, moments, probabilisticSharpe, expectedMaxSharpe, deflatedSharpe, gridDeflatedSharpe };
