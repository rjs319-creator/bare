// PATTERN SIMILARITY — DESCRIPTIVE shape agreement, NOT probability.
//
// The user asked for stocks that "correlate" with classic chart types. This module makes
// that precise by keeping the distinct notions of similarity SEPARATE (the prompt's
// explicit requirement) instead of blending everything into one number called
// "correlation":
//   pathCorrelation   — Pearson correlation of normalized price paths
//   dtwSimilarity     — Dynamic-Time-Warping alignment similarity (tolerates time shift)
//   geometrySimilarity— agreement of measured geometry with the pattern template's ranges
//   volumeSimilarity  — agreement of volume contraction/expansion with the template
//   contextSimilarity — market/volatility/liquidity environment agreement
//   combined          — a weighted blend, LABELED SIMILARITY, never a win probability
//
// A high combined score means "this chart looks like the template," which is a hypothesis,
// not an edge. Predictive value is measured elsewhere (predict.js / analog.js) and only
// after leakage-safe forward outcomes exist.

const { resample } = require('./geometry');

const isNum = v => typeof v === 'number' && isFinite(v);
const clamp01 = v => Math.max(0, Math.min(1, v));
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// ---- pathCorrelation ----------------------------------------------------------

// Pearson correlation of two normalized paths, each resampled to a common length. Because
// it operates on normalized paths it is invariant to price scale and to vertical offset.
function pathCorrelation(pathA, pathB, n = 32) {
  if (!Array.isArray(pathA) || !Array.isArray(pathB) || pathA.length < 2 || pathB.length < 2) return null;
  const a = resample(pathA, n);
  const b = resample(pathB, n);
  return pearson(a, b);
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null; // a flat path has undefined correlation
  return round(num / Math.sqrt(da * db));
}

// ---- dtwSimilarity ------------------------------------------------------------

// Dynamic Time Warping distance on unit-normalized paths, mapped to a [0,1] similarity.
// A Sakoe-Chiba band bounds the warp so an early rally can't align to a late one.
function dtwSimilarity(pathA, pathB, { n = 32, band = 6 } = {}) {
  if (!Array.isArray(pathA) || !Array.isArray(pathB) || pathA.length < 2 || pathB.length < 2) return null;
  const a = norm01(resample(pathA, n));
  const b = norm01(resample(pathB, n));
  const INF = Infinity;
  const dp = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(INF));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const jlo = Math.max(1, i - band);
    const jhi = Math.min(n, i + band);
    for (let j = jlo; j <= jhi; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      dp[i][j] = cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const dist = dp[n][n];
  if (!isNum(dist)) return null;
  // Normalize by path length; map distance→similarity with a soft exponential.
  const avg = dist / n;
  return round(clamp01(Math.exp(-3 * avg)));
}

function norm01(series) {
  const xs = series.filter(isNum);
  if (!xs.length) return series.map(() => 0.5);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi - lo <= 0) return series.map(() => 0.5);
  return series.map(v => (v - lo) / (hi - lo));
}

// ---- geometrySimilarity -------------------------------------------------------

// Score how well a measured geometry object matches a template's declared feature ranges.
// A template range is [min, max] (either bound may be null = open). A feature inside the
// range scores 1; outside, it decays smoothly over `tol` (in the feature's own units) so
// near-misses aren't binary-rejected. Returns { score, perFeature }.
function rangeScore(value, range, tol) {
  if (!isNum(value)) return null;         // missing feature → excluded (not penalized)
  const [min, max] = range;
  if (min != null && value < min) return clamp01(1 - (min - value) / (tol || Math.abs(min) || 1));
  if (max != null && value > max) return clamp01(1 - (value - max) / (tol || Math.abs(max) || 1));
  return 1;
}

function geometrySimilarity(features, template) {
  if (!features || !template || !template.geometry) return null;
  const perFeature = {};
  const scores = [];
  for (const [key, spec] of Object.entries(template.geometry)) {
    const s = rangeScore(features[key], spec.range, spec.tol);
    if (s == null) continue;
    perFeature[key] = round(s);
    scores.push(spec.weight != null ? { s, w: spec.weight } : { s, w: 1 });
  }
  if (!scores.length) return null;
  const wsum = scores.reduce((a, b) => a + b.w, 0);
  const combined = scores.reduce((a, b) => a + b.s * b.w, 0) / wsum;
  return { score: round(combined), perFeature };
}

// ---- volumeSimilarity ---------------------------------------------------------

