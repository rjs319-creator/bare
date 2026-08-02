'use strict';
// Alpha Foundry — step 40: the BENCHMARK evidence run on panel-v3.
//   node research/40-foundry-benchmark.js
//
// Re-measures the standing yardstick (12-1 momentum vs the shuffled random
// control) on the authoritative-label panel through harness-v3 (HAC + moving-
// block bootstrap + BH-bounded verdicts) and appends the result to the
// append-only evidence log for hypothesis `momentum-12-1-swing`.
//
// This is NOT an alpha search: no candidate rankers, no variants, no tuning.
// It exists so every future Foundry experiment has a clean-label benchmark
// evidence record to be measured against, and so the loop
// (registry → panel-v3 → harness-v3 → evidence log) is proven end-to-end.
// Every future candidate run MUST preregister in lib/research/hypothesis-
// registry.js first and declare variantsInspected honestly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const H = require('../lib/research/harness-v3');
const EL = require('../lib/research/evidence-log');

const DATA = path.join(__dirname, 'data');
const PANEL_PATH = path.join(DATA, 'panel-features-v3.json');
const HORIZON = 21;

function main() {
  if (!fs.existsSync(PANEL_PATH)) {
    console.log('BLOCKED: panel-features-v3.json missing — run research/15-panel-features-v3.js first (see its BLOCKED artifact).');
    process.exitCode = 1;
    return;
  }
  const raw = fs.readFileSync(PANEL_PATH, 'utf8');
  const panel = JSON.parse(raw);
  const datasetHash = `panel-features-v3:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  let codeVersion = 'git:unknown';
  try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }

  const events = [];
  for (const ym of panel.months) {
    for (const r of panel.panel[ym]) {
      if (!Number.isFinite(r[`f${HORIZON}`])) continue;   // label-ready rows only (null = pending/unresolved/withheld — fail closed)
      events.push({
        securityId: r.lid || `sym:${r.s}`,
        ticker: r.s,
        decisionTs: r.dt || `${ym}-28`,
        horizon: `${HORIZON}d`,
        features: { mom121: r.m121 },
        outcome: r[`f${HORIZON}`],
        capBand: r.cap >= 2e9 ? 'mid' : 'small',
      });
    }
  }

  const report = H.runExperimentV3(events, [], {
    folds: 4, horizonBars: HORIZON, seed: 40,
  }, {
    experimentId: 'foundry-benchmark-momentum-panel-v3',
    experimentFamilyId: 'swing-ranking',
    datasetHash, codeCommit: codeVersion,
    variantsInspected: 0,          // benchmark-only: nothing searched
    survivorshipSafe: true,
    survivorshipReason: `panel-v3 fwd-outcome-v3 labels; ${panel.deadNamesIncluded} confirmed-delisted names included; masterSource=${panel.securityMasterSource}`,
    generatedAt: new Date().toISOString(),
  });

  const mom = report.summaries['momentum-12-1'];
  const ctrl = report.summaries['control-random'];
  console.log(`momentum-12-1 on panel-v3 (${HORIZON}d): meanIC ${mom.meanIC}, HAC t ${mom.hac.tstat}, MBB CI90 [${(mom.mbbCi90 || []).join(', ')}], ESS ${mom.effectiveSampleSize}, dates ${mom.dates}`);
  console.log(`control-random: meanIC ${ctrl.meanIC}, HAC t ${ctrl.hac.tstat}`);

  const rec = EL.makeEvidenceRecord({
    hypothesisId: 'momentum-12-1-swing',
    datasetHash,
    periodStart: panel.months[0], periodEnd: panel.months[panel.months.length - 1],
    horizon: `${HORIZON}d`,
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(report.manifest || report)).digest('hex').slice(0, 16),
    metrics: {
      meanIC: mom.meanIC, hacT: mom.hac.tstat, mbbCi90: mom.mbbCi90,
      effectiveSampleSize: mom.effectiveSampleSize, dates: mom.dates,
      fracPositive: mom.fracPositive, positiveFolds: mom.positiveFolds,
      controlMeanIC: ctrl.meanIC, controlHacT: ctrl.hac.tstat,
      labelStates: panel.labelStates, deadNamesIncluded: panel.deadNamesIncluded,
    },
    // Benchmark yardstick measurement — never a pass. The registry keeps
    // momentum at no-edge (as a live claim); this records its clean-label IC.
    verdict: 'inconclusive',
    mode: 'confirmatory',
    generatedAt: new Date().toISOString(),
    note: `Benchmark yardstick re-measured on authoritative labels (masterSource=${panel.securityMasterSource}; ${panel.deadNamesIncluded} dead names included, unverified-reason delistings label-withheld). No candidates, no variants. Verdict inconclusive by design: this is the ruler, not a claim.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }

  const deps = {
    readJSON: async (p, dflt) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
    },
    writeJSON: async (p, obj) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    },
  };
  EL.appendEvidence(deps, rec.record).then((r) => {
    console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/momentum-12-1-swing/`);
  });
}

main();
