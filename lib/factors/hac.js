'use strict';
// HAC (Newey-West, Bartlett kernel) sandwich covariance for regression coefficients.
//
//   V = Q⁻¹ S Q⁻¹,  Q = X'X,  S = Γ₀ + Σ_{l=1..L} w_l (Γ_l + Γ_l'),  Γ_l = Σ_t g_t g_{t−l}',
//   g_t = x_t·e_t,  w_l = 1 − l/(L+1)
//
// Used for the t-statistic on the factor-model intercept (alpha) where consecutive
// decision dates share most of a multi-session label's return path. Pure, no
// small-sample correction (documented; a correction may only widen — callers that want
// one apply it outside). Returns null (never NaN) when X'X is singular.
const M = require('../orbit-math');

const ANDREWS_SCALE = 1.5;

const bartlett = (l, L) => (l > L ? 0 : 1 - l / (L + 1));

// Lag choice shared with lib/evidence-stats: horizonBars − 1 when the label overlap is
// known, else the Andrews-style rule of thumb used by stats-v3.neweyWest.
function defaultLags(n, horizonBars) {
  if (Number.isFinite(horizonBars) && horizonBars > 0) return Math.max(1, Math.floor(horizonBars) - 1);
  return Math.max(1, Math.floor(ANDREWS_SCALE * Math.cbrt(n)));
}

function zeros(p) { return Array.from({ length: p }, () => new Array(p).fill(0)); }

function invert(A) {
  const p = A.length;
  const cols = [];
  for (let j = 0; j < p; j++) {
    const e = new Array(p).fill(0); e[j] = 1;
    const x = M.solveLinear(A, e);
    if (!x) return null;
    cols.push(x);
  }
  // cols[j] is column j of A⁻¹ → transpose into row-major.
  return Array.from({ length: p }, (_, i) => cols.map(c => c[i]));
}

function matMul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let s = 0; for (let t = 0; t < k; t++) s += A[i][t] * B[t][j]; out[i][j] = s; }
  return out;
}

// p×p HAC covariance of the OLS/ridge coefficient vector, or null when singular.
function hacCovariance(X, resid, { lags = null } = {}) {
  const n = X.length;
  if (!n || resid.length !== n) return null;
  const p = X[0].length;
  const L = lags == null ? defaultLags(n, null) : Math.max(0, Math.floor(lags));
  const Q = zeros(p);
  for (const row of X) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) Q[i][j] += row[i] * row[j];
  const Qinv = invert(Q);
  if (!Qinv) return null;
  const g = X.map((row, t) => row.map(v => v * resid[t]));
  const S = zeros(p);
  for (let l = 0; l <= Math.min(L, n - 1); l++) {
    const w = l === 0 ? 1 : bartlett(l, L);
    for (let t = l; t < n; t++) {
      for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
        const term = g[t][i] * g[t - l][j];
        S[i][j] += l === 0 ? term : w * term;
        if (l > 0) S[j][i] += w * term;     // Γ_l' — written once per (i,j) pair as the transposed cell
      }
    }
  }
  return matMul(matMul(Qinv, S), Qinv);
}

// Standard errors and t-statistics for `coefs` (same order as X's columns).
function hacTStats(coefs, X, resid, { lags = null } = {}) {
  const p = coefs.length;
  const V = hacCovariance(X, resid, { lags });
  if (!V) return { se: new Array(p).fill(null), t: new Array(p).fill(null), lags };
  const se = coefs.map((_, i) => (V[i][i] > 0 ? Math.sqrt(V[i][i]) : null));
  const t = coefs.map((c, i) => (se[i] ? c / se[i] : null));
  return { se, t, lags: lags == null ? defaultLags(X.length, null) : lags };
}

module.exports = { bartlett, defaultLags, hacCovariance, hacTStats };
