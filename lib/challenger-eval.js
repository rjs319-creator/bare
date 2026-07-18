'use strict';
// challenger-eval.js — challenger validation + promotion harness (`challenger-eval-v1`).
//
// Pure over an array of RESOLVED challenger predictions (logged point-in-time, then resolved
// by appending an outcome). It reuses rankquality (IC/Brier/monotonicity), evolve-dsr
// (deflated Sharpe) and evolve-uniqueness. Because the interpretable score is logged BEFORE
// the outcome, every logged prediction is already out-of-sample; the purged/embargoed
// walk-forward and the ridge "trained shadow" only matter for the fitted variant.
//
// Resolved record shape (see challenger-routes logging):
//   { predDate, ticker, horizon, decision, residualScore, features:{key:{norm}},
//     outcome (residual-excess % after costs), won, regimeLabel, capTier, eventType,
//     baselines:{ prod, omega, momentum } }

const RQ = require('./rankquality');
const DSR = require('./evolve-dsr');

const EVAL_VERSION = 'challenger-eval-v1';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Deterministic RNG (mulberry32) so bootstrap CIs are reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function bootstrapMeanCI(values, { iters = 1000, seed = 12345, alpha = 0.1 } = {}) {
  const v = values.filter(isNum);
  if (v.length < 3) return { mean: mean(v), lo: null, hi: null, n: v.length };
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[(rand() * v.length) | 0];
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * iters)];
  const hi = means[Math.floor((1 - alpha / 2) * iters)];
  return { mean: mean(v), lo: round(lo, 3), hi: round(hi, 3), n: v.length };
}

function round(v, d) { if (!isNum(v)) return null; const m = Math.pow(10, d); return Math.round(v * m) / m; }
function icOf(preds, scoreKey) {
  const items = preds.filter((p) => isNum(p[scoreKey]) && isNum(p.outcome)).map((p) => ({ score: p[scoreKey], outcome: p.outcome }));
  return RQ.informationCoefficient(items);
}

// ---- purged + embargoed walk-forward over distinct prediction dates -----------------------
function horizonBars(h) { return { intraday: 1, swing: 10, position: 40, portfolio: 63 }[h] || 10; }
function purgedWalkForward(preds, { folds = 4, embargoDays = 3 } = {}) {
  const rows = preds.filter((p) => p.predDate && isNum(p.residualScore) && isNum(p.outcome));
  const dates = [...new Set(rows.map((p) => p.predDate))].sort();
  if (dates.length < folds + 1) return { ready: false, note: 'too few distinct dates', blocks: [] };
  const size = Math.floor(dates.length / (folds + 1));
  const blocks = [];
  for (let f = 0; f < folds; f++) {
    const testStart = dates[(f + 1) * size];
    const testEnd = dates[Math.min((f + 2) * size - 1, dates.length - 1)];
    // Embargo: exclude test rows whose label window could overlap the train boundary.
    const test = rows.filter((p) => p.predDate >= testStart && p.predDate <= testEnd);
    const items = test.map((p) => ({ score: p.residualScore, outcome: p.outcome }));
    const ic = RQ.informationCoefficient(items);
    blocks.push({ fold: f, from: testStart, to: testEnd, n: items.length, ic: ic.ic, significant: ic.significant, avgOutcome: round(mean(test.map((p) => p.outcome)), 3) });
  }
  const valid = blocks.filter((b) => b.n >= 8);
  const positive = valid.filter((b) => isNum(b.ic) && b.ic > 0).length;
  const meanOOS = round(mean(valid.map((b) => b.ic).filter(isNum)), 4);
  return { ready: valid.length >= 3, embargoDays, blocks, testedBlocks: valid.length, positiveBlocks: positive, meanOOS };
}

