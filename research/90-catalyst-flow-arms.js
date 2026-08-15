'use strict';
// CATALYST–FLOW — STEP 4: THE LOCKED ARMS, EVALUATED ON IDENTICAL COHORTS.
//
//   node research/90-catalyst-flow-arms.js
//
// Four preregistered arms and two preregistered ablations, scored on the SAME eligible
// decision-date cohorts, with dependence-aware inference and a Benjamini-Hochberg
// correction across exactly that declared family.
//
//   E0_CURRENT_OMEGA        the incumbent OMEGA event score, reconstructed offline at each
//                           event's confirmation close from the app's own pure scorer.
//   E1_SIMPLE_PEAD          transparent surprise + first-session confirmation.
//   E2_CATALYST_RANKER      LambdaMART, no signed-option features (offline, purged WF).
//   E3_CATALYST_FLOW_RANKER the same architecture plus signed opening flow.
//   RIDGE                   regularised linear challenger, fit on the SAME recorded folds.
//
// THE INFERENCE UNIT IS THE DECISION-DATE COHORT, NOT THE STOCK ROW. Five-session holds
// started on nearby dates overlap heavily, so stock rows are not independent observations
// and a t-statistic over 23,869 of them would be fiction. Everything is collapsed to one
// value per date, then run through the app's own HAC (Newey-West, lag 4) + seeded
// moving-block bootstrap machinery, so the research side and the promotion gate compute
// significance identically.
//
// E3 IS NOT MEASURABLE IN THIS BUILD, AND THAT IS REPORTED AS INSUFFICIENT_DATA — NOT AS
// A VERDICT ABOUT ALPHA. An arm that was never fed data has not been shown to be worthless.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const OMEGA = require('../lib/omega-swing');
const CH = require('../lib/catalyst-flow/challengers');
const PORT = require('../lib/catalyst-flow/portfolio');
const SIGNED = require('../lib/catalyst-flow/options-signed');
const DSR = require('../lib/evolve-dsr');
const CFG = require('../lib/catalyst-flow/config');
const REGISTRY = require('../lib/catalyst-flow/registry');

const OUT_DIR = path.join(K.DATA_DIR, 'catalyst-flow');
const DATASET = path.join(OUT_DIR, 'dataset.jsonl');
const OOF = path.join(OUT_DIR, 'oof-predictions.jsonl');
const MODEL_META = path.join(OUT_DIR, 'model-meta.json');
const RESULT_PATH = path.join(OUT_DIR, 'arms-result.json');

const ID = 'catalyst-flow-ranker-2026-08';
const VERSION = 'catalyst-arms-v1';
// Preregistered PRIMARY configuration among the two declared schemes × two block lengths.
// Declared here, before the results are read, so the reported arm is not the flattering one.
const PRIMARY_SCHEME = 'expanding';
const PRIMARY_TEST_MONTHS = 6;

const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── E0: the incumbent, reconstructed point-in-time ──────────────────────────
// `omegaScore` is a pure function of features derived from candles, so the incumbent can
// be scored at each event's confirmation close from bars that existed then. This is the
// real incumbent, not a lookalike — and where it cannot be computed (the scorer needs ~55
// bars) the event is recorded as UNRESOLVED for E0 rather than given a default score.
function omegaScoreAt(candles, idx, spyCandles, spyIdx, sectorCandles, sectorIdx) {
  if (idx < 55) return null;
  const slice = candles.slice(0, idx + 1);
  const bench = {
    spy: spyIdx != null && spyIdx >= 0 ? spyCandles.slice(0, spyIdx + 1) : null,
    sector: sectorIdx != null && sectorIdx >= 0 ? sectorCandles.slice(0, sectorIdx + 1) : null,
  };
  const f = OMEGA.computeFeatures(slice, bench);
  if (!f) return null;
  const s = OMEGA.omegaScore(f, {});
  return Number.isFinite(s.score) ? s.score : null;
}

