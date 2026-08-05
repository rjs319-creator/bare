'use strict';
// EXPERIMENT D — ANALYST REVISION BREADTH / ACCELERATION: THE GATE, NOT THE STUDY.
// (non-daytrade redesign 2026-08, Phase 11 item D.)
//
// D is the one experiment that MUST NOT RUN YET. Its preconditions are data-quality facts,
// not modelling choices, and running it before they hold would produce a number that looks
// like evidence and is not: without proven point-in-time publication timestamps, a revision
// "known" on a decision date may have been published days later, which manufactures edge.
//
// THIS FILE IS THE GATE. It reads the estimates audit (lib/research/estimates-audit.js,
// the module the estimates work already produces) and REFUSES to run the study unless all
// four preconditions pass:
//   1. publication timestamps are point-in-time (classification !== PIT_UNPROVEN);
//   2. revision histories were actually available on each decision date (multi-observation
//      groups exist — a single snapshot per name is not a history);
//   3. symbol identity is stable across the sample (no unresolved symbol changes);
//   4. historical coverage and missingness are acceptable.
//
// When the gate passes, the study design it unlocks is FROZEN here in advance so it cannot
// be chosen after seeing the data: nested walk-forward validation (tuning strictly inside
// training folds, an untouched final holdout), scored against a PRICE-ONLY ranking on the
// identical dates and universe, with the incremental value over that baseline as the
// primary metric.
//
// Usage: node research/73-revision-breadth-gate.js [--sample research/data/estimates/sample.csv]

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');

const STUDY_ID = 'D-revision-breadth-2026-08';
const STUDY_VERSION = 'revision-breadth-gate-v1';
const OUT_DIR = path.join(K.DATA_DIR, 'revision-breadth');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const SAMPLE = args.sample ? path.resolve(args.sample) : path.join(K.DATA_DIR, 'estimates', 'sample.csv');

// FROZEN STUDY DESIGN — declared BEFORE the gate is evaluated, so it cannot be tuned to
// whatever the data turns out to support.
const FROZEN_DESIGN = Object.freeze({
  hypothesis: 'Analyst estimate-revision BREADTH (share of analysts revising up) and ACCELERATION (change in that breadth) rank forward returns better than a price-only ranking on the identical PIT universe and dates.',
  labels: 'cost-net excess vs SPY at 21 sessions, next-session-open entry',
  validation: 'nested walk-forward: hyperparameters chosen ONLY inside training folds, purged + embargoed at the label horizon, with a final untouched holdout',
  baseline: 'price-only ranking (the tournament\'s marketRelative entrant) on the identical dates and eligibility',
  primaryMetric: 'INCREMENTAL cost-net top-k excess over the price-only baseline, date-clustered',
  inference: 'HAC standard errors + seeded moving-block bootstrap + effective sample size + FDR across every attempted variant',
  variationsRegistered: ['breadth', 'acceleration', 'breadth+acceleration'],
  refuseIf: 'any precondition below fails — the study does not run, and no partial number is reported',
});

function readAudit() {
  // The audit module is the source of truth; this runner never re-implements it.
  let audit = null;
  try {
    const { auditEstimatesSample, parseCsv } = require('../lib/research/estimates-audit');
    if (!fs.existsSync(SAMPLE)) return { available: false, reason: `no estimates sample at ${SAMPLE}` };
    const rows = parseCsv(fs.readFileSync(SAMPLE, 'utf8'));
    audit = auditEstimatesSample(rows);
    return { available: true, audit };
  } catch (e) {
    return { available: false, reason: `estimates audit unavailable: ${String((e && e.message) || e)}` };
  }
}

function main() {
  const t0 = Date.now();
  const read = readAudit();
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed: passed === true, detail });

  if (!read.available) {
    add('AUDIT_AVAILABLE', false, read.reason);
  } else {
    const a = read.audit || {};
    add('AUDIT_AVAILABLE', true, `classification ${a.classification || 'unknown'}`);
    add('PIT_TIMESTAMPS_PROVEN', a.classification && a.classification !== 'PIT_UNPROVEN', `classification=${a.classification}`);
    add('REVISION_HISTORY_PRESENT', Number.isFinite(a.multiObsGroups) ? a.multiObsGroups > 0 : false, `multi-observation groups: ${a.multiObsGroups ?? 'unreported'}`);
    add('SYMBOL_IDENTITY_STABLE', a.symbolIdentityStable === true, `symbolIdentityStable=${a.symbolIdentityStable ?? 'unreported'}`);
    add('COVERAGE_ACCEPTABLE', a.coverageAcceptable === true, `coverageAcceptable=${a.coverageAcceptable ?? 'unreported'}`);
  }

  const passed = checks.length > 0 && checks.every(c => c.passed);
  const verdict = passed
    ? 'GATE OPEN — the preconditions hold; the frozen design above may now be executed'
    : 'BLOCKED_DATA — analyst-revision testing remains blocked; estimate revisions stay PIT_UNPROVEN and may NOT enter live rank or promotion';

  const manifest = {
    studyId: STUDY_ID, version: STUDY_VERSION, kit: K.KIT_VERSION,
    frozenDesign: FROZEN_DESIGN,
    sample: SAMPLE,
    checks, passed, verdict,
    consequence: passed ? null : [
      'Estimate revisions are labeled PIT_UNPROVEN everywhere they appear.',
      'They may NOT be used in live ranking or in any promotion artifact.',
      'Nothing about revisions is claimed, positively or negatively — the question is unanswered, not answered no.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const art = K.writeArtifact(OUT_DIR, 'gate.json', manifest);
  K.recordExperiment({
    id: STUDY_ID,
    hypothesis: FROZEN_DESIGN.hypothesis,
    frozenConfig: FROZEN_DESIGN,
    dataSnapshot: { sample: SAMPLE, available: read.available },
    codeVersion: STUDY_VERSION,
    testDates: null,
    variationsAttempted: 0,
    result: null,
    correctedSignificance: null,
    costStress: null,
    decision: passed ? 'READY TO RUN (not run in this pass)' : 'NOT RUN — BLOCKED_DATA',
    reason: verdict + '. ' + checks.filter(c => !c.passed).map(c => `${c.id}: ${c.detail}`).join('; '),
    artifact: art,
  });
  console.log(`[${STUDY_ID}] ${verdict}`);
  for (const c of checks) console.log(`  ${c.passed ? '✔' : '✖'} ${c.id} — ${c.detail}`);
  console.log(`  artifact: ${art.file}`);
  return manifest;
}

if (require.main === module) main();
module.exports = { STUDY_ID, STUDY_VERSION, FROZEN_DESIGN, main };
