// Reproducible ORBIT validation harness (research artifact).
//   node research/orbit/validate.js [limit] [range] [outerBlocks]
//
// Runs the REAL pipeline end-to-end on a bounded universe: backfill (PIT features
// + executable labels) → nested purged walk-forward → freeze artifact (model +
// OOF calibrators) → score today's board. Prints outer-OOS metrics per horizon,
// calibration status, and the honest survivorship caveat. Falls back to a clear
// "no network / no data" message rather than fabricating results.

const Backfill = require('../../lib/orbit-backfill');
const WF = require('../../lib/orbit-walkforward');
const Routes = require('../../lib/orbit-routes');
const { LARGE } = require('../../lib/universe');

const limit = +(process.argv[2] || 15);
const range = process.argv[3] || '3y';
const outerBlocks = +(process.argv[4] || 6);

(async () => {
  const t0 = Date.now();
  console.log(`ORBIT validation — ${limit} names, range ${range}, ${outerBlocks} outer blocks\n`);
  let bf;
  try {
    bf = await Backfill.runBackfill({ universe: LARGE, scope: 'large', range, limit, step: 10 });
  } catch (e) { console.log('backfill failed (network?):', e.message); process.exit(0); }

  console.log(`Backfill: ${bf.built}/${bf.nTickers} tickers built, ${bf.nSamples} samples, ${bf.skipped} skipped`);
  if (bf.nSamples < 200) { console.log('Too few samples for a credible walk-forward — likely no network or a thin range.'); process.exit(0); }

  for (const horizon of ['days5', 'days21', 'days63']) {
    const wf = WF.walkForward(bf.samples, { horizon, labelField: 'positiveResidual', outerBlocks });
    if (!wf.ok) { console.log(`\n${horizon}: ${wf.reason}`); continue; }
    const p = wf.purged.overall, l = wf.leaky.overall;
    console.log(`\n== ${horizon} ==`);
    console.log(`  purged: IC ${fmt(p && p.ic)}  ICIR ${fmt(p && p.icir)}  posFrac ${fmt(p && p.posFrac)}  Brier ${fmt(p && p.brier)}  topDecileNet ${fmt(p && p.topDecileNet)}  dirAcc ${fmt(p && p.directionalAccuracy)}`);
    console.log(`  leaky : IC ${fmt(l && l.ic)}   (leakage inflation ${fmt(wf.leakageInflation)})`);
    console.log(`  outer folds evaluated: ${wf.purged.nOuter}`);
  }

  const artifact = Routes.trainArtifact(bf.samples, bf.researchValidity);
  console.log('\nArtifact calibration status:');
  for (const h of ['days5', 'days21', 'days63']) {
    const c = artifact.calibrators[h];
    console.log(`  ${h}: model ${artifact.models[h].trained ? 'trained' : 'untrained'}, calibrated=${!!c.calibrated}${c.calibrated ? ` (${c.method}, Brier ${c.metrics.brier})` : ` (${c.reason})`}`);
  }
  console.log(`\nresearchValidity: productionGrade=${bf.researchValidity.productionGrade}, survivorshipSafe=${bf.researchValidity.survivorshipSafe}`);
  console.log(`(${bf.researchValidity.reason})`);
  console.log(`\nElapsed ${(Date.now() - t0) / 1000}s`);
})();

function fmt(x) { return x == null ? 'n/a' : (+x).toFixed(4); }
