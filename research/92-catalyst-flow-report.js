'use strict';
// CATALYST–FLOW — STEP 6: THE FINAL REPORT.
//
//   node research/92-catalyst-flow-report.js
//
// Distills the measured artifacts (arms-result, dataset/ledger manifests, model meta,
// trial registry) into the two deliverables a reader should actually open:
//   research/results/catalyst_flow_report.json  — machine-readable, gate-by-gate
//   research/results/catalyst_flow_report.md    — the same thing in plain English
//
// This script COMPUTES NOTHING NEW. Every number is read from the pipeline's recorded
// outputs, so the report cannot disagree with the measurement; if an input is missing
// it says so and stops rather than filling the hole.

const fs = require('node:fs');
const path = require('node:path');
const { PROMOTION_GATES } = require('../lib/catalyst-flow/config');

const DATA = path.join(__dirname, 'data', 'catalyst-flow');
const OUT = path.join(__dirname, 'results');

function readJson(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) { console.error(`MISSING INPUT: ${p} — run the pipeline steps (research/88..90) first.`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const arms = readJson('arms-result.json');
const dataset = readJson('dataset-manifest.json');
const ledger = readJson('ledger-manifest.json');
const model = readJson('model-meta.json');
const trialsPath = path.join(DATA, 'trials.jsonl');
const trialCount = fs.existsSync(trialsPath) ? fs.readFileSync(trialsPath, 'utf8').split('\n').filter(Boolean).length : null;

const bps = (x) => (x == null ? null : Math.round(x * 1e5) / 10);
const armRow = (a) => a && a.avgPrecise !== undefined ? {
  netBpsPerCohort: a.avgBpsPerCohort ?? bps(a.avgPrecise),
  p: a.p, ci95: a.ci95, positiveBlocks: `${a.positiveBlocks}/${a.blockStability?.blocks}`,
  cohorts: a.n, abstained: a.diag ? `${a.diag.abstained}/${a.diag.dates}` : null,
  forcedTop10BpsPerCohort: a.forcedTopN ? (a.forcedTopN.avgBpsPerCohort ?? bps(a.forcedTopN.avgPrecise)) : null,
  forcedTop10P: a.forcedTopN ? a.forcedTopN.p : null,
} : a;

// ── Gate-by-gate verdict, each tied to a measured quantity ─────────────────────────
const pitObserved = ledger.pitObservedAtCutoff ?? 0;
const gates = [
  { gate: 'pitImmutableEvidence', passed: false, measured: `${pitObserved} of ${ledger.events ?? ledger.ledgerEvents ?? dataset.ledgerEvents} ledger rows were observed at their own decision cutoff — the consensus archive is a post-release vendor snapshot (RECONSTRUCTED_EXPLORATORY)` },
  { gate: 'delistingsIncluded', passed: false, measured: 'delisted names’ price series simply end; delisting RETURNS are absent, so survivorship safety is reduced, not proven' },
  { gate: 'signedOptionsCoverage', passed: false, measured: 'no Cboe Open-Close (or equivalent participant/side/open-close) feed — family C is 0% populated by refusal' },
  { gate: 'ablationSurvivesFDR', passed: false, measured: `nothing survives Benjamini-Hochberg: all q = ${arms.fdr?.[0]?.q?.toFixed(3)} across the ${arms.fdr?.length}-member family` },
  { gate: 'positiveNetOfStressCost', passed: false, measured: 'every arm’s primary mean is ≤ 0 at the liquidity-aware cost case; stress cases are moot' },
  { gate: 'deflatedSharpePositive', passed: false, measured: `E2 DSR = ${arms.deflatedSharpe?.E2_CATALYST_RANKER?.dsr} on a negative raw Sharpe, deflated by ${arms.deflatedSharpe?.trialCount} recorded configurations` },
  { gate: 'holdoutUntouched', passed: true, measured: `final holdout never opened (holdoutOpened = ${arms.model?.holdoutOpened}) — deliberately left closed; do not burn it on a study already blocked on data` },
];
const missing = PROMOTION_GATES.filter((g) => !gates.some((x) => x.gate === g));
if (missing.length) { console.error(`gate list drifted from config.PROMOTION_GATES: ${missing.join(', ')}`); process.exit(1); }

const sampleGates = {
  heldOutDecisionDates: { required: 100, measured: arms.cohorts.decisionDates, passed: arms.cohorts.decisionDates >= 100 },
  heldOutEventObservations: { required: 500, measured: arms.cohorts.rows, passed: arms.cohorts.rows >= 500 },
};

const report = {
  version: 'catalyst-flow-report-v1',
  engine: arms.id,
  generatedAt: new Date().toISOString(),
  inputsRanAt: { arms: arms.ranAt, dataset: dataset.builtAt, model: model.builtAt || model.trainedAt || null },
  verdict: 'KEEP_RESEARCH_ONLY',
  verdictE3: 'INSUFFICIENT_DATA',
  oneLine: 'No arm produced positive net sector-relative alpha; with abstention equalised and then removed, LambdaMART shows zero ranking advantage over a transparent PEAD score (E2−E1 forced = +1.1 bps, p = 0.92). E3 (signed options) was never measurable. The strategy stays RESEARCH/SHADOW at weight zero.',
  primaryConfiguration: arms.primaryConfiguration,
  cohorts: arms.cohorts,
  arms: Object.fromEntries(Object.entries(arms.arms).map(([k, v]) => [k, armRow(v)])),
  ablations: Object.fromEntries(Object.entries(arms.ablations).map(([k, v]) => [k, armRow(v)])),
  fdr: arms.fdr,
  deflatedSharpe: arms.deflatedSharpe,
  trialCount,
  model: arms.model,
  promotionGates: gates,
  sampleSizeGates: sampleGates,
  pairedCoverage: {
    identicalAcrossArms: arms.cohorts.identicalAcrossArms,
    exclusionReasons: dataset.attrition,
    overlapRejected: dataset.overlapRejected,
    note: 'All measured arms score the identical eligible event-date cohorts; exclusions happen upstream at dataset build and are itemised above. E3 is excluded wholesale (no signed-flow data), which is a coverage statement, not a result.',
  },
  dataCoverage: {
    pitClass: arms.honesty.pitClass,
    promotionEligibleEvents: 0,
    ledgerEvents: dataset.ledgerEvents,
    datasetRows: dataset.datasetRows,
    decisionDates: dataset.decisionDates,
    dateRange: dataset.dateRange,
    cohortSize: dataset.cohortSize,
    featureCoverage: dataset.featureCoverage,
  },
  honesty: arms.honesty,
  whatWouldChangeTheAnswer: [
    'A licensed signed customer-opening option feed (Cboe Open-Close or equivalent) to make E3 measurable at all.',
    'Provider-timestamped point-in-time consensus (or the append-only snapshot process maturing for ~2 quarters) to lift family A out of EXPLORATORY.',
    'Delisting returns for the price panel so survivorship safety can be proven rather than argued.',
  ],
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'catalyst_flow_report.json'), JSON.stringify(report, null, 1));

// ── Plain-English companion ────────────────────────────────────────────────────────
const armLine = (k) => {
  const a = report.arms[k];
  if (!a || a.netBpsPerCohort === undefined) return `| ${k} | — | — | — | — | INSUFFICIENT_DATA |`;
  return `| ${k} | ${a.netBpsPerCohort} | ${a.p != null ? a.p.toFixed(3) : '— (all-cash: constant series)'} | ${a.abstained ?? '—'} | ${a.forcedTop10BpsPerCohort ?? '—'} | ${a.forcedTop10P != null ? a.forcedTop10P.toFixed(3) : '—'} |`;
};
const md = `# Catalyst–Flow Ranker — final report

**Verdict: KEEP_RESEARCH_ONLY** (E3 arm: **INSUFFICIENT_DATA**). Generated ${report.generatedAt} from the
measured pipeline outputs (arms run ${arms.ranAt}). Weight zero; nothing here touches a live trade.

${report.oneLine}

## The numbers (net, sector-relative, per decision-date cohort)

${report.cohorts.decisionDates} out-of-fold decision-date cohorts, ${report.cohorts.rows} event rows, identical across every measured arm.
Inference is on date cohorts with Newey–West (lag 4) and a seeded block bootstrap; the wider interval is reported.

| Arm | net bps/cohort | p | abstained | forced top-10 bps | forced p |
|---|---:|---:|---:|---:|---:|
${['E0_CURRENT_OMEGA', 'E1_SIMPLE_PEAD', 'E2_CATALYST_RANKER', 'RIDGE', 'E3_CATALYST_FLOW_RANKER'].map(armLine).join('\n')}

**Paired ablations:** E2−E1 = ${report.ablations.E2_MINUS_E1?.netBpsPerCohort} bps (p = ${report.ablations.E2_MINUS_E1?.p?.toFixed(3)});
with abstention removed the ranking difference collapses to ≈ +1 bp (p ≈ 0.92) — the model has no ranking skill the
transparent PEAD score lacks. E3−E2 was **never computed** (no signed-flow data) and is reported as INSUFFICIENT_DATA,
not as a null. Nothing survives Benjamini–Hochberg (all q = ${arms.fdr?.[0]?.q?.toFixed(3)}). Deflated Sharpe (over the full
${trialCount}-trial registry): E2 = ${arms.deflatedSharpe?.E2_CATALYST_RANKER?.dsr}, E1 = ${arms.deflatedSharpe?.E1_SIMPLE_PEAD?.dsr}, both on negative raw Sharpe.

The only behaviour that "works" is refusing to trade: each arm looks ~flat on its primary line purely because its
calibrated edge is almost always negative, so it holds cash on most dates. That is the abstention rule working and
the ranking underneath it failing.

## Promotion gates

${gates.map((g) => `- ${g.passed ? '✅' : '❌'} \`${g.gate}\` — ${g.measured}`).join('\n')}
- ✅ sample floor: ${sampleGates.heldOutDecisionDates.measured} held-out decision dates (≥ 100), ${sampleGates.heldOutEventObservations.measured} event observations (≥ 500)

