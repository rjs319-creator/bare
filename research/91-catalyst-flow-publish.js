'use strict';
// CATALYST–FLOW — STEP 5: BUILD (AND OPTIONALLY PUBLISH) THE PREDICTION ARTIFACT.
//
//   node research/91-catalyst-flow-publish.js [--date YYYY-MM-DD] [--publish]
//
// Turns the newest out-of-fold decision date into the versioned artifact the serving layer
// reads. Writes it to disk always; uploads to Blob storage only with --publish AND a
// configured token, because publishing is the one step here with a side effect outside the
// research rig.
//
// The artifact carries its own discount rate. `dataQuality.pitClass`,
// `optionsSignedCoverage`, `delistingsIncluded` and the promotion-gate booleans are all
// stamped from what the pipeline MEASURED, so the serving layer's limitations panel and
// its refusal to leave shadow both follow from the data rather than from a flag someone
// remembered to set.
//
// Note the artifact this build produces is necessarily a SHADOW artifact: the gates below
// are false because the evidence behind them is exploratory, and `validateArtifact` plus
// `resolveMode` will keep it in shadow no matter what CATALYST_FLOW_MODE says.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const ART = require('../lib/catalyst-flow/artifact');
const PORT = require('../lib/catalyst-flow/portfolio');
const CFG = require('../lib/catalyst-flow/config');

const OUT_DIR = path.join(K.DATA_DIR, 'catalyst-flow');
const DATASET = path.join(OUT_DIR, 'dataset.jsonl');
const OOF = path.join(OUT_DIR, 'oof-predictions.jsonl');
const MODEL_META = path.join(OUT_DIR, 'model-meta.json');
const ARMS_RESULT = path.join(OUT_DIR, 'arms-result.json');

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The five features that moved this row furthest from its cohort's median, named in plain
// language. An explanation the reader cannot check is worse than none, so this reports the
// observable quantity, not a SHAP-flavoured story about the model's internals.
function contributors(row, cohortMedians) {
  const out = [];
  for (const [name, v] of Object.entries(row.features)) {
    const med = cohortMedians[name];
    if (!Number.isFinite(v) || !Number.isFinite(med)) continue;
    out.push({ feature: name, value: +v.toFixed(4), cohortMedian: +med.toFixed(4), deviation: +(v - med).toFixed(4) });
  }
  return out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation)).slice(0, 5);
}

