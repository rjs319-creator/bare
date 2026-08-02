'use strict';
// research-stats-v3 + research-harness-v3: the deterministic proofs Phase 7
// requires (HAC conservatism, block-bootstrap dependence, benchmark exclusion,
// BH-bound verdicts, control containment, manifest reproducibility).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../lib/research/stats-v3');
const H3 = require('../lib/research/harness-v3');

// ── stats ─────────────────────────────────────────────────────────────────────
function ar1(n, phi, seed = 9) {
  const rnd = ST.lcg(seed);
  const out = [];
  let x = 0;
  for (let i = 0; i < n; i++) { x = phi * x + (rnd() - 0.5); out.push(x + 0.05); }
  return out;
}

test('HAC (Newey-West) is more conservative than IID inference for positively autocorrelated data', () => {
  const xs = ar1(200, 0.8);
  const nw = ST.neweyWest(xs, { lags: 12 });
  assert.ok(Math.abs(nw.tstat) < Math.abs(nw.naiveTstat), `HAC |t| ${nw.tstat} should be < naive |t| ${nw.naiveTstat}`);
  // …and roughly agrees with naive on white noise.
  const wnRnd = ST.lcg(31);
  const wn = Array.from({ length: 200 }, () => wnRnd() - 0.5 + 0.05);
  const nw2 = ST.neweyWest(wn, { lags: 12 });
  assert.ok(Math.abs(nw2.tstat - nw2.naiveTstat) / Math.abs(nw2.naiveTstat) < 0.5, 'no drastic penalty without autocorrelation');
});

test('moving-block bootstrap preserves local dependence: CI wider than single-date IID for AR(1) series', () => {
  const xs = ar1(150, 0.8);
  const mbb = ST.movingBlockBootstrap(xs, { seed: 5 });
  const iid = ST.movingBlockBootstrap(xs, { blockLen: 2, seed: 5 });   // shortest legal block
  // Reference IID via v2 summarizeICs-style single-value resampling:
  const H1 = require('../lib/research/harness');
  const v2 = H1.summarizeICs(xs.map((x, i) => ({ date: `d${i}`, ic: x, n: 10 })), 5);
  const widthMbb = mbb.ci90[1] - mbb.ci90[0];
  const widthV2 = v2.ci90[1] - v2.ci90[0];
  assert.ok(widthMbb > widthV2, `MBB width ${widthMbb} > IID width ${widthV2}`);
  assert.ok(mbb.blockLen > iid.blockLen);
});

test('effective sample size discounts autocorrelated series and leaves white noise ~n', () => {
  const dep = ST.effectiveSampleSize(ar1(300, 0.9));
  assert.ok(dep.ess < 100, `ESS ${dep.ess} well below n=300 for phi=0.9`);
  const rnd = ST.lcg(77);
  const wn = ST.effectiveSampleSize(Array.from({ length: 300 }, () => rnd() - 0.5));
  assert.ok(wn.ess > 200, `white-noise ESS ${wn.ess} stays near n`);
});

test('pairedDaily only compares dates where BOTH sides exist, and reports the exclusions', () => {
  const cand = { d1: 0.1, d2: 0.2, d3: 0.3 };
  const base = { d1: 0.05, d3: 0.1, d4: 0.2 };
  const p = ST.pairedDaily(cand, base);
  assert.equal(p.pairedN, 2);
  assert.equal(p.candidateOnlyDates, 1);
  assert.equal(p.baselineOnlyDates, 1);
  assert.deepEqual(p.diffs.map((d) => +d.toFixed(2)), [0.05, 0.2]);
});

// ── harness ───────────────────────────────────────────────────────────────────
// Synthetic panel: `sig` genuinely ranks outcomes; `mom121` is present on most
// rows; some rows miss it (coverage must be reported, not zero-scored).
function panel({ nDates = 40, perDate = 8, missingFrac = 0.2, sigStrength = 1, seed = 3 } = {}) {
  const rnd = ST.lcg(seed);
  const rows = [];
  for (let d = 0; d < nDates; d++) {
    const date = `2026-01-${String(d + 1).padStart(2, '0')}T00:00:00Z`.replace('2026-01-32', '2026-02-01');
    for (let k = 0; k < perDate; k++) {
      const sig = rnd() - 0.5;
      const noise = (rnd() - 0.5) * 0.5;
      rows.push({
        securityId: `s${k}`, ticker: `s${k}`, decisionTs: `d${String(d).padStart(3, '0')}`,
        horizon: 'swing', regime: d < nDates / 2 ? 'risk-on' : 'risk-off', capBand: k % 2 ? 'small' : 'large',
        features: rnd() < missingFrac ? { sig } : { sig, mom121: rnd() - 0.5 },
        outcome: sig * sigStrength + noise,
      });
    }
  }
  return rows;
}
const sigRanker = { name: 'sig-candidate', fit: () => null, score: (_m, r) => (r.features.sig != null ? r.features.sig : NaN) };
const antiRanker = { name: 'anti-candidate', fit: () => null, score: (_m, r) => -(r.features.sig != null ? r.features.sig : NaN) };

