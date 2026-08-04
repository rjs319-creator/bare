'use strict';
// PRE-REGISTERED PROMOTION GATE (v2) — the learned model replaces/joins the deterministic
// baseline ONLY if EVERY gate below passes on out-of-sample walk-forward evidence.
// FAIL-CLOSED: any missing statistic, thin data, or unmet threshold ⇒ do NOT promote.
// Thresholds are fixed in advance (here, in code) so the bar cannot be moved after seeing
// results — the discipline the whole capture/validation stack exists to enforce.
//
// v2 (2026-08-03) additions over v1's seven checks:
//   • testEpisodes is DISTINCT EXECUTABLE EPISODES (date×ticker), never raw 5-min rows
//   • minimum distinct dates
//   • fold dominance (a majority of folds must independently beat the baseline)
//   • ticker-concentration ceiling on the top-K (one lucky name cannot carry the result)
//   • positive net utility under ADVERSE cost assumptions (2× the modeled cost)
//   • must beat every single-signal comparator, not just the severity baseline
//   • slice stability (no sufficient session/liquidity slice with negative top-K net)
//   • data-health ceiling (join-loss ratio) and prospective-provenance requirement
//   • multiple-testing deflation: the net-return-lift bar scales with the logged number of
//     attempted variants (trials ledger), so the best-of-many cannot pass the single-trial bar
//   • prospective shadow evidence (min days + episodes) — supplied by the model registry;
//     absent ⇒ fail closed (a backtest alone can never promote)

const GATES = Object.freeze({
  minEpisodes: 400,          // distinct graded episodes to train/evaluate on
  minTestEpisodes: 150,      // out-of-fold DISTINCT EPISODES (date×ticker — never rows)
  minDistinctDates: 21,      // ≥ one trading month of distinct sessions
  minFolds: 3,               // must hold across ≥3 chronological folds (not one lucky window)
  minFoldsPositiveShare: 0.6, // ≥60% of fitted folds beat the baseline independently
  minPrecisionLift: 0.05,    // model precision@k − baseline precision@k
  minNetReturnLift: 0.0010,  // model top-k avg NET return − baseline (after costs/slippage)
  minAdverseNetReturn: 0,    // top-k policy net return must stay POSITIVE under 2× costs
  maxTickerConcentration: 0.25, // max share of top-K slots any single ticker may hold
  maxEce: 0.10,              // expected calibration error ceiling (probabilities must be honest)
  maxBrier: 0.25,            // Brier score ceiling
  maxJoinLossRatio: 0.5,     // >50% of captured rows lost to version/grade joins = unhealthy data
  minShadowDays: 5,          // prospective shadow observation window (distinct sessions)
  minShadowEpisodes: 50,     // prospective shadow episodes observed
  // Multiple-testing deflation: effective lift bar = minNetReturnLift × (1 + 0.15·log2(trials)).
  // Pre-registered, conservative — with 16 logged variants the bar is 1.6× the single-trial bar.
  trialsDeflationPerLog2: 0.15,
});

function deflatedLiftBar(trials, gates = GATES) {
  const t = Number.isFinite(trials) && trials >= 1 ? trials : null;
  if (t == null) return null;   // unlogged search ⇒ cannot pass (fail closed in the check)
  return +(gates.minNetReturnLift * (1 + gates.trialsDeflationPerLog2 * Math.log2(Math.max(1, t)))).toFixed(6);
}

