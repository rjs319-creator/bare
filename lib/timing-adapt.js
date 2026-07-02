// TIMING SELF-IMPROVEMENT — adaptive factor-weight tuner for the entry-timing light.
//
// The timing grade is now ACCOUNTABLE: every graded pick is logged with its factor values
// and later resolved to a forward return (the `timing/` ledger). This module turns that
// track record into a learning loop: each cycle it fits challenger weights from the
// resolved sample (each factor earns weight ∝ its own VALIDATED forward-return IC, shrunk
// toward the current champion so noise can't swing it), and PROMOTES the challenger only if
// it beats the champion out-of-sample by a margin on enough resolved picks. Otherwise it
// stays put. Idiomatic to the app's other dormant-until-proven engines (recalibrate /
// fade-engine / GAI adaptive). Pure: resolved rows in → {weights, promoted, ...} out.
//
// Honest prior (research/35): on the historical eval, re-weighting did NOT beat the shipped
// hand-weights (they're already near-optimal) — so this stays DORMANT (keeps champion)
// until the LIVE ledger proves a challenger. Its real value is catching factor-edge DRIFT.

const { DEFAULT_WEIGHTS } = require('./timing');

const FK = ['rr', 'extension', 'trend', 'rvol', 'trigger'];
const MIN_RESOLVED = 120;      // need this many resolved graded picks before any promotion
const IC_MARGIN = 0.01;        // challenger must beat champion OOS grade-IC by this
const MAX_STEP = 0.25;         // bounded move: blend ≤25% toward the fitted weights per cycle

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}

// weighted-mean composite of present factors (mirrors lib/timing.js).
function composite(f, W) {
  let num = 0, den = 0;
  for (const k of FK) if (f && f[k] != null && W[k] != null) { num += W[k] * f[k]; den += W[k]; }
  return den > 0 ? num / den : 0.4;
}

// per-factor validated rank-IC vs forward return, over rows where the factor is present.
function factorICs(rows) {
  const out = {};
  for (const k of FK) {
    const sub = rows.filter(r => r.f && r.f[k] != null && Number.isFinite(r.fwd));
    out[k] = sub.length >= 20 ? (spearman(sub.map(r => r.f[k]), sub.map(r => r.fwd)) || 0) : 0;
  }
  return out;
}

// Fit challenger weights: factor weight ∝ max(0, its IC), shrunk 50/50 toward `prior`
// (robustness), renormalized. A factor that stops predicting loses weight; a drifting one
// gains it — but only up to the bounded step applied by the caller.
function fitWeights(rows, prior = DEFAULT_WEIGHTS) {
  const ic = factorICs(rows);
  const posSum = FK.reduce((s, k) => s + Math.max(0, ic[k]), 0) || 1;
  const raw = {};
  for (const k of FK) raw[k] = 0.5 * (Math.max(0, ic[k]) / posSum) + 0.5 * prior[k];
  const tot = FK.reduce((s, k) => s + raw[k], 0);
  const w = {}; for (const k of FK) w[k] = +(raw[k] / tot).toFixed(3);
  return { weights: w, factorICs: ic };
}

const stepToward = (from, to, frac) => { const w = {}; for (const k of FK) w[k] = +(from[k] + (to[k] - from[k]) * frac).toFixed(3); return w; };

// grade-IC (composite→outcome) under weights W on rows.
function icUnder(rows, W) {
  const r = rows.filter(x => x.f && Number.isFinite(x.fwd));
  return r.length >= 20 ? spearman(r.map(x => composite(x.f, W)), r.map(x => x.fwd)) : null;
}

// Champion/challenger cycle. `champion` = current active weights (default shipped).
// Returns { promoted, weights, reason, ...diagnostics }. Dormant (keeps champion) unless a
// bounded-step challenger beats it OOS by IC_MARGIN with ≥MIN_RESOLVED resolved rows.
function championChallenger(rows, champion = DEFAULT_WEIGHTS, opts = {}) {
  const resolved = (rows || []).filter(r => r.f && Number.isFinite(r.fwd));
  const minN = opts.minResolved || MIN_RESOLVED;
  if (resolved.length < minN) {
    return { promoted: false, weights: champion, reason: `accruing (${resolved.length}/${minN} resolved)`, resolved: resolved.length };
  }
  resolved.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cut = Math.floor(resolved.length * 0.7);
  const tr = resolved.slice(0, cut), te = resolved.slice(cut);
  const fit = fitWeights(tr, champion);
  const challenger = stepToward(champion, fit.weights, opts.maxStep ?? MAX_STEP);   // bounded move
  const icChamp = icUnder(te, champion), icChall = icUnder(te, challenger);
  const promoted = icChall != null && icChamp != null && (icChall - icChamp) >= (opts.margin ?? IC_MARGIN);
  return {
    promoted, weights: promoted ? challenger : champion,
    reason: promoted ? `challenger OOS IC ${icChall.toFixed(4)} > champion ${icChamp.toFixed(4)} by ≥${opts.margin ?? IC_MARGIN}`
      : `kept champion (challenger OOS ${icChall == null ? 'n/a' : icChall.toFixed(4)} vs ${icChamp == null ? 'n/a' : icChamp.toFixed(4)})`,
    resolved: resolved.length, oosIcChampion: icChamp, oosIcChallenger: icChall,
    factorICs: fit.factorICs, fitted: fit.weights,
  };
}

module.exports = { championChallenger, fitWeights, factorICs, icUnder, composite, FK, MIN_RESOLVED, DEFAULT_WEIGHTS };
