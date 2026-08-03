'use strict';
// VALIDATION HARNESS V3 (research-harness-v3) — the statistically corrected
// experiment runner. Built BESIDE research-harness-v2 (lib/research/harness.js),
// which is retained for comparability but whose verdicts are now marked as
// requiring revalidation (see DATA-FOUNDATION-V3-IMPLEMENTATION.md).
//
// Corrections over v2 (each one a verified defect or gap):
//   * DEFECT 10 — v2's "block bootstrap" resampled SINGLE dates IID. v3 uses a
//     genuine moving-block bootstrap plus Newey-West HAC t-statistics with
//     horizon-appropriate lags (lib/research/stats-v3.js).
//   * DEFECT 11 — v2 scored rows missing the benchmark feature as 0. v3
//     EXCLUDES them from every comparison, reports benchmark coverage, and
//     evaluates all rankers on the SAME covered population, so candidate and
//     benchmark are compared on identical rows.
//   * DEFECT 12 — BH/FDR existed but never bound a verdict. v3 verdicts are
//     decided AFTER Benjamini-Hochberg correction, with a trial denominator
//     that counts every inspected variant (rankers + declared variants + the
//     hypothesis-registry family count) — never just headline hypotheses.
//   * Paired daily candidate-minus-baseline inference, effective sample size,
//     chronological fold results, regime/cap blocks, outlier dependence, and a
//     required no-information control are all first-class outputs.
//
// This harness measures ranking quality only; it never labels anything
// production-grade, and PASS verdicts stay 'provisional' pending survivorship
// safety and prospective agreement. Deterministic (seeded) → reproducible.

const RQ = require('../rankquality');
const ST = require('./stats-v3');
const { makeExperimentManifest, researchValidity } = require('./schemas');

const HARNESS_V3_VERSION = 'research-harness-v3.1';
const MIN_NAMES_PER_DATE = 3;
const DEFAULT_ALPHA_Q = 0.10;
const DEFAULT_MIN_ESS = 30;
const DEFAULT_MIN_POSITIVE_FOLDS = 2;
const DEFAULT_EMBARGO_BARS = 3;

// Verdict tiers (Phase-6 contract). A missing cost estimate can NEVER satisfy
// an economic gate, and this harness can never grant promotion eligibility by
// itself — that requires prospective agreement plus a human review artifact.
const TIERS = Object.freeze({
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  STATISTICAL: 'STATISTICAL_SIGNAL_CANDIDATE',
  ECONOMIC: 'ECONOMICALLY_VIABLE_CANDIDATE',
  PROMOTION: 'PROSPECTIVE_PROMOTION_ELIGIBLE',
});

// PURGE + EMBARGO (leakage control): a training row may be used only when its
// label FULLY resolved (labelEndDate) strictly before the embargo boundary —
// the decision date `embargoBars` positions before the test fold's first date
// on the observed decision-date axis. A row without labelEndDate cannot PROVE
// it closed and is excluded from training (fail closed) and counted.
// Horizon-awareness is automatic: 5/21/63/126-session labels carry their own
// exact end dates.
function purgeTrainingRows(rows, dates, testStartIdx, embargoBars = DEFAULT_EMBARGO_BARS) {
  const boundaryIdx = Math.max(0, testStartIdx - embargoBars);
  const boundaryDate = dates[boundaryIdx];
  const kept = [];
  let purged = 0, noLabelEnd = 0;
  for (const r of rows) {
    if (!(r.decisionTs < dates[testStartIdx])) continue;   // strictly-past decisions only
    if (!r.labelEndDate) { noLabelEnd++; continue; }
    if (r.labelEndDate < boundaryDate) kept.push(r);
    else purged++;
  }
  return { kept, purged, noLabelEnd, boundaryDate, embargoBars };
}