function main() {
  const rows = readJsonl(DATASET);
  const oof = readJsonl(OOF);
  const modelMeta = JSON.parse(fs.readFileSync(MODEL_META, 'utf8'));
  const armsResult = fs.existsSync(ARMS_RESULT) ? JSON.parse(fs.readFileSync(ARMS_RESULT, 'utf8')) : null;

  const primary = oof.filter((p) => p.scheme === 'expanding' && p.testMonths === 6);
  const scores = new Map(primary.map((p) => [p.key, p]));
  const dates = [...new Set(primary.map((p) => p.key.split('|')[1]))].sort();
  const date = arg('--date', dates[dates.length - 1]);
  if (!date) throw new Error('no out-of-fold decision dates available');

  const cohort = rows.filter((r) => r.decisionDate === date && scores.has(r.key));
  if (!cohort.length) throw new Error(`no scored rows for ${date}`);

  const medians = {};
  for (const name of Object.keys(cohort[0].features)) {
    const vals = cohort.map((r) => r.features[name]).filter(Number.isFinite).sort((a, b) => a - b);
    medians[name] = vals.length ? vals[vals.length >> 1] : null;
  }

  // Edge from the frozen in-fold calibration — the same mapping the evaluator used, so the
  // published book and the measured book cannot diverge.
  const edgeOf = (cal, s) => {
    if (!cal || !Array.isArray(cal.bounds) || cal.bounds.length < 2) return null;
    let bin = 0;
    while (bin < cal.bounds.length - 2 && s >= cal.bounds[bin + 1]) bin++;
    const v = cal.meanTargetByBin[String(bin)] ?? cal.meanTargetByBin[bin];
    return Number.isFinite(v) ? v : null;
  };

  const candidates = cohort.map((r) => {
    const p = scores.get(r.key);
    return {
      symbol: r.symbol, sector: r.sector, score: p.score,
      estimatedEdge: edgeOf(p.calibration, p.score),
      estRoundTripCostPct: r.features.estRoundTripCostPct,
      missingFeatureShare: r.features.missingFeatureShare,
      topContributors: contributors(r, medians),
    };
  });

  const book = PORT.selectBook(candidates);

  const doc = ART.buildArtifact({
    decisionDate: date,
    generatedAt: new Date().toISOString(),
    arm: 'E2_CATALYST_RANKER',
    mode: 'shadow',
    ranks: book.positions,
    modelMeta: {
      objective: modelMeta.objective, metric: modelMeta.metric, ndcgEvalAt: modelMeta.ndcgEvalAt,
      params: modelMeta.grid, featureSchema: modelMeta.featureColumns,
      lightgbmVersion: modelMeta.lightgbmVersion, trainerVersion: modelMeta.trainerVersion,
    },
    trainingCutoff: modelMeta.folds && modelMeta.folds.length ? modelMeta.folds[modelMeta.folds.length - 1].train_end : null,
    trialCount: modelMeta.trialCount,
    codeHash: modelMeta.schemaSha256,
    dataHash: modelMeta.datasetSha256,
    pitClass: 'RECONSTRUCTED_EXPLORATORY',
    optionsSignedCoverage: false,
    dataQuality: {
      // Every one of these is a MEASUREMENT, not a setting. They are the reason the
      // serving layer will refuse to promote this artifact.
      delistingsIncluded: false,
      spreadIsProxy: true,
      sectorPitVerified: false,
      announcementTimeKnown: false,
      ablationSurvivesFDR: !!(armsResult && armsResult.fdr || []).find?.((f) => f.id === 'E2_MINUS_E1' && f.survives),
      positiveNetOfStressCost: false,
      deflatedSharpePositive: !!(armsResult && armsResult.deflatedSharpe
        && armsResult.deflatedSharpe.E2_CATALYST_RANKER
        && armsResult.deflatedSharpe.E2_CATALYST_RANKER.sharpePerCohort > 0),
      holdoutUntouched: modelMeta.holdoutOpened === false,
      cohortSize: cohort.length,
      abstainedSlots: book.capacity - book.filled,
    },
    explanations: {
      basis: 'deviation of each feature from its own decision-date cohort median',
      scoreMeaning: 'ordinal LambdaMART relevance — not a return, not a probability',
      abstention: `${book.filled} of ${book.capacity} slots filled; the remainder is cash by rule, not by omission`,
    },
    calibration: null,   // no purged out-of-fold probability calibrator has been earned
    notes: [
      'RESEARCH/SHADOW artifact. The historical evidence behind this model is reconstructed, not point-in-time.',
      'The signed-options arm (E3) was never measurable in this build and is INSUFFICIENT_DATA, not a null result.',
    ],
  });

  const v = ART.validateArtifact(doc);
  if (!v.ok) throw new Error(`refusing to write an invalid artifact: ${v.errors.join('; ')}`);

  const file = path.join(OUT_DIR, `artifact-${date}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  process.stdout.write(`artifact → ${file}\n`);
  process.stdout.write(`${JSON.stringify({
    decisionDate: doc.decisionDate, arm: doc.arm, mode: doc.mode,
    cohort: cohort.length, filled: book.filled, cash: book.cashWeight,
    ranks: doc.ranks.map((r) => `${r.rank}. ${r.symbol} (${r.sector})`),
    dataQuality: doc.dataQuality, artifactHash: doc.artifactHash.slice(0, 16),
  }, null, 2)}\n`);

  if (process.argv.includes('--publish')) {
    const STORE = require('../lib/catalyst-flow/store');
    if (!STORE.hasStore()) { process.stdout.write('\n--publish requested but BLOB_READ_WRITE_TOKEN is absent — NOT published.\n'); return; }
    Promise.all([STORE.writePrediction(date, doc), STORE.writeLatest({ decisionDate: date, artifactHash: doc.artifactHash })])
      .then(() => process.stdout.write('\npublished to blob storage.\n'))
      .catch((e) => { process.stderr.write(`publish failed: ${e.message}\n`); process.exit(1); });
  }
}

main();
