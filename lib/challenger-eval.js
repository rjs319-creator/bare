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
const PBO = require('./research/pbo');

const EVAL_VERSION = 'challenger-eval-v1';

// ---- CSCV Probability of Backtest Overfitting (lib/research/pbo, previously orphaned) -----
// Was the challenger selected as "best variant" on evidence that generalizes, or was
// picking the in-sample winner mostly noise? Bailey, Borwein, López de Prado & Zhu (2014)
// read PBO ≥ 0.5 as "the in-sample winner ranks in the bottom half out-of-sample at least
// half the time" — i.e. selection is no better than a coin flip. pbo.js declares no
// threshold of its own, so the literature-standard 0.5 is the block line.
// DEMOTE-ONLY: a computable PBO at/above the line adds a FAILING promotion criterion; a
// low PBO adds a passing one, which can never flip `promotable` to true (it is the AND of
// all criteria); a PBO that cannot be computed leaves the gate byte-identical to the
// pre-wiring behavior and is stamped 'not-computable' — never claimed as passed.
const PBO_OVERFIT_THRESHOLD = 0.5;
// The variant columns every resolved record already carries (challenger score + logged
// baseline scores). A column must actually be LOGGED to count as a variant — baselineOmega
// is null on the live logging path — so columns below the coverage floor are dropped
// rather than being allowed to blank every matrix row via pbo()'s all-finite row filter.
const PBO_VARIANT_KEYS = ['residualScore', 'baselineProd', 'baselineOmega', 'baselineMomentum'];
const PBO_MIN_VARIANT_COVERAGE = 0.9;

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

// Date-clustered expectancy interval (QM-3): equal-weight same-date outcomes into one
// observation per prediction date, HAC/Newey-West SE with lags scaled to the LONGEST
// horizon present (conservative), CI widened by the moving-block bootstrap.
function clusteredExpectancyCI(rows, outcomes) {
  try {
    const ES = require('./evidence-stats');
    const withDates = rows.filter((p) => isNum(p.outcome) && p.predDate);
    const maxBars = Math.max(1, ...withDates.map((p) => horizonBars(p.horizon)));
    const ded = ES.dedupeToDateSeries(withDates, { pickValue: (p) => p.outcome, pickDate: (p) => p.predDate });
    const s = ES.summarizeDateSeries(ded.series, { horizonBars: maxBars });
    if (s && s.ci95 && isNum(s.ci95.lo) && isNum(s.ci95.hi)) {
      // FULL-PRECISION fields (audit 2026-08-14): `s.avg` is the 2dp DISPLAY value —
      // re-rounding it to 3dp manufactured false precision, and the promotion criterion
      // (ci.lo > 0) read an interval built from display fields. Prefer avgExact/seExact
      // (fall back to the rounded fields for summaries persisted before they existed),
      // and never let the bound come out NARROWER than the summary's widest-of interval.
      const avg = isNum(s.avgExact) ? s.avgExact : s.avg;
      const se = isNum(s.seExact) ? s.seExact : null;
      const tCrit = isNum(s.tCritical) ? s.tCritical : 1.96;
      const lo = se != null && se > 0 ? Math.min(s.ci95.lo, avg - tCrit * se) : s.ci95.lo;
      const hi = se != null && se > 0 ? Math.max(s.ci95.hi, avg + tCrit * se) : s.ci95.hi;
      return { mean: round(avg, 3), lo: round(lo, 3), hi: round(hi, 3), n: outcomes.length, dates: s.n, effectiveN: s.effectiveN ?? null, basis: 'date-clustered HAC + moving-block (widest wins)' };
    }
  } catch { /* fall through to the labeled IID fallback */ }
  return { ...bootstrapMeanCI(outcomes), basis: 'iid-bootstrap FALLBACK (date series too thin — interval likely too narrow)' };
}
function icOf(preds, scoreKey) {
  const items = preds.filter((p) => isNum(p[scoreKey]) && isNum(p.outcome)).map((p) => ({ score: p[scoreKey], outcome: p.outcome }));
  return RQ.informationCoefficient(items);
}

