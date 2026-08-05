'use strict';
// EXPERIMENT A — DOWN-DAY EXACT-CONTRACT TEST (non-daytrade redesign 2026-08, Phase 11).
//
// THE HYPOTHESIS (frozen before the run): on a RED tape, the production oversold-bounce
// detector's flagged names beat matched red-day controls over the CONTRACT's exact
// 3-session window, entered at the next session's open, net of costs, relative to the
// market and to the sector.
//
// WHY IT EXISTS. Down-Day carries the app's most credible conditional evidence, but the
// contract said "3-session red-tape window" while the Scoreboard graded it on a 5-day
// bucket, entries were logged at the signal close, and the "controls" were the rest of the
// board rather than matched names on the same dates. This test measures exactly what the
// (now reconciled) contract claims — no more.
//
// FROZEN CONFIGURATION (declared here, before any number is looked at):
//   population   every cached name with ≥280 bars and ≥$5M ADV at the decision date
//   red tape     SPY close-to-close return ≤ -0.4% on the decision session (the app's own
//                RED_TAPE_SPY constant; the macro overlay has NO point-in-time series and
//                is therefore NOT used — stated, not imputed)
//   signal       lib/downday.classify(...).bucket === 'bounce' (the PRODUCTION detector,
//                called through its own module — no re-implementation)
//   control      names on the SAME red date, in the SAME liquidity band, that the detector
//                did NOT flag (matched by date x band, which is the confound that matters)
//   entry        NEXT session's open (a signal-close fill is not executable)
//   horizon      3 sessions (the contract's own time exit)
//   outcome      cost-net excess vs SPY and vs the sector ETF proxy, at base / doubled /
//                stressed costs
//   inference    date-clustered: one equal-weight portfolio observation per decision date,
//                HAC standard errors, seeded moving-block bootstrap, effective sample size,
//                4-block chronological stability
//   holdout      the FINAL 25% of decision dates is an untouched prospective holdout —
//                reported separately and never used to choose anything
//
// WHAT THIS CANNOT DO. The universe is survivorship-REDUCED, not survivorship-safe (see
// research/lib/experiment-kit.js), so a positive result here can never promote anything.
//
// Usage: node research/66-downday-exact-contract.js [--step 1] [--maxNames 1500]

const path = require('node:path');
const K = require('./lib/experiment-kit');
const DD = require('../lib/downday');
const { SECTOR_OF } = require('../lib/universe');

const STUDY_ID = 'A-downday-exact-contract-2026-08';
const STUDY_VERSION = 'downday-exact-contract-v1';
const OUT_DIR = path.join(K.DATA_DIR, 'downday-exact-contract');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 1);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 1500);
const H = 3;                       // the contract's exact horizon
const RED_TAPE_SPY = -0.4;         // percent — mirrors lib/opportunity-density RED_TAPE_SPY
const HOLDOUT_FRACTION = 0.25;
const MIN_HISTORY = 280;
const MIN_ADV = 5e6;
const VARIATIONS_ATTEMPTED = 1;    // ONE frozen specification. No sweep, no tuning.

const bandOf = (dv) => (dv >= 2e7 ? 'liquid' : dv >= 5e6 ? 'small' : 'micro');

