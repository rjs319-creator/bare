// Reproducible negative-controls run on REAL data (research artifact).
//   node research/orbit_ml/controls.js [limit] [range] [outerBlocks]
//
// Backfills survivorship-biased samples and runs the leakage/robustness battery,
// then prints the honest verdict + the dataset-suitability gate. Reports "no data"
// rather than fabricating.

const Backfill = require('../../lib/orbit-backfill');
const MLFeat = require('../../lib/orbit-ml-features');
const Controls = require('../../lib/orbit-controls');
const PIT = require('../../lib/pit-contract');
const { FEATURE_SET } = require('../../lib/orbit-model');
const { LARGE } = require('../../lib/universe');

const limit = +(process.argv[2] || 24);
const range = process.argv[3] || '5y';
const outerBlocks = +(process.argv[4] || 6);
const f = (x) => x == null ? 'n/a' : (+x).toFixed(4);

(async () => {
  const t0 = Date.now();
  console.log(`ORBIT negative controls — ${limit} names, ${range}, ${outerBlocks} outer blocks\n`);
  let bf;
  try { bf = await Backfill.runBackfill({ universe: LARGE, scope: 'large', range, limit, step: 10, featureFn: MLFeat.orbitMlFeatures }); }
  catch (e) { console.log('backfill failed (network?):', e.message); process.exit(0); }
  console.log(`Backfill: ${bf.built} tickers, ${bf.nSamples} samples\n`);
  if (bf.nSamples < 200) { console.log('Too few samples.'); process.exit(0); }

  const features = [...FEATURE_SET, ...MLFeat.ML_FEATURE_NAMES];
  const out = Controls.runControls(bf.samples, { horizon: 'days21', features, outerBlocks });
  console.log(`VERDICT: ${out.verdict}`);
  console.log(`  ${out.reason}\n`);
  console.log(`  real purged IC          : ${f(out.realIC)}`);
  console.log(`  shuffled-label IC       : ${f(out.controls.shuffled.shuffledIC)}  (leak suspected: ${out.controls.shuffled.leakSuspected})`);
  console.log(`  future-feature flags    : ${out.controls.futureFeat.flagged.length} ${JSON.stringify(out.controls.futureFeat.flagged.slice(0, 5))}`);
  console.log(`  random-ranker IC        : ${f(out.controls.randomRanker.ic)}  (ok: ${out.controls.randomRanker.ok})`);
  const dc = out.controls.doubledCost;
  console.log(`  doubled-cost top-decile : base ${f(dc.baseTopDecileNet)} → 2x ${f(dc.doubledTopDecileNet)}  (survives: ${dc.survivesDoubledCost})`);
  const dy = out.controls.dropYear;
  console.log(`  drop-best-year          : full ${f(dy.fullIC)} → without ${dy.bestYear} ${f(dy.withoutBestYearIC)}  (robust: ${dy.robust})`);

  const suit = PIT.datasetSuitability({ hasRejectedCandidates: true, hasDelisted: false, pointInTimeUniverse: false });
  console.log(`\nDataset suitability: trainReady=${suit.trainReady}, evalOnly=${suit.evalOnly}, survivorshipSafe=${suit.survivorshipSafe}`);
  suit.reasons.forEach(r => console.log(`  - ${r}`));
  console.log(`\nElapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
