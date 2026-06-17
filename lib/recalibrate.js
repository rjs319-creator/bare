// Module 2 — Rolling walk-forward re-optimization of the Apex pillar weights.
//
// A deliberately dumb, fully inspectable coarse grid search (no black-box
// optimizer). The objective is rank-IC — how well the weighted composite RANKS
// winners above losers — because that is what the weights actually control
// (a thresholded Apex+Loaded selection barely moves under ±10 reweighting once
// the balance rule and tier cutoffs have done the selecting). Better ranking ⇒
// better-quality Apex tiers, which is the spec's intent. Candidate weights are
// picked on the full window, then the SELECTION PROCEDURE is validated
// out-of-sample with purged k-fold walk-forward CV: a re-fit is adopted only if
// the procedure beats the incumbent preset on EVERY out-of-sample fold by a
// margin. Profit factor is still reported as a human-readable diagnostic.
//
// Pure functions — no I/O — so the engine is unit-testable in isolation.
const apex = require('./apex');

const OFFSETS = [-10, -5, 0, 5, 10]; // ±10 pts from the Module 1 preset, 5-pt steps
const MIN_SIGNALS = 40;
const CV_FOLDS = 4;          // expanding-window folds
const IC_MARGIN = 0.04;      // required rank-IC improvement to count a fold / adopt
const MIN_IC_N = 10;         // rank-IC needs at least this many signals to mean anything

// Profit factor of a set of resolved signals (reported diagnostic, not optimized).
function profitFactorOf(signals) {
  let sw = 0, sl = 0;
  for (const s of signals) { if (s.r > 0) sw += s.r; else sl += Math.abs(s.r); }
  return sl > 0 ? +(sw / sl).toFixed(2) : (sw > 0 ? 99 : 0);
}

// The Apex+Loaded selection under a candidate weight set (for reporting).
function selectApexLoaded(signals, w) {
  const out = [];
  for (const s of signals) {
    const score = apex.composite(s.pillars, w);
    const tier = apex.tierOf(score, s.pillars, { status: s.status });
    if (tier === 'apex' || tier === 'loaded') out.push(s);
  }
  return out;
}

// Average (tie-corrected) ranks of an array.
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) r[idx[k][1]] = avg;
    i = j;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length; if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}
// Spearman rank-IC between the weighted composite and realized return.
function rankIC(signals, w) {
  if (signals.length < MIN_IC_N) return null;
  return pearson(ranks(signals.map(s => apex.composite(s.pillars, w))), ranks(signals.map(s => s.r)));
}

// All weight combos within ±10 of the preset (positive). `fixed` pillars are
// pinned at their preset value — used when a pillar can't be fit from the data
// (e.g. the technical-only historical backfill can't reconstruct Pillar 3).
function gridFor(preset, fixed = []) {
  const opt = k => (fixed.includes(k) ? [0] : OFFSETS);
  const combos = [];
  for (const a of opt('p1')) for (const b of opt('p2')) for (const c of opt('p3')) for (const d of opt('p4')) {
    const w = { p1: preset.p1 + a, p2: preset.p2 + b, p3: preset.p3 + c, p4: preset.p4 + d };
    if (w.p1 > 0 && w.p2 > 0 && w.p3 > 0 && w.p4 > 0) combos.push(w);
  }
  return combos;
}

// Best weights by in-sample rank-IC (the selection procedure under test).
function bestWeights(signals, preset, fixed) {
  let best = preset, bestIC = rankIC(signals, preset);
  if (bestIC == null) bestIC = -2;
  for (const w of gridFor(preset, fixed)) {
    const ic = rankIC(signals, w);
    if (ic != null && ic > bestIC) { bestIC = ic; best = w; }
  }
  return { best, bestIC };
}

// Marginal contribution of each pillar = rank-IC(best) − rank-IC(best, pillar zeroed).
function ablate(signals, w) {
  const base = rankIC(signals, w) ?? 0;
  return apex.KEYS.map(k => {
    const got = rankIC(signals, { ...w, [k]: 0 });
    return { key: k, label: apex.PILLAR_LABEL[k], marginal: +(base - (got ?? 0)).toFixed(3) };
  });
}

