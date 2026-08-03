'use strict';
// Alpha Foundry — step 40: the BENCHMARK evidence run on panel-v3.
//   node research/40-foundry-benchmark.js
//
// Re-measures the standing yardstick (12-1 momentum vs the shuffled random
// control) on the authoritative-label panel through harness-v3 (HAC + moving-
// block bootstrap + BH-bounded verdicts) and appends the result to the
// append-only evidence log for hypothesis `momentum-12-1-swing`.
//
// v3.2 corrections:
//   * COHORT ELIGIBILITY — only fully observed cohorts (zero pending rows,
//     coverage ≥ policy minimum on the market-session calendar) enter rank-IC.
//     periodEnd = the last ELIGIBLE evaluated decision date, never the last
//     date with any finite outcome.
//   * SURVIVORSHIP — the manifest's MEASURED contract (survivorship-reduced
//     until a proven historical listing universe exists); never a hand-set
//     boolean.
//   * COST EVIDENCE — measured through the common execution engine
//     (next-session-open entry, liquidity-tiered costs) on the frozen
//     top-decile momentum portfolio; the artifact is content-hashed.
//
// This is NOT an alpha search: no candidate rankers, no variants, no tuning.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const H = require('../lib/research/harness-v3');
const EX = require('../lib/research/execution');
const EL = require('../lib/research/evidence-log');
const COHORT = require('./lib/cohort');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const PANEL_PATH = path.join(DATA, 'panel-features-v3.json');
const COHORT_PATH = path.join(DATA, 'cohort-eligibility-v3.json');
const HORIZON = 21;
const TOP_DECILE = 0.10;

// Executable cost evidence for the frozen momentum rule: on each eligible
// decision date, take the top decile by mom121 and execute long at the next
// session's open, exiting at the +HORIZON-session close, with liquidity-tiered
// costs. Uses RAW cached bars (never the TR label series).
function momentumCostEvidence(events, eligibleDates, datasetHash) {
  const byDate = new Map();
  for (const e of events) {
    if (!eligibleDates.has(e.decisionTs) || !Number.isFinite(e.features.mom121)) continue;
    if (!byDate.has(e.decisionTs)) byDate.set(e.decisionTs, []);
    byDate.get(e.decisionTs).push(e);
  }
  const barsMemo = new Map();
  const loadBars = (sym) => {
    if (barsMemo.has(sym)) return barsMemo.get(sym);
    let out = null;
    try { out = pit.priceSeries(JSON.parse(fs.readFileSync(path.join(pit.CACHE, `${sym}.json`), 'utf8')).price); } catch { out = null; }
    barsMemo.set(sym, out);
    return out;
  };
  const fills = [];
  for (const [dt, group] of byDate) {
    const ranked = [...group].sort((a, b) => b.features.mom121 - a.features.mom121);
    const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length * TOP_DECILE)));
    for (const e of top) {
      const bars = loadBars(e.cacheSymbol || e.ticker);
      if (!bars) continue;
      const dMs = Date.parse(dt);
      let idx = -1; for (let k = 0; k < bars.length; k++) { if (bars[k].ms <= dMs) idx = k; else break; }
      if (idx < 0) continue;
      fills.push(EX.executableOutcome({ bars, decisionIdx: idx, horizonSessions: HORIZON, adv: e.adv }));
    }
  }
  return EX.buildCostEvidence({
    fills, strategyId: 'momentum-12-1-top-decile-long', datasetHash,
    horizonSessions: HORIZON, generatedAt: new Date().toISOString(),
  });
}