function volumeSimilarity(volFeatures, template) {
  if (!volFeatures || !template || !template.volume) return null;
  const perFeature = {};
  const scores = [];
  for (const [key, spec] of Object.entries(template.volume)) {
    const s = rangeScore(volFeatures[key], spec.range, spec.tol);
    if (s == null) continue;
    perFeature[key] = round(s);
    scores.push(s);
  }
  if (!scores.length) return null;
  return { score: round(scores.reduce((a, b) => a + b, 0) / scores.length), perFeature };
}

// ---- contextSimilarity --------------------------------------------------------

// Does the current market/volatility/liquidity environment resemble the environment a
// template is meant for? A bullish continuation template in a risk-off, illiquid tape is
// a WORSE match even if the shape is perfect — this discounts that.
function contextSimilarity(context, template) {
  if (!context || !template || !template.context) return null;
  const t = template.context;
  const parts = [];
  if (t.regime && context.marketRegime) {
    parts.push(t.regime.includes(context.marketRegime) ? 1 : (context.marketRegime === 'NEUTRAL' ? 0.6 : 0.2));
  }
  if (t.liquidity && context.liquidity) {
    parts.push(context.liquidity === 'SUPPORTED' ? 1 : (context.liquidity === 'THIN' ? 0.4 : 0.7));
  }
  if (isNum(context.volPercentile) && t.volMax != null) {
    parts.push(context.volPercentile <= t.volMax ? 1 : clamp01(1 - (context.volPercentile - t.volMax) / 40));
  }
  if (!parts.length) return null;
  return round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// ---- combine ------------------------------------------------------------------

const DEFAULT_WEIGHTS = { pathCorrelation: 0.28, geometrySimilarity: 0.34, dtwSimilarity: 0.10, volumeSimilarity: 0.16, contextSimilarity: 0.12 };

// Blend the available components into one combined similarity in [0,1]. Missing components
// are dropped and the weights renormalized (never imputed). pathCorrelation, which lives
// in [-1,1], is folded to [0,1] as (x+1)/2. The result is LABELED SIMILARITY.
function combineSimilarity(components, weights = DEFAULT_WEIGHTS) {
  let wsum = 0;
  let acc = 0;
  const used = {};
  for (const [key, w] of Object.entries(weights)) {
    let v = components[key];
    if (v && typeof v === 'object' && 'score' in v) v = v.score;
    if (!isNum(v)) continue;
    const folded = key === 'pathCorrelation' ? (v + 1) / 2 : v;
    used[key] = round(folded);
    acc += folded * w;
    wsum += w;
  }
  if (wsum === 0) return { combined: null, used, coverage: 0 };
  return { combined: round(acc / wsum), used, coverage: round(wsum / sum(Object.values(weights))) };
}

function sum(a) { return a.reduce((x, y) => x + y, 0); }

// ---- match tier (HONEST) ------------------------------------------------------
//
// The prompt is explicit: do NOT invent a universal 85/100 "Strong" cutoff. A tier should
// come from a VALIDATED similarity distribution (deciles/percentiles) with sufficient
// effective sample size. Until such a distribution exists, we return a DESCRIPTIVE tier
// and flag `calibratedThreshold:false` so nothing downstream mistakes it for an edge gate.
//
// If `deciles` (an ascending array of similarity cut-points from the resolved-outcome
// study) is supplied AND effective sample size is sufficient, we use the empirical top
// deciles; otherwise we fall back to conservative descriptive bands.
function matchTier(combined, { deciles = null, effectiveN = 0, minN = 50 } = {}) {
  if (!isNum(combined)) return { tier: 'NONE', calibratedThreshold: false };
  if (Array.isArray(deciles) && deciles.length >= 9 && effectiveN >= minN) {
    const p90 = deciles[8];
    const p70 = deciles[6];
    if (combined >= p90) return { tier: 'STRONG', calibratedThreshold: true, cut: round(p90) };
    if (combined >= p70) return { tier: 'MODERATE', calibratedThreshold: true, cut: round(p70) };
    return { tier: 'WEAK', calibratedThreshold: true };
  }
  // Descriptive fallback — explicitly NOT an empirically-validated edge threshold.
  let tier = 'WEAK';
  if (combined >= 0.82) tier = 'STRONG';
  else if (combined >= 0.68) tier = 'MODERATE';
  return { tier, calibratedThreshold: false };
}

module.exports = {
  pathCorrelation, pearson,
  dtwSimilarity,
  geometrySimilarity, volumeSimilarity, contextSimilarity,
  rangeScore,
  combineSimilarity, matchTier,
  DEFAULT_WEIGHTS,
};