// stats: {
//   episodes, testEpisodes, distinctDates, folds, foldsPositive,
//   precisionLift, netReturnLift, adverseTopKNet, tickerConcentration,
//   ece, brier, beatsAllComparators, sliceStable, joinLossRatio,
//   provenanceProspective, trials, shadowDays, shadowEpisodes,
// }
function checkPromotion(stats = {}, gates = GATES) {
  const s = stats;
  const liftBar = deflatedLiftBar(s.trials, gates);
  const foldsPosShare = (s.folds ?? 0) > 0 && s.foldsPositive != null ? s.foldsPositive / s.folds : null;
  const checks = [
    { gate: 'episodes', pass: (s.episodes ?? 0) >= gates.minEpisodes, detail: `${s.episodes ?? 0} ≥ ${gates.minEpisodes}` },
    { gate: 'testEpisodes', pass: (s.testEpisodes ?? 0) >= gates.minTestEpisodes, detail: `${s.testEpisodes ?? 0} ≥ ${gates.minTestEpisodes} (distinct date×ticker)` },
    { gate: 'distinctDates', pass: (s.distinctDates ?? 0) >= gates.minDistinctDates, detail: `${s.distinctDates ?? 0} ≥ ${gates.minDistinctDates}` },
    { gate: 'folds', pass: (s.folds ?? 0) >= gates.minFolds, detail: `${s.folds ?? 0} ≥ ${gates.minFolds}` },
    { gate: 'foldDominance', pass: foldsPosShare != null && foldsPosShare >= gates.minFoldsPositiveShare, detail: `${s.foldsPositive ?? 'n/a'}/${s.folds ?? 'n/a'} folds beat baseline (need ≥${gates.minFoldsPositiveShare})` },
    { gate: 'precisionLift', pass: s.precisionLift != null && s.precisionLift >= gates.minPrecisionLift, detail: `${s.precisionLift ?? 'n/a'} ≥ ${gates.minPrecisionLift}` },
    { gate: 'netReturnLift', pass: s.netReturnLift != null && liftBar != null && s.netReturnLift >= liftBar, detail: `${s.netReturnLift ?? 'n/a'} ≥ ${liftBar ?? 'n/a (trials unlogged)'} (deflated for ${s.trials ?? '?'} trials)` },
    { gate: 'adverseCosts', pass: s.adverseTopKNet != null && s.adverseTopKNet > gates.minAdverseNetReturn, detail: `top-K policy net under 2× costs ${s.adverseTopKNet ?? 'n/a'} > ${gates.minAdverseNetReturn}` },
    { gate: 'tickerConcentration', pass: s.tickerConcentration != null && s.tickerConcentration <= gates.maxTickerConcentration, detail: `${s.tickerConcentration ?? 'n/a'} ≤ ${gates.maxTickerConcentration}` },
    { gate: 'beatsComparators', pass: s.beatsAllComparators === true, detail: 'must beat cusum/relVol/dayPct single-signal comparators' },
    { gate: 'sliceStability', pass: s.sliceStable === true, detail: 'no sufficient session/liquidity slice with negative top-K net' },
    { gate: 'calibrationEce', pass: s.ece != null && s.ece <= gates.maxEce, detail: `${s.ece ?? 'n/a'} ≤ ${gates.maxEce}` },
    { gate: 'brier', pass: s.brier != null && s.brier <= gates.maxBrier, detail: `${s.brier ?? 'n/a'} ≤ ${gates.maxBrier}` },
    { gate: 'dataHealth', pass: s.joinLossRatio != null && s.joinLossRatio <= gates.maxJoinLossRatio, detail: `join-loss ratio ${s.joinLossRatio ?? 'n/a'} ≤ ${gates.maxJoinLossRatio}` },
    { gate: 'provenance', pass: s.provenanceProspective === true, detail: 'evaluation data must be prospective-live (historical reconstruction cannot promote alone)' },
    { gate: 'prospectiveShadow', pass: (s.shadowDays ?? 0) >= gates.minShadowDays && (s.shadowEpisodes ?? 0) >= gates.minShadowEpisodes, detail: `shadow ${s.shadowDays ?? 0}d/${s.shadowEpisodes ?? 0}ep ≥ ${gates.minShadowDays}d/${gates.minShadowEpisodes}ep` },
  ];
  return { promote: checks.every(c => c.pass), checks, gates, failed: checks.filter(c => !c.pass).map(c => c.gate) };
}

module.exports = { GATES, checkPromotion, deflatedLiftBar };
