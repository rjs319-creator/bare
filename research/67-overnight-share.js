'use strict';
// Step 67 — OVERNIGHT-SHARE CONDITIONING (exploratory, registered 2026-08-05).
//   node research/67-overnight-share.js
//
// The ONE preregistered exploratory pass for hypothesis `overnight-share-conditioning`
// (family swing-ranking): does the overnight share of trailing 63-session returns
// (onShare63) — or the tug-of-war spread (tugOfWar63) — rank 21-session forward
// total return incremental to m121? Expected direction: HIGH overnight share
// (retail/attention clientele) underperforms, so the candidate rankers score by
// the NEGATIVE of each feature.
//
// Runs through harness-v3 on panel-v3.3 eligible cohorts with both symmetric
// extreme-sensitivity views, then appends ONE evidence record. The 2022-2026
// window is SPENT for this hypothesis when this completes, whatever the answer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const H = require('../lib/research/harness-v3');
const EX = require('../lib/research/execution');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const COHORT = require('./lib/cohort');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const PANEL_PATH = path.join(DATA, 'panel-features-v3.json');
const COHORT_PATH = path.join(DATA, 'cohort-eligibility-v3.json');
const HORIZON = 21;
const TOP_DECILE = 0.10;
const HYP_ID = 'overnight-share-conditioning';

// Candidate rankers — FROZEN direction (short-the-feature): high overnight share
// is the hypothesized UNDERperformer, so low-onShare ranks first.
const onShareRanker = {
  name: 'overnight-share-low',
  fit() { return null; },
  score(_m, row) { const v = row.features.onShare63; return Number.isFinite(v) ? -v : null; },
};
const tugRanker = {
  name: 'tug-of-war-low',
  fit() { return null; },
  score(_m, row) { const v = row.features.tugOfWar63; return Number.isFinite(v) ? -v : null; },
};

// Executable cost evidence for a ranker's frozen top-decile long book —
// identical machinery to 40-foundry-benchmark (next-session-open entry,
// liquidity-tiered costs, RAW bars).
function costEvidenceFor(events, eligibleDates, scoreOf, strategyId, datasetHash) {
  const byDate = new Map();
  for (const e of events) {
    const s = scoreOf(e);
    if (!eligibleDates.has(e.decisionTs) || !Number.isFinite(s)) continue;
    if (!byDate.has(e.decisionTs)) byDate.set(e.decisionTs, []);
    byDate.get(e.decisionTs).push({ e, s });
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
    const ranked = [...group].sort((a, b) => b.s - a.s);
    const top = ranked.slice(0, Math.max(1, Math.floor(ranked.length * TOP_DECILE)));
    for (const { e } of top) {
      const bars = loadBars(e.cacheSymbol || e.ticker);
      if (!bars) continue;
      const dMs = Date.parse(dt);
      let idx = -1; for (let k = 0; k < bars.length; k++) { if (bars[k].ms <= dMs) idx = k; else break; }
      if (idx < 0) continue;
      fills.push(EX.executableOutcome({ bars, decisionIdx: idx, horizonSessions: HORIZON, adv: e.adv }));
    }
  }
  return EX.buildCostEvidence({ fills, strategyId, datasetHash, horizonSessions: HORIZON, generatedAt: new Date().toISOString() });
}

