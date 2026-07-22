'use strict';
// OMEGA-SWING RESEARCH VERDICT — the app-facing surface for the SURVIVORSHIP-FREE research finding.
//
// The app's op=omegawf runs on the free, survivor-biased Yahoo feed, so it can never earn
// survivorshipSafe=true. That flag is discharged RESEARCH-side by research/53-omega-survivorship-
// free.js, which re-runs the identical OMEGA scorer over the survivorship-complete pit-secmaster-v1
// master and writes a compact, machine-readable verdict to lib/omega-research-verdict.json (that
// script is the ONLY writer, so the number the app shows is always the number research produced).
//
// This module loads that committed artifact so op=omegamodel can surface the survivorship-free
// verdict alongside the live model config. It is a RECORDED snapshot, clearly stamped with its
// provenance (experiment path, generatedAt, master version) — never recomputed at request time.

let verdict = null;
try {
  // eslint-disable-next-line global-require
  verdict = require('./omega-research-verdict.json');
} catch {
  verdict = null;   // artifact not present (research run never committed) — fail soft, say so
}

// The app-facing view: the recorded verdict, or an explicit "not run" marker (never a fabricated
// pass). survivorshipSafe applies to THIS research evidence only, not the app-side live replay.
function researchVerdict() {
  if (!verdict || typeof verdict !== 'object') {
    return { available: false, note: 'No survivorship-free research verdict has been committed (run research/53-omega-survivorship-free.js).' };
  }
  return {
    available: true,
    scope: 'research-side survivorship-complete (pit-secmaster-v1) — distinct from the app-side survivor-biased live replay',
    version: verdict.version,
    experiment: verdict.experiment,
    doc: verdict.doc,
    generatedAt: verdict.generatedAt,
    verdict: verdict.verdict,
    passed: verdict.passed,
    promotable: verdict.promotable,
    survivorshipSafe: verdict.survivorshipSafe,
    historicalLiveParity: verdict.historicalLiveParity,
    universe: verdict.universe,
    metrics: verdict.metrics,
    gates: verdict.gates,
    reading: verdict.reading,
  };
}

module.exports = { researchVerdict, RAW: verdict };
