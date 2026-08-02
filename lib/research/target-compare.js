'use strict';
// 🎯 TARGET COMPARISON (research-target-compare-v1) — which LEARNING TARGET transfers?
//
// The target factory defines challenger labels; this module answers the question the
// factory deliberately left open: does training on rank-cost-residual (the declared
// preference) actually produce better out-of-sample rankings than training on the
// champion's raw/residual labels?
//
// EXPERIMENTAL DESIGN — one fixed evaluation, many training signals:
//   • every variant trains its OWN ridge model on its OWN label (train folds only);
//   • every trained model is evaluated on the SAME pre-declared economic metric —
//     daily cross-sectional rank-IC against the COST-ADJUSTED SECTOR-RESIDUAL
//     return (the money question) — on identical purged, embargoed folds.
// A variant can only win by making the model rank the economic outcome better,
// not by being easier to predict. Mixing those two up is the classic way a
// "better target" result lies.
//
// Built-in falsification: a `control-shuffled` variant (labels permuted within
// each decision date, deterministic seed). If IT wins, the whole comparison is
// noise and the verdict says so.
//
// Pure & deterministic. Fail-closed: below minimum dates/rows the verdict is
// INSUFFICIENT_DATA, never a winner.

const LP = require('./label-purge');
const { perDateIC, summarizeICs, lcg } = require('./harness');
const { ridgeRanker } = require('./baseline-ranker');

const TARGET_COMPARE_VERSION = 'research-target-compare-v1';
const EVAL_VARIANT = 'cost-adjusted-residual';       // pre-declared economic metric
const MIN_DATES = 8;
const MIN_ROWS = 150;
const SHUFFLE_SEED = 20260802;

const isFin = Number.isFinite;

// Deterministic within-date permutation of the evaluation label — the noise control.
function addShuffledControl(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.decisionTs)) byDate.set(r.decisionTs, []);
    byDate.get(r.decisionTs).push(r);
  }
  for (const [date, group] of byDate) {
    let seed = SHUFFLE_SEED;
    for (let i = 0; i < date.length; i++) seed = (Math.imul(seed, 31) + date.charCodeAt(i)) >>> 0;
    const rnd = lcg(seed);
    const vals = group.map(r => r.outcomes[EVAL_VARIANT]).filter(isFin);
    const shuffled = vals.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let k = 0;
    for (const r of group) r.outcomes['control-shuffled'] = isFin(r.outcomes[EVAL_VARIANT]) ? shuffled[k++] : null;
  }
  return rows;
}

/**
 * Compare training targets on identical purged folds.
 *
 * @param rows  [{securityId, ticker, decisionTs, labelEndDate, horizon,
 *               features:{k->num}, score, outcomes:{variant->num|null}}]
 *              — `outcomes` must include EVAL_VARIANT; other keys are candidate
 *              training targets.
 * @param opts  { folds=4, embargo=5, rankerOpts }
 */