function main() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);
  if (!fs.existsSync(PANEL_PATH) || !fs.existsSync(COHORT_PATH)) {
    console.log('BLOCKED: panel-features-v3.json / cohort-eligibility-v3.json missing — run research/15-panel-features-v3.js (v3.3+) first.');
    process.exitCode = 1;
    return;
  }
  const raw = fs.readFileSync(PANEL_PATH, 'utf8');
  const panel = JSON.parse(raw);
  const hasFeature = panel.months.some((ym) => (panel.panel[ym] || []).some((r) => r.onShare63 != null));
  if (!hasFeature) { console.log('BLOCKED: panel carries no onShare63 — rebuild with panel-v3.3.'); process.exitCode = 1; return; }
  const ledger = JSON.parse(fs.readFileSync(COHORT_PATH, 'utf8'));
  const eligibility = COHORT.eligibilityMapForHorizon(ledger, HORIZON);
  const datasetHash = `${panel.panelVersion}:${panel.datasetHash.slice(0, 16)}`;
  let codeVersion = 'git:unknown';
  try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }
  const dirty = (() => { try { return execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0; } catch { return true; } })();
  if (dirty) codeVersion += '+dirty';

  const events = [];
  for (const ym of panel.months) {
    for (const r of panel.panel[ym]) {
      if (!Number.isFinite(r[`f${HORIZON}`])) continue;
      events.push({
        securityId: r.lid || `sym:${r.s}`,
        ticker: r.s, cacheSymbol: r.cs || r.s, adv: r.adv,
        decisionTs: r.dt || `${ym}-28`,
        labelEndDate: r[`le${HORIZON}`] || null,
        horizon: `${HORIZON}d`,
        features: { mom121: r.m121, onShare63: r.onShare63, tugOfWar63: r.tugOfWar63 },
        outcome: r[`f${HORIZON}`],
        capBand: r.cap >= 2e9 ? 'mid' : 'small',
        extremeFlagged: r[`x${HORIZON}`] === 1,
      });
    }
  }
  const withFeature = events.filter((e) => Number.isFinite(e.features.onShare63)).length;
  console.log(`events ${events.length} (label-ready ${HORIZON}s), with onShare63 ${withFeature}`);

  const costEvidenceByRanker = {
    'momentum-12-1': costEvidenceFor(events, eligibility.eligibleDates, (e) => e.features.mom121, 'momentum-12-1-top-decile-long', datasetHash),
    'overnight-share-low': costEvidenceFor(events, eligibility.eligibleDates, (e) => (Number.isFinite(e.features.onShare63) ? -e.features.onShare63 : null), 'overnight-share-low-top-decile-long', datasetHash),
    'tug-of-war-low': costEvidenceFor(events, eligibility.eligibleDates, (e) => (Number.isFinite(e.features.tugOfWar63) ? -e.features.tugOfWar63 : null), 'tug-of-war-low-top-decile-long', datasetHash),
  };

  const runOnce = (evs, label) => H.runExperimentV3(evs, [onShareRanker, tugRanker], {
    folds: 4, horizonBars: HORIZON, seed: 67,
    cohortEligibility: eligibility,
    costEvidenceByRanker,
  }, {
    experimentId: `overnight-share-${label}`,
    experimentFamilyId: hyp.familyId,
    datasetHash, codeCommit: codeVersion,
    variantsInspected: 2,          // exactly the two frozen rankers — nothing else was looked at
    survivorship: panel.manifest && panel.manifest.survivorship,
    generatedAt: new Date().toISOString(),
  });

  const report = runOnce(events, 'panel-v33-all');
  const reportX = runOnce(events.filter((e) => !e.extremeFlagged), 'panel-v33-exclude-unconfirmed-extremes');

  const show = (rep, name) => {
    const s = rep.summaries[name];
    return s ? `meanIC ${s.meanIC} HAC-t ${s.hac.tstat} ESS ${s.effectiveSampleSize} dates ${s.dates}` : 'n/a';
  };
  for (const name of ['overnight-share-low', 'tug-of-war-low', 'momentum-12-1', 'control-random']) {
    console.log(`${name}: ${show(report, name)}   |   x-view: ${show(reportX, name)}`);
  }
  console.log(`verdicts: ${JSON.stringify(report.verdicts)}`);
  console.log(`cohorts: ${report.cohortReport.eligibleDatesEvaluated} eligible dates, latest ${report.cohortReport.latestEvaluatedDecisionDate}`);
  for (const [k, ce] of Object.entries(costEvidenceByRanker)) console.log(`cost ${k}: fills ${ce.fills} gross ${ce.grossMean} net ${ce.net} doubled ${ce.doubledCostNet} stressed ${ce.stressedLiquidityNet}`);

  const evaluated = events.filter((e) => eligibility.eligibleDates.has(e.decisionTs)).map((e) => e.decisionTs).sort();
  const deps = {
    readJSON: async (p, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p.replace(/^research\//, '')), 'utf8')); } catch { return dflt; } },
    writeJSON: async (p, obj) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    },
  };
  const on = report.summaries['overnight-share-low'];
  const tug = report.summaries['tug-of-war-low'];
  const onX = reportX.summaries['overnight-share-low'];
  const ctrl = report.summaries['control-random'];
  const rec = EL.makeEvidenceRecord({
    hypothesisId: HYP_ID,
    datasetHash,
    periodStart: evaluated[0], periodEnd: evaluated[evaluated.length - 1],
    horizon: `${HORIZON}d`,
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(report.manifest || report)).digest('hex').slice(0, 16),
    metrics: {
      overnightShareLow: { meanIC: on.meanIC, hacT: on.hac.tstat, ess: on.effectiveSampleSize, dates: on.dates, fracPositive: on.fracPositive },
      tugOfWarLow: { meanIC: tug.meanIC, hacT: tug.hac.tstat, ess: tug.effectiveSampleSize, dates: tug.dates },
      sensitivityExcludeUnconfirmedExtremes: { overnightShareLow: { meanIC: onX.meanIC, hacT: onX.hac.tstat, dates: onX.dates } },
      control: { meanIC: ctrl.meanIC, hacT: ctrl.hac.tstat },
      verdicts: report.verdicts,
      eventsWithFeature: withFeature,
      costEvidence: costEvidenceByRanker,
      cohort: { eligibleDatesEvaluated: report.cohortReport.eligibleDatesEvaluated, latestEvaluatedDecisionDate: report.cohortReport.latestEvaluatedDecisionDate, ledgerHash: eligibility.ledgerHash },
    },
    verdict: 'inconclusive',       // the registry entry's status change (if any) is a separate reviewed diff
    mode: 'exploratory',           // exploratory BY REGISTRATION, whatever the tree state
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass on ${panel.panelVersion} (window now SPENT for ${HYP_ID}). Frozen rankers only; variantsInspected=2. Direction registered: high overnight share underperforms.${dirty ? ' Built from a dirty worktree.' : ''}`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

if (require.main === module) main();
module.exports = { onShareRanker, tugRanker, HYP_ID, HORIZON };
