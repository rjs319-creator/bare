'use strict';
// OMEGA_SI_LEVEL_5D_TOP10 — the pure experiment engine. Given reconstructed OMEGA panels
// (already PIT-joined to FINRA short interest), runs the three matched arms through an
// expanding purged walk-forward, computes the frozen statistics, and returns honest
// verdicts. No I/O, no network, no clock — everything deterministic under fixed seeds,
// so every path is testable and a resume reproduces byte-identically.
//
// ARMS (identical dates, universe, labels, costs, exclusions):
//   A  fixed OMEGA        — rank by the production OMEGA score, no training.
//   B  trained baseline   — ridge (alpha=25, frozen) on the existing OMEGA features
//                           + regime and sector controls. Median imputation, missingness
//                           indicators, standardization — all fitted on the training fold.
//   C  baseline + SI      — exactly B plus the frozen short-interest level features
//                           (si-features.js). Nothing else. No threshold search.
//
// The experiment NEVER touches live OMEGA scoring, ranking, alerts or portfolios.

const STATS = require('./stats-v3');
const { BASELINE_FEATURES, SI_FEATURES } = require('./si-features');

const SI_EXPERIMENT_VERSION = 'si-overlay-v1';
const EXPERIMENT_ID = 'OMEGA_SI_LEVEL_5D_TOP10';

const FROZEN = Object.freeze({
  horizonSessions: 5,
  topK: 10,
  ridgeAlpha: 25,
  testFolds: 4,              // expanding: train seg 1..k, test seg k+1, k = 1..4 (5 segments)
  purgeCohorts: 2,           // >= adjacent cohort; 2 cohorts x 5-session step = 10 sessions > 5-session label
  bootstrap: { B: 5000, blockLen: 4, seed: 20260813 },   // block length: 4 cohorts (minimum allowed)
  costRoundTripPct: 0.16,    // liquid tier, lib/costs cost-v3
  lagDaysPrimary: 13,
  lagDaysStale: 16,
  annualizeCohorts: Math.sqrt(50.4),   // step-5 cohorts/year, for the Sharpe-like stat only
  minOosDates: 40, minCoverage: 0.60, minUsableFolds: 2,   // INSUFFICIENT_DATA gates
  shadowMinOosDates: 100, shadowMinPositiveFolds: 3, shadowMaxQ: 0.10,   // SHADOW_CANDIDATE gates
});

const VERDICTS = Object.freeze(['INSUFFICIENT_DATA', 'NO_INCREMENTAL_ALPHA', 'SHADOW_CANDIDATE', 'PROMOTION_REVIEW_REQUIRED']);

const mean = (a) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
};

// ── Preprocessing (train-fold only) ─────────────────────────────────────────
// Median imputer + missingness indicators + standardizer, ALL fitted on training rows.
// Indicator columns exist only for features with observed training missingness.
function fitPreprocessor(trainRows, featureKeys) {
  const medians = {}, missingKeys = [];
  for (const k of featureKeys) {
    const vals = trainRows.map((r) => r[k]).filter(Number.isFinite);
    medians[k] = vals.length ? median(vals) : 0;
    if (vals.length < trainRows.length) missingKeys.push(k);
  }
  const impute = (row) => {
    const out = [];
    for (const k of featureKeys) out.push(Number.isFinite(row[k]) ? row[k] : medians[k]);
    for (const k of missingKeys) out.push(Number.isFinite(row[k]) ? 0 : 1);
    return out;
  };
  const X = trainRows.map(impute);
  const p = featureKeys.length + missingKeys.length;
  const means = new Array(p).fill(0), sds = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const col = X.map((r) => r[j]);
    means[j] = mean(col) ?? 0;
    const s = sd(col);
    sds[j] = Number.isFinite(s) && s > 0 ? s : 1;
  }
  return { featureKeys: [...featureKeys], missingKeys, medians, means, sds };
}

function designVector(row, prep) {
  const raw = [];
  for (const k of prep.featureKeys) raw.push(Number.isFinite(row[k]) ? row[k] : prep.medians[k]);
  for (const k of prep.missingKeys) raw.push(Number.isFinite(row[k]) ? 0 : 1);
  return raw.map((v, j) => (v - prep.means[j]) / prep.sds[j]);
}

// ── Ridge (closed-form, no hyperparameter search) ───────────────────────────
function ridgeFit(X, y, alpha) {
  const n = X.length, p = n ? X[0].length : 0;
  if (!n || !p) return null;
  const yBar = mean(y);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i], yi = y[i] - yBar;
    for (let j = 0; j < p; j++) {
      b[j] += xi[j] * yi;
      for (let k = j; k < p; k++) A[j][k] += xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) A[j][k] = A[k][j]; A[j][j] += alpha; }
  const w = solve(A, b);
  return w ? { weights: w, intercept: yBar } : null;
}