// Measured cost evidence for one ranker: { net, doubledCostNet,
// stressedLiquidityNet } — all three must be finite MEASUREMENTS (caller
// computes them from a real cost model on the same rows). Missing/partial
// evidence is 'unmeasured' and can never pass.
function costEvidenceCheck(ev) {
  if (!ev || typeof ev !== 'object') return { measured: false, passes: false, detail: 'no cost evidence supplied' };
  const need = ['net', 'doubledCostNet', 'stressedLiquidityNet'];
  const missing = need.filter((k) => !Number.isFinite(ev[k]));
  if (missing.length) return { measured: false, passes: false, detail: `missing measured fields: ${missing.join(', ')}` };
  const failing = need.filter((k) => !(ev[k] > 0));
  return {
    measured: true,
    passes: failing.length === 0,
    detail: failing.length ? `non-positive under: ${failing.join(', ')}` : 'positive net under base, doubled-cost and stressed-liquidity scenarios',
    values: { net: ev.net, doubledCostNet: ev.doubledCostNet, stressedLiquidityNet: ev.stressedLiquidityNet },
  };
}

// Per-date cross-sectional rank-IC with EXPLICIT exclusion of rows missing any
// required feature. Returns { ics: [{date, ic, n}], coverage }.
function perDateICv3(rows, scoreOf, { requireFeatures = [] } = {}) {
  const covered = [], excluded = [];
  for (const r of rows) {
    const missing = requireFeatures.filter((k) => !(r && r.features && Number.isFinite(r.features[k])));
    if (missing.length) excluded.push({ row: r, missing }); else covered.push(r);
  }
  const byDate = new Map();
  for (const r of covered) {
    if (!byDate.has(r.decisionTs)) byDate.set(r.decisionTs, []);
    byDate.get(r.decisionTs).push(r);
  }
  const ics = [];
  for (const [date, group] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const items = group.map((r) => ({ score: scoreOf(r), outcome: r.outcome }))
      .filter((x) => Number.isFinite(x.score) && Number.isFinite(x.outcome));
    if (items.length < MIN_NAMES_PER_DATE) continue;
    const ic = RQ.informationCoefficient(items).ic;
    if (ic != null) ics.push({ date, ic, n: items.length });
  }
  return {
    ics,
    coverage: {
      totalRows: rows.length, coveredRows: covered.length, excludedRows: excluded.length,
      coveredFrac: rows.length ? +(covered.length / rows.length).toFixed(4) : null,
      missingByFeature: requireFeatures.length
        ? Object.fromEntries(requireFeatures.map((k) => [k, excluded.filter((e) => e.missing.includes(k)).length]))
        : {},
    },
  };
}

// BH with an EXPLICIT denominator m ≥ number of supplied p-values, so trials
// inspected without a recorded p still widen the correction.
function bhWithDenominator(items, m) {
  const valid = items.filter((it) => Number.isFinite(it.p) && it.p >= 0 && it.p <= 1).sort((a, b) => a.p - b.p);
  const denom = Math.max(m || 0, valid.length);
  let runningMin = 1;
  const qById = new Map();
  for (let i = valid.length - 1; i >= 0; i--) {
    const raw = (valid[i].p * denom) / (i + 1);
    runningMin = Math.min(runningMin, raw);
    qById.set(valid[i].id, Math.min(1, runningMin));
  }
  return items.map((it) => ({ ...it, q: qById.has(it.id) ? qById.get(it.id) : null, denominator: denom }));
}

const icByDate = (ics) => Object.fromEntries(ics.map((x) => [x.date, x.ic]));

function blockMeans(rows, ics, keyOf) {
  const icMap = icByDate(ics);
  const byBlock = {};
  for (const r of rows) {
    const key = keyOf(r);
    if (!key || !Number.isFinite(icMap[r.decisionTs])) continue;
    (byBlock[key] ||= new Set()).add(r.decisionTs);
  }
  const out = {};
  for (const [key, dates] of Object.entries(byBlock)) {
    const vals = [...dates].map((d) => icMap[d]).filter(Number.isFinite);
    if (vals.length) out[key] = { dates: vals.length, meanIC: +ST.mean(vals).toFixed(4) };
  }
  return out;
}

