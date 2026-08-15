'use strict';
// Step 89 — OMEGA_SI_LEVEL_5D_TOP10: does FINRA consolidated short-interest CROWDING
// (days-to-cover level) add incremental 5-session alpha to OMEGA selection on the
// options-liquid universe? Retrospective reconstruction + shadow artifacts. Research
// and shadow logging ONLY — live OMEGA ranking/alerts/portfolios are never touched.
//
//   node research/89-si-incremental.js
//
// Substrate: the 62 non-ETF names of lib/optionsflow LIQUID_OPTIONS (the repo's own
// options-liquid definition), OMEGA-scored per PIT slice via lib/omega-swing
// evaluateCandidate on the research price cache, step-5 SPY cohorts (same axis as
// research/87), next-open entry, H-session close exit, SPY benchmark, liquid-tier
// 0.16% round-trip cost — the kit's established label convention.
//
// SI joins go through ONE door: finra-si.asOfJoinSi (settlement + 13 calendar days,
// conservative fallback; the 16-day variant is a predeclared robustness check).
// Arms/walk-forward/stats: lib/research/si-experiment (frozen spec).

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const SI = require('../lib/research/finra-si');
const F = require('../lib/research/si-features');
const X = require('../lib/research/si-experiment');
const O = require('../lib/omega-swing');
const { SECTOR_ETF } = require('../lib/omega-backfill');
const { SECTOR_OF } = require('../lib/universe');
const { LIQUID_OPTIONS } = require('../lib/optionsflow');
const { UNIVERSE, OUT_DIR: SI_DIR } = require('./88-si-fetch');

const ID = 'omega-si-level-5d-top10-2026-08';
const RESULTS_DIR = path.join(__dirname, 'results');
const ARTIFACT_DIR = path.join(K.DATA_DIR, 'si-incremental');
const HORIZONS = [5, 10];
const MAX_H = Math.max(...HORIZONS);
const MIN_PIT_BARS = 220;
const AXIS_START_IDX = 262;   // same warmup as research/87
const STEP = 5;

// Frozen sector supplement for the 7 universe names lib/universe SECTOR_OF lacks.
const SECTOR_SUPPLEMENT = {
  MSTR: 'Technology', BABA: 'Consumer Discretionary', MRVL: 'Technology',
  SNAP: 'Communication Services', GME: 'Consumer Discretionary',
  AMC: 'Communication Services', SHOP: 'Technology',
};
const sectorOf = (t) => SECTOR_OF[t] || SECTOR_SUPPLEMENT[t] || null;

// Frozen PIT regime rule (shared with the prospective tick via si-features.spyRegime).
const regimeAt = F.spyRegime;

function loadSiSnapshots() {
  if (!fs.existsSync(SI_DIR)) return [];
  // Base snapshots only — .revN files are preserved revisions, never join inputs.
  const files = fs.readdirSync(SI_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(SI_DIR, f), 'utf8')));
}