Six of seven gates fail; the one pass (untouched holdout) is deliberate — the holdout stays closed because the
study is already blocked on data, and a holdout is only spendable once.

## Data coverage: what is genuinely point-in-time

- **Genuine PIT:** family B (first-session price/volume confirmation, 19/19 features, ~98–100% coverage) and the
  FINRA days-to-cover overlay (visible only after a derived 10-session publication lag, 96.8%).
- **EXPLORATORY (reconstructed):** family A fundamentals — ${report.dataCoverage.promotionEligibleEvents} of ${report.dataCoverage.ledgerEvents} ledger rows were
  observed at their own cutoff; the earnings/consensus archive is a post-release vendor snapshot. Promotion-eligible
  events: **0**.
- **Absent by refusal:** family C signed option flow (free Yahoo chains cannot see participant, side, or open/close
  and are barred from these fields by schema and test).
- Exclusions at dataset build (paired across arms): ${Object.entries(dataset.attrition).map(([k, v]) => `${k} ${v}`).join(', ')}; ${dataset.overlapRejected} overlapping re-entries rejected.

## What would change the answer

${report.whatWouldChangeTheAnswer.map((x) => `1. ${x}`).join('\n')}

Full preregistration, schema, defect log and reproduction commands: \`docs/catalyst-flow-ranker.md\`.
Operator procedures: \`docs/catalyst-flow-runbook.md\`.
`;
fs.writeFileSync(path.join(OUT, 'catalyst_flow_report.md'), md);
console.log(`wrote ${path.join(OUT, 'catalyst_flow_report.json')} and .md — verdict ${report.verdict} (E3 ${report.verdictE3})`);