function compareTargets(rows, opts = {}) {
  const folds = opts.folds || 4;
  const embargo = isFin(opts.embargo) ? opts.embargo : 5;
  const usable = (rows || []).filter(r => r && r.decisionTs && r.labelEndDate && r.outcomes && isFin(r.outcomes[EVAL_VARIANT]));
  addShuffledControl(usable);

  const variants = [...new Set(usable.flatMap(r => Object.keys(r.outcomes)))]
    .filter(v => usable.filter(r => isFin(r.outcomes[v])).length >= Math.min(50, usable.length / 2));

  const dates = [...new Set(usable.map(r => r.decisionTs))].sort();
  if (dates.length < MIN_DATES || usable.length < MIN_ROWS) {
    return {
      version: TARGET_COMPARE_VERSION, evaluationVariant: EVAL_VARIANT,
      verdict: 'INSUFFICIENT_DATA', rows: usable.length, distinctDates: dates.length,
      needed: { minDates: MIN_DATES, minRows: MIN_ROWS },
      perVariant: {}, baselines: {}, foldReport: [],
    };
  }

  const axis = LP.buildDateAxis(usable.map(r => r.decisionTs).concat(usable.map(r => r.labelEndDate)));
  const ordOf = new Map(dates.map((d, i) => [d, i]));
  const D = dates.length;

  // Baselines evaluated on the same economic metric, no training required.
  const baselineScorers = {
    'production-composite': row => (isFin(row.score) ? row.score : 0),
    'residual-momentum': row => (isFin(row.features && row.features.residMom21) ? row.features.residMom21 : 0),
  };

  const icsByName = new Map();
  const push = (name, ics) => {
    if (!icsByName.has(name)) icsByName.set(name, []);
    icsByName.get(name).push(...ics);
  };
  const foldReport = [];

  for (let f = 1; f < folds; f++) {
    const lo = Math.floor((D * f) / folds), hi = Math.floor((D * (f + 1)) / folds);
    const testStart = dates[lo];
    const testDates = new Set(dates.slice(lo, hi));
    // Evaluation rows: outcome = the COMMON economic label, whatever we trained on.
    const testRows = usable.filter(r => testDates.has(r.decisionTs))
      .map(r => ({ ...r, outcome: r.outcomes[EVAL_VARIANT] }));
    const past = usable.filter(r => ordOf.get(r.decisionTs) < lo);
    const train = LP.exactPurge(past.map(r => ({ ...r, outcome: r.outcomes[EVAL_VARIANT] })), axis, testStart, embargo);

    const foldRow = { fold: f, from: dates[lo], to: dates[hi - 1], pastN: past.length, trainN: train.length, testN: testRows.length, variants: {} };

    for (const v of variants) {
      // Train on the VARIANT's label — only rows where that label exists.
      const trainV = train.map(r => ({ ...r, outcome: r.outcomes[v] })).filter(r => isFin(r.outcome));
      const model = ridgeRanker.fit(trainV, opts.rankerOpts || {});
      const ics = perDateIC(testRows, row => ridgeRanker.score(model, row));
      push(v, ics);
      foldRow.variants[v] = { trainN: trainV.length, datedICs: ics.length, degenerate: !!(model && model.degenerate) };
    }
    for (const [name, scorer] of Object.entries(baselineScorers)) {
      push(name, perDateIC(testRows, scorer));
    }
    foldReport.push(foldRow);
  }

  const perVariant = {};
  for (const v of variants) perVariant[v] = summarizeICs(icsByName.get(v) || []);
  const baselines = {};
  for (const name of Object.keys(baselineScorers)) baselines[name] = summarizeICs(icsByName.get(name) || []);

  const trained = variants.filter(v => v !== 'control-shuffled' && perVariant[v] && perVariant[v].meanIC != null);
  const winner = trained.slice().sort((a, b) => perVariant[b].meanIC - perVariant[a].meanIC)[0] || null;
  const shuffledIC = perVariant['control-shuffled'] ? perVariant['control-shuffled'].meanIC : null;
  const winnerIC = winner ? perVariant[winner].meanIC : null;
  const champIC = baselines['production-composite'] ? baselines['production-composite'].meanIC : null;

  const noiseWins = winnerIC != null && shuffledIC != null && shuffledIC >= winnerIC;
  let verdict;
  if (noiseWins) {
    verdict = 'NOISE — the shuffled-label control matched or beat every real target; no target preference is supportable on this sample';
  } else if (winnerIC != null && champIC != null && winnerIC > champIC && perVariant[winner].significant) {
    verdict = `PROVISIONAL — training on '${winner}' beats the production composite OOS (survivorship-unsafe data; not a promotion)`;
  } else if (winnerIC != null && champIC != null && winnerIC > champIC) {
    verdict = `WEAK-PROVISIONAL — '${winner}' nominally best but not statistically significant; keep accruing`;
  } else {
    verdict = 'CHAMPION-NOT-BEATEN — no trained target variant improves on the production composite OOS';
  }

  return {
    version: TARGET_COMPARE_VERSION,
    evaluationVariant: EVAL_VARIANT,
    folds, embargo,
    rows: usable.length, distinctDates: D,
    variants, perVariant, baselines,
    winner, winnerIC, shuffledIC, championIC: champIC,
    preferredTargetConfirmed: winner === 'rank-cost-residual' && !noiseWins,
    foldReport,
    verdict,
    honesty: 'All variants train on their own label but are scored on ONE pre-declared economic metric (cost-adjusted sector-residual rank-IC) on identical purged folds. Survivorship-unsafe; a winner here re-declares the training target for future challengers, it promotes nothing.',
  };
}

module.exports = { TARGET_COMPARE_VERSION, EVAL_VARIANT, MIN_DATES, MIN_ROWS, compareTargets, addShuffledControl };
