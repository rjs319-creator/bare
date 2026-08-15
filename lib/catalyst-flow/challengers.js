'use strict';
// CATALYST–FLOW — MANDATORY SIMPLE CHALLENGERS.
//
// A gradient-boosted ranker is only interesting if it beats something a person could have
// written down. These are the somethings, and they are not strawmen: the transparent PEAD
// score is the literal economic hypothesis (underreaction to a surprise, confirmed by the
// first session), and ridge is the same information under a linear model.
//
//   E1_SIMPLE_PEAD  — surprise + first-session confirmation, fixed weights, no fitting.
//   RIDGE           — regularised linear event model, coefficients fit INSIDE the fold.
//
// The scores are ORDINAL. They are not expected returns and not probabilities, and nothing
// in this module converts them into either.
//
// Pure module: no network, no clock, no fs.

const CHALLENGER_VERSION = 'catalyst-challengers-v1';

// ── E1: transparent PEAD ────────────────────────────────────────────────────
// Preregistered weights. They are round numbers on purpose: any tuning of them would make
// E1 a fitted model competing with E2 rather than the honest prior it is meant to be.
const PEAD_WEIGHTS = Object.freeze({
  epsSurpriseStd: 1.0,
  revenueSurpriseStd: 0.5,
  surpriseSignAgreement: 0.25,
  firstSessionVsSector: 1.0,      // confirmation, sector-relative
  gapRetention: 0.5,              // did the move hold into the close?
  closeLocationValue: 0.25,
});

// Score one row. Returns null when NO component is measurable — a score assembled from
// nothing would rank an empty row alongside a confirmed one.
function transparentPeadScore(row, weights = PEAD_WEIGHTS) {
  let sum = 0, usedWeight = 0, used = 0;
  for (const [name, w] of Object.entries(weights)) {
    const v = row ? row[name] : null;
    if (!Number.isFinite(v)) continue;
    sum += w * v; usedWeight += Math.abs(w); used++;
  }
  if (!used || usedWeight === 0) return null;
  // Renormalise by the weight actually used, so a row missing revenue surprise is not
  // mechanically ranked below one that has it.
  return { score: sum / usedWeight, componentsUsed: used, weightUsed: usedWeight };
}

// ── Ridge (closed form, fit in-fold) ────────────────────────────────────────
// Solves (XᵀX + λI)β = Xᵀy by Gaussian elimination with partial pivoting. Small p, so a
// direct solve is both simpler and more predictable than an iterative one.
//
// standardise() returns the scaler so the SAME numbers are reapplied to the test fold.
// Fitting a scaler on train+test is the single most common leak in this class of study.
function standardise(X) {
  const p = X[0] ? X[0].length : 0;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const col = X.map((r) => r[j]).filter(Number.isFinite);
    const m = col.length ? col.reduce((s, v) => s + v, 0) / col.length : 0;
    const v = col.length > 1 ? col.reduce((s, x) => s + (x - m) ** 2, 0) / (col.length - 1) : 0;
    mu[j] = m; sd[j] = v > 0 ? Math.sqrt(v) : 1;
  }
  return { mu, sd };
}

// Apply a scaler, imputing a missing value to the TRAINING mean (which becomes 0 after
// centring) — the only imputation in this module, and it uses training statistics only.
const applyScaler = (X, { mu, sd }) => X.map((r) => r.map((v, j) => (Number.isFinite(v) ? (v - mu[j]) / sd[j] : 0)));

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // Gauss-Jordan leaves a diagonal system: row i is [0…0, M[i][i], 0…0 | rhs].
  // `row[i]` IS that diagonal element — indexing it twice would read a number's property
  // and silently produce NaN for every coefficient.
  return M.map((row, i) => row[n] / row[i]);
}

function fitRidge(X, y, lambda = 1.0) {
  if (!Array.isArray(X) || !X.length || X.length !== y.length) return null;
  const scaler = standardise(X);
  const Z = applyScaler(X, scaler);
  const p = Z[0].length;
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;

  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < Z.length; i++) {
    const yi = y[i] - yMean;
    for (let j = 0; j < p; j++) {
      Xty[j] += Z[i][j] * yi;
      for (let k = j; k < p; k++) XtX[j][k] += Z[i][j] * Z[i][k];
    }
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) XtX[j][k] = XtX[k][j]; XtX[j][j] += lambda; }

  const beta = solve(XtX, Xty);
  if (!beta) return null;
  return { beta, intercept: yMean, scaler, lambda, p, n: Z.length };
}

function predictRidge(model, X) {
  if (!model) return null;
  const Z = applyScaler(X, model.scaler);
  return Z.map((r) => model.intercept + r.reduce((s, v, j) => s + v * model.beta[j], 0));
}

// ── E0: the existing OMEGA event score, where technically comparable ────────
// The app's OMEGA score is defined on its own universe and cadence. Rather than
// re-deriving it (which would produce a lookalike, not the incumbent), the arm consumes
// whatever the caller resolved from the live ledger and REFUSES when a decision date has
// no genuine incumbent score — an arm silently running on a different cohort is the
// failure the locked-arm design exists to prevent.
function omegaArmScores(rows, resolveOmegaScore) {
  const scored = [], unresolved = [];
  for (const r of rows || []) {
    const s = resolveOmegaScore ? resolveOmegaScore(r) : null;
    if (Number.isFinite(s)) scored.push({ ...r, score: s });
    else unresolved.push({ key: r.key, reason: 'no-incumbent-omega-score-for-this-event' });
  }
  return { scored, unresolved, comparable: scored.length > 0 };
}

module.exports = {
  CHALLENGER_VERSION, PEAD_WEIGHTS,
  transparentPeadScore, standardise, applyScaler, fitRidge, predictRidge, omegaArmScores,
};