// Purged, expanding-window walk-forward cross-validation, folded by whole
// DISTINCT DATES (point-in-time cohorts can put many signals on one date, so
// index-based folds would split mid-date and the purge would wipe a fold). For
// each fold the weights are RE-SELECTED on the train dates and tested on a later
// held-out date block, with a `purgeDates` gap between them so a signal's
// forward holding window doesn't leak across the split. We measure whether the
// grid-search PROCEDURE generalizes — not whether one weight set worked once.
function purgedWalkForward(sorted, preset, opts = {}) {
  const K = opts.folds || CV_FOLDS, margin = opts.margin ?? IC_MARGIN, fixed = opts.fixed || [];
  const gap = opts.purgeDates ?? 1; // whole date-steps dropped between train and test
  const dates = [...new Set(sorted.map(s => s.date))].sort();
  const D = dates.length;
  const folds = [];
  if (D >= 4) {
    const nF = Math.min(K, D - 1);
    for (let f = 1; f <= nF; f++) {
      const trainEnd = Math.floor((D * f) / (nF + 1));          // last train date index (inclusive)
      const testStart = trainEnd + 1 + gap;                     // purge `gap` whole dates
      const testEnd = Math.floor((D * (f + 1)) / (nF + 1));
      if (trainEnd < 1 || testStart > testEnd) continue;
      const trainDates = new Set(dates.slice(0, trainEnd + 1));
      const testDates = new Set(dates.slice(testStart, testEnd + 1));
      const train = sorted.filter(s => trainDates.has(s.date));
      const test = sorted.filter(s => testDates.has(s.date));
      if (train.length < 24 || test.length < MIN_IC_N) continue;
      const { best } = bestWeights(train, preset, fixed);
      const tb = rankIC(test, best), tp = rankIC(test, preset);
      if (tb == null || tp == null) continue;
      folds.push({ improve: +(tb - tp).toFixed(3), beat: tb - tp > margin, trainN: train.length, testN: test.length });
    }
  }
  const valid = folds.length;
  const beatFolds = folds.filter(f => f.beat).length;
  const meanImprove = valid ? folds.reduce((a, f) => a + f.improve, 0) / valid : 0;
  // Adopt only on UNANIMOUS out-of-sample agreement (every valid fold beats the
  // preset by the margin) with ≥3 folds — strict, to refuse overfit noise.
  const passed = valid >= 3 && beatFolds === valid && meanImprove > margin;
  return { passed, valid, beatFolds, meanImprove: +meanImprove.toFixed(3), folds, margin, dateBlocks: D };
}

// Fit one regime's weights. Returns the chosen weights (preset if it can't/shouldn't move).
function fitRegime(signals, preset, opts = {}) {
  const minN = opts.minSignals || MIN_SIGNALS;
  const fixed = opts.fixed || [];
  if (signals.length < minN) {
    return { fitted: false, reason: 'insufficient-signals', n: signals.length, weights: preset };
  }
  const sorted = [...signals].sort((a, b) => (a.date < b.date ? -1 : 1));
  const stats = w => ({ ic: +(rankIC(sorted, w) ?? 0).toFixed(3), pf: profitFactorOf(selectApexLoaded(sorted, w)) });

  // 1. Select candidate weights on the full window (by rank-IC).
  const { best } = bestWeights(sorted, preset, fixed);
  if (best === preset) {
    return { fitted: false, reason: 'preset-optimal', n: signals.length, weights: preset, full: { preset: stats(preset) } };
  }

  // 2. Validate the selection procedure with purged walk-forward CV.
  const cv = purgedWalkForward(sorted, preset, opts);
  if (!cv.passed) {
    return { fitted: false, reason: 'failed-walkforward', n: signals.length, weights: preset, full: { preset: stats(preset), best: stats(best) }, validation: cv };
  }

  return {
    fitted: true, reason: 'refit', n: signals.length, weights: best, preset, fixed,
    full: { preset: stats(preset), best: stats(best) },
    validation: cv,
    ablation: ablate(sorted, best),
  };
}

// Recalibrate all three regimes. signals: [{ regime, pillars:{p1..p4}, r, date, status }].
function recalibrate(signals, opts = {}) {
  const out = { regimes: {}, weights: {}, fittedAny: false, minSignals: opts.minSignals || MIN_SIGNALS, fixed: opts.fixed || [] };
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const fit = fitRegime(signals.filter(s => s.regime === R), apex.PRESETS[R], opts);
    out.regimes[R] = fit;
    out.weights[R] = fit.weights;
    if (fit.fitted) out.fittedAny = true;
  }
  return out;
}

module.exports = { recalibrate, fitRegime, purgedWalkForward, profitFactorOf, selectApexLoaded, rankIC, gridFor, bestWeights, ablate, OFFSETS, MIN_SIGNALS, CV_FOLDS, IC_MARGIN };
