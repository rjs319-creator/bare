// ORBIT shared numeric core — pure, deterministic, dependency-light primitives
// used across the ORBIT feature engine, factor model, drift state, and models.
//
// Design rules (see docs/orbit-architecture.md):
//  - Every function is a pure function of its inputs (no Date.now, no I/O, no
//    global state) so feature snapshots are byte-reproducible.
//  - Robust estimators (median / MAD / winsorization) are preferred over
//    mean / std wherever a single outlier bar could distort a signal.
//  - Fit-then-apply: winsorization and scaling expose a fit step (training-only)
//    and a separate apply step, so no test-fold statistic ever leaks into a
//    training transform.

const EPS = 1e-12;

// ── Basic moments ──────────────────────────────────────────────────────────
function mean(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

// Sample variance (n-1). Returns null on <2 finite points.
function variance(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1);
}

function std(xs) {
  const va = variance(xs);
  return va == null ? null : Math.sqrt(va);
}

// ── Robust statistics ───────────────────────────────────────────────────────
// Linear-interpolated quantile of an UNSORTED array (finite values only).
function quantile(xs, q) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const pos = clamp(q, 0, 1) * (v.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function median(xs) { return quantile(xs, 0.5); }

// Median Absolute Deviation, scaled ×1.4826 so it estimates σ for Gaussian data.
function mad(xs, center = null) {
  const v = xs.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const c = center == null ? median(v) : center;
  const dev = v.map(x => Math.abs(x - c));
  const m = median(dev);
  return m == null ? null : m * 1.4826;
}

// Robust z-score of `x` against a sample, using median/MAD. Falls back to
// mean/std when MAD collapses to ~0 (e.g. many identical values).
function robustZ(x, sample) {
  if (x == null || !Number.isFinite(x)) return 0;
  const c = median(sample);
  let scale = mad(sample, c);
  if (scale == null || scale < EPS) { const s = std(sample); scale = (s == null || s < EPS) ? null : s; }
  if (c == null || scale == null) return 0;
  return (x - c) / scale;
}

// Fit winsorization limits on a TRAINING sample only (returns {lo,hi}); apply
// clamps new values to those limits. Keeps test-fold extremes from leaking.
function fitWinsor(sample, pLow = 0.02, pHigh = 0.98) {
  return { lo: quantile(sample, pLow), hi: quantile(sample, pHigh) };
}
function applyWinsor(x, limits) {
  if (x == null || !Number.isFinite(x) || !limits) return x;
  let y = x;
  if (limits.lo != null && y < limits.lo) y = limits.lo;
  if (limits.hi != null && y > limits.hi) y = limits.hi;
  return y;
}

// ── Correlation ─────────────────────────────────────────────────────────────
// Pearson over the paired finite subset. Returns null on <2 usable pairs or a
// degenerate (zero-variance) input.
function pearson(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] != null && b[i] != null && Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  }
  if (xs.length < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { const a1 = xs[i] - mx, b1 = ys[i] - my; num += a1 * b1; dx += a1 * a1; dy += b1 * b1; }
  if (dx < EPS || dy < EPS) return null;
  return num / Math.sqrt(dx * dy);
}

// ── Linear algebra: ridge regression via normal equations ───────────────────
// Solve (XᵀX + λI) β = Xᵀy for β. `X` is an array of rows (each an equal-length
// feature vector — the caller prepends a 1 for an intercept if wanted). λ is NOT
// applied to any particular column here; callers that don't want to penalise the
// intercept should pass a per-column penalty via `penalty`. Deterministic
// Gaussian elimination with partial pivoting. Returns null if singular.
function ridgeSolve(X, y, lambda = 1e-3, penalty = null) {
  const n = X.length;
  if (!n) return null;
  const p = X[0].length;
  // Aᵀ = XᵀX + λI  (p×p),  b = Xᵀy  (p)
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let r = 0; r < n; r++) {
    const row = X[r], yr = y[r];
    for (let i = 0; i < p; i++) {
      b[i] += row[i] * yr;
      for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < p; i++) A[i][i] += (penalty ? penalty[i] : lambda);
  return solveLinear(A, b);
}

// Gaussian elimination with partial pivoting. Returns x for A x = b, or null.
function solveLinear(Ain, bin) {
  const p = bin.length;
  const A = Ain.map(row => row.slice());
  const b = bin.slice();
  for (let col = 0; col < p; col++) {
    let piv = col, best = Math.abs(A[col][col]);
    for (let r = col + 1; r < p; r++) { const v = Math.abs(A[r][col]); if (v > best) { best = v; piv = r; } }
    if (best < EPS) return null; // singular
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
    const d = A[col][col];
    for (let r = col + 1; r < p; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < p; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(p).fill(0);
  for (let r = p - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < p; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

// ── Link functions ──────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-clamp(z, -30, 30))); }
function logit(p) { const q = clamp(p, 1e-6, 1 - 1e-6); return Math.log(q / (1 - q)); }

// Standard normal CDF via the Abramowitz-Stegun erf approximation (|err|<1.5e-7).
function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// ── Exponentially weighted moving average of a series (causal) ──────────────
function ewma(xs, halfLife) {
  const alpha = 1 - Math.pow(0.5, 1 / Math.max(halfLife, EPS));
  let s = null;
  const out = new Array(xs.length).fill(null);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x == null || !Number.isFinite(x)) { out[i] = s; continue; }
    s = (s == null) ? x : alpha * x + (1 - alpha) * s;
    out[i] = s;
  }
  return out;
}

// OLS slope of y vs a 0..n-1 time index over the finite subset (per-step drift).
function slope(ys) {
  const pts = [];
  for (let i = 0; i < ys.length; i++) if (ys[i] != null && Number.isFinite(ys[i])) pts.push([i, ys[i]]);
  if (pts.length < 2) return null;
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  let num = 0, den = 0;
  for (const [x, yv] of pts) { num += (x - mx) * (yv - my); den += (x - mx) * (x - mx); }
  if (den < EPS) return null;
  return num / den;
}

// Deterministic L2-regularised logistic regression via batch gradient descent.
// `X` rows include their own intercept column (a leading 1) if wanted; the
// intercept (column 0) is NOT penalised. Starts at all-zero weights so the fit is
// reproducible. Returns the weight vector.
function logisticFit(X, y, opts = {}) {
  const { lambda = 1e-3, iters = 400, lr = 0.3 } = opts;
  const n = X.length; if (!n) return null;
  const p = X[0].length;
  const w = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const grad = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      let z = 0; for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < p; j++) grad[j] += err * X[i][j];
    }
    for (let j = 0; j < p; j++) { grad[j] /= n; if (j > 0) grad[j] += lambda * w[j]; w[j] -= lr * grad[j]; }
  }
  return w;
}
function logisticPredict(w, x) {
  let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * x[j];
  return sigmoid(z);
}

// Brier score and log loss for probability-vs-binary-label evaluation.
function brier(probs, labels) {
  let s = 0, n = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] == null || labels[i] == null) continue;
    const d = probs[i] - labels[i]; s += d * d; n++;
  }
  return n ? s / n : null;
}
function logLoss(probs, labels) {
  let s = 0, n = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] == null || labels[i] == null) continue;
    const p = clamp(probs[i], 1e-6, 1 - 1e-6);
    s += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p)); n++;
  }
  return n ? s / n : null;
}

module.exports = {
  EPS, mean, variance, std, quantile, median, mad, robustZ,
  fitWinsor, applyWinsor, pearson, ridgeSolve, solveLinear,
  clamp, sigmoid, logit, normCdf, ewma, slope, brier, logLoss,
  logisticFit, logisticPredict,
};