async function main() {
  const t0 = Date.now();
  console.log(`[${STUDY_ID}] loading universe…`);
  const { dataset, spy, spyIdx, attrition: uAttr } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  console.log(`  ${dataset.size} names (${JSON.stringify(uAttr)})`);

  // Red-tape decision sessions with a full observable forward window.
  const redDates = [];
  for (let i = 262; i <= spy.length - 1 - H; i += STEP) {
    const prev = spy[i - 1], cur = spy[i];
    if (!prev || !(prev.close > 0)) continue;
    const chg = (cur.close / prev.close - 1) * 100;
    if (chg <= RED_TAPE_SPY) redDates.push(cur.date);
  }
  console.log(`  red-tape decision sessions: ${redDates.length} (${redDates[0]} → ${redDates[redDates.length - 1]})`);

  const attr = K.newAttrition();
  attr.noSignal = 0; attr.noSector = 0;
  const flagged = [];   // { date, ticker, band, tier, netExc, netSecExc, ... }
  const controls = [];
  let scanned = 0;

  for (const D of redDates) {
    const spyF = K.benchmarkForward(spy, spyIdx, D, H);
    if (spyF == null) { attr.noBenchmark++; continue; }
    // Sector proxy: the equal-weight forward return of the same-sector cohort on this date
    // (the app has no PIT sector-ETF series in this cache — an equal-weight sector cohort
    // is the honest available control, and it is labeled as such).
    const rowsToday = [];
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < 120) { attr.truncatedHistory++; continue; }
      if (pit[pit.length - 1].date !== D) continue;      // the name must actually trade that day
      const fwd = K.forwardFromNextOpen(v, D, H, attr);
      if (fwd == null) continue;
      const liq = DD.liquidity(pit);
      if (!liq) { attr.ineligible++; continue; }
      scanned++;
      const c = DD.classify(pit);
      rowsToday.push({
        ticker: t, sector: SECTOR_OF[t] || 'Other', band: bandOf(liq.dollarVol),
        dollarVol: liq.dollarVol, fwd, bounce: !!(c && c.bucket === 'bounce'),
        tier: c && c.bucket === 'bounce' ? c.tier : null,
      });
    }
    if (!rowsToday.length) continue;
    // Sector cohort means for the sector-relative leg.
    const bySector = new Map();
    for (const r of rowsToday) { if (!bySector.has(r.sector)) bySector.set(r.sector, []); bySector.get(r.sector).push(r.fwd); }
    const secMean = new Map([...bySector].map(([s, a]) => [s, K.mean(a)]));

    for (const r of rowsToday) {
      const cost = K.costFractions(r.dollarVol);
      const secLeg = secMean.get(r.sector);
      const row = {
        date: D, ticker: r.ticker, band: r.band, sector: r.sector, tier: r.tier,
        gross: r.fwd, grossExc: r.fwd - spyF,
        netExcBase: r.fwd - cost.base - spyF,
        netExcDoubled: r.fwd - cost.doubled - spyF,
        netExcStressed: r.fwd - cost.stressed - spyF,
        netSecExc: secLeg == null ? null : r.fwd - cost.base - secLeg,
        costTier: cost.tier,
      };
      if (r.bounce) flagged.push(row); else controls.push(row);
    }
  }

  console.log(`  flagged bounce episodes ${flagged.length}, matched controls ${controls.length}, scanned name-dates ${scanned}`);
  if (!flagged.length) {
    console.log('  NO flagged episodes — nothing to conclude.');
    return finish({ flagged, controls, uAttr, attr, redDates, t0, verdict: 'INSUFFICIENT_DATA' });
  }

  // MATCHED CONTROL: for every flagged (date, band) cell, the equal-weight control return
  // in the SAME cell — so the comparison is never "flagged names vs the whole market".
  const cellKey = (r) => `${r.date}|${r.band}`;
  const controlCell = new Map();
  for (const c of controls) {
    if (!controlCell.has(cellKey(c))) controlCell.set(cellKey(c), []);
    controlCell.get(cellKey(c)).push(c);
  }
  const paired = [];
  for (const f of flagged) {
    const cell = controlCell.get(cellKey(f));
    if (!cell || !cell.length) { attr.ineligible++; continue; }
    paired.push({
      date: f.date,
      liftBase: f.netExcBase - K.mean(cell.map(c => c.netExcBase)),
      liftDoubled: f.netExcDoubled - K.mean(cell.map(c => c.netExcDoubled)),
      liftStressed: f.netExcStressed - K.mean(cell.map(c => c.netExcStressed)),
      controlN: cell.length,
    });
  }

  // Chronological split: the FINAL 25% of red dates is an untouched holdout.
  const allDates = [...new Set(flagged.map(f => f.date))].sort();
  const cut = allDates[Math.floor(allDates.length * (1 - HOLDOUT_FRACTION))];
  const inSample = (r) => r.date < cut;

  const S = (rows, key, label) => ({
    label,
    all: K.summarizeByDate(rows.map(r => ({ date: r.date, value: r[key] * 100 })), { horizonBars: H }),
    inSample: K.summarizeByDate(rows.filter(inSample).map(r => ({ date: r.date, value: r[key] * 100 })), { horizonBars: H }),
    holdout: K.summarizeByDate(rows.filter(r => !inSample(r)).map(r => ({ date: r.date, value: r[key] * 100 })), { horizonBars: H }),
  });

  const results = {
    flaggedNetExcessBase: S(flagged, 'netExcBase', 'flagged: cost-net excess vs SPY @3 sessions'),
    flaggedNetExcessDoubled: S(flagged, 'netExcDoubled', 'flagged: doubled-cost net excess vs SPY'),
    flaggedNetExcessStressed: S(flagged, 'netExcStressed', 'flagged: stressed-cost net excess vs SPY'),
    flaggedSectorRelative: S(flagged.filter(f => f.netSecExc != null), 'netSecExc', 'flagged: cost-net excess vs same-sector cohort'),
    controlNetExcessBase: S(controls, 'netExcBase', 'matched controls: cost-net excess vs SPY'),
    liftVsMatchedControls: S(paired, 'liftBase', 'LIFT over matched same-date same-band controls (the primary metric)'),
    liftDoubledCost: S(paired, 'liftDoubled', 'lift at doubled costs'),
    liftStressedCost: S(paired, 'liftStressed', 'lift at stressed costs'),
  };

  // PRIMARY metric, declared above: lift over matched controls, base costs, full sample.
  const primary = results.liftVsMatchedControls.all;
  const pv = primary ? K.pValue(primary) : null;
  // FDR across every metric family this study reports (the honest denominator for a run
  // that looks at more than one number).
  const family = Object.entries(results)
    .map(([k, v]) => ({ id: k, p: v.all ? K.pValue(v.all) : null }))
    .filter(x => Number.isFinite(x.p));
  const corrected = K.fdr(family);
  const primaryQ = (corrected.find(c => c.id === 'liftVsMatchedControls') || {}).q ?? null;

  const passes = !!(primary && primary.ci95.lo > 0
    && results.liftDoubledCost.all && results.liftDoubledCost.all.ci95.lo > 0
    && Number.isFinite(primaryQ) && primaryQ <= 0.05
    && primary.effectiveN >= 12 && primary.positiveBlocks >= 3
    && results.liftVsMatchedControls.holdout && results.liftVsMatchedControls.holdout.avg > 0);

  const verdict = !primary ? 'INSUFFICIENT_DATA'
    : passes ? 'CONFIRMED-IN-SAMPLE (survivorship-reduced data ⇒ NOT promotable)'
      : 'NOT CONFIRMED';

  return finish({ flagged, controls, paired, results, primary, pv, corrected, primaryQ, verdict, uAttr, attr, redDates, t0 });
}