// ── ONE ABSTENTION MECHANISM FOR EVERY ARM ─────────────────────────────────
// Defect this replaces: E2 received a fitted in-fold decile→edge calibration while E0/E1
// used a raw one-day sector-excess return as their "expected edge". Different machinery
// produced wildly different abstention rates (E2 held cash on 153 of 310 dates, E1 on 45),
// and because every arm's mean is NEGATIVE, abstaining more mechanically moves an arm
// toward zero. The E2−E1 ablation was therefore measuring abstention POLICY at least as
// much as ranking QUALITY — the two things the ablation exists to separate.
//
// Now every arm is calibrated identically: inside each fold's TRAINING window only
// (purged and embargoed exactly as the ranker's), its own scores are cut into deciles and
// each decile's mean net target recorded. Test rows are mapped through those frozen
// boundaries. Only the SCORE differs between arms; the machinery around it is shared.
function calibrateArmInFold(rows, folds, scoreOf, { dates, dIdx, need }) {
  const edges = new Map();
  for (const f of folds) {
    const testIdx = dates.findIndex((d) => d >= f.test_start);
    if (testIdx < 0) continue;
    const train = rows.filter((r) => r.decisionDate >= f.train_start && r.decisionDate < f.valid_start
      && (dIdx.get(r.decisionDate) + need) < testIdx);
    const test = rows.filter((r) => r.decisionDate >= f.test_start && r.decisionDate < f.test_end);
    if (train.length < 300 || !test.length) continue;

    const pairs = train
      .map((r) => ({ s: scoreOf(r), t: r.targets[CFG.PRIMARY_COST_CASE] }))
      .filter((p) => Number.isFinite(p.s) && Number.isFinite(p.t))
      .sort((a, b) => a.s - b.s);
    if (pairs.length < 100) continue;

    const bounds = [];
    for (let q = 0; q <= 10; q++) bounds.push(pairs[Math.min(pairs.length - 1, Math.floor((q / 10) * (pairs.length - 1)))].s);
    const uniq = [...new Set(bounds)];
    if (uniq.length < 2) continue;

    const binOf = (s) => { let b = 0; while (b < uniq.length - 2 && s >= uniq[b + 1]) b++; return b; };
    const sums = new Map();
    for (const p of pairs) {
      const b = binOf(p.s);
      const cur = sums.get(b) || { n: 0, sum: 0 };
      sums.set(b, { n: cur.n + 1, sum: cur.sum + p.t });
    }
    const meanByBin = new Map([...sums].map(([b, v]) => [b, v.sum / v.n]));

    for (const r of test) {
      const s = scoreOf(r);
      if (!Number.isFinite(s)) continue;
      const v = meanByBin.get(binOf(s));
      if (Number.isFinite(v)) edges.set(r.key, v);
    }
  }
  return edges;
}

// Map a score through a frozen in-fold decile calibration → expected net edge.
function edgeFromCalibration(cal, score) {
  if (!cal || !Array.isArray(cal.bounds) || cal.bounds.length < 2) return null;
  let bin = 0;
  while (bin < cal.bounds.length - 2 && score >= cal.bounds[bin + 1]) bin++;
  const v = cal.meanTargetByBin[String(bin)] ?? cal.meanTargetByBin[bin];
  return Number.isFinite(v) ? v : null;
}

// Per-date book outcome for one arm. Returns one value per decision date — the ONLY
// independence unit accepted here.
// `forceTopN` removes the abstention rule entirely and takes the top ten (subject only to
// the sector cap). It isolates PURE RANKING QUALITY, and is reported beside the primary
// read so a reader can see how much of any arm's result is ranking and how much is
// choosing to hold cash.
function armDateSeries(rowsByDate, scoreOf, edgeOf, { hysteresis = false, forceTopN = false } = {}) {
  const out = [];
  const diag = { dates: 0, booksFilled: 0, abstained: 0, positions: 0, unscoredRows: 0 };
  let held = new Map();
  for (const [date, cohort] of rowsByDate) {
    const candidates = [];
    for (const r of cohort) {
      const s = scoreOf(r);
      if (!Number.isFinite(s)) { diag.unscoredRows++; continue; }
      const edge = edgeOf(r, s);
      candidates.push({
        symbol: r.symbol, sector: r.sector, score: s,
        // In the forced variant the edge gate is neutralised by construction (a positive
        // edge comfortably above cost), so every arm fills the same number of slots.
        estimatedEdge: forceTopN ? 1 : edge,
        estRoundTripCostPct: forceTopN ? 0 : r.features.estRoundTripCostPct,
        realised: r.targets[CFG.PRIMARY_COST_CASE],
      });
    }
    if (!candidates.length) continue;
    diag.dates++;

    const book = PORT.selectBook(candidates, { held, hysteresis });
    diag.positions += book.filled;
    if (book.filled) diag.booksFilled++; else diag.abstained++;

    // The target is ALREADY net of the sector benchmark and of cost, so the book's mean
    // target IS the equal-weight excess return. An empty book is cash: 0, not null.
    const value = book.filled
      ? book.positions.reduce((s, p) => s + (Number.isFinite(p.realised) ? p.realised : 0), 0) / book.filled
      : 0;
    out.push({ date, value, filled: book.filled });
    held = new Map(book.positions.map((p) => [p.symbol, true]));
  }
  return { series: out, diag };
}