// ---- purged + embargoed walk-forward over distinct prediction dates -----------------------
function horizonBars(h) { return { intraday: 1, swing: 10, position: 40, portfolio: 63 }[h] || 10; }
const SESSIONS_TO_CALENDAR = 1.45; // ~7/4.83 — trading sessions to calendar days
function addDays(iso, days) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function purgedWalkForward(preds, { folds = 4, embargoDays = 3 } = {}) {
  const rows = preds.filter((p) => p.predDate && isNum(p.residualScore) && isNum(p.outcome));
  const dates = [...new Set(rows.map((p) => p.predDate))].sort();
  if (dates.length < folds + 1) return { ready: false, note: 'too few distinct dates', blocks: [] };
  const size = Math.floor(dates.length / (folds + 1));
  const blocks = [];
  for (let f = 0; f < folds; f++) {
    const boundary = dates[(f + 1) * size - 1];
    const testStart = dates[(f + 1) * size];
    const testEnd = dates[Math.min((f + 2) * size - 1, dates.length - 1)];
    // Embargo — now actually APPLIED (graduation-league QM-2: the parameter was
    // declared, echoed in the output, and never used). Test rows inside the embargo
    // window after the block boundary are excluded so residual serial correlation
    // across the boundary cannot leak into the block's IC.
    const embargoEnd = addDays(boundary, Math.max(0, embargoDays));
    const test = rows.filter((p) => p.predDate >= testStart && p.predDate <= testEnd && p.predDate > embargoEnd);
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
    // LABEL-END PURGE (graduation-league QM-2): a training row whose 10–40-session
    // outcome resolves inside the test block leaks test-period information into the
    // ridge fit. Each row is purged by its OWN horizon (sessions → calendar days).
    const train = rows.filter((p) => {
      const spanDays = Math.ceil(horizonBars(p.horizon) * SESSIONS_TO_CALENDAR);
      return p.predDate <= addDays(trainEnd, -spanDays);
    });
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
// `trials` was defaulted to a hardcoded 8 and the sole caller passed nothing, so the
// multiple-testing correction was applied against an invented number that bore no
// relation to how many variants had actually been evaluated. It is now REQUIRED: a caller
// must state its trial count, and a missing/invalid one fails closed to `ready:false`
// rather than silently deflating against a fiction. Supply the count from the append-only
// experiment ledger (research/experiments/registry.json variationsAttempted) or from the
// searched grid size — never a guess.
function deflatedSharpeOf(preds, trials) {
  if (!Number.isFinite(trials) || trials < 1) {
    return { ready: false, reason: 'trial-count-required', note: 'deflated Sharpe needs a stated number of attempted variants; a hardcoded default is not evidence' };
  }
  const rets = preds.map((p) => p.outcome).filter(isNum);
  if (rets.length < 8) return { ready: false };
  const m = DSR.moments(rets);
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const psr = DSR.probabilisticSharpe(sr, m.n, m.skew, m.kurt, 0);
  const varSR = (1 / m.n) * (1 - m.skew * sr + ((m.kurt - 1) / 4) * sr * sr);
  const def = DSR.deflatedSharpe(sr, m.n, m.skew, m.kurt, trials, Math.max(varSR, 1e-6));
  return { ready: true, sr: round(sr, 3), psr: round(psr, 3), dsr: round(def.dsr, 3), n: m.n };
}

// ---- CSCV PBO over the logged variant columns ---------------------------------------------
// Builds the dates × variants performance matrix pbo() needs from the resolved records in
// hand: one row per prediction date, one column per covered variant, each cell = that
// variant's Spearman rank-IC over that date's OWN cross-section (variant score vs realized
// outcome). Dates where any variant's IC is not computable (fewer than 3 picks, zero rank
// variance) get a non-finite cell, which pbo()'s all-finite row filter drops — fail closed,
// never a fabricated 0. Inputs are never fabricated: only columns the ledger actually
// carries (≥ coverage floor) participate.
function pboOverVariants(preds) {
  const rows = (preds || []).filter((p) => p && p.predDate && isNum(p.outcome));
  const covered = PBO_VARIANT_KEYS.filter((k) =>
    rows.length > 0 && rows.filter((p) => isNum(p[k])).length / rows.length >= PBO_MIN_VARIANT_COVERAGE);
  if (covered.length < 2) {
    return { version: PBO.PBO_VERSION, pbo: null, variantKeys: covered,
      reason: `need ≥2 variant score columns at ≥${PBO_MIN_VARIANT_COVERAGE * 100}% coverage (got ${covered.length})` };
  }
  const usable = rows.filter((p) => covered.every((k) => isNum(p[k])));
  const byDate = new Map();
  for (const p of usable) {
    if (!byDate.has(p.predDate)) byDate.set(p.predDate, []);
    byDate.get(p.predDate).push(p);
  }
  const matrix = [...byDate.keys()].sort().map((d) => covered.map((k) => {
    const ic = RQ.informationCoefficient(byDate.get(d).map((p) => ({ score: p[k], outcome: p.outcome }))).ic;
    return isNum(ic) ? ic : NaN;
  }));
  return {
    ...PBO.pbo(matrix),
    variantKeys: covered,
    measure: "per-date Spearman rank-IC of each variant's score over that date's own cross-section",
  };
}

// Self-describing gate stamp: { pbo, n, verdictInput: 'blocked'|'pass'|'not-computable' }.
// Anything without a finite pbo (including a pre-wiring cached evaluation that lacks the
// field entirely) is 'not-computable' — the gate stays unchanged AND the check is never
// claimed as passed.
function pboVerdictInput(p) {
  if (!p || !isNum(p.pbo)) {
    return {
      pbo: null,
      n: p && Number.isFinite(p.dates) ? p.dates : 0,
      verdictInput: 'not-computable',
      threshold: PBO_OVERFIT_THRESHOLD,
      note: `pbo: not computable (${(p && p.reason) || 'insufficient data'})`,
    };
  }
  return {
    pbo: p.pbo,
    n: p.dates,
    verdictInput: p.pbo >= PBO_OVERFIT_THRESHOLD ? 'blocked' : 'pass',
    threshold: PBO_OVERFIT_THRESHOLD,
    variantKeys: p.variantKeys || null,
  };
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
    // CI basis (graduation-league QM-3): the promotion criterion reads ci.lo, and an
    // IID resample over overlapping multi-session outcomes is too narrow — an error
    // that can only be permissive. Prefer the date-deduped HAC/moving-block interval
    // (widest-wins) from evidence-stats; the IID bootstrap remains only as a labeled
    // fallback when the date series is too thin to summarize.
    netExpectancy: { avg: round(mean(outcomes), 3), median: round(median(outcomes), 3), ci: clusteredExpectancyCI(rows, outcomes) },
    calibration: RQ.calibration(rankItems.filter((i) => typeof i.won === 'boolean')),
    monotonicity: RQ.monotonicity(RQ.quantileStats(rankItems, rankItems.length >= 50 ? 10 : rankItems.length >= 30 ? 5 : 3)),
    walkForward: purgedWalkForward(rows, opts),
    byRegime: splitBy(rows, (p) => p.regimeLabel),
    byCapTier: splitBy(rows, (p) => p.capTier),
    byEvent: splitBy(rows, (p) => p.eventType),
    byHorizon: splitBy(rows, (p) => p.horizon),
    leaveOneYearOut: leaveOneYearOut(rows),
    leaveLargestWinnersOut: leaveLargestWinnersOut(rows, opts.dropWinners || 5),
    // The trial count must be STATED by the caller (opts.trials) — e.g. from the
    // append-only experiment ledger's variationsAttempted. Absent, this reports
    // ready:false rather than deflating against an invented number, which is what the
    // previous hardcoded default did.
    deflatedSharpe: deflatedSharpeOf(rows, opts.trials),
    // CSCV PBO across the logged variant columns — computed here because this is the one
    // gate-time place the dates × variants inputs actually exist. Null (with the reason)
    // whenever the ledger cannot support it; promotionCheck treats that as not-computable.
    pbo: pboOverVariants(rows),
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
  // CSCV PBO — DEMOTE-ONLY. The criterion is appended ONLY when PBO is computable:
  // when it is not, the criteria list (and passed/of/promotable) is byte-identical to
  // the pre-wiring gate, and the stamp below says 'not-computable' — a missing
  // diagnostic can neither fail a strategy nor be claimed as a pass. When computable,
  // a passing row can never flip `promotable` to true (it is the AND of all criteria),
  // so low PBO never boosts; PBO ≥ PBO_OVERFIT_THRESHOLD blocks.
  const pboStamp = pboVerdictInput(ev.pbo);
  if (pboStamp.verdictInput !== 'not-computable') {
    criteria.push({ name: `variant selection survives CSCV (PBO < ${PBO_OVERFIT_THRESHOLD})`, pass: pboStamp.verdictInput === 'pass' });
  }
  const passed = criteria.filter((c) => c.pass).length;
  return {
    version: EVAL_VERSION,
    pbo: pboStamp,
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
  clusteredExpectancyCI,
  purgedWalkForward,
  splitBy,
  leaveOneYearOut,
  leaveLargestWinnersOut,
  ridgeFit,
  trainedShadow,
  deflatedSharpeOf,
  PBO_OVERFIT_THRESHOLD,
  pboOverVariants,
  pboVerdictInput,
  evaluate,
  promotionCheck,
};
