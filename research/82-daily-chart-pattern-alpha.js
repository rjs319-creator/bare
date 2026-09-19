'use strict';

// Fixed daily-chart hypotheses layered onto the 252→21 beta-residual momentum
// core. Pattern rows get priority within the same top-30 momentum shortlist;
// remaining slots backfill by momentum, preserving ten-name exposure per date.

const path = require('node:path');
const K = require('./lib/experiment-kit');
const HF = require('../lib/research/hedge-fund-swing-formula');
const { pbo } = require('../lib/research/pbo');
const { buildPanels } = require('./81-residual-momentum-predictive-power');

const ID = 'daily-chart-pattern-alpha-2026-08';
const VERSION = 'daily-chart-pattern-alpha-v1';
const H = 21, TOP_K = 10, SHORTLIST = 30;

const ARMS = Object.freeze({
  momentumOnly: () => true,
  tightBase: r => r.chart.tightBase,
  orderlyPullback: r => r.chart.orderlyPullback,
  relativeStrengthBreakout: r => r.chart.rsBreakout,
  exhaustionVeto: r => !r.chart.exhaustionVeto,
  confirmedSetup: r => r.chart.confirmedSetup,
});

function picks(panel, arm) {
  const ranked = panel.rows.slice().sort((a, b) => b.m252 - a.m252 || a.ticker.localeCompare(b.ticker)).slice(0, SHORTLIST);
  const pass = ARMS[arm], preferred = ranked.filter(pass), fallback = ranked.filter(r => !pass(r));
  return [...preferred, ...fallback].slice(0, TOP_K);
}

function value(panel, arm, outcome = 'netBase') {
  const top = picks(panel, arm);
  return top.length === TOP_K ? HF.mean(top.map(r => r[outcome])) * 100 : null;
}

function evaluate(panels, arm, outcome = 'netBase') {
  const summary = K.summarizeByDate(panels.map(p => ({ date: p.date, value: value(p, arm, outcome) })), { horizonBars: H });
  const selected = panels.flatMap(p => picks(p, arm));
  return { ...summary,
    preferredShare: selected.length ? +(selected.filter(ARMS[arm]).length / selected.length).toFixed(4) : null,
    datesWithPreferred: panels.filter(p => picks(p, arm).some(ARMS[arm])).length,
  };
}

function lift(panels, arm, outcome = 'netBase') {
  return K.summarizeByDate(panels.map(p => ({ date: p.date,
    value: value(p, arm, outcome) - value(p, 'momentumOnly', outcome) })), { horizonBars: H });
}

function exactPurged(panels, testStart) { return panels.filter(p => p.date < testStart && p.labelEndDate < testStart); }

function bestOn(panels) {
  const candidates = Object.keys(ARMS).filter(a => a !== 'momentumOnly').map(arm => ({ arm,
    result: evaluate(panels, arm), lift: lift(panels, arm) }));
  candidates.forEach(x => { x.utility = (x.lift.avg || 0) + .10 * x.lift.positiveBlocks; });
  candidates.sort((a, b) => b.utility - a.utility || a.arm.localeCompare(b.arm));
  return { selected: candidates[0], candidates };
}