// lib/evidence-stats rounds its reported mean to 2 decimals — fine for percentages, fatal
// for a per-cohort excess return of ~0.003, which rounds to 0.00 and turns every t-statistic
// into noise. The dependence-aware standard error is reused as-is; the MEAN is recomputed at
// full precision here, and the p-value is derived from those two.
const S3 = require('../lib/research/stats-v3');

function summarize(series, label) {
  const vals = (series || []).map((r) => r.value).filter(Number.isFinite);
  const s = K.summarizeByDate(series, { horizonBars: CFG.CLOCK.holdSessions });
  if (!s || !vals.length) return null;
  const { perDateCounts, ...rest } = s;
  const avgPrecise = vals.reduce((a, b) => a + b, 0) / vals.length;
  const degenerate = vals.every((v) => v === vals[0]);
  const p = (!degenerate && Number.isFinite(rest.se) && rest.se > 0) ? S3.pFromT(avgPrecise / rest.se) : null;
  return {
    label, ...rest,
    avgPrecise: +avgPrecise.toFixed(6),
    avgBpsPerCohort: +(avgPrecise * 10000).toFixed(1),
    p,
    // An arm that abstained on EVERY date is all-cash: a constant series has no dispersion,
    // so there is no test to run. Saying so beats emitting a NaN that reads like a number.
    ...(degenerate ? { pUnavailableReason: 'constant series (the arm abstained on every date) — no dispersion to test' } : {}),
  };
}

// Paired ablation: A − B on the dates BOTH arms produced a book for. Pairing on shared
// dates is what makes the difference an ablation rather than two studies with different
// samples silently subtracted.
function pairedDifference(aSeries, bSeries, label) {
  const bMap = new Map(bSeries.map((r) => [r.date, r.value]));
  const rows = [];
  for (const r of aSeries) {
    if (!bMap.has(r.date)) continue;
    rows.push({ date: r.date, value: r.value - bMap.get(r.date) });
  }
  const s = summarize(rows, label);
  return s ? { ...s, pairedDates: rows.length } : { label, pairedDates: rows.length, insufficient: true };
}

