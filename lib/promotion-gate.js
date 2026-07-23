'use strict';
// PRE-REGISTERED PROMOTION GATE — the learned Momentum Survival model replaces the
// deterministic baseline ONLY if EVERY gate below passes on out-of-sample walk-forward
// evidence. FAIL-CLOSED: any missing statistic, thin data, or unmet threshold ⇒ do NOT promote.
// These thresholds are fixed in advance (here, in code) so the bar cannot be moved after seeing
// results — the discipline the whole capture/validation stack exists to enforce.

const GATES = Object.freeze({
  minEpisodes: 400,          // total graded first-entry episodes to train/evaluate on
  minTestEpisodes: 150,      // out-of-fold test episodes (the honest sample)
  minFolds: 3,               // must hold across ≥3 chronological folds (not one lucky window)
  minPrecisionLift: 0.05,    // model precision@k − baseline precision@k
  minNetReturnLift: 0.0010,  // model top-k avg NET return − baseline (after costs/slippage)
  maxEce: 0.10,              // expected calibration error ceiling (probabilities must be honest)
  maxBrier: 0.25,            // Brier score ceiling
});

// stats: { episodes, testEpisodes, folds, precisionLift, netReturnLift, ece, brier }
function checkPromotion(stats = {}, gates = GATES) {
  const s = stats;
  const checks = [
    { gate: 'episodes', pass: (s.episodes ?? 0) >= gates.minEpisodes, detail: `${s.episodes ?? 0} ≥ ${gates.minEpisodes}` },
    { gate: 'testEpisodes', pass: (s.testEpisodes ?? 0) >= gates.minTestEpisodes, detail: `${s.testEpisodes ?? 0} ≥ ${gates.minTestEpisodes}` },
    { gate: 'folds', pass: (s.folds ?? 0) >= gates.minFolds, detail: `${s.folds ?? 0} ≥ ${gates.minFolds}` },
    { gate: 'precisionLift', pass: s.precisionLift != null && s.precisionLift >= gates.minPrecisionLift, detail: `${s.precisionLift ?? 'n/a'} ≥ ${gates.minPrecisionLift}` },
    { gate: 'netReturnLift', pass: s.netReturnLift != null && s.netReturnLift >= gates.minNetReturnLift, detail: `${s.netReturnLift ?? 'n/a'} ≥ ${gates.minNetReturnLift}` },
    { gate: 'calibrationEce', pass: s.ece != null && s.ece <= gates.maxEce, detail: `${s.ece ?? 'n/a'} ≤ ${gates.maxEce}` },
    { gate: 'brier', pass: s.brier != null && s.brier <= gates.maxBrier, detail: `${s.brier ?? 'n/a'} ≤ ${gates.maxBrier}` },
  ];
  return { promote: checks.every(c => c.pass), checks, gates, failed: checks.filter(c => !c.pass).map(c => c.gate) };
}

module.exports = { GATES, checkPromotion };