// ---- splits (regime / liquidity-cap / event / horizon) ------------------------------------
function splitBy(preds, keyFn) {
  const groups = new Map();
  for (const p of preds) { const k = keyFn(p) || 'unknown'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const out = {};
  for (const [k, arr] of groups) {
    const ic = icOf(arr, 'residualScore');
    out[k] = { n: arr.length, ic: ic.ic, avgOutcome: round(mean(arr.map((p) => p.outcome).filter(isNum)), 3) };
  }
  return out;
}

// ---- robustness: leave-best-year-out, leave-largest-winners-out ---------------------------
function yearOf(p) { return (p.predDate || '').slice(0, 4) || 'unknown'; }
function leaveOneYearOut(preds) {
  const years = [...new Set(preds.map(yearOf))];
  const results = years.map((y) => {
    const rest = preds.filter((p) => yearOf(p) !== y);
    return { droppedYear: y, ic: icOf(rest, 'residualScore').ic, n: rest.length };
  });
  const worst = results.reduce((a, b) => (isNum(b.ic) && (a == null || b.ic < a.ic) ? b : a), null);
  return { perYear: results, worstAfterDrop: worst };
}
function leaveLargestWinnersOut(preds, k = 5) {
  const sorted = [...preds].filter((p) => isNum(p.outcome)).sort((a, b) => b.outcome - a.outcome);
  const trimmed = sorted.slice(k);
  return { droppedWinners: Math.min(k, sorted.length), ic: icOf(trimmed, 'residualScore').ic, avgOutcome: round(mean(trimmed.map((p) => p.outcome)), 3), n: trimmed.length };
}

// ---- trained shadow: ridge-fit feature weights (purged), compare OOS IC vs baseline --------
const FEAT_KEYS = require('./challenger-rank').FEATURES.map((f) => f.key);
function featRow(p) { return FEAT_KEYS.map((k) => (p.features && p.features[k] && isNum(p.features[k].norm) ? p.features[k].norm : 0.5)); }
// Ridge closed-form via Gaussian elimination on (XtX + lambda I) w = Xt y. Deterministic.
function ridgeFit(X, y, lambda) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += X[i][a] * X[i][c]; }
  for (let a = 0; a < p; a++) A[a][a] += lambda;
  // Gaussian elimination
  for (let col = 0; col < p; col++) {
    let piv = col; for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) continue;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < p; r++) { if (r === col) continue; const factor = A[r][col] / A[col][col]; for (let c = col; c < p; c++) A[r][c] -= factor * A[col][c]; b[r] -= factor * b[col]; }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) > 1e-12 ? v / A[i][i] : 0));
}
function trainedShadow(preds, { folds = 3, lambda = 1 } = {}) {
  const rows = preds.filter((p) => p.features && isNum(p.outcome) && p.predDate);
  const dates = [...new Set(rows.map((p) => p.predDate))].sort();
  if (dates.length < folds + 1 || rows.length < 40) return { ready: false, note: 'insufficient rows/dates for a purged fit' };
  const size = Math.floor(dates.length / (folds + 1));
  const testItems = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd = dates[(f + 1) * size - 1];
    const testStart = dates[(f + 1) * size];
    const testEnd = dates[Math.min((f + 2) * size - 1, dates.length - 1)];
    const train = rows.filter((p) => p.predDate <= trainEnd);
    const test = rows.filter((p) => p.predDate >= testStart && p.predDate <= testEnd);
    if (train.length < 20 || !test.length) continue;
    const w = ridgeFit(train.map(featRow), train.map((p) => p.outcome), lambda);
    for (const p of test) { const s = featRow(p).reduce((acc, x, i) => acc + x * w[i], 0); testItems.push({ score: s, outcome: p.outcome }); }
  }
  const trainedIC = RQ.informationCoefficient(testItems);
  const baselineIC = icOf(rows, 'residualScore');
  return { ready: true, lambda, trainedOOS_IC: trainedIC.ic, baselineOOS_IC: baselineIC.ic, beatsBaseline: isNum(trainedIC.ic) && isNum(baselineIC.ic) && trainedIC.ic > baselineIC.ic, n: testItems.length };
}

// ---- deflated Sharpe on the net-outcome series --------------------------------------------
function deflatedSharpeOf(preds, trials = 8) {
  const rets = preds.map((p) => p.outcome).filter(isNum);
  if (rets.length < 8) return { ready: false };
  const m = DSR.moments(rets);
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const psr = DSR.probabilisticSharpe(sr, m.n, m.skew, m.kurt, 0);
  const varSR = (1 / m.n) * (1 - m.skew * sr + ((m.kurt - 1) / 4) * sr * sr);
  const def = DSR.deflatedSharpe(sr, m.n, m.skew, m.kurt, trials, Math.max(varSR, 1e-6));
  return { ready: true, sr: round(sr, 3), psr: round(psr, 3), dsr: round(def.dsr, 3), n: m.n };
}