function main() {
  const t0 = Date.now();
  const rows = readJsonl(DATASET);
  const modelMeta = fs.existsSync(MODEL_META) ? JSON.parse(fs.readFileSync(MODEL_META, 'utf8')) : null;
  const oof = fs.existsSync(OOF) ? readJsonl(OOF) : [];

  const spy = K.loadSeries(path.join(K.CACHE_DIR, 'SPY.json'));
  const spyIdx = new Map(spy.map((b, i) => [b.date, i]));
  const seriesCache = new Map();
  const loadS = (sym) => {
    if (!seriesCache.has(sym)) {
      const s = K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
      seriesCache.set(sym, s ? { candles: s, idx: new Map(s.map((b, i) => [b.date, i])) } : null);
    }
    return seriesCache.get(sym);
  };

  // ── E0 scores ──
  let omegaResolved = 0, omegaUnresolved = 0;
  for (const r of rows) {
    const s = loadS(r.symbol);
    const bench = loadS(r.benchmark);
    if (!s) { r.omega = null; omegaUnresolved++; continue; }
    const ci = s.idx.get(r.decisionDate);
    const si = spyIdx.get(r.decisionDate);
    const bi = bench ? bench.idx.get(r.decisionDate) : null;
    const v = ci == null ? null : omegaScoreAt(s.candles, ci, spy, si, bench ? bench.candles : null, bi);
    r.omega = v;
    if (v == null) omegaUnresolved++; else omegaResolved++;
  }

  // ── E2 scores from the PRIMARY preregistered configuration ──
  const primaryOof = oof.filter((p) => p.scheme === PRIMARY_SCHEME && p.testMonths === PRIMARY_TEST_MONTHS);
  const e2 = new Map(primaryOof.map((p) => [p.key, p]));

  // ── RIDGE: fit on the SAME recorded folds, so it is a challenger on equal terms ──
  const ridgeCols = REGISTRY.featureNamesForArm('E2_CATALYST_RANKER')
    .filter((c) => c !== 'sectorId')
    .filter((c) => rows.some((r) => Number.isFinite(r.features[c])));
  const ridgeScores = new Map();
  const ridgeFolds = (modelMeta && modelMeta.folds || []).filter((f) => f.scheme === PRIMARY_SCHEME && f.test_months === PRIMARY_TEST_MONTHS);
  for (const f of ridgeFolds) {
    const inTrain = (d) => d >= f.train_start && d < f.valid_start;
    const inTest = (d) => d >= f.test_start && d < f.test_end;
    // The same purge the ranker gets: a training label must close, plus the embargo,
    // before the test block opens. Applied on the dataset's own date axis.
    const dates = [...new Set(rows.map((r) => r.decisionDate))].sort();
    const testIdx = dates.findIndex((d) => d >= f.test_start);
    const dIdx = new Map(dates.map((d, i) => [d, i]));
    const need = CFG.VALIDATION.purgeSessions + CFG.VALIDATION.embargoSessions;
    const train = rows.filter((r) => inTrain(r.decisionDate) && (dIdx.get(r.decisionDate) + need) < testIdx);
    const test = rows.filter((r) => inTest(r.decisionDate));
    if (train.length < 300 || !test.length) continue;
    const X = train.map((r) => ridgeCols.map((c) => r.features[c]));
    const y = train.map((r) => r.targets[CFG.PRIMARY_COST_CASE]);
    const model = CH.fitRidge(X, y, 1.0);
    if (!model) continue;
    const preds = CH.predictRidge(model, test.map((r) => ridgeCols.map((c) => r.features[c])));
    test.forEach((r, i) => ridgeScores.set(r.key, preds[i]));
  }

  // ── Cohorts: the SAME dates for every arm ──
  // Restricted to dates the offline model actually produced out-of-fold predictions for,
  // so no arm is silently scored on a period another arm never saw.
  const testDates = new Set(primaryOof.map((p) => p.key.split('|')[1]));
  const cohortRows = rows.filter((r) => testDates.has(r.decisionDate));
  const byDate = new Map();
  for (const r of cohortRows) {
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const orderedDates = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  // ── Arms ──
  // Every arm gets the SAME abstention machinery (see calibrateArmInFold): its own scores,
  // calibrated to expected net edge inside the training fold only. Nothing but the score
  // differs between arms.
  const allDates = [...new Set(rows.map((r) => r.decisionDate))].sort();
  const calCtx = {
    dates: allDates,
    dIdx: new Map(allDates.map((d, i) => [d, i])),
    need: CFG.VALIDATION.purgeSessions + CFG.VALIDATION.embargoSessions,
  };
  const scoreOfE0 = (r) => (Number.isFinite(r.omega) ? r.omega : null);
  const scoreOfE1 = (r) => { const s = CH.transparentPeadScore(r.features); return s ? s.score : null; };
  const scoreOfE2 = (r) => { const p = e2.get(r.key); return p ? p.score : null; };
  const scoreOfRidge = (r) => (ridgeScores.has(r.key) ? ridgeScores.get(r.key) : null);

  const edgeE0 = calibrateArmInFold(rows, ridgeFolds, scoreOfE0, calCtx);
  const edgeE1 = calibrateArmInFold(rows, ridgeFolds, scoreOfE1, calCtx);
  const edgeRidge = calibrateArmInFold(rows, ridgeFolds, scoreOfRidge, calCtx);

  const armResults = {};
  const ARM_SPECS = [
    { id: 'E0_CURRENT_OMEGA', score: scoreOfE0, edge: (r) => edgeE0.get(r.key) ?? null },
    { id: 'E1_SIMPLE_PEAD', score: scoreOfE1, edge: (r) => edgeE1.get(r.key) ?? null },
    // E2 keeps the calibration the trainer emitted — the identical construction, computed
    // inside the same fold by the process that owns the model's training scores.
    { id: 'E2_CATALYST_RANKER', score: scoreOfE2, edge: (r, s) => { const p = e2.get(r.key); return p ? edgeFromCalibration(p.calibration, s) : null; } },
    { id: 'RIDGE', score: scoreOfRidge, edge: (r) => edgeRidge.get(r.key) ?? null },
  ];

  const series = {}, forced = {};
  for (const spec of ARM_SPECS) {
    const primaryRun = armDateSeries(orderedDates, spec.score, spec.edge);
    const forcedRun = armDateSeries(orderedDates, spec.score, spec.edge, { forceTopN: true });
    series[spec.id] = primaryRun.series;
    forced[spec.id] = forcedRun.series;
    armResults[spec.id] = {
      ...summarize(primaryRun.series, spec.id),
      diag: primaryRun.diag,
      forcedTopN: { ...summarize(forcedRun.series, `${spec.id}:forced-top10`), diag: forcedRun.diag },
    };
  }
  armResults.E0_CURRENT_OMEGA.resolved = omegaResolved;
  armResults.E0_CURRENT_OMEGA.unresolved = omegaUnresolved;

  const e1 = { series: series.E1_SIMPLE_PEAD };
  const e2res = { series: series.E2_CATALYST_RANKER };
  const ridgeRes = { series: series.RIDGE };

  // ── E3: never measured, therefore never judged ──
  const signed = SIGNED.coverageReport(null);
  armResults.E3_CATALYST_FLOW_RANKER = SIGNED.armVerdict({ coverage: signed.optionsSignedCoverage, pairedCohorts: 0, result: null });

  // ── Ablations ──
  const ablations = {
    E2_MINUS_E1: pairedDifference(e2res.series, e1.series, 'E2 − E1 (incremental value of nonlinear ranking)'),
    E3_MINUS_E2: {
      label: 'E3 − E2 (incremental value of licensed signed options flow)',
      verdict: 'INSUFFICIENT_DATA',
      reason: 'E3 has no signed opening-flow feed, so the difference was never computed. This is NOT evidence of no incremental alpha.',
    },
    // Reported alongside, because "did the machine beat the line?" is the question a
    // reader actually has.
    E2_MINUS_RIDGE: pairedDifference(e2res.series, ridgeRes.series, 'E2 − RIDGE (nonlinear vs linear, same folds)'),
    // PURE RANKING, abstention removed. Every arm fills the same slots on the same dates,
    // so this difference cannot be produced by one arm holding more cash than another.
    E2_MINUS_E1_FORCED: pairedDifference(forced.E2_CATALYST_RANKER, forced.E1_SIMPLE_PEAD,
      'E2 − E1 with abstention REMOVED (forced top-10) — isolates ranking quality'),
  };

  // ── Multiple testing across EXACTLY the declared family ──
  const family = [
    ...CFG.ARMS.filter((a) => armResults[a] && Number.isFinite(armResults[a].p)).map((a) => ({ id: a, p: armResults[a].p })),
    ...(Number.isFinite(ablations.E2_MINUS_E1.p) ? [{ id: 'E2_MINUS_E1', p: ablations.E2_MINUS_E1.p }] : []),
  ];
  const fdr = K.fdr(family, { alpha: 0.05 });

  // ── Deflated Sharpe, deflated by the ACTUAL trial count ──
  const trialCount = (modelMeta && modelMeta.trialCount) || 0;
  // Deflated Sharpe on the per-cohort series, deflated by the number of configurations
  // ACTUALLY tried (the trial registry's own count, not a flattering guess). The Sharpe is
  // per-cohort, not annualised — annualising an overlapping five-session series would
  // multiply the very dependence the HAC correction exists to respect.
  const dsrOf = (series) => {
    const vals = series.map((r) => r.value).filter(Number.isFinite);
    if (vals.length < 12) return null;
    const m = DSR.moments(vals);
    if (!(m.sd > 0)) return { dsr: null, reason: 'zero dispersion' };
    const sr = m.mean / m.sd;
    const out = DSR.deflatedSharpe(sr, m.n, m.skew, m.kurt, Math.max(1, trialCount), null);
    return { ...out, sharpePerCohort: +sr.toFixed(4), n: m.n, annualised: false };
  };

  const result = {
    id: ID, version: VERSION,
    ranAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    primaryConfiguration: { scheme: PRIMARY_SCHEME, testMonths: PRIMARY_TEST_MONTHS, costCase: CFG.PRIMARY_COST_CASE, declaredBeforeReadingResults: true },
    cohorts: { decisionDates: orderedDates.length, rows: cohortRows.length, identicalAcrossArms: true },
    arms: armResults,
    ablations,
    fdr,
    deflatedSharpe: {
      trialCount,
      E2_CATALYST_RANKER: dsrOf(e2res.series),
      E1_SIMPLE_PEAD: dsrOf(e1.series),
    },
    model: modelMeta ? {
      trainer: modelMeta.trainerVersion, lightgbm: modelMeta.lightgbmVersion,
      objective: modelMeta.objective, metric: modelMeta.metric, ndcgEvalAt: modelMeta.ndcgEvalAt,
      featureCount: modelMeta.featureCount, trialCount: modelMeta.trialCount,
      meanValidNdcg10: modelMeta.meanValidNdcg10,
      leakageDiagnostic: modelMeta.leakageDiagnostic,
      holdoutOpened: modelMeta.holdoutOpened,
      datasetSha256: modelMeta.datasetSha256,
    } : null,
    honesty: {
      inferenceUnit: 'decision-date cohort (never the stock row)',
      hac: 'Newey-West lag 4 via lib/evidence-stats, floored at the IID SE',
      bootstrap: 'seeded moving-block, 95%; the WIDER of HAC-t and bootstrap is reported',
      multipleTesting: `Benjamini-Hochberg across the ${CFG.DECLARED_TEST_FAMILY_SIZE}-member declared family`,
      pitClass: 'RECONSTRUCTED_EXPLORATORY — the consensus archive is a post-release vendor snapshot',
      promotionEligible: false,
      promotionBlockers: [
        'estimates are not point-in-time (0 of 24,533 ledger rows observed at their own cutoff)',
        'delisting RETURNS are absent from the price cache (survivorship not proven safe)',
        'no signed customer opening option flow — E3 was never measurable',
        'NDCG@10 is near-degenerate on this cohort distribution (median cohort 8 names ≤ 10)',
      ],
      signedOptions: signed,
    },
  };

  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n');

  // Append to the shared experiment registry — winners AND losers, one ledger.
  K.recordExperiment({
    id: ID,
    hypothesis: 'Post-earnings/guidance underreaction, ranked by LambdaMART over frozen event features, beats a transparent PEAD score on net 5-session sector-excess return.',
    version: VERSION,
    config: { primary: result.primaryConfiguration, arms: CFG.ARMS, ablations: CFG.ABLATIONS.map((a) => a.id) },
    dataSnapshot: { rows: rows.length, dates: result.cohorts.decisionDates, datasetSha256: modelMeta ? modelMeta.datasetSha256 : null },
    variationsAttempted: trialCount,
    // Basis points per cohort, NOT the 2-decimal rounded mean — a permanent ledger that
    // records a −19.8 bps result as "0" is worse than no ledger, because it will be read
    // years later as a measured null.
    unit: 'basis points of sector-excess return per decision-date cohort, net of cost',
    result: {
      E0: armResults.E0_CURRENT_OMEGA && armResults.E0_CURRENT_OMEGA.avgBpsPerCohort,
      E1: armResults.E1_SIMPLE_PEAD && armResults.E1_SIMPLE_PEAD.avgBpsPerCohort,
      E2: armResults.E2_CATALYST_RANKER && armResults.E2_CATALYST_RANKER.avgBpsPerCohort,
      RIDGE: armResults.RIDGE && armResults.RIDGE.avgBpsPerCohort,
      E3: 'INSUFFICIENT_DATA',
      ablationE2minusE1: ablations.E2_MINUS_E1.avgBpsPerCohort,
      ablationE3minusE2: 'INSUFFICIENT_DATA',
    },
    deflatedSharpe: result.deflatedSharpe,
    fdr,
    costStress: Object.keys(CFG.COST_CASES),
    decision: 'RESEARCH_ONLY — not promotable',
    reason: result.honesty.promotionBlockers.join('; '),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`\nresult → ${RESULT_PATH}\n`);
}

main();
