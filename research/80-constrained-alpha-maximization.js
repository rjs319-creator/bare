'use strict';

// Constrained alpha maximization around the surviving residual-momentum signal.
// The search is deliberately small, positive-weight-only and momentum-anchored.
// Feature engineering was informed by earlier experiments, so even the final
// internal holdout is diagnostic rather than a genuinely untouched confirmation.

const path = require('node:path');
const K = require('./lib/experiment-kit');
const O = require('../lib/research/constrained-alpha-optimizer');
const { pbo } = require('../lib/research/pbo');
const { buildPanels } = require('./79-hedge-fund-swing-formula');

const ID = 'constrained-alpha-maximization-2026-08';
const VERSION = 'constrained-alpha-max-v1';
const H = 21;
const TOP_K = 10;
const VARIANTS = 32;
const MOMENTUM_FLOOR = .65;
const SEED = 20260812;
const HOLDOUT_DATES = 16;
const BASELINE = O.normalizeWeights({ momentum: 1 }, { momentumFloor: MOMENTUM_FLOOR });

function preparePanels(panels) {
  for (const p of panels) for (const r of p.rows) {
    r.optFeatures = {
      momentum: r.marketResidualRank,
      entry: r.entryRawRank,
      fundamental: r.fundamentalRawRank,
      lowDownside: 1 - r.downsideRawRank,
      lowExtension: 1 - r.extensionRawRank,
      lowCost: 1 - r.costRawRank,
    };
  }
  return panels;
}

function exactPurgedTrain(panels, testStartDate) {
  return panels.filter(p => p.date < testStartDate && p.labelEndDate && p.labelEndDate < testStartDate);
}

function series(panels, weights, outcome = 'netBase') {
  return panels.map(p => ({ date: p.date, value: O.topKReturn(p, weights, { topK: TOP_K, outcome }) }))
    .filter(x => Number.isFinite(x.value));
}

function summarize(panels, weights, outcome = 'netBase') {
  return K.summarizeByDate(series(panels, weights, outcome), { horizonBars: H });
}

function liftSummary(panels, challenger, control, outcome = 'netBase') {
  const a = new Map(series(panels, challenger, outcome).map(x => [x.date, x.value]));
  return K.summarizeByDate(series(panels, control, outcome).map(x => ({
    date: x.date,
    value: a.has(x.date) ? a.get(x.date) - x.value : null,
  })).filter(x => Number.isFinite(x.value)), { horizonBars: H });
}

function testMetrics(panels, weights) {
  const base = summarize(panels, weights, 'netBase');
  const doubled = summarize(panels, weights, 'netDoubled');
  const baseline = summarize(panels, BASELINE, 'netBase');
  const lift = liftSummary(panels, weights, BASELINE, 'netBase');
  const ic = panels.map(p => O.rankIC(p, weights)).filter(Number.isFinite);
  return { base, doubledCost: doubled, baseline, liftVsResidualMomentum: lift,
    rankIC: ic.length ? +O.mean(ic).toFixed(5) : null, rankICDates: ic.length };
}