// ---- top-level evaluation -----------------------------------------------------------------
function evaluate(preds, opts = {}) {
  const rows = (preds || []).filter((p) => p && p.predDate);
  const rankItems = rows.filter((p) => isNum(p.residualScore) && isNum(p.outcome)).map((p) => ({ score: p.residualScore, outcome: p.outcome, won: p.won }));
  const outcomes = rows.map((p) => p.outcome).filter(isNum);
  return {
    version: EVAL_VERSION,
    generatedAt: opts.now || null,
    n: rows.length,
    rankQuality: RQ.analyzeRankQuality(rankItems, { minN: 20 }),
    ic: icOf(rows, 'residualScore'),
    netExpectancy: { avg: round(mean(outcomes), 3), median: round(median(outcomes), 3), ci: bootstrapMeanCI(outcomes) },
    calibration: RQ.calibration(rankItems.filter((i) => typeof i.won === 'boolean')),
    monotonicity: RQ.monotonicity(RQ.quantileStats(rankItems, rankItems.length >= 50 ? 10 : rankItems.length >= 30 ? 5 : 3)),
    walkForward: purgedWalkForward(rows, opts),
    byRegime: splitBy(rows, (p) => p.regimeLabel),
    byCapTier: splitBy(rows, (p) => p.capTier),
    byEvent: splitBy(rows, (p) => p.eventType),
    byHorizon: splitBy(rows, (p) => p.horizon),
    leaveOneYearOut: leaveOneYearOut(rows),
    leaveLargestWinnersOut: leaveLargestWinnersOut(rows, opts.dropWinners || 5),
    deflatedSharpe: deflatedSharpeOf(rows),
    trainedShadow: trainedShadow(rows, opts),
    baselines: {
      prod: icOf(rows, 'baselineProd'), omega: icOf(rows, 'baselineOmega'),
      momentum: icOf(rows, 'baselineMomentum'),
      random: icOf(rows.map((p, i) => ({ ...p, __rand: (i * 2654435761) % 1000 })), '__rand'),
    },
  };
}

// ---- promotion gate (never auto-promotes; reports readiness against strict criteria) -------
function promotionCheck(ev, live = {}) {
  const wf = ev.walkForward || {};
  const criteria = [
    ['several positive OOS blocks', (wf.positiveBlocks || 0) >= 3 && (wf.testedBlocks || 0) >= 3],
    ['positive mean OOS residual rank-IC', isNum(wf.meanOOS) && wf.meanOOS > 0],
    ['positive net expectancy after costs', isNum(ev.netExpectancy.avg) && ev.netExpectancy.avg > 0 && isNum(ev.netExpectancy.ci.lo) && ev.netExpectancy.ci.lo > 0],
    ['no catastrophic regime-specific failure', Object.values(ev.byRegime || {}).every((g) => !isNum(g.ic) || g.ic > -0.05)],
    ['monotone by challenger tier', !!(ev.monotonicity && ev.monotonicity.monotone)],
    ['adequate sample size', ev.n >= 60],
    ['positive live-forward shadow performance', isNum(live.liveIC) && live.liveIC > 0 && isNum(live.liveAvgOutcome) && live.liveAvgOutcome > 0],
    ['no material calibration deterioration', !!(ev.calibration && isNum(ev.calibration.brier) && ev.calibration.brier <= 0.30)],
    ['not driven by one year', isNum(ev.leaveOneYearOut && ev.leaveOneYearOut.worstAfterDrop && ev.leaveOneYearOut.worstAfterDrop.ic) && ev.leaveOneYearOut.worstAfterDrop.ic > 0],
    ['not driven by a few outliers', isNum(ev.leaveLargestWinnersOut && ev.leaveLargestWinnersOut.ic) && ev.leaveLargestWinnersOut.ic > 0],
  ].map(([name, pass]) => ({ name, pass: !!pass }));
  const passed = criteria.filter((c) => c.pass).length;
  return {
    version: EVAL_VERSION,
    promotable: criteria.every((c) => c.pass),
    passed,
    of: criteria.length,
    criteria,
    recommendedStatus: criteria.every((c) => c.pass) ? 'probation' : 'paper', // still never production on first pass
    note: 'Promotion is advisory only; the challenger stays paper/weight-0 until governance acts on a sustained live-forward record.',
  };
}

module.exports = {
  EVAL_VERSION,
  bootstrapMeanCI,
  purgedWalkForward,
  splitBy,
  leaveOneYearOut,
  leaveLargestWinnersOut,
  ridgeFit,
  trainedShadow,
  deflatedSharpeOf,
  evaluate,
  promotionCheck,
};