function finish(ctx) {
  const { flagged, controls, paired = [], results = null, primary = null, pv = null, corrected = [], primaryQ = null, verdict, uAttr, attr, redDates, t0 } = ctx;
  const manifest = {
    studyId: STUDY_ID, version: STUDY_VERSION, kit: K.KIT_VERSION,
    frozenConfig: {
      horizonSessions: H, entry: 'next-session open', redTapeSpyPct: RED_TAPE_SPY,
      detector: 'lib/downday.classify (production module, bucket=bounce)',
      control: 'same date x liquidity band, not flagged',
      costs: 'app cost model, base/doubled/stressed', holdoutFraction: HOLDOUT_FRACTION,
      minHistoryBars: MIN_HISTORY, minAdvUsd: MIN_ADV, step: STEP, maxNames: MAX_NAMES,
      variationsAttempted: VARIATIONS_ATTEMPTED,
    },
    dataSnapshot: { cacheDir: K.CACHE_DIR, redTapeSessions: redDates.length, firstDate: redDates[0] || null, lastDate: redDates[redDates.length - 1] || null },
    universeAttrition: uAttr,
    episodeAttrition: attr,
    counts: { flagged: flagged.length, controls: controls.length, pairedFlagged: paired.length },
    survivorshipProvenSafe: false,
    pitProven: false,
    limitations: [
      'Universe is survivorship-REDUCED, not survivorship-safe: delisted names are present but their bars simply end.',
      'Sector control is an equal-weight same-sector cohort, not a point-in-time sector ETF series.',
      'The macro risk-off overlay has no point-in-time history and is NOT used in the red-tape definition.',
      'A positive result here cannot promote anything (docs/model-promotion-policy.md hard blocker).',
    ],
    results, primary, pValue: pv, fdr: corrected, primaryQ, verdict,
    runtimeMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  };
  const art = K.writeArtifact(OUT_DIR, 'result.json', manifest);
  K.recordExperiment({
    id: STUDY_ID,
    hypothesis: 'On a red tape, flagged oversold-bounce names beat matched same-date same-liquidity-band controls over the contract\'s 3-session window, entered next-open, cost-net, vs SPY and sector.',
    frozenConfig: manifest.frozenConfig,
    dataSnapshot: manifest.dataSnapshot,
    codeVersion: STUDY_VERSION,
    testDates: { first: redDates[0] || null, last: redDates[redDates.length - 1] || null, n: redDates.length },
    variationsAttempted: VARIATIONS_ATTEMPTED,
    result: primary ? { primaryMetric: 'lift vs matched controls, cost-net, 3 sessions', avgPct: primary.avg, ci95: primary.ci95, dates: primary.n, effectiveN: primary.effectiveN, positiveBlocks: primary.positiveBlocks } : null,
    correctedSignificance: { pValue: pv, q: primaryQ, method: 'Benjamini-Hochberg across this study\'s reported metric family' },
    costStress: results ? { base: results.liftVsMatchedControls.all && results.liftVsMatchedControls.all.avg, doubled: results.liftDoubledCost.all && results.liftDoubledCost.all.avg, stressed: results.liftStressedCost.all && results.liftStressedCost.all.avg } : null,
    decision: 'NOT PROMOTED',
    reason: `${verdict}. Survivorship-unsafe data is a hard promotion blocker regardless of the statistics; this run is evidence about the CONTRACT, not a promotion.`,
    artifact: art,
  });
  console.log(`\n[${STUDY_ID}] verdict: ${verdict}`);
  if (primary) {
    console.log(`  primary lift vs matched controls: ${primary.avg}% over ${primary.n} dates (effective ${primary.effectiveN}), 95% CI [${primary.ci95.lo}, ${primary.ci95.hi}], blocks +${primary.positiveBlocks}/4`);
    console.log(`  doubled-cost lift ${results.liftDoubledCost.all ? results.liftDoubledCost.all.avg : 'n/a'}%, stressed ${results.liftStressedCost.all ? results.liftStressedCost.all.avg : 'n/a'}%`);
    console.log(`  holdout (final ${HOLDOUT_FRACTION * 100}% of dates): ${results.liftVsMatchedControls.holdout ? results.liftVsMatchedControls.holdout.avg + '%' : 'insufficient'}`);
    console.log(`  p=${pv} q(BH)=${primaryQ}`);
  }
  console.log(`  artifact: ${art.file}`);
  return manifest;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { STUDY_ID, STUDY_VERSION, main };
