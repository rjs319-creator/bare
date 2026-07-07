// DUAL-READ SELF-IMPROVEMENT — adaptive factor-weight tuner for the long-term read.
//
// The dual-horizon read is ACCOUNTABLE: op=dualreadlog logs each read with its
// per-factor signals, and forward excess-vs-SPY resolves them (the `dualread/`
// ledger). This module turns that track record into a learning loop: each cycle it
// fits challenger weights from the resolved sample (each long-term factor earns
// weight ∝ its own VALIDATED forward-return IC, shrunk toward the champion so noise
// can't swing it) and PROMOTES the challenger only if it beats the champion
// out-of-sample by a margin on enough resolved reads. Otherwise it stays put.
//
// Direct analog of lib/timing-adapt.js — same champion/challenger machinery, but the
// "factors" are the long-term signals (trend200 / cross / rs3m / …) and the outcome
// is forward excess-vs-SPY. Pure: resolved rows in → {weights, promoted, …} out.
//
// HONEST prior (consistent with the whole app edge-hunt): re-weighting price factors
// has diminishing returns — the composite is already ~all momentum (~0.10 IC). So this
// stays DORMANT (keeps champion) until the LIVE ledger proves a challenger; its real
// value is (a) validating which factors still carry edge and (b) demoting ones that die.

const { DEFAULT_LT_WEIGHTS, LT_FACTORS, compositeFrom } = require('./longterm');

const MIN_RESOLVED = 40;       // resolved reads before any promotion (matches the app's other ≥40 gates)
const IC_MARGIN = 0.01;        // challenger must beat champion OOS composite-IC by this
const MAX_STEP = 0.25;         // bounded move: blend ≤25% toward the fitted weights per cycle

function spearman(xs, ys) {
  const n = xs.length; if (n < 20) return null;
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : null;
}

// per-factor validated rank-IC (signal → forward excess), over rows where present.
function factorICs(rows) {
  const out = {};
  for (const k of LT_FACTORS) {
    const sub = rows.filter(r => r.signals && r.signals[k] != null && Number.isFinite(r.fwd));
    out[k] = sub.length >= 20 ? (spearman(sub.map(r => r.signals[k]), sub.map(r => r.fwd)) || 0) : 0;
  }
  return out;
}

// Fit challenger weights: factor weight ∝ max(0, its IC), shrunk 50/50 toward `prior`
// (robustness), renormalized to sum 1. A factor that stops predicting loses weight; a
// drifting one gains it — bounded by the step the caller applies.
function fitWeights(rows, prior = DEFAULT_LT_WEIGHTS) {
  const ic = factorICs(rows);
  const posSum = LT_FACTORS.reduce((s, k) => s + Math.max(0, ic[k]), 0) || 1;
  const raw = {};
  for (const k of LT_FACTORS) raw[k] = 0.5 * (Math.max(0, ic[k]) / posSum) + 0.5 * prior[k];
  const tot = LT_FACTORS.reduce((s, k) => s + raw[k], 0);
  const w = {}; for (const k of LT_FACTORS) w[k] = +(raw[k] / tot).toFixed(3);
  return { weights: w, factorICs: ic };
}

const stepToward = (from, to, frac) => { const w = {}; for (const k of LT_FACTORS) w[k] = +(from[k] + (to[k] - from[k]) * frac).toFixed(3); return w; };

// composite-IC (long-term composite → forward excess) under weights W on rows.
function icUnder(rows, W) {
  const r = rows.filter(x => x.signals && Number.isFinite(x.fwd));
  return r.length >= 20 ? spearman(r.map(x => compositeFrom(x.signals, W)), r.map(x => x.fwd)) : null;
}

// Champion/challenger cycle. `champion` = current active weights (default shipped).
// Returns { promoted, weights, reason, …diagnostics }. Dormant (keeps champion) unless a
// bounded-step challenger beats it OOS by IC_MARGIN with ≥MIN_RESOLVED resolved rows.
function championChallenger(rows, champion = DEFAULT_LT_WEIGHTS, opts = {}) {
  const resolved = (rows || []).filter(r => r.signals && Number.isFinite(r.fwd));
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

// ── Per-group adaptation ─────────────────────────────────────────────────────
// "Adjust to whatever is working for THIS kind of stock." Group the resolved rows
// by their behavior bucket (row.group) and, for each group, run the SAME
// champion/challenger — but the champion to beat is the GLOBAL active weights. A
// group only gets its own personalized weights if fitting on that group's reads
// beats global OUT-OF-SAMPLE on that group's held-out reads. Groups without enough
// data, or whose own weights don't beat global, ride the global weights. So
// personalization is opt-in and proof-gated, never overfit-by-default.
function groupRowsBy(rows) {
  const by = {};
  for (const r of rows || []) { const g = r.group || 'other'; (by[g] || (by[g] = [])).push(r); }
  return by;
}

function championChallengerByGroup(rows, globalActive = DEFAULT_LT_WEIGHTS, opts = {}) {
  const by = groupRowsBy(rows);
  const groups = {};
  for (const [g, gr] of Object.entries(by)) {
    // The group's challenger is fit from its own reads; it must beat GLOBAL OOS to promote.
    const cc = championChallenger(gr, globalActive, opts);
    groups[g] = {
      personalized: cc.promoted,
      weights: cc.promoted ? cc.weights : globalActive,
      resolved: cc.resolved, reason: cc.reason,
      oosIcGroup: cc.oosIcChallenger, oosIcGlobal: cc.oosIcChampion,
      factorICs: cc.factorICs || null,
    };
  }
  return { groups };
}

module.exports = {
  championChallenger, championChallengerByGroup, groupRowsBy,
  fitWeights, factorICs, icUnder, LT_FACTORS, MIN_RESOLVED, DEFAULT_LT_WEIGHTS,
};