async function main() {
  const t0 = Date.now(), built = buildPanels(), panels = built.panels;
  const development = panels.filter(p => p.date >= '2022-01-01' && p.date <= '2025-12-31');
  const holdout = panels.filter(p => p.date >= '2026-01-01');
  const folds = [], optimizedRows = [], baselineRows = [];
  for (const [start, end] of [['2023-01-01','2023-12-31'], ['2024-01-01','2024-12-31'], ['2025-01-01','2025-12-31']]) {
    const test = development.filter(p => p.date >= start && p.date <= end);
    const train = exactPurged(development.filter(p => p.date < start), start);
    if (train.length < 20 || test.length < 10) continue;
    const selection = bestOn(train), arm = selection.selected.arm;
    const result = evaluate(test, arm), testLift = lift(test, arm);
    folds.push({ trainRange: [train[0].date, train.at(-1).date], testRange: [test[0].date, test.at(-1).date],
      trainDates: train.length, testDates: test.length, selected: arm, training: selection.selected, test: result, testLift });
    for (const p of test) { optimizedRows.push({ date: p.date, value: value(p, arm) }); baselineRows.push({ date: p.date, value: value(p, 'momentumOnly') }); }
  }
  const oos = new Map(optimizedRows.map(x => [x.date, x.value]));
  const walkForward = {
    optimized: K.summarizeByDate(optimizedRows, { horizonBars: H }),
    baseline: K.summarizeByDate(baselineRows, { horizonBars: H }),
    lift: K.summarizeByDate(baselineRows.map(x => ({ date: x.date, value: oos.get(x.date) - x.value })), { horizonBars: H }),
  };
  const finalTrain = exactPurged(development, holdout[0].date), selection = bestOn(finalTrain), locked = selection.selected.arm;
  const allDevelopment = Object.fromEntries(Object.keys(ARMS).map(a => [a, { result: evaluate(development, a), lift: lift(development, a) }]));
  const holdoutResults = Object.fromEntries(Object.keys(ARMS).map(a => [a, { result: evaluate(holdout, a),
    doubledCost: evaluate(holdout, a, 'netDoubled'), lift: lift(holdout, a) }]));
  const names = Object.keys(ARMS), pboResult = pbo(development.map(p => names.map(a => value(p, a))));
  const lockedLift = holdoutResults[locked].lift;
  const verdict = lockedLift && lockedLift.ci95.lo > 0 && lockedLift.positiveBlocks >= 3
    ? 'CHART_FILTER_IMPROVES_LATER_BLOCK_DIAGNOSTIC_ONLY' : 'NO_CONFIRMED_CHART_PATTERN_ALPHA';
  const result = { studyId: ID, version: VERSION,
    contract: { arms: names, baseSignal: '252→21 beta-adjusted residual momentum', shortlist: SHORTLIST, topK: TOP_K,
      patternUse: 'pattern-priority within top-30 momentum; unmatched slots backfilled by momentum to keep ten names',
      entry: 'next-session open', horizonSessions: H, costs: 'app base and doubled costs', outcome: 'excess versus SPY',
      selection: 'best fixed chart hypothesis on exact-label-end-purged prior dates; no threshold/weight fitting',
      definitions: { tightBase: 'uptrend; 20-day range ≤15%; ATR10/ATR40 ≤0.90; close within 8% of 20-day high',
        orderlyPullback: 'uptrend; 3–12% below 20-day high; above 50-day average; five-day volume ≤90% of 20-day volume',
        relativeStrengthBreakout: 'stock/SPY ratio within 2% of its prior 63-day high',
        exhaustionVeto: 'reject >4 ATR extension, >30% 20-day rise, >2 failed breakouts, or ≥5 distribution days',
        confirmedSetup: 'tight base or orderly pullback, plus RS breakout, with no exhaustion veto' } },
    data: { first: panels[0].date, last: panels.at(-1).date, dates: panels.length,
      candidates: panels.reduce((s,p)=>s+p.rows.length,0), developmentDates: development.length, holdoutDates: holdout.length,
      attrition: built.attrition },
    folds, walkForward, allDevelopment, lockedArm: locked, lockedTraining: selection.selected,
    holdout: holdoutResults, pbo: pboResult, verdict, promotable: false,
    limitations: ['Daily OHLCV patterns are objective approximations of visual chart concepts.',
      'The 2026 block is later than selection data but not untouched by the broader research program.',
      'Historical earnings-date coverage is incomplete/current-snapshot based.',
      'The price cache is survivorship-reduced, not survivorship-proven-safe.',
      'Overlapping 21-session outcomes reduce effective sample size; dependence-aware intervals are used.'],
    generatedAt: new Date().toISOString(), runtimeMs: Date.now()-t0 };
  const artifact = K.writeArtifact(path.join(K.DATA_DIR, 'daily-chart-pattern-alpha'), 'result.json', result);
  K.recordExperiment({ id: ID, hypothesis: 'Objective daily-chart patterns add cost-net top-10 excess over 252→21 residual momentum within the same decision-time gap universe.',
    family: 'swing-ranking', frozenConfig: result.contract, dataSnapshot: result.data, codeVersion: VERSION,
    testDates: { first: holdout[0].date, last: holdout.at(-1).date, n: holdout.length }, variationsAttempted: names.length,
    result: { lockedArm: locked, walkForward, holdout: holdoutResults, pbo: pboResult, verdict },
    correctedSignificance: 'exact-label-end purge; paired date-level HAC/effective-N/21-session moving-block CI; CSCV PBO over all six arms',
    costStress: { base: holdoutResults[locked].result.avg, doubled: holdoutResults[locked].doubledCost.avg },
    decision: 'NOT PROMOTED — later internal diagnostic only', reason: `${verdict}; future prospective dates required.`, artifact });
  console.log(JSON.stringify({ ...result, artifact: artifact.file }, null, 2));
  return result;
}

if (require.main === module) main().catch(e=>{console.error(e);process.exit(1);});
module.exports = { main, picks, value, evaluate, lift, exactPurged, bestOn, ARMS };