// The v3 experiment runner.
//   events  — rows { securityId, ticker, decisionTs, horizon, features, outcome, regime?, capBand? }
//   rankers — [{ name, fit, score }]; control-random and momentum-12-1 are
//             auto-appended (required; opts.requireBenchmarks=false is tests-only).
//   opts    — { folds, benchmarkFeature ('mom121'), horizonBars, alphaQ, minEss,
//               minPositiveFolds, seed, costNetByRanker? }
//   meta    — { experimentId, experimentFamilyId, datasetHash, codeCommit,
//               variantsInspected (count of every model/threshold/subgroup tried),
//               survivorshipSafe, survivorshipReason, generatedAt }
function runExperimentV3(events, rankers, opts = {}, meta = {}) {
  const B = require('./baseline-ranker');
  const folds = opts.folds || 4;
  const seed = opts.seed == null ? 12345 : opts.seed;
  const alphaQ = opts.alphaQ ?? DEFAULT_ALPHA_Q;
  const minEss = opts.minEss ?? DEFAULT_MIN_ESS;
  const minPositiveFolds = opts.minPositiveFolds ?? DEFAULT_MIN_POSITIVE_FOLDS;
  const benchmarkFeature = opts.benchmarkFeature || 'mom121';
  const benchmarkName = 'momentum-12-1';
  const controlName = 'control-random';

  let all = [...(rankers || [])];
  if (opts.requireBenchmarks !== false) {
    const have = new Set(all.map((r) => r.name));
    if (!have.has(controlName)) all.push(B.randomRanker);
    if (!have.has(benchmarkName)) all.push(B.momentum121Ranker);
  }

  const rows = (events || []).filter((e) => e && e.decisionTs && Number.isFinite(e.outcome));
  // COMPARABLE POPULATIONS: every ranker is evaluated on rows carrying the
  // benchmark feature, so no ranker gains an edge from rows the benchmark
  // cannot score (and none scores a missing feature as zero).
  const probe = perDateICv3(rows, () => 0, { requireFeatures: [benchmarkFeature] });
  const benchCoverage = probe.coverage;
  const comparable = rows.filter((r) => r && r.features && Number.isFinite(r.features[benchmarkFeature]));

  const dates = [...new Set(comparable.map((r) => r.decisionTs))].sort();
  const D = dates.length;
  const perRanker = {};
  const foldDefs = [];
  for (const r of all) perRanker[r.name] = { ics: [], folds: [] };

  const embargoBars = opts.embargoBars ?? DEFAULT_EMBARGO_BARS;
  let totalPurged = 0, totalNoLabelEnd = 0;
  for (let f = 1; f < folds; f++) {
    const lo = Math.floor((D * f) / folds), hi = Math.floor((D * (f + 1)) / folds);
    if (lo >= hi) continue;
    const testDates = new Set(dates.slice(lo, hi));
    const testRows = comparable.filter((r) => testDates.has(r.decisionTs));
    const purge = purgeTrainingRows(comparable, dates, lo, embargoBars);
    const trainRows = purge.kept;
    totalPurged += purge.purged; totalNoLabelEnd += purge.noLabelEnd;
    foldDefs.push({
      fold: f, from: dates[lo], to: dates[hi - 1], trainN: trainRows.length, testN: testRows.length,
      purgedRows: purge.purged, noLabelEndRows: purge.noLabelEnd,
      embargoBars, embargoBoundary: purge.boundaryDate,
    });
    for (const r of all) {
      const model = r.fit(trainRows, opts.rankerOpts || {});
      const { ics } = perDateICv3(testRows, (row) => r.score(model, row), { requireFeatures: [benchmarkFeature] });
      perRanker[r.name].ics.push(...ics);
      perRanker[r.name].folds.push({ fold: f, datedICs: ics.length, meanIC: ics.length ? +ST.mean(ics.map((x) => x.ic)).toFixed(4) : null });
    }
  }

  // Per-ranker dependence-aware summaries.
  const summaries = {};
  for (const r of all) {
    const ics = perRanker[r.name].ics.sort((a, b) => a.date.localeCompare(b.date));
    const vals = ics.map((x) => x.ic);
    const nw = ST.neweyWest(vals, { horizonBars: opts.horizonBars || null });
    const ess = ST.effectiveSampleSize(vals);
    const mbb = ST.movingBlockBootstrap(vals, { seed, B: opts.bootstrapB || 500 });
    summaries[r.name] = {
      dates: vals.length,
      meanIC: vals.length ? +ST.mean(vals).toFixed(4) : null,
      fracPositive: vals.length ? +(vals.filter((v) => v > 0).length / vals.length).toFixed(2) : null,
      hac: { tstat: nw.tstat == null ? null : +nw.tstat.toFixed(2), lags: nw.lags, naiveTstat: nw.naiveTstat == null ? null : +nw.naiveTstat.toFixed(2) },
      effectiveSampleSize: ess.ess,
      mbbCi90: mbb.ci90 || null,
      chronoFolds: perRanker[r.name].folds,
      positiveFolds: perRanker[r.name].folds.filter((x) => x.meanIC != null && x.meanIC > 0).length,
      outlierDependence: ST.outlierDependence(vals),
      regimeBlocks: blockMeans(comparable, ics, (row) => row.regime || null),
      capBlocks: blockMeans(comparable, ics, (row) => row.capBand || null),
    };
  }

  // Paired candidate-minus-benchmark inference → p-values → BH q-values.
  // Trial denominator counts EVERYTHING inspected: candidate rankers, every
  // declared variant (models, feature sets, thresholds, subgroups), and the
  // registry-level family trials — never just the headline hypotheses.
  const benchIcs = icByDate(perRanker[benchmarkName] ? perRanker[benchmarkName].ics : []);
  const candidates = all.filter((r) => r.name !== benchmarkName && r.name !== controlName);
  const pairedTests = [];
  for (const r of candidates) {
    const paired = ST.pairedDaily(icByDate(perRanker[r.name].ics), benchIcs);
    const nw = ST.neweyWest(paired.diffs, { horizonBars: opts.horizonBars || null });
    pairedTests.push({
      id: r.name,
      pairedN: paired.pairedN,
      meanDiff: paired.diffs.length ? +ST.mean(paired.diffs).toFixed(4) : null,
      tstat: nw.tstat == null ? null : +nw.tstat.toFixed(2),
      p: nw.tstat == null ? null : ST.pFromT(nw.tstat),
      excludedDates: { candidateOnly: paired.candidateOnlyDates, benchmarkOnly: paired.baselineOnlyDates },
    });
  }
  const registryTrials = meta.experimentFamilyId
    ? require('./hypothesis-registry').familyTrials(meta.experimentFamilyId) : 0;
  const trialsInspected = Math.max(
    candidates.length + (meta.variantsInspected || 0),
    registryTrials,
  );
  const withQ = bhWithDenominator(pairedTests, trialsInspected);

  // Verdicts — decided AFTER correction, with the control binding, then
  // TIERED: statistical significance alone can never claim economic viability,
  // and a MISSING cost estimate can never satisfy the economic gate (the old
  // `costNetPositive !== false` null-passes defect is closed).
  const controlMean = summaries[controlName] ? summaries[controlName].meanIC : null;
  const verdicts = {};
  for (const t of withQ) {
    const s = summaries[t.id];
    const cost = costEvidenceCheck(opts.costEvidenceByRanker && opts.costEvidenceByRanker[t.id]);
    const checks = {
      beatsBenchmarkNominal: t.tstat != null && t.tstat > 0,
      qPassesFdr: t.q != null && t.q <= alphaQ,
      sufficientEffectiveN: s.effectiveSampleSize != null && s.effectiveSampleSize >= minEss,
      multiplePositivePeriods: s.positiveFolds >= minPositiveFolds,
      beatsControl: s.meanIC != null && controlMean != null && s.meanIC > controlMean,
      costEvidenceMeasured: cost.measured,
      costNetPositiveUnderStress: cost.measured ? cost.passes : false,   // missing evidence FAILS, never null-passes
      notOutlierDriven: !s.outlierDependence || s.outlierDependence.dominantFrac == null || s.outlierDependence.dominantFrac < 0.5,
    };
    const statRequired = ['beatsBenchmarkNominal', 'qPassesFdr', 'sufficientEffectiveN', 'multiplePositivePeriods', 'beatsControl', 'notOutlierDriven'];
    const statPass = statRequired.every((k) => checks[k] === true);
    const econPass = statPass && cost.measured && cost.passes;
    const prospective = opts.prospectiveEvidence && opts.prospectiveEvidence.agreementVerified === true
      && typeof opts.prospectiveEvidence.humanReviewArtifact === 'string' && opts.prospectiveEvidence.humanReviewArtifact.length > 0;
    const tier = !statPass ? TIERS.NOT_CONFIRMED
      : !econPass ? TIERS.STATISTICAL
        : prospective ? TIERS.PROMOTION : TIERS.ECONOMIC;
    verdicts[t.id] = {
      ...t, checks,
      costEvidence: cost,
      tier,
      verdict: tier === TIERS.NOT_CONFIRMED
        ? 'NOT-CONFIRMED'
        : tier === TIERS.STATISTICAL
          ? `PASS-PROVISIONAL (${TIERS.STATISTICAL}) — survives FDR + dependence-aware inference; cost-net evidence ${cost.measured ? 'FAILS under stress' : 'MISSING'} so economic viability is NOT established; promotion requires measured costs, survivorship safety and prospective agreement`
          : tier === TIERS.ECONOMIC
            ? `PASS-PROVISIONAL (${TIERS.ECONOMIC}) — survives FDR + dependence-aware inference + measured cost-net incl. doubled-cost and stressed-liquidity; promotion still requires survivorship safety and prospective agreement with human review`
            : `PASS-PROVISIONAL (${TIERS.PROMOTION}) — statistical + economic gates passed and prospective agreement with human-review artifact supplied; final promotion remains a human, gated act`,
      nominallySignificantButFdrFailed: checks.beatsBenchmarkNominal && t.p != null && t.p <= 0.05 && !checks.qPassesFdr,
    };
  }

  // Champion selection: controls and rankers with degraded coverage can NEVER
  // be champion; candidates already share the comparable population.
  const champion = candidates
    .map((r) => ({ name: r.name, meanIC: summaries[r.name].meanIC }))
    .filter((x) => x.meanIC != null)
    .sort((a, b) => b.meanIC - a.meanIC)[0] || null;

  const validity = researchValidity({
    productionGrade: false,
    survivorshipSafe: !!meta.survivorshipSafe,
    reason: meta.survivorshipReason || 'survivorship-unsafe unless the caller justifies otherwise',
  });
  const manifest = makeExperimentManifest({
    experimentId: meta.experimentId || 'exp-v3-unnamed',
    experimentFamilyId: meta.experimentFamilyId || null,
    datasetHash: meta.datasetHash || 'unhashed',
    securityMasterVersion: meta.securityMasterVersion || null,
    universePolicy: meta.universePolicy || 'caller-declared',
    featureManifest: require('./features').FEATURE_KEYS,
    labelVersion: meta.labelVersion || 'fwd-outcome-v3',
    foldDefinitions: foldDefs,
    modelParams: opts.rankerOpts || {},
    calibrationParams: {},
    costModel: meta.costModel || null,
    codeCommit: meta.codeCommit || null,
    randomSeed: seed,
    relatedExperimentsAttempted: trialsInspected,
    primaryMetric: 'paired daily candidate-minus-benchmark rank-IC, HAC t + BH q',
    results: Object.fromEntries(Object.entries(summaries).map(([k, v]) => [k, v.meanIC])),
    confidenceIntervals: Object.fromEntries(Object.entries(summaries).map(([k, v]) => [k, v.mbbCi90])),
    researchValidity: validity,
    generatedAt: meta.generatedAt || null,
  });

  return {
    version: HARNESS_V3_VERSION,
    benchmark: { name: benchmarkName, feature: benchmarkFeature, coverage: benchCoverage },
    control: { name: controlName, meanIC: controlMean },
    summaries, pairedVsBenchmark: withQ, verdicts,
    trialsInspected, alphaQ,
    champion,
    foldDefinitions: foldDefs,
    leakageControls: {
      purgeBasis: 'exact-labelEndDate vs decision-date axis',
      embargoBars,
      totalPurged, totalNoLabelEnd,
      note: totalNoLabelEnd > 0 ? `${totalNoLabelEnd} strictly-past rows lacked labelEndDate and were excluded from training (fail closed)` : null,
    },
    manifest,
    overall: champion && verdicts[champion.name] && verdicts[champion.name].verdict.startsWith('PASS')
      ? verdicts[champion.name].verdict
      : 'NOT-CONFIRMED — no candidate survives corrected inference',
  };
}

module.exports = {
  HARNESS_V3_VERSION, MIN_NAMES_PER_DATE, DEFAULT_ALPHA_Q, DEFAULT_MIN_ESS,
  DEFAULT_EMBARGO_BARS, TIERS,
  perDateICv3, bhWithDenominator, runExperimentV3, blockMeans,
  purgeTrainingRows, costEvidenceCheck,
};