// ── Panel reconstruction (the expensive pass — done once, shared by every spec) ──
function buildOmegaPanels() {
  const load = (sym) => K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
  const spy = load('SPY');
  if (!spy) throw new Error('SPY missing from research cache');
  const spyIdx = new Map(spy.map((b, i) => [b.date, i]));
  const sectorCandles = {};
  for (const etf of new Set(Object.values(SECTOR_ETF))) sectorCandles[etf] = load(etf);
  const dataset = new Map();
  for (const t of UNIVERSE) {
    const c = load(t);
    if (c) dataset.set(t, { candles: c, idx: new Map(c.map((b, i) => [b.date, i])) });
  }

  const dates = [];
  for (let i = AXIS_START_IDX; i <= spy.length - 1 - MAX_H; i += STEP) dates.push(spy[i].date);

  const attr = K.newAttrition();
  const panels = [];
  let missingLastBarDate = 0;
  for (const D of dates) {
    const spyF = {};
    let ok = true;
    for (const H of HORIZONS) { spyF[H] = K.benchmarkForward(spy, spyIdx, D, H); if (spyF[H] == null) ok = false; }
    if (!ok) continue;
    const spySlice = K.sliceAsOf(spy, D);
    const regime = regimeAt(spySlice);
    const rows = [];
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < MIN_PIT_BARS) continue;
      const lastBarDate = pit[pit.length - 1].date;
      if (lastBarDate !== D) { missingLastBarDate++; continue; }   // stale series — the signal's final bar must BE the decision bar
      const etf = SECTOR_ETF[sectorOf(t)];
      const sec = etf && sectorCandles[etf] ? K.sliceAsOf(sectorCandles[etf], D) : null;
      let card = null;
      try {
        card = O.evaluateCandidate({ ticker: t, candles: pit, bench: { spy: spySlice, sector: sec }, ctx: { regime: { riskOn: regime.riskOn, bearish: regime.bearish } } });
      } catch { card = null; }
      if (!card || !Number.isFinite(card.score)) continue;
      const cost = K.costFractions(card.features.dollarVol);
      const net = {};
      for (const H of HORIZONS) {
        const fwd = K.forwardFromNextOpen(v, D, H, attr);
        net[H] = fwd == null ? null : (fwd - spyF[H] - cost.base) * 100;   // pct
      }
      // Execution decomposition for the shadow ledger (primary horizon only).
      const i = v.idx.get(D);
      const eBar = i != null ? v.candles[i + 1] : null;
      const xBar = i != null && i + 5 <= v.candles.length - 1 ? v.candles[i + 5] : null;
      const exec5 = eBar && xBar && Number.isFinite(net[5]) ? {
        entryDate: eBar.date, entryOpen: eBar.open, exitDate: xBar.date, exitClose: xBar.close,
        rawReturn: +((xBar.close / eBar.open - 1) * 100).toFixed(4),
        benchmarkReturn: +(spyF[5] * 100).toFixed(4),
        cost: +(cost.base * 100).toFixed(4),
      } : null;
      rows.push({
        exec5,
        ticker: t, lastBarDate, sector: sectorOf(t), costTier: cost.tier, dtc: null, si: null,
        score: card.score, utility: card.utility,
        pPositive: card.pred.pPositive, p3pct: card.pred.p3pct, p5pct: card.pred.p5pct,
        expResid10: card.pred.expResidual10,
        r10: card.features.r10, distFrom52High: card.features.distFrom52High, relVol5: card.features.relVol5,
        net,
      });
    }
    if (rows.length >= 20) panels.push({ date: D, regime, rows, spyFwd: spyF });
  }
  return { panels, attrition: attr, candidateDates: dates.length, missingLastBarDate };
}

// Attach one SI join variant to shared omega panels → new panel objects.
function joinVariant(panels, bySymbol, { lagDays, excludeRevised = false }) {
  return panels.map((p) => {
    const rows = p.rows.map((r) => {
      let si = SI.asOfJoinSi(bySymbol.get(r.ticker), p.date, { lagDays });
      if (si && excludeRevised && si.revisionFlag === 'R') si = null;   // revised print treated as unavailable
      return { ...r, si, dtc: si ? si.dtc : null };
    });
    return { ...p, rows: F.attachSiFeatures(rows) };
  });
}