async function main() {
  const t0 = Date.now();
  const built = await buildPanels();
  const panels = preparePanels(built.panels);
  if (panels.length <= HOLDOUT_DATES + 30) throw new Error(`only ${panels.length} dates; insufficient for constrained walk-forward`);
  const holdoutStart = panels.length - HOLDOUT_DATES;
  const development = panels.slice(0, holdoutStart);
  const holdout = panels.slice(holdoutStart);

  // Three expanding, chronologically later development folds. Every training
  // label must have ended before its test block begins.
  const boundaries = [40, 49, 57, development.length];
  const folds = [];
  const oosRows = [], oosBaselineRows = [];
  const selectionCounts = new Map();
  for (let f = 0; f < boundaries.length - 1; f++) {
    const test = development.slice(boundaries[f], boundaries[f + 1]);
    if (!test.length) continue;
    const train = exactPurgedTrain(development.slice(0, boundaries[f]), test[0].date);
    if (train.length < 12) continue;
    const fit = O.fitRandomSearch(train, { variants: VARIANTS, seed: SEED,
      momentumFloor: MOMENTUM_FLOOR, baselineWeights: BASELINE, topK: TOP_K });
    selectionCounts.set(fit.best.variant, (selectionCounts.get(fit.best.variant) || 0) + 1);
    const testResult = testMetrics(test, fit.best.weights);
    oosRows.push(...series(test, fit.best.weights));
    oosBaselineRows.push(...series(test, BASELINE));
    folds.push({
      fold: f + 1,
      trainRange: [train[0].date, train.at(-1).date],
      testRange: [test[0].date, test.at(-1).date],
      trainDates: train.length,
      purgedDates: boundaries[f] - train.length,
      testDates: test.length,
      selectedVariant: fit.best.variant,
      weights: fit.best.weights,
      trainMetrics: fit.best.metrics,
      test: testResult,
    });
  }

  const oosByDate = new Map(oosRows.map(x => [x.date, x.value]));
  const developmentWalkForward = {
    optimized: K.summarizeByDate(oosRows, { horizonBars: H }),
    baseline: K.summarizeByDate(oosBaselineRows, { horizonBars: H }),
    lift: K.summarizeByDate(oosBaselineRows.map(x => ({ date: x.date,
      value: oosByDate.has(x.date) ? oosByDate.get(x.date) - x.value : null }))
      .filter(x => Number.isFinite(x.value)), { horizonBars: H }),
  };

  // Final internal holdout: select once using only labels that ended before the
  // holdout began, then lock that formula for all sixteen later dates.
  const finalTrain = exactPurgedTrain(development, holdout[0].date);
  const finalFit = O.fitRandomSearch(finalTrain, { variants: VARIANTS, seed: SEED,
    momentumFloor: MOMENTUM_FLOOR, baselineWeights: BASELINE, topK: TOP_K });
  const holdoutResult = testMetrics(holdout, finalFit.best.weights);

  // Search-overfit diagnostic on development only. This does not bless a winner;
  // it estimates how often selecting the in-sample winner selects an OOS loser.
  const family = finalFit.variants;
  const pboMatrix = development.map(panel => family.map(w => O.topKReturn(panel, w, { topK: TOP_K })));
  const pboResult = pbo(pboMatrix);

  const holdoutLift = holdoutResult.liftVsResidualMomentum;
  const verdict = holdoutLift && holdoutLift.ci95.lo > 0 && holdoutLift.positiveBlocks >= 3
    ? 'PROMISING_INTERNAL_HOLDOUT_NOT_FRESH_CONFIRMATION'
    : 'NO_CONFIRMED_INCREMENTAL_ALPHA';
  const result = {
    studyId: ID,
    version: VERSION,
    contract: {
      search: 'fixed-seed random search over nonnegative rank weights',
      features: O.FIELDS,
      explicitlyExcluded: ['news (two prior no-lift diagnostics)', 'sector neutralization (reduced the corrected baseline)',
        'hard vetoes (reduced full-sample performance)', 'analyst revisions (PIT_UNPROVEN)'],
      variants: VARIANTS,
      momentumWeightFloor: MOMENTUM_FLOOR,
      objective: 'training paired top-10 lift + 5×rank-IC − 0.05×cross-date return volatility',
      execution: 'next-session open; 21 sessions; base and doubled trading costs; excess versus SPY',
      validation: 'three expanding development folds plus one locked final 16-date holdout; exact label-end purge at every boundary',
      noRetuningAfterHoldout: true,
    },
    data: {
      first: panels[0].date,
      last: panels.at(-1).date,
      dates: panels.length,
      candidates: panels.reduce((s, p) => s + p.rows.length, 0),
      development: { first: development[0].date, last: development.at(-1).date, dates: development.length },
      internalHoldout: { first: holdout[0].date, last: holdout.at(-1).date, dates: holdout.length },
      finalPurgedTrainDates: finalTrain.length,
    },
    baselineWeights: BASELINE,
    folds,
    developmentWalkForward,
    selectionStability: [...selectionCounts.entries()].sort((a, b) => b[1] - a[1]).map(([variant, count]) => ({ variant, count })),
    finalLocked: { variant: finalFit.best.variant, weights: finalFit.best.weights, trainMetrics: finalFit.best.metrics },
    internalHoldout: holdoutResult,
    pbo: pboResult,
    verdict,
    promotable: false,
    limitations: [
      'All feature families and the event-conditioned universe were informed by prior experiments; the final block is untouched by this optimizer, not by the research program.',
      'Only 81 dates exist and 21-session outcomes overlap; effective sample sizes are much smaller than raw date counts.',
      'The gap/news event universe is not a broad all-stock portfolio and can make absolute excess returns look unusually large.',
      'The price cache is survivorship-reduced rather than survivorship-proven-safe.',
      'Sector labels are current rather than point-in-time, though sector features are excluded from this optimizer.',
    ],
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - t0,
  };
  const artifact = K.writeArtifact(path.join(K.DATA_DIR, 'constrained-alpha-maximization'), 'result.json', result);
  K.recordExperiment({
    id: ID,
    hypothesis: 'A constrained, momentum-anchored combination of entry quality, filed fundamental acceleration and soft risk controls can improve cost-net top-10 excess over residual momentum on purged later dates.',
    family: 'swing-ranking',
    frozenConfig: result.contract,
    dataSnapshot: result.data,
    codeVersion: VERSION,
    testDates: result.data.internalHoldout,
    variationsAttempted: VARIANTS,
    result: { developmentWalkForward, finalLocked: result.finalLocked, internalHoldout: holdoutResult, pbo: pboResult, verdict },
    correctedSignificance: 'selection occurs only on exact-label-end-purged training; HAC/effective-N/21-session moving-block CI on paired later-date lift; CSCV PBO over all 32 variants',
    costStress: { base: holdoutResult.base && holdoutResult.base.avg, doubled: holdoutResult.doubledCost && holdoutResult.doubledCost.avg },
    decision: 'NOT PROMOTED — internal diagnostic on previously researched feature families',
    reason: `${verdict}; future prospective data are required before any live weight.`,
    artifact,
  });
  console.log(JSON.stringify({ ...result, artifact: artifact.file }, null, 2));
  return result;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, preparePanels, exactPurgedTrain, series, summarize, liftSummary };
