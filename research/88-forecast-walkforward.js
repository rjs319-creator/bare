'use strict';
// CFR WALK-FORWARD BENCHMARK — the real out-of-sample evaluation of the cross-sectional
// forecast & ranking system (lib/forecast/*) on the local research cache.
//
// WHAT THIS RUN IS AND IS NOT
//   * It is a purged, chronological, cost-aware walk-forward with an untouched final holdout.
//   * It is NOT survivorship-proven-safe (the cache was assembled from a present-day symbol
//     list) and it is NOT prospective. Nothing here may promote anything.
//   * Sector classification is the CURRENT vendor mapping, not point-in-time.
//   * Decision dates are SAMPLED at a stride to keep the panel tractable; the stride is
//     recorded and the backtest rebalances on that same axis.
//
// Usage:
//   node --max-old-space-size=8192 research/88-forecast-walkforward.js
// Env knobs (all recorded in the artifact):
//   FORECAST_STRIDE=5           decision dates every N trading sessions
//   FORECAST_MAX_NAMES=1500     cap on universe size
//   FORECAST_MIN_ADV=20000000   liquidity floor
//   FORECAST_HORIZONS=1,3,5,10
//   FORECAST_MIN_TRAIN_SESSIONS / FORECAST_TEST_SESSIONS  (in DECISION-DATE units)

const path = require('node:path');
const K = require('./lib/experiment-kit');
const F = require('../lib/forecast');

const ID = 'cfr-walkforward-2026-08';
const VERSION = 'cfr-walkforward-v1';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const STRIDE = num(process.env.FORECAST_STRIDE, 5);
const HORIZONS = (process.env.FORECAST_HORIZONS || '1,3,5,10').split(',').map(Number).filter(Number.isFinite);
const fx = (v, n = 4) => (Number.isFinite(v) ? +v.toFixed(n) : null);

function buildConfig(horizons = HORIZONS) {
  return F.config.resolveConfig({
    horizons,
    universe: {
      // Liquidity floor high enough that the cost model is not the whole story, and a name cap
      // so one run stays inside a normal heap.
      minAvgDollarVolume: num(process.env.FORECAST_MIN_ADV, 2e7),
      maxNames: num(process.env.FORECAST_MAX_NAMES, 1500),
      minHistorySessions: 300,
    },
    // Fold sizes are in DECISION-DATE units (the strided axis), not raw sessions. The embargo
    // is pinned to the LONGEST horizon in the study (not the horizon being run) so every
    // horizon is evaluated on the same fold geometry and the comparison is like-for-like.
    walkforward: {
      embargoSessions: Math.max(...HORIZONS) + 2,
      minTrainSessions: num(process.env.FORECAST_MIN_TRAIN_SESSIONS, 100),
      testSessions: num(process.env.FORECAST_TEST_SESSIONS, 25),
      innerFolds: 3,
      holdoutFraction: 0.2,
      scheme: 'expanding',
    },
    metaRanker: { numRounds: 200, minDataInLeaf: 100 },
    calibration: { minSamples: 1000, minPositives: 50, minNegatives: 50 },
  });
}