function solve(A, b) {
  const p = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[p] / row[i]);
}

const ridgePredict = (model, x) => model.intercept + x.reduce((a, v, j) => a + v * model.weights[j], 0);

// ── Walk-forward folds (expanding, purged, chronological — never shuffled) ──
function foldsOf(dates, { testFolds = FROZEN.testFolds, purgeCohorts = FROZEN.purgeCohorts } = {}) {
  const n = dates.length;
  const segments = testFolds + 1;
  if (n < segments * 2) return [];
  const bounds = Array.from({ length: segments + 1 }, (_, i) => Math.round((i * n) / segments));
  const folds = [];
  for (let k = 1; k <= testFolds; k++) {
    const testStart = bounds[k], testEnd = bounds[k + 1];
    const trainEnd = Math.max(0, testStart - purgeCohorts);   // purge the cohorts adjacent to the boundary
    folds.push({
      fold: k,
      trainDates: dates.slice(0, trainEnd),
      purgedDates: dates.slice(trainEnd, testStart),
      testDates: dates.slice(testStart, testEnd),
    });
  }
  return folds;
}

// ── Portfolio mechanics ─────────────────────────────────────────────────────
// Ranking must be deterministic under score ties → tiebreak on ticker.
function topK(rows, scoreOf, k) {
  return rows
    .map((r) => ({ r, s: scoreOf(r) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => (b.s - a.s) || a.r.ticker.localeCompare(b.r.ticker))
    .slice(0, k)
    .map((x) => x.r);
}

function rankMap(rows, scoreOf) {
  const sorted = rows
    .map((r) => ({ t: r.ticker, s: scoreOf(r) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => (b.s - a.s) || a.t.localeCompare(b.t));
  const m = new Map();
  sorted.forEach((x, i) => m.set(x.t, i + 1));
  return m;
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(n);
    idx.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  if (xs.every((v) => v === xs[0])) return null;
  const rx = rank(xs), ry = rank(ys), mr = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mr, b = ry[i] - mr; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

// ── Statistics on a per-date series ─────────────────────────────────────────
function pairedT(diffs) {
  const n = diffs.length;
  if (n < 3) return { t: null, pOneSided: null, pTwoSided: null, n };
  const m = mean(diffs), s = sd(diffs);
  if (!Number.isFinite(s) || s === 0) return { t: null, pOneSided: null, pTwoSided: null, n };
  const t = m / (s / Math.sqrt(n));
  const pTwo = STATS.pFromT(t);   // normal approximation, same convention as stats-v3
  const pOne = t > 0 ? pTwo / 2 : 1 - pTwo / 2;
  return { t: +t.toFixed(4), pOneSided: +pOne.toFixed(6), pTwoSided: +pTwo.toFixed(6), n };
}

// Seeded moving-block bootstrap of the mean, 95% percentile interval. Implemented here
// (stats-v3's version only reports a 90% interval) with the kit's own LCG so the draw
// sequence — and therefore the CI — is byte-identical across runs.
function bootstrapCI(series, { B, blockLen, seed } = FROZEN.bootstrap) {
  const xs = series.filter(Number.isFinite);
  const n = xs.length;
  if (n < blockLen + 4) return null;
  const nBlocks = n - blockLen + 1;
  const rnd = STATS.lcg(seed);
  const stats = new Array(B);
  for (let b = 0; b < B; b++) {
    let sum = 0, count = 0;
    while (count < n) {
      const start = Math.floor(rnd() * nBlocks);
      for (let j = 0; j < blockLen && count < n; j++, count++) sum += xs[start + j];
    }
    stats[b] = sum / n;
  }
  stats.sort((a, b) => a - b);
  const q = (f) => stats[Math.min(B - 1, Math.floor(f * B))];
  return { lo: +q(0.025).toFixed(4), hi: +q(0.975).toFixed(4), B, blockLen, seed };
}

function maxDrawdown(series) {
  let cum = 0, peak = 0, mdd = 0;
  for (const v of series) { cum += v; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
  return +mdd.toFixed(4);
}

function armStats(perDate, key) {
  const rets = perDate.map((d) => d[key]).filter(Number.isFinite);
  if (!rets.length) return null;
  const m = mean(rets), s = sd(rets);
  return {
    dates: rets.length,
    meanPct: +m.toFixed(4),
    medianPct: +median(rets).toFixed(4),
    winRate: +(rets.filter((v) => v > 0).length / rets.length).toFixed(4),
    sharpeLike: Number.isFinite(s) && s > 0 ? +((m / s) * FROZEN.annualizeCohorts).toFixed(3) : null,
  };
}

// ── The walk-forward run for one specification ──────────────────────────────
// panels: [{ date, regime:{riskOn,bearish}, rows:[{ticker, sector, <BASELINE fields>,
//           si features already attached, net: {5: pct|null, 10: pct|null}, dtc}] }]
// A row enters a spec's panel only with a resolved label at that spec's horizon —
// identically for all three arms (identical missing-label exclusions).
function runSpec(panels, { topK: K = FROZEN.topK, horizon = FROZEN.horizonSessions, label = 'primary', sectors = null } = {}) {
  const usable = panels
    .map((p) => ({ ...p, rows: p.rows.filter((r) => Number.isFinite(r.net && r.net[horizon])) }))
    .filter((p) => p.rows.length >= K * 2);   // need a real cross-section to rank
  const dates = usable.map((p) => p.date);
  const byDate = new Map(usable.map((p) => [p.date, p]));
  const folds = foldsOf(dates);

  const sectorKeys = sectors || [...new Set(usable.flatMap((p) => p.rows.map((r) => r.sector).filter(Boolean)))].sort();
  const withControls = (p) => p.rows.map((r) => {
    const out = { ...r, regRiskOn: p.regime && p.regime.riskOn ? 1 : 0, regBearish: p.regime && p.regime.bearish ? 1 : 0 };
    for (const s of sectorKeys) out[`sec_${s}`] = r.sector === s ? 1 : 0;
    return out;
  });
  const baseKeys = [...BASELINE_FEATURES, ...sectorKeys.map((s) => `sec_${s}`)];
  const augKeys = [...baseKeys, ...SI_FEATURES];
  const target = (r) => r.net[horizon];

  const perDate = [];
  const ledger = [];
  const foldReports = [];
  for (const fold of folds) {
    const trainRows = fold.trainDates.flatMap((d) => withControls(byDate.get(d)));
    if (trainRows.length < 50) { foldReports.push({ fold: fold.fold, usable: false, reason: `train rows ${trainRows.length} < 50` }); continue; }
    const prepB = fitPreprocessor(trainRows, baseKeys);
    const prepC = fitPreprocessor(trainRows, augKeys);
    const y = trainRows.map(target);
    const modelB = ridgeFit(trainRows.map((r) => designVector(r, prepB)), y, FROZEN.ridgeAlpha);
    const modelC = ridgeFit(trainRows.map((r) => designVector(r, prepC)), y, FROZEN.ridgeAlpha);
    if (!modelB || !modelC) { foldReports.push({ fold: fold.fold, usable: false, reason: 'ridge solve failed' }); continue; }
    const foldDates = [];
    for (const D of fold.testDates) {
      const p = byDate.get(D);
      const rows = withControls(p);
      const scoreA = (r) => r.score;
      const scoreB = (r) => ridgePredict(modelB, designVector(r, prepB));
      const scoreC = (r) => ridgePredict(modelC, designVector(r, prepC));
      const pickA = topK(rows, scoreA, K), pickB = topK(rows, scoreB, K), pickC = topK(rows, scoreC, K);
      // net is already in percent; an empty pick list is a null return, never a fake 0.
      const ret = (picks) => (picks.length ? mean(picks.map(target)) : null);
      const rA = ret(pickA), rB = ret(pickB), rC = ret(pickC);
      if (![rA, rB, rC].every(Number.isFinite)) continue;   // a date is OOS only when every arm resolves
      const setB = new Set(pickB.map((r) => r.ticker)), setC = new Set(pickC.map((r) => r.ticker));
      const added = pickC.filter((r) => !setB.has(r.ticker));
      const removed = pickB.filter((r) => !setC.has(r.ticker));
      const icOf = (score) => {
        const xs = [], ys = [];
        for (const r of rows) { const s = score(r), t = target(r); if (Number.isFinite(s) && Number.isFinite(t)) { xs.push(s); ys.push(t); } }
        return spearman(xs, ys);
      };
      perDate.push({
        date: D, fold: fold.fold, names: rows.length,
        retA: rA, retB: rB, retC: rC, incr: rC - rB,
        overlap: pickB.filter((r) => setC.has(r.ticker)).length / K,
        turnover: added.length / K,
        addedDtc: added.length ? +mean(added.map((r) => r.dtc).filter(Number.isFinite))?.toFixed(3) ?? null : null,
        removedDtc: removed.length ? +mean(removed.map((r) => r.dtc).filter(Number.isFinite))?.toFixed(3) ?? null : null,
        crowdedShareB: mean(pickB.map((r) => (r.siCrowded7 === 1 ? 1 : 0))),
        crowdedShareC: mean(pickC.map((r) => (r.siCrowded7 === 1 ? 1 : 0))),
        icA: icOf(scoreA), icB: icOf(scoreB), icC: icOf(scoreC),
        siCoverage: rows.length ? rows.filter((r) => r.si).length / rows.length : 0,
      });
      foldDates.push(D);
      const ranksB = rankMap(rows, scoreB), ranksC = rankMap(rows, scoreC);
      for (const r of rows) {
        if (!setB.has(r.ticker) && !setC.has(r.ticker)) continue;   // ledger stores selections, not the whole tape
        const ex = r.exec5 || {};
        ledger.push({
          decisionDate: D, decisionTime: `${D} session close (US/Eastern)`, lastBarDate: r.lastBarDate ?? null,
          fold: fold.fold, ticker: r.ticker,
          entryDate: ex.entryDate ?? null, entryOpen: ex.entryOpen ?? null,
          exitDate: ex.exitDate ?? null, exitClose: ex.exitClose ?? null,
          rawReturn: ex.rawReturn ?? null, benchmarkReturn: ex.benchmarkReturn ?? null,
          residualReturn: Number.isFinite(ex.rawReturn) && Number.isFinite(ex.benchmarkReturn) ? +(ex.rawReturn - ex.benchmarkReturn).toFixed(4) : null,
          cost: ex.cost ?? null,
          outcomeStatus: Number.isFinite(r.net && r.net[5]) ? 'RESOLVED_RETROSPECTIVE' : 'UNRESOLVED',
          baselineRank: ranksB.get(r.ticker) ?? null, augmentedRank: ranksC.get(r.ticker) ?? null,
          baselineSelected: setB.has(r.ticker), augmentedSelected: setC.has(r.ticker),
          omegaScore: r.score, r10: r.r10,
          siSettlementDate: r.si ? r.si.settlementDate : null,
          siPublicationDate: r.si ? r.si.publicationDate : null,
          siAvailableAt: r.si ? r.si.availableAt : null,
          siFetchedAt: r.si ? r.si.fetchedAt : null,
          siLogDtc: r.siLogDtc, siCrowded7: r.siCrowded7,
          revisionFlag: r.si ? r.si.revisionFlag : null,
          revisionRisk: r.si ? !!r.si.revisionRisk : null,
          sourceHash: r.si ? r.si.sourceHash : null,
          netResidualReturn: target(r),
        });
      }
    }
    const foldIncr = perDate.filter((d) => d.fold === fold.fold).map((d) => d.incr);
    foldReports.push({
      fold: fold.fold, usable: true,
      trainDates: { n: fold.trainDates.length, first: fold.trainDates[0], last: fold.trainDates[fold.trainDates.length - 1] },
      purgedDates: fold.purgedDates.length,
      testDates: { n: foldDates.length, first: foldDates[0], last: foldDates[foldDates.length - 1] },
      incrementalMeanPct: foldIncr.length ? +mean(foldIncr).toFixed(4) : null,
    });
  }

  const incr = perDate.map((d) => d.incr).filter(Number.isFinite);
  const usableFolds = foldReports.filter((f) => f.usable);
  const positiveFolds = usableFolds.filter((f) => Number.isFinite(f.incrementalMeanPct) && f.incrementalMeanPct > 0).length;
  const t = pairedT(incr);
  const summary = {
    label, horizon, topK: K,
    joinedRows: usable.reduce((a, p) => a + p.rows.length, 0),
    tickers: new Set(usable.flatMap((p) => p.rows.map((r) => r.ticker))).size,
    candidateDates: panels.length,
    oosDates: perDate.length,
    siCoverage: perDate.length ? +mean(perDate.map((d) => d.siCoverage)).toFixed(4) : 0,
    arms: { A: armStats(perDate, 'retA'), B: armStats(perDate, 'retB'), C: armStats(perDate, 'retC') },
    meanIC: {
      A: +(mean(perDate.map((d) => d.icA).filter(Number.isFinite)) ?? 0).toFixed(4),
      B: +(mean(perDate.map((d) => d.icB).filter(Number.isFinite)) ?? 0).toFixed(4),
      C: +(mean(perDate.map((d) => d.icC).filter(Number.isFinite)) ?? 0).toFixed(4),
    },
    incremental: incr.length ? {
      meanPct: +mean(incr).toFixed(4),
      medianPct: +median(incr).toFixed(4),
      winRate: +(incr.filter((v) => v > 0).length / incr.length).toFixed(4),
      tTest: t,
      bootstrap: bootstrapCI(incr),
      maxDrawdownPct: maxDrawdown(incr),
    } : null,
    portfolio: {
      meanOverlap: perDate.length ? +mean(perDate.map((d) => d.overlap)).toFixed(4) : null,
      meanTurnover: perDate.length ? +mean(perDate.map((d) => d.turnover)).toFixed(4) : null,
      meanAddedDtc: +(mean(perDate.map((d) => d.addedDtc).filter(Number.isFinite)) ?? 0).toFixed(3),
      meanRemovedDtc: +(mean(perDate.map((d) => d.removedDtc).filter(Number.isFinite)) ?? 0).toFixed(3),
      crowdedShareB: +(mean(perDate.map((d) => d.crowdedShareB).filter(Number.isFinite)) ?? 0).toFixed(4),
      crowdedShareC: +(mean(perDate.map((d) => d.crowdedShareC).filter(Number.isFinite)) ?? 0).toFixed(4),
    },
    folds: foldReports, usableFolds: usableFolds.length, positiveFolds,
  };
  return { summary, perDate, ledger, sectorKeys };
}

// ── Verdicts ────────────────────────────────────────────────────────────────
// An empty or broken run must surface as INSUFFICIENT_DATA — it can never print a
// negative-alpha (or any other substantive) verdict.
function assessInsufficient({ panelCount, resolvedOutcomes, summary, missingLastBarDate }) {
  const reasons = [];
  if (missingLastBarDate) reasons.push('missing lastBarDate on reconstructed cohorts');
  if (!panelCount) reasons.push('zero reconstructed panels');
  if (!resolvedOutcomes) reasons.push('zero resolved outcomes');
  if (!summary || !summary.oosDates) reasons.push('zero OOS portfolio dates');
  else {
    if (summary.oosDates < FROZEN.minOosDates) reasons.push(`OOS dates ${summary.oosDates} < ${FROZEN.minOosDates}`);
    if (summary.siCoverage < FROZEN.minCoverage) reasons.push(`SI factor coverage ${summary.siCoverage} < ${FROZEN.minCoverage}`);
    if (summary.usableFolds < FROZEN.minUsableFolds) reasons.push(`usable folds ${summary.usableFolds} < ${FROZEN.minUsableFolds}`);
  }
  return reasons;
}

// Retrospective SHADOW_CANDIDATE gates. Meeting them does NOT authorize live promotion —
// PROMOTION_REVIEW_REQUIRED additionally needs the separate prospective frozen ledger.
function assessRetrospective({ summary, staleSummary, exRevisedSummary, fdrQ }) {
  const inc = summary && summary.incremental;
  const reasons = [];
  if (!inc) return { verdict: 'NO_INCREMENTAL_ALPHA', reasons: ['no incremental series'] };
  if (summary.oosDates < FROZEN.shadowMinOosDates) reasons.push(`OOS dates ${summary.oosDates} < ${FROZEN.shadowMinOosDates}`);
  if (!(inc.meanPct > 0)) reasons.push(`incremental mean ${inc.meanPct} not positive`);
  if (!inc.bootstrap || !(inc.bootstrap.lo > 0)) reasons.push('bootstrap 95% interval not entirely above zero');
  if (summary.positiveFolds < FROZEN.shadowMinPositiveFolds) reasons.push(`positive folds ${summary.positiveFolds} < ${FROZEN.shadowMinPositiveFolds}`);
  const staleInc = staleSummary && staleSummary.incremental;
  if (!staleInc || !(staleInc.meanPct > 0)) reasons.push('sign reversal (or missing result) under the 16-day availability delay');
  const exInc = exRevisedSummary && exRevisedSummary.incremental;
  if (!exInc || !(exInc.meanPct > 0.5 * inc.meanPct)) reasons.push('material collapse after excluding revised records');
  if (!(Number.isFinite(fdrQ) && fdrQ <= FROZEN.shadowMaxQ)) reasons.push(`FDR q ${fdrQ} > ${FROZEN.shadowMaxQ}`);
  return reasons.length ? { verdict: 'NO_INCREMENTAL_ALPHA', reasons } : { verdict: 'SHADOW_CANDIDATE', reasons: [] };
}

module.exports = {
  SI_EXPERIMENT_VERSION, EXPERIMENT_ID, FROZEN, VERDICTS,
  mean, median, sd,
  fitPreprocessor, designVector, ridgeFit, ridgePredict, solve,
  foldsOf, topK, rankMap, spearman, pairedT, bootstrapCI, maxDrawdown,
  runSpec, assessInsufficient, assessRetrospective,
};