function main() {
  if (!fs.existsSync(PANEL_PATH)) {
    console.log('BLOCKED: panel-features-v3.json missing — run research/15-panel-features-v3.js first (see its BLOCKED artifact).');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(COHORT_PATH)) {
    console.log('BLOCKED: cohort-eligibility-v3.json missing — rebuild the panel (v3.2) so experiments have a verified eligibility map.');
    process.exitCode = 1;
    return;
  }
  const raw = fs.readFileSync(PANEL_PATH, 'utf8');
  const panel = JSON.parse(raw);
  const ledger = JSON.parse(fs.readFileSync(COHORT_PATH, 'utf8'));
  const eligibility = COHORT.eligibilityMapForHorizon(ledger, HORIZON);
  const datasetHash = panel.datasetHash
    ? `${panel.panelVersion || 'panel-features-v3'}:${panel.datasetHash.slice(0, 16)}`
    : `panel-features-v3:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  let codeVersion = 'git:unknown';
  try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }
  const dirty = (() => { try { return execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0; } catch { return true; } })();
  if (dirty) codeVersion += '+dirty';

  const events = [];
  for (const ym of panel.months) {
    for (const r of panel.panel[ym]) {
      if (!Number.isFinite(r[`f${HORIZON}`])) continue;   // label-ready rows only (null = pending/unresolved/withheld — fail closed)
      events.push({
        securityId: r.lid || `sym:${r.s}`,
        ticker: r.s,
        cacheSymbol: r.cs || r.s,
        adv: r.adv,
        decisionTs: r.dt || `${ym}-28`,
        labelEndDate: r[`le${HORIZON}`] || null,   // exact label end — required for purge/embargo (rows without it never train)
        horizon: `${HORIZON}d`,
        features: { mom121: r.m121 },
        outcome: r[`f${HORIZON}`],
        capBand: r.cap >= 2e9 ? 'mid' : 'small',
        extremeFlagged: r[`x${HORIZON}`] === 1,
      });
    }
  }

  const costEvidence = momentumCostEvidence(events, eligibility.eligibleDates, datasetHash);

  const runOnce = (evs, label) => H.runExperimentV3(evs, [], {
    folds: 4, horizonBars: HORIZON, seed: 40,
    cohortEligibility: eligibility,
    costEvidenceByRanker: { 'momentum-12-1': costEvidence },
  }, {
    experimentId: `foundry-benchmark-momentum-${label}`,
    experimentFamilyId: 'swing-ranking',
    datasetHash, codeCommit: codeVersion,
    variantsInspected: 0,          // benchmark-only: nothing searched
    survivorship: panel.manifest && panel.manifest.survivorship,
    generatedAt: new Date().toISOString(),
  });

  // SYMMETRIC sensitivity views: include all provider-unconfirmed extremes vs
  // exclude them all (regardless of future path). A claim must survive both.
  const report = runOnce(events, 'panel-v3-all');
  const reportNoExtremes = runOnce(events.filter((e) => !e.extremeFlagged), 'panel-v3-exclude-unconfirmed-extremes');

  const mom = report.summaries['momentum-12-1'];
  const ctrl = report.summaries['control-random'];
  const momX = reportNoExtremes.summaries['momentum-12-1'];
  console.log(`momentum-12-1 on ${panel.panelVersion} (${HORIZON}s, eligible cohorts only): meanIC ${mom.meanIC}, HAC t ${mom.hac.tstat}, MBB CI90 [${(mom.mbbCi90 || []).join(', ')}], ESS ${mom.effectiveSampleSize}, dates ${mom.dates}`);
  console.log(`  sensitivity (exclude unconfirmed extremes): meanIC ${momX.meanIC}, HAC t ${momX.hac.tstat}, dates ${momX.dates}`);
  console.log(`control-random: meanIC ${ctrl.meanIC}, HAC t ${ctrl.hac.tstat}`);
  console.log(`cohorts: evaluated ${report.cohortReport.eligibleDatesEvaluated} eligible dates (min ${report.cohortReport.minNamesPerDate} / median ${report.cohortReport.medianNamesPerDate} names), excluded ${report.cohortReport.excludedIneligibleDateCount} ineligible dates, latest evaluated ${report.cohortReport.latestEvaluatedDecisionDate}`);
  console.log(`cost evidence (${costEvidence.fills} fills, engine ${costEvidence.engine}): gross ${costEvidence.grossMean}, net ${costEvidence.net}, doubled ${costEvidence.doubledCostNet}, stressed ${costEvidence.stressedLiquidityNet}`);

  // periodEnd = the last ELIGIBLE decision date actually evaluated.
  const evaluated = events.filter((e) => eligibility.eligibleDates.has(e.decisionTs)).map((e) => e.decisionTs).sort();
  const deps = {
    readJSON: async (p, dflt) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
    },
    writeJSON: async (p, obj) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    },
  };
  // Prior records stay immutable; the new record names what it supersedes.
  EL.loadEvidence(deps, 'momentum-12-1-swing').then((prior) => {
    const supersedesIds = prior.map((r) => r.recordId);
    const rec = EL.makeEvidenceRecord({
      hypothesisId: 'momentum-12-1-swing',
      datasetHash,
      periodStart: evaluated[0], periodEnd: evaluated[evaluated.length - 1],
      horizon: `${HORIZON}d`,
      codeVersion,
      manifestHash: crypto.createHash('sha256').update(JSON.stringify(report.manifest || report)).digest('hex').slice(0, 16),
      metrics: {
        meanIC: mom.meanIC, hacT: mom.hac.tstat, mbbCi90: mom.mbbCi90,
        effectiveSampleSize: mom.effectiveSampleSize, dates: mom.dates,
        fracPositive: mom.fracPositive, positiveFolds: mom.positiveFolds,
        controlMeanIC: ctrl.meanIC, controlHacT: ctrl.hac.tstat,
        sensitivityExcludeUnconfirmedExtremes: { meanIC: momX.meanIC, hacT: momX.hac.tstat, dates: momX.dates },
        cohort: {
          eligibleDatesEvaluated: report.cohortReport.eligibleDatesEvaluated,
          excludedIneligibleDateCount: report.cohortReport.excludedIneligibleDateCount,
          minNamesPerDate: report.cohortReport.minNamesPerDate,
          medianNamesPerDate: report.cohortReport.medianNamesPerDate,
          latestEvaluatedDecisionDate: report.cohortReport.latestEvaluatedDecisionDate,
          ledgerHash: eligibility.ledgerHash,
        },
        costEvidence,
        labelStates: panel.labelStates, deadNamesIncluded: panel.deadNamesIncluded,
        supersedesRecordIds: supersedesIds,
      },
      // Benchmark yardstick measurement — never a pass.
      verdict: 'inconclusive',
      mode: dirty ? 'exploratory' : 'confirmatory',
      generatedAt: new Date().toISOString(),
      note: `Benchmark yardstick on fully observed cohorts only (${panel.panelVersion}); survivorship=${(panel.manifest && panel.manifest.survivorship && panel.manifest.survivorship.status) || 'unknown'}. Supersedes ${supersedesIds.length} prior records (immutable, retained). No candidates, no variants. Verdict inconclusive by design: this is the ruler, not a claim.${dirty ? ' EXPLORATORY: built from a dirty worktree.' : ''}`,
    });
    if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
    EL.appendEvidence(deps, rec.record).then((r) => {
      console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/momentum-12-1-swing/`);
    });
  });
}

main();