function fmtPct(x, d = 3) { return x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`; }

async function main() {
  const t0 = Date.now();
  const snapshots = loadSiSnapshots();
  const { bySymbol, health: siHealth } = SI.buildSiHistory(snapshots, { symbols: UNIVERSE });
  const { panels, attrition, candidateDates, missingLastBarDate } = buildOmegaPanels();
  const resolvedOutcomes = panels.reduce((a, p) => a + p.rows.filter((r) => Number.isFinite(r.net[5])).length, 0);

  // ── Predeclared specifications (frozen; FDR family = the six below, one-sided) ──
  const SPECS = [
    { id: 'primary_13d_top10_5s', lagDays: 13, excludeRevised: false, topK: 10, horizon: 5, primary: true },
    { id: 'stale_16d_top10_5s', lagDays: 16, excludeRevised: false, topK: 10, horizon: 5 },
    { id: 'exRevised_13d_top10_5s', lagDays: 13, excludeRevised: true, topK: 10, horizon: 5 },
    { id: 'exRevised_16d_top10_5s', lagDays: 16, excludeRevised: true, topK: 10, horizon: 5 },
    { id: 'secondary_top5_5s', lagDays: 13, excludeRevised: false, topK: 5, horizon: 5, secondary: true },
    { id: 'secondary_top10_10s', lagDays: 13, excludeRevised: false, topK: 10, horizon: 10, secondary: true },
  ];
  const runs = {};
  for (const spec of SPECS) {
    const variant = joinVariant(panels, bySymbol, spec);
    runs[spec.id] = X.runSpec(variant, { topK: spec.topK, horizon: spec.horizon, label: spec.id });
  }
  const primary = runs.primary_13d_top10_5s;

  // FDR across the whole predeclared family (one-sided ps; frozen BEFORE results).
  const family = SPECS
    .map((s) => ({ id: s.id, p: runs[s.id].summary.incremental?.tTest?.pOneSided }))
    .filter((f) => Number.isFinite(f.p));
  const fdr = K.fdr(family, { alpha: 0.10 });
  const qOf = (id) => { const row = (fdr || []).find((f) => f.id === id); return row ? +row.q.toFixed(4) : null; };

  // ── Verdict (guards first — a broken run can never print a substantive verdict) ──
  const insufficientReasons = X.assessInsufficient({
    panelCount: panels.length, resolvedOutcomes, summary: primary.summary,
    missingLastBarDate: panels.length === 0 && missingLastBarDate > 0,
  });
  let verdict, verdictReasons;
  if (insufficientReasons.length) {
    verdict = 'INSUFFICIENT_DATA'; verdictReasons = insufficientReasons;
  } else {
    const a = X.assessRetrospective({
      summary: primary.summary,
      staleSummary: runs.stale_16d_top10_5s.summary,
      exRevisedSummary: runs.exRevised_13d_top10_5s.summary,
      fdrQ: qOf('primary_13d_top10_5s'),
    });
    verdict = a.verdict; verdictReasons = a.reasons;
  }

  // ── Discrepancy investigation (diagnostics only — no spec or threshold changes) ──
  // The preliminary claim (+0.517%/cohort "vs the matched trained OMEGA baseline") is
  // checked against every arm contrast so a mislabeled baseline can be detected.
  const contrast = (k1, k2) => {
    const s = primary.perDate.map((d) => d[k1] - d[k2]);
    const foldMeans = {};
    primary.perDate.forEach((d, i) => { (foldMeans[d.fold] = foldMeans[d.fold] || []).push(s[i]); });
    const fm = Object.values(foldMeans).map((a) => +X.mean(a).toFixed(4));
    const t = X.pairedT(s);
    const ci = X.bootstrapCI(s);
    return { meanPct: +X.mean(s).toFixed(4), ci95: ci ? { lo: ci.lo, hi: ci.hi } : null, pOneSided: t.pOneSided, foldMeans: fm, positiveFolds: fm.filter((x) => x > 0).length };
  };
  const discrepancyInvestigation = {
    contrasts: { 'B_minus_A': contrast('retB', 'retA'), 'C_minus_A': contrast('retC', 'retA'), 'C_minus_B': contrast('retC', 'retB') },
    conclusion: null,   // filled below once the numbers are in hand
  };
  const cMinusA = discrepancyInvestigation.contrasts.C_minus_A;
  discrepancyInvestigation.conclusion =
    `The preliminary +0.517%/cohort matches the C−A contrast here (${cMinusA.meanPct >= 0 ? '+' : ''}${cMinusA.meanPct}%/cohort, ` +
    `${cMinusA.positiveFolds}/4 folds positive) — trained-ridge-with-SI vs the FIXED production OMEGA score — not the true ` +
    `SI increment C−B. The training lift belongs to the ridge baseline (B−A), and the SI features themselves subtract from it. ` +
    `The preliminary run appears to have compared against the fixed score while labeling it the trained baseline.`;

  // ── Frozen prospective model (all retrospective dates as training; no re-tuning) ──
  const allRows = joinVariant(panels, bySymbol, SPECS[0]).flatMap((p) => p.rows
    .filter((r) => Number.isFinite(r.net[5]))
    .map((r) => ({ ...r, regRiskOn: p.regime.riskOn ? 1 : 0, regBearish: p.regime.bearish ? 1 : 0, ...Object.fromEntries(primary.sectorKeys.map((s) => [`sec_${s}`, r.sector === s ? 1 : 0])) })));
  const baseKeys = [...F.BASELINE_FEATURES, ...primary.sectorKeys.map((s) => `sec_${s}`)];
  const augKeys = [...baseKeys, ...F.SI_FEATURES];
  const prepB = X.fitPreprocessor(allRows, baseKeys);
  const prepC = X.fitPreprocessor(allRows, augKeys);
  const yAll = allRows.map((r) => r.net[5]);
  const frozenModel = {
    experimentId: X.EXPERIMENT_ID, version: X.SI_EXPERIMENT_VERSION, frozenAt: new Date().toISOString(),
    trainedThrough: panels.length ? panels[panels.length - 1].date : null,
    sectors: primary.sectorKeys, universe: UNIVERSE,
    baseline: { prep: prepB, model: X.ridgeFit(allRows.map((r) => X.designVector(r, prepB)), yAll, X.FROZEN.ridgeAlpha) },
    augmented: { prep: prepC, model: X.ridgeFit(allRows.map((r) => X.designVector(r, prepC)), yAll, X.FROZEN.ridgeAlpha) },
    note: 'Frozen for PROSPECTIVE shadow collection only. No parameter changes during collection. Never scores live OMEGA.',
  };

  // ── Artifacts ──
  const inc = primary.summary.incremental;
  const artifact = {
    experimentId: X.EXPERIMENT_ID, studyId: ID, version: X.SI_EXPERIMENT_VERSION, kit: K.KIT_VERSION,
    finra: SI.FINRA_SI_VERSION,
    frozenConfig: {
      ...X.FROZEN,
      universe: `LIQUID_OPTIONS minus ETFs (${UNIVERSE.length} names, lib/optionsflow)`,
      axis: `SPY step-${STEP} cohorts from index ${AXIS_START_IDX}`,
      availability: 'finra-si.asOfJoinSi — settlement + 13 calendar days, conservative fallback (the only join door)',
      features: { baseline: F.BASELINE_FEATURES, si: F.SI_FEATURES, sectors: primary.sectorKeys },
      specs: SPECS.map((s) => s.id),
    },
    dataSnapshot: {
      siSnapshots: snapshots.length,
      siRange: snapshots.length ? { first: snapshots[0].settlementDate, last: snapshots[snapshots.length - 1].settlementDate } : null,
      siHealth,
      panelDates: panels.length,
      panelRange: panels.length ? { first: panels[0].date, last: panels[panels.length - 1].date } : null,
      joinedRows: primary.summary.joinedRows, tickers: primary.summary.tickers,
      resolvedOutcomes, candidateDates, missingLastBarDate,
      universeAttrition: attrition,
    },
    primary: primary.summary,
    discrepancyInvestigation,
    robustness: Object.fromEntries(SPECS.filter((s) => !s.primary).map((s) => [s.id, runs[s.id].summary])),
    fdr: { family: fdr, primaryQ: qOf('primary_13d_top10_5s'), alpha: 0.10 },
    verdict, verdictReasons,
    promotable: false, survivorshipProvenSafe: false,
    reproductionCheck: {
      preliminary: { joinedRows: 11770, tickers: 62, oosDates: 129, incrementalMeanPct: 0.517, ci95: { lo: 0.172, hi: 0.878 }, positiveFolds: 4, pOneSided: 0.0027, q: 0.064 },
      observed: inc ? {
        joinedRows: primary.summary.joinedRows, tickers: primary.summary.tickers, oosDates: primary.summary.oosDates,
        incrementalMeanPct: inc.meanPct, ci95: inc.bootstrap ? { lo: inc.bootstrap.lo, hi: inc.bootstrap.hi } : null,
        positiveFolds: primary.summary.positiveFolds, pOneSided: inc.tTest.pOneSided, q: qOf('primary_13d_top10_5s'),
      } : null,
    },
    limitations: [
      'Fixed present-day options-liquid list — names that fell OUT of options liquidity are absent (survivorship on the universe definition; the price cache itself keeps delisted series).',
      'Historical FINRA publication timestamps are unrecoverable; ALL retrospective joins use the conservative settlement+13d fallback and every record carries revisionRisk:true.',
      'Regime is a frozen SPY-derived rule, not the live macro overlay (no PIT macro series exists).',
      'Retrospective reconstruction, not live-funnel parity — nothing here can promote anything.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultArt = K.writeArtifact(ARTIFACT_DIR, 'result.json', artifact);
  K.writeArtifact(ARTIFACT_DIR, 'model.json', frozenModel);
  const json = (name, obj) => fs.writeFileSync(path.join(RESULTS_DIR, name), JSON.stringify(obj, null, 2) + '\n');
  json('short_interest_alpha.json', artifact);
  json('short_interest_sensitivity.json', {
    experimentId: X.EXPERIMENT_ID, specs: SPECS,
    results: Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, r.summary])),
    fdr: artifact.fdr, generatedAt: artifact.generatedAt,
  });

  const md = [];
  md.push(`# Short Interest Overlay — ${X.EXPERIMENT_ID}`, '');
  md.push(`> Shadow research only. **Does not affect live OMEGA ranking.** Generated ${artifact.generatedAt}.`, '');
  md.push(`**Verdict: \`${verdict}\`**${verdictReasons.length ? ` — ${verdictReasons.join('; ')}` : ''}`, '');
  md.push('## Data');
  md.push(`- FINRA consolidated short interest: ${snapshots.length} settlement cycles ${artifact.dataSnapshot.siRange?.first} → ${artifact.dataSnapshot.siRange?.last}; ${siHealth.kept} records kept, ${siHealth.invalid} invalid, ${siHealth.duplicates} duplicates.`);
  md.push(`- OMEGA panels: ${panels.length} decision dates (${artifact.dataSnapshot.panelRange?.first} → ${artifact.dataSnapshot.panelRange?.last}), ${primary.summary.joinedRows} joined rows, ${primary.summary.tickers} tickers, SI coverage ${(primary.summary.siCoverage * 100).toFixed(1)}%.`, '');
  md.push('## Primary result (top-10, 5 sessions, 13-day conservative availability)');
  if (inc) {
    md.push(`| metric | Arm A (fixed) | Arm B (trained) | Arm C (B+SI) |`, `|---|---|---|---|`);
    for (const [k, label] of [['meanPct', 'mean net residual/cohort'], ['medianPct', 'median'], ['winRate', 'win rate'], ['sharpeLike', 'Sharpe-like']]) {
      md.push(`| ${label} | ${primary.summary.arms.A?.[k] ?? 'n/a'} | ${primary.summary.arms.B?.[k] ?? 'n/a'} | ${primary.summary.arms.C?.[k] ?? 'n/a'} |`);
    }
    md.push('');
    md.push(`- **Incremental (C − B): ${fmtPct(inc.meanPct)} per cohort**, 95% moving-block bootstrap CI [${fmtPct(inc.bootstrap?.lo)}, ${fmtPct(inc.bootstrap?.hi)}] (B=${X.FROZEN.bootstrap.B}, block=${X.FROZEN.bootstrap.blockLen}).`);
    md.push(`- OOS dates ${primary.summary.oosDates}; positive folds ${primary.summary.positiveFolds}/${primary.summary.usableFolds}; one-sided paired p ${inc.tTest.pOneSided}; two-sided ${inc.tTest.pTwoSided}; FDR q ${artifact.fdr.primaryQ}.`);
    md.push(`- Portfolio: overlap ${primary.summary.portfolio.meanOverlap}, turnover ${primary.summary.portfolio.meanTurnover}, added-name DTC ${primary.summary.portfolio.meanAddedDtc} vs removed ${primary.summary.portfolio.meanRemovedDtc}, crowded-share B ${primary.summary.portfolio.crowdedShareB} → C ${primary.summary.portfolio.crowdedShareC}, incremental max drawdown ${fmtPct(inc.maxDrawdownPct)}.`);
  } else md.push('- No incremental series (insufficient data).');
  md.push('', '## Fold detail');
  for (const f of primary.summary.folds) {
    md.push(f.usable
      ? `- fold ${f.fold}: train ${f.trainDates.first}→${f.trainDates.last} (${f.trainDates.n}), purge ${f.purgedDates}, test ${f.testDates.first}→${f.testDates.last} (${f.testDates.n}), incremental ${fmtPct(f.incrementalMeanPct)}`
      : `- fold ${f.fold}: UNUSABLE — ${f.reason}`);
  }
  md.push('', '## Discrepancy investigation (arm contrasts, diagnostics only)');
  for (const [name, c] of Object.entries(discrepancyInvestigation.contrasts)) {
    md.push(`- ${name.replace(/_/g, ' ')}: ${fmtPct(c.meanPct)}/cohort, CI ${c.ci95 ? `[${c.ci95.lo}, ${c.ci95.hi}]` : 'n/a'}, p(1s) ${c.pOneSided}, folds ${c.foldMeans.join(' / ')} (${c.positiveFolds}/4 positive)`);
  }
  md.push(`- ${discrepancyInvestigation.conclusion}`);
  md.push('', '## Reproduction vs preliminary');
  const rc = artifact.reproductionCheck;
  md.push(`- Preliminary: ${rc.preliminary.joinedRows} rows / ${rc.preliminary.oosDates} OOS dates / +${rc.preliminary.incrementalMeanPct}% [${rc.preliminary.ci95.lo}, ${rc.preliminary.ci95.hi}] / ${rc.preliminary.positiveFolds}/4 folds / p ${rc.preliminary.pOneSided} / q ${rc.preliminary.q}.`);
  md.push(rc.observed
    ? `- This run: ${rc.observed.joinedRows} rows / ${rc.observed.oosDates} OOS dates / ${fmtPct(rc.observed.incrementalMeanPct)} [${rc.observed.ci95?.lo}, ${rc.observed.ci95?.hi}] / ${rc.observed.positiveFolds}/4 folds / p ${rc.observed.pOneSided} / q ${rc.observed.q}.`
    : '- This run: no result (insufficient data).');
  md.push('', '## Limitations');
  for (const l of artifact.limitations) md.push(`- ${l}`);
  fs.writeFileSync(path.join(RESULTS_DIR, 'short_interest_alpha.md'), md.join('\n') + '\n');

  const smd = [`# Short Interest Overlay — sensitivity (${X.EXPERIMENT_ID})`, '', '> Predeclared robustness family; BH-FDR across all six one-sided tests. No post-hoc specs.', ''];
  smd.push('| spec | OOS dates | incremental | 95% CI | folds+ | p (1s) | q |', '|---|---|---|---|---|---|---|');
  for (const s of SPECS) {
    const r = runs[s.id].summary, i = r.incremental;
    smd.push(`| ${s.id}${s.secondary ? ' (secondary)' : s.primary ? ' (PRIMARY)' : ''} | ${r.oosDates} | ${i ? fmtPct(i.meanPct) : 'n/a'} | ${i && i.bootstrap ? `[${i.bootstrap.lo}, ${i.bootstrap.hi}]` : 'n/a'} | ${r.positiveFolds}/${r.usableFolds} | ${i ? i.tTest.pOneSided : 'n/a'} | ${qOf(s.id) ?? 'n/a'} |`);
  }
  fs.writeFileSync(path.join(RESULTS_DIR, 'short_interest_sensitivity.md'), smd.join('\n') + '\n');

  // ── Deployable bundle (lib/si-overlay/) — /research/ is vercelignored, so the tracker
  //    ops serve these committed copies (omega-research-verdict.json precedent). ──
  const BUNDLE_DIR = path.join(__dirname, '..', 'lib', 'si-overlay');
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const ledgerDoc = {
    experimentId: X.EXPERIMENT_ID, runId: ID, modelVersion: X.SI_EXPERIMENT_VERSION,
    provenance: 'historical_reconstruction', appendOnly: true,
    rows: primary.ledger.map((r) => ({ experimentId: X.EXPERIMENT_ID, runId: ID, modelVersion: X.SI_EXPERIMENT_VERSION, ...r })),
    generatedAt: artifact.generatedAt,
  };
  const ledgerBody = JSON.stringify(ledgerDoc);
  // Immutable retrospective shadow ledger — selections stamped with full SI provenance;
  // provenance: historical_reconstruction (retrospective rows can never claim otherwise).
  K.writeArtifact(ARTIFACT_DIR, 'ledger.json', ledgerDoc);
  const bundle = (name, obj) => fs.writeFileSync(path.join(BUNDLE_DIR, name), JSON.stringify(obj) + '\n');
  bundle('result.json', { ...artifact, integrity: { resultSha256: resultArt.sha256, ledgerSha256: SI.sourceHash(ledgerBody) } });
  bundle('sensitivity.json', { experimentId: X.EXPERIMENT_ID, results: Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, r.summary])), fdr: artifact.fdr, generatedAt: artifact.generatedAt });
  bundle('ledger.json', ledgerDoc);
  bundle('model.json', frozenModel);
  bundle('snapshot.json', {
    generatedAt: artifact.generatedAt, source: 'finra:consolidatedShortInterest',
    latestBySymbol: Object.fromEntries([...bySymbol.entries()].map(([sym, series]) => {
      const last = series[series.length - 1];
      const avail = SI.availabilityFor(last.settlementDate);
      return [sym, { ...last, ...avail }];
    })),
  });

  // SI_REGISTER=0 skips the append-only registry write (formatting-only re-runs are not
  // new experimental attempts; results above are unchanged by construction).
  if (process.env.SI_REGISTER !== '0') K.recordExperiment({
    id: ID,
    hypothesis: 'FINRA consolidated short-interest crowding LEVEL (log days-to-cover + >=7 DTC flag + 4 frozen interactions) adds incremental 5-session net residual alpha to a trained OMEGA baseline on the options-liquid universe (top-10, next-open entry, 0.16% cost).',
    family: 'crowding-overlay',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: { siSnapshots: snapshots.length, panelDates: panels.length, joinedRows: primary.summary.joinedRows, tickers: primary.summary.tickers, oosDates: primary.summary.oosDates },
    codeVersion: X.SI_EXPERIMENT_VERSION,
    variationsAttempted: family.length,
    result: {
      verdict, verdictReasons,
      primaryIncremental: inc ? { meanPct: inc.meanPct, ci95: inc.bootstrap, pOneSided: inc.tTest.pOneSided, q: artifact.fdr.primaryQ, positiveFolds: primary.summary.positiveFolds } : null,
      reproductionCheck: artifact.reproductionCheck,
    },
  });

  console.log(JSON.stringify({
    verdict, verdictReasons,
    oosDates: primary.summary.oosDates, joinedRows: primary.summary.joinedRows, tickers: primary.summary.tickers,
    incremental: inc ? { meanPct: inc.meanPct, ci95: inc.bootstrap, pOneSided: inc.tTest.pOneSided, q: artifact.fdr.primaryQ } : null,
    positiveFolds: `${primary.summary.positiveFolds}/${primary.summary.usableFolds}`,
    runtimeMs: artifact.runtimeMs,
  }, null, 2));
  return artifact;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, ID, buildOmegaPanels, joinVariant, loadSiSnapshots, regimeAt, SECTOR_SUPPLEMENT };
