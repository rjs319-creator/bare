// Reproducible ORBIT-ML validation (research artifact).
//   node research/orbit_ml/validate.js [limit] [range] [outerBlocks]
//
// Real pipeline: backfill with SPECIALIST-AUGMENTED features → date-grouped RANK-model
// nested purged walk-forward per horizon → marginal-ensemble contribution (leave-ORBIT-out
// vs a residual-momentum baseline). Prints purged vs leaky rank-IC and the honest
// survivorship/PIT caveat. Never fabricates: reports "no data" instead of guessing.

const Backfill = require('../../lib/orbit-backfill');
const MLFeat = require('../../lib/orbit-ml-features');
const MLModel = require('../../lib/orbit-ml-model');
const Ensemble = require('../../lib/orbit-ml-ensemble');
const { FEATURE_SET } = require('../../lib/orbit-model');
const { LARGE } = require('../../lib/universe');

const limit = +(process.argv[2] || 20);
const range = process.argv[3] || '5y';
const outerBlocks = +(process.argv[4] || 8);
const fmt = (x) => x == null ? 'n/a' : (+x).toFixed(4);

(async () => {
  const t0 = Date.now();
  console.log(`ORBIT-ML validation — ${limit} names, range ${range}, ${outerBlocks} outer blocks\n`);
  let bf;
  try { bf = await Backfill.runBackfill({ universe: LARGE, scope: 'large', range, limit, step: 10, featureFn: MLFeat.orbitMlFeatures }); }
  catch (e) { console.log('backfill failed (network?):', e.message); process.exit(0); }
  console.log(`Backfill: ${bf.built}/${bf.nTickers} built, ${bf.nSamples} samples\n`);
  if (bf.nSamples < 200) { console.log('Too few samples for a credible walk-forward.'); process.exit(0); }

  const features = [...FEATURE_SET, ...MLFeat.ML_FEATURE_NAMES];
  for (const horizon of ['days5', 'days21', 'days63']) {
    const wf = MLModel.rankWalkForward(bf.samples, { horizon, targetField: 'residualReturn', outerBlocks, features });
    if (!wf.ok) { console.log(`${horizon}: ${wf.reason}`); continue; }
    const p = wf.purged.overall, l = wf.leaky.overall;
    console.log(`== ${horizon} (rank-IC on residual return) ==`);
    console.log(`  purged: IC ${fmt(p && p.ic)}  ICIR ${fmt(p && p.icir)}  posFrac ${fmt(p && p.posFrac)}  dates ${p ? p.nDates : 0}  (outer folds ${wf.purged.nOuter})`);
    console.log(`  leaky : IC ${fmt(l && l.ic)}   (leakage inflation ${fmt(wf.leakageInflation)})\n`);
  }

  // Marginal-ensemble contribution: ORBIT-ML rank vs a residual-momentum peer on the
  // SAME resolved cross-section (leave-one-out rank-IC).
  const joint = [];
  for (const s of bf.samples) {
    const h = s.horizons && s.horizons.days21;
    if (!h || !h.resolved) continue;
    const outcome = h.residualReturn != null ? h.residualReturn : h.netReturn;
    if (outcome == null) continue;
    joint.push({ date: s.decisionDate, ticker: s.ticker, outcome, scores: { residualMomentum: s.features.residMom63 || 0, idiosyncraticPersistence: s.features.drift || 0 } });
  }
  const loo = Ensemble.leaveOneOutIC(joint);
  console.log('Marginal ensemble contribution (leave-ORBIT-out vs residual-momentum peer, 21d):');
  console.log(loo.ready ? `  withIC ${fmt(loo.withIC)}  withoutIC ${fmt(loo.withoutIC)}  marginalDelta ${fmt(loo.marginalDelta)} → ${loo.verdict}` : `  ${loo.reason}`);
  console.log(`\nGBM challenger: ${JSON.stringify(MLModel.gbmStatus(null))}`);
  console.log(`researchValidity: productionGrade=${bf.researchValidity.productionGrade}, survivorshipSafe=${bf.researchValidity.survivorshipSafe}, pointInTimeSafe=${bf.researchValidity.pointInTimeSafe}`);
  console.log(`\nElapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