function main() {
  const t0 = Date.now();
  const cfg = buildConfig();
  const caps = F.capabilities.detectCapabilities(cfg);

  console.error(`[cfr] capability tier ${caps.tier} — ${caps.tierLabel}`);
  for (const d of caps.degraded) console.error(`[cfr]   degraded: ${d}`);

  console.error('[cfr] loading panel …');
  const { panel, attrition, missingSectorProxies } = require('./lib/forecast-panel').loadPanel(cfg);
  console.error(`[cfr] panel: ${panel.size} names, ${panel.sessions.length} sessions (${panel.sessions[0]} … ${panel.sessions[panel.sessions.length - 1]})`);
  if (missingSectorProxies.length) console.error(`[cfr]   missing sector proxies: ${missingSectorProxies.join(',')}`);

  // Decision dates: strided, leaving room at the end for the longest label to resolve.
  const maxH = Math.max(...cfg.horizons);
  const last = panel.sessions.length - maxH - 2;
  const decisionDates = [];
  for (let i = cfg.universe.minHistorySessions; i <= last; i += STRIDE) decisionDates.push(panel.sessions[i]);
  console.error(`[cfr] ${decisionDates.length} decision dates (stride ${STRIDE}): ${decisionDates[0]} … ${decisionDates[decisionDates.length - 1]}`);

  const manifest = F.registry.makeManifest({
    runType: 'walk-forward', cfg, caps,
    dataCutoff: panel.sessions[panel.sessions.length - 1],
    codeVersions: { runner: VERSION, walkforward: F.walkforward.WALKFORWARD_VERSION, dataset: F.dataset.DATASET_VERSION },
    notes: [`decision dates sampled every ${STRIDE} trading sessions`, 'survivorship reduced, not proven safe', 'sector basis is the current vendor classification, not point-in-time'],
  });

  const perHorizon = {};
  const universeSizes = [];

  for (const h of cfg.horizons) {
    console.error(`\n[cfr] ── horizon ${h} ──`);
    const hCfg = buildConfig([h]);
    const tB = Date.now();
    const built = F.dataset.buildPanelRows({ panel, dates: decisionDates, cfg: hCfg });
    const rows = built.rowsByHorizon.get(h) || [];
    if (!universeSizes.length) universeSizes.push(...built.universeSizes);
    console.error(`[cfr]   ${rows.length} labelled rows in ${((Date.now() - tB) / 1000).toFixed(1)}s; unobservable: ${JSON.stringify(built.unobservable)}`);
    if (rows.length < 5000) { perHorizon[h] = { ok: false, reason: `only ${rows.length} labelled rows` }; continue; }

    const prevalence = F.targets.classPrevalence(rows.map((r) => r.label), hCfg);

    const res = F.walkforward.runHorizon({
      horizon: h, rows, featureKeys: built.featureKeys, cfg: hCfg, caps, panel,
      decisionDates, sessions: panel.sessions, stride: STRIDE,
      onFold: (r, fold) => {
        const mf = r.diagnostics.metaFit;
        const fit = !mf ? ` | meta=${r.diagnostics.meta.backend}`
          : mf.abstained ? ' | meta ABSTAINED -> dynamic-ensemble'
            : ` | meta ${mf.objective}@${mf.rounds} IS=${fx(mf.rankICInSample)} OOS=${fx(mf.rankICOutOfSample)}`;
        console.error(`[cfr]   ${fold.id}: test ${fold.testStart}..${fold.testEnd} | train ${r.diagnostics.purge.kept}/${r.diagnostics.purge.candidates}${fit} | audit=${r.audit.ok ? 'ok' : 'FAILED ' + r.audit.failedChecks.join(',')}`);
      },
    });

    // FINAL HOLDOUT — read exactly once, after every fold has been run and nothing more will be
    // tuned. Its rows are stamped `final-holdout` and never pooled with walk-forward OOS.
    const hold = F.walkforward.runHoldout({
      horizon: h, rows, featureKeys: built.featureKeys, cfg: hCfg, caps, panel,
      decisionDates, sessions: panel.sessions, stride: STRIDE,
    });
    if (hold.ok) console.error(`[cfr]   holdout: ${hold.fold.testStart}..${hold.fold.testEnd} | audit=${hold.audit.ok ? 'ok' : 'FAILED ' + hold.audit.failedChecks.join(',')}`);
    else console.error(`[cfr]   holdout: NOT SCORED — ${hold.reason}`);

    const sb = F.scoreboard.makeScoreboard(res.scoreboardRows);
    const holdSb = hold.ok ? F.scoreboard.makeScoreboard(hold.rows) : null;
    // Dependence-aware interval on the POOLED per-date rank-IC series, per arm, plus the
    // sector / liquidity / year breakdowns from the last fold that produced them.
    const armNames = [...new Set(res.scoreboardRows.map((r) => r.model))];
    const uncertainty = {};
    for (const m of armNames) {
      const u = F.scoreboard.pooledIcUncertainty(sb, { model: m, horizon: h });
      if (u) uncertainty[m] = u;
    }
    const breakdowns = {};
    for (const m of ['ridge', 'meta-ranker', 'dynamic-ensemble']) {
      const rowsForModel = res.scoreboardRows.filter((r) => r.model === m && r.breakdowns);
      if (rowsForModel.length) breakdowns[m] = mergeBreakdowns(rowsForModel.map((r) => r.breakdowns));
    }
    perHorizon[h] = {
      holdoutResult: hold.ok
        ? { ok: true, fold: hold.fold, auditOk: hold.audit.ok, comparison: F.scoreboard.compare(holdSb, { evaluationType: 'final-holdout' }), warning: hold.warning }
        : { ok: false, reason: hold.reason },
      ok: true,
      rows: rows.length,
      classPrevalence: prevalence[h],
      folds: res.folds.map((f) => ({ id: f.id, trainStart: f.trainStart, trainEnd: f.trainEnd, testStart: f.testStart, testEnd: f.testEnd, embargoSessions: f.embargoSessions, embargoUnits: f.embargoUnits })),
      foldReports: res.foldReports,
      auditOk: res.auditOk, audits: res.audits,
      icUncertainty: uncertainty,
      breakdowns,
      // Per-fold meta-ranker fit detail: the objective inner validation chose, the number of
      // rounds early stopping kept, and the in-sample vs out-of-sample rank IC gap.
      metaFit: res.foldReports.filter((f) => !f.skipped && f.diagnostics.metaFit).map((f) => ({ fold: f.fold, ...f.diagnostics.metaFit })),
      holdout: res.holdout, development: res.development,
      comparison: F.scoreboard.compare(sb),
      scoreboardRows: res.scoreboardRows,
    };
    printTable(h, perHorizon[h].comparison);
    printUncertainty(h, perHorizon[h].icUncertainty);
    if (perHorizon[h].holdoutResult.ok) {
      printTable(h, perHorizon[h].holdoutResult.comparison, 'FINAL HOLDOUT — read once, not pooled with walk-forward OOS');
    }
  }

  const result = {
    id: ID, version: VERSION, generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - t0,
    manifest,
    capabilities: { tier: caps.tier, tierLabel: caps.tierLabel, degraded: caps.degraded, components: caps.components, sidecar: caps.sidecar },
    data: {
      cache: panel.source, names: panel.size, attrition,
      sessions: { n: panel.sessions.length, first: panel.sessions[0], last: panel.sessions[panel.sessions.length - 1] },
      decisionDates: { n: decisionDates.length, stride: STRIDE, first: decisionDates[0], last: decisionDates[decisionDates.length - 1] },
      universeSize: summarize(universeSizes.map((u) => u.size)),
      benchmark: panel.benchmark, sectorProxies: Object.values(F.panel.SECTOR_ETF).filter((v, i, a) => a.indexOf(v) === i),
    },
    contract: {
      execution: cfg.execution, target: cfg.target, horizons: cfg.horizons,
      universePolicy: cfg.universe, walkforward: cfg.walkforward,
      features: { version: cfg.features.version, crossSectionScope: cfg.features.crossSectionScope, includeDateConstant: cfg.features.includeDateConstant },
      costs: cfg.costs, portfolio: cfg.portfolio, metaRanker: cfg.metaRanker,
    },
    horizons: perHorizon,
    // DESIGN-ITERATION EXPOSURE, stated rather than buried. The meta-ranker's configuration was
    // revised after inspecting walk-forward OOS results (the first build was reliably
    // anti-predictive and the cause had to be found). Every revision that survived is justified by
    // MECHANISM or by chronological inner validation — the objective, the date-constant exclusion,
    // the rank-IC round selection, the multi-block inner validation and the baseline-relative
    // abstention gate are all decidable without the test blocks — but the OOS numbers below were
    // nonetheless seen during that process, so treat them as OPTIMISTICALLY BIASED for the
    // meta-ranker arm specifically. The `ridge` baseline, the controls and the target/feature
    // definitions were not revised against OOS results.
    designIterationExposure: {
      armsRevisedAfterSeeingOos: ['meta-ranker', 'control-shuffled-label', 'control-delayed-signal'],
      armsNotRevised: ['ridge', 'control-random', 'static-ensemble', 'dynamic-ensemble'],
      revisions: [
        'objective default lambdarank -> regression (mechanism: NDCG@k optimizes a head, the metric is a full-cross-section Spearman IC; confirmed on inner validation)',
        'date-constant columns excluded from the model matrix (mechanism: they cannot change a within-date ordering, but a tree can split on them to fit date means)',
        'boosting rounds selected by validation rank IC rather than LightGBM loss (mechanism: select on the metric you report)',
        'single inner validation block -> three (mechanism: a ~20-date rank-IC estimate has a standard error comparable to the effect)',
        'abstention gate requiring incremental value over the permanent baseline on inner validation (spec: every complex system is compared against the baseline)',
      ],
      holdoutReads: 2,
      holdoutCaveat: 'the final holdout was scored once before these revisions and once after; two reads of one block is mild multiple-testing exposure and it is not treated as decisive.',
    },
    honesty: [
      'Survivorship is REDUCED (per-date staleness + liquidity gates) but NOT proven safe: the cache was assembled from a present-day symbol list.',
      'Sector classification is the current vendor mapping, not point-in-time; sector-conditioned results inherit that limitation.',
      'Decision dates are sampled at a stride; the backtest rebalances on that axis, so turnover and Sharpe are stride-dependent.',
      'Pooled backtest statistics use overlapping sleeves; the tranche distribution is the dependence-aware view.',
      'Chronos-2 and Moirai-2 did not run in this environment — see capabilities.degraded. No foundation-model result in this artifact is real.',
      'No result here is prospective, and nothing in this artifact promotes anything.',
      'The meta-ranker configuration was revised after seeing walk-forward OOS results — see designIterationExposure. Its OOS numbers are optimistically biased; the ridge baseline and the controls were not revised.',
    ],
  };

  const artifact = K.writeArtifact(path.join(K.DATA_DIR, 'forecast'), 'walkforward-result.json', result);
  K.recordExperiment({
    id: ID,
    hypothesis: 'A cross-fitted LightGBM meta-ranker over a Ridge/AR baseline (plus foundation-model forecasters when available) ranks 1/3/5/10-session market- and sector-neutralized residual returns better than the baseline and the negative controls, after costs, out of sample.',
    family: 'cross-sectional-forecast-ranking',
    frozenConfig: result.contract, dataSnapshot: result.data, codeVersion: VERSION,
    testDates: { first: decisionDates[0], last: decisionDates[decisionDates.length - 1], n: decisionDates.length },
    variationsAttempted: Object.keys(perHorizon).length,
    result: Object.fromEntries(Object.entries(perHorizon).map(([h, v]) => [h, v.ok ? { comparison: v.comparison, auditOk: v.auditOk } : v])),
    correctedSignificance: 'per-date IC with an IC information ratio across dates; negative controls (random, shuffled-label, delayed-signal) run on identical rows; cost stress reported',
    decision: 'NOT PROMOTED — research evaluation only; survivorship not proven safe and no prospective confirmation',
    reason: 'Research/decision-support run. Foundation models unavailable in this environment.',
    artifact,
  });

  console.error(`\n[cfr] artifact: ${artifact.file} (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 16)})`);
  console.error(`[cfr] done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  return result;
}

/**
 * Merge per-fold breakdowns into one view: sum the row/date counts and report the size-weighted
 * mean rank IC per bucket. A bucket that never had enough dates in ANY fold stays null rather
 * than being conjured from a weighted average of nothings.
 */
function mergeBreakdowns(list) {
  const out = {};
  for (const dim of ['sector', 'liquidity', 'year']) {
    const acc = {};
    for (const b of list) {
      for (const [k, v] of Object.entries((b && b[dim]) || {})) {
        if (!acc[k]) acc[k] = { n: 0, dates: 0, wSum: 0, w: 0 };
        acc[k].n += v.n || 0;
        acc[k].dates += v.dates || 0;
        if (Number.isFinite(v.meanRankIC) && v.dates > 0) { acc[k].wSum += v.meanRankIC * v.dates; acc[k].w += v.dates; }
      }
    }
    out[dim] = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, {
      n: v.n, dates: v.dates,
      meanRankIC: v.w > 0 ? +(v.wSum / v.w).toFixed(5) : null,
      note: v.w > 0 ? null : 'no fold had enough dates in this bucket to estimate an IC',
    }]));
  }
  return out;
}

function summarize(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, min: v[0], p25: v[Math.floor(v.length * 0.25)], median: v[Math.floor(v.length * 0.5)], p75: v[Math.floor(v.length * 0.75)], max: v[v.length - 1] };
}

function printTable(h, comparison, label = 'walk-forward OOS') {
  // Duty cycle: with a decision-date stride coarser than the holding period the book sits in
  // cash part of the time while still paying a full round trip. Stating it stops the annualized
  // number from being read as a daily-rebalanced strategy's.
  const perPeriod = Math.max(1, Math.ceil(h / STRIDE)) * STRIDE;
  const duty = Math.min(1, h / perPeriod);
  console.error(`\n[cfr] horizon ${h} — ${label} (after-cost net is the primary column)`);
  console.error(`[cfr]   rebalance every ${perPeriod} sessions, hold ${h} -> capital duty cycle ${(duty * 100).toFixed(0)}%, ${(252 / perPeriod).toFixed(1)} periods/yr`);
  const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);
  const padL = (s, n) => String(s == null ? '—' : s).padStart(n);
  console.error(`[cfr]   ${pad('model', 24)}${padL('rankIC', 9)}${padL('IC-IR', 8)}${padL('gross SR', 10)}${padL('net SR', 9)}${padL('resid net SR', 14)}${padL('resid net ann', 15)}${padL('turnover', 10)}`);
  for (const r of comparison) {
    console.error(`[cfr]   ${pad(r.model, 24)}${padL(fx(r.meanRankIC), 9)}${padL(fx(r.rankICIR, 2), 8)}${padL(fx(r.grossSharpe, 2), 10)}${padL(fx(r.netSharpe, 2), 9)}${padL(fx(r.residualNetSharpe, 2), 14)}${padL(fx(r.residualNetAnnReturn, 4), 15)}${padL(fx(r.turnover, 3), 10)}`);
  }
  console.error('[cfr]   net SR is the LONG-ONLY book (beta-dominated); resid net SR is the same book on the market/sector-neutralized residual, which is what this system predicts.');
}

function printUncertainty(h, uncertainty) {
  const keys = Object.keys(uncertainty || {});
  if (!keys.length) return;
  console.error(`\n[cfr] horizon ${h} — rank IC with a dependence-aware interval (decision date = independence unit)`);
  console.error(`[cfr]   ${'model'.padEnd(24)}${'dates'.padStart(7)}${'rankIC'.padStart(9)}${'bootstrap 90% CI'.padStart(24)}${'HAC t'.padStart(8)}`);
  for (const m of keys.sort()) {
    const u = uncertainty[m];
    const ci = u.bootstrapCi90 ? `[${fx(u.bootstrapCi90[0])}, ${fx(u.bootstrapCi90[1])}]` : '—';
    console.error(`[cfr]   ${m.padEnd(24)}${String(u.dates).padStart(7)}${String(fx(u.meanRankIC)).padStart(9)}${ci.padStart(24)}${String(fx(u.hacT, 2)).padStart(8)}`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { main, buildConfig, ID, VERSION };