test('runExperimentV3: benchmark coverage reported; all rankers share the covered population', () => {
  const out = H3.runExperimentV3(panel(), [sigRanker], { folds: 4, seed: 11 }, { generatedAt: 'T' });
  assert.ok(out.benchmark.coverage.excludedRows > 0);
  assert.ok(out.benchmark.coverage.coveredFrac < 1);
  assert.ok(out.benchmark.coverage.missingByFeature.mom121 > 0, 'missingness visible per feature');
  assert.ok(out.summaries['sig-candidate'].hac.tstat != null);
  assert.ok(out.summaries['sig-candidate'].effectiveSampleSize >= 1);
  assert.ok(Object.keys(out.summaries['sig-candidate'].regimeBlocks).length === 2, 'regime blocks reported');
  assert.ok(Object.keys(out.summaries['sig-candidate'].capBlocks).length === 2, 'cap blocks reported');
});

test('BH correction CAN change a nominal pass into a non-pass (defect 12 fixed)', () => {
  // Direct: p=0.03 is a nominal .05 pass; 40 inspected trials → q swamps it.
  const [row] = H3.bhWithDenominator([{ id: 'x', p: 0.03 }], 40);
  assert.ok(row.q > 0.1, `q ${row.q} fails the FDR bar although p=0.03 passed nominally`);
  // End-to-end: for SOME effect size on a fixed-seed panel, the SAME evidence
  // passes with a small trial count and fails once every inspected variant is
  // counted — the flip is the point.
  let flipped = false;
  for (const s of [0.05, 0.08, 0.12, 0.18, 0.25, 0.35]) {
    const rows = panel({ sigStrength: s, seed: 21 });
    const few = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 11 }, { generatedAt: 'T', variantsInspected: 0 });
    const many = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 11 }, { generatedAt: 'T', variantsInspected: 4000 });
    const vFew = few.verdicts['sig-candidate'], vMany = many.verdicts['sig-candidate'];
    if (vFew.q != null && vMany.q != null) assert.ok(vMany.q >= vFew.q, 'more inspected variants can never SHRINK q');
    if (vFew.checks.qPassesFdr && !vMany.checks.qPassesFdr) {
      flipped = true;
      assert.match(vMany.verdict, /NOT-CONFIRMED/);
      break;
    }
  }
  assert.ok(flipped, 'an effect size exists where honest trial counting flips the verdict');
});

test('the negative control can never become champion, even when candidates are worthless', () => {
  const out = H3.runExperimentV3(panel(), [antiRanker], { folds: 4, seed: 11 }, { generatedAt: 'T' });
  assert.notEqual(out.champion && out.champion.name, 'control-random');
  assert.match(out.overall, /NOT-CONFIRMED/);
  const v = out.verdicts['anti-candidate'];
  assert.equal(v.checks.beatsControl, false, 'anti-signal loses to the control and the check says so');
});

test('trial denominator never shrinks below the registry family count', () => {
  const out = H3.runExperimentV3(panel(), [sigRanker], { folds: 4, seed: 11 },
    { generatedAt: 'T', experimentFamilyId: 'swing-ranking' });
  const REG = require('../lib/research/hypothesis-registry');
  assert.ok(out.trialsInspected >= REG.familyTrials('swing-ranking'));
  assert.equal(out.manifest.relatedExperimentsAttempted, out.trialsInspected);
});

test('results are reproducible from the manifest: identical inputs + seed → byte-identical output', () => {
  const rows = panel();
  const a = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 42 }, { generatedAt: 'T', datasetHash: 'h1' });
  const b = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 42 }, { generatedAt: 'T', datasetHash: 'h1' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = H3.runExperimentV3(rows, [sigRanker], { folds: 4, seed: 43 }, { generatedAt: 'T', datasetHash: 'h1' });
  assert.equal(c.manifest.randomSeed, 43, 'seed recorded so the run is re-derivable');
});

test('a PASS verdict is only ever provisional and never claims production', () => {
  const strong = panel({ sigStrength: 3, missingFrac: 0.05, nDates: 50, seed: 8 });
  const out = H3.runExperimentV3(strong, [sigRanker], { folds: 4, seed: 11 }, { generatedAt: 'T' });
  const v = out.verdicts['sig-candidate'];
  if (v.verdict.startsWith('PASS')) {
    assert.match(v.verdict, /PROVISIONAL/);
    assert.match(v.verdict, /survivorship|prospective/);
  }
  assert.equal(out.manifest.researchValidity.productionGrade, false);
});
