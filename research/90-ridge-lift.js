'use strict';
// Step 90 — OMEGA_RIDGE_LIFT_5D_TOP10: does TRAINING a ridge (alpha=25, frozen
// preprocessing) on OMEGA's own published features add net 5-session alpha over the
// FIXED production OMEGA score at top-10? Falsification-first follow-up to research/89
// (OMEGA_SI_LEVEL_5D_TOP10), where the B−A contrast (+0.673%/cohort, 3/4 folds) was the
// one live thread. Research only — nothing here touches live OMEGA.
//
//   node research/90-ridge-lift.js        (RESEARCH_DATA_DIR override honored via the kit)
//
// HONESTY STAMP. The hypothesis was GENERATED from research/89's primary panel (the 62
// options-liquid names). The primary spec re-measures on that same panel and is therefore
// confirmatory-in-form only; the broad-universe spec (LARGE ∪ SMALL_CAPS ∩ cache,
// ADV >= $20M) is the closest available thing to fresh data. Nothing here is fully
// out-of-sample and nothing here can promote anything.
//
// FROZEN SPECS (FDR family = the five B−A one-sided tests):
//   primary_62_top10_5s   — 62 LIQUID_OPTIONS names (hypothesis panel)
//   broad_top10_5s        — LARGE ∪ SMALL_CAPS ∩ cache, ADV>=2e7 (quasi-OOS)
//   secondary_top5_5s     — top-5 sensitivity (62)
//   secondary_top10_10s   — 10-session sensitivity (62)
//   doubledcost_top10_5s  — doubled round-trip costs (62)
// VALIDITY CONTROLS (not hypotheses): shuffled-label ridge (must show ~0 lift — leakage
// detector), seeded random ranker, r10 momentum ranker (is the ridge just momentum?),
// and the mean after dropping the 3 best lift dates (outlier dependence).

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const X = require('../lib/research/si-experiment');
const F = require('../lib/research/si-features');
const O = require('../lib/omega-swing');
const { SECTOR_ETF } = require('../lib/omega-backfill');
const { SECTOR_OF, LARGE, SMALL_CAPS } = require('../lib/universe');
const { LIQUID_OPTIONS } = require('../lib/optionsflow');

const ID = 'omega-ridge-lift-2026-08';
const EXPERIMENT_ID = 'OMEGA_RIDGE_LIFT_5D_TOP10';
const VERSION = 'ridge-lift-v1';
const RESULTS_DIR = path.join(__dirname, 'results');
const ARTIFACT_DIR = path.join(K.DATA_DIR, 'ridge-lift');
const HORIZONS = [5, 10];
const MAX_H = 10, MIN_PIT_BARS = 220, AXIS_START_IDX = 262, STEP = 5;
const BROAD_MIN_ADV = 2e7, BROAD_MAX_NAMES = 500;
const SHUFFLE_SEED = 20260814, RANDOM_SEED = 4242;
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'SMH']);
const PRIMARY_UNIVERSE = LIQUID_OPTIONS.filter((t) => !ETFS.has(t));
// Frozen sector supplement for universe names lib/universe SECTOR_OF lacks (same as research/89).
const SECTOR_SUPPLEMENT = { MSTR: 'Technology', BABA: 'Consumer Discretionary', MRVL: 'Technology', SNAP: 'Communication Services', GME: 'Consumer Discretionary', AMC: 'Communication Services', SHOP: 'Technology' };
const sectorOf = (t) => SECTOR_OF[t] || SECTOR_SUPPLEMENT[t] || null;
const mean = X.mean;

// ── Panel reconstruction (same contract as research/89, minus SI joins) ──────
function buildPanels(tickers) {
  const load = (sym) => K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
  const spy = load('SPY');
  if (!spy) throw new Error('SPY missing from research cache');
  const spyIdx = new Map(spy.map((b, i) => [b.date, i]));
  const sectorCandles = {};
  for (const etf of new Set(Object.values(SECTOR_ETF))) sectorCandles[etf] = load(etf);
  const dataset = new Map();
  for (const t of tickers) { const c = load(t); if (c) dataset.set(t, { candles: c, idx: new Map(c.map((b, i) => [b.date, i])) }); }
  const dates = [];
  for (let i = AXIS_START_IDX; i <= spy.length - 1 - MAX_H; i += STEP) dates.push(spy[i].date);
  const attr = K.newAttrition();
  const panels = [];
  for (const D of dates) {
    const spyF = {};
    let ok = true;
    for (const H of HORIZONS) { spyF[H] = K.benchmarkForward(spy, spyIdx, D, H); if (spyF[H] == null) ok = false; }
    if (!ok) continue;
    const spySlice = K.sliceAsOf(spy, D);
    const regime = F.spyRegime(spySlice);
    const rows = [];
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < MIN_PIT_BARS || pit[pit.length - 1].date !== D) continue;   // last bar must BE the decision bar
      const etf = SECTOR_ETF[sectorOf(t)];
      const sec = etf && sectorCandles[etf] ? K.sliceAsOf(sectorCandles[etf], D) : null;
      let card = null;
      try { card = O.evaluateCandidate({ ticker: t, candles: pit, bench: { spy: spySlice, sector: sec }, ctx: { regime: { riskOn: regime.riskOn, bearish: regime.bearish } } }); } catch { card = null; }
      if (!card || !Number.isFinite(card.score)) continue;
      const cost = K.costFractions(card.features.dollarVol);
      const net = {}, netDoubled = {};
      for (const H of HORIZONS) {
        const fwd = K.forwardFromNextOpen(v, D, H, attr);
        net[H] = fwd == null ? null : (fwd - spyF[H] - cost.base) * 100;         // pct
        netDoubled[H] = fwd == null ? null : (fwd - spyF[H] - cost.doubled) * 100;
      }
      rows.push({
        ticker: t, lastBarDate: D, sector: sectorOf(t), costTier: cost.tier,
        score: card.score, utility: card.utility, pPositive: card.pred.pPositive,
        p3pct: card.pred.p3pct, p5pct: card.pred.p5pct, expResid10: card.pred.expResidual10,
        r10: card.features.r10, distFrom52High: card.features.distFrom52High, relVol5: card.features.relVol5,
        net, netDoubled,
      });
    }
    if (rows.length >= 20) panels.push({ date: D, regime, rows });
  }
  return { panels, attrition: attr, candidateDates: dates.length };
}

function broadUniverse() {
  const pool = [...new Set([...LARGE, ...SMALL_CAPS])].filter((t) => !ETFS.has(t));
  const scored = [];
  for (const t of pool) {
    const c = K.loadSeries(path.join(K.CACHE_DIR, `${t}.json`));
    if (!c || c.length < 280) continue;
    const adv = K.advOf(c);
    if (adv >= BROAD_MIN_ADV) scored.push([t, adv]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, BROAD_MAX_NAMES).map(([t]) => t);
}

// ── One spec: arms A/B + controls through the frozen purged walk-forward ─────
function runLift(panels, { topK = 10, horizon = 5, netKey = 'net', label }) {
  const usable = panels
    .map((p) => ({ ...p, rows: p.rows.filter((r) => Number.isFinite(r[netKey] && r[netKey][horizon])) }))
    .filter((p) => p.rows.length >= topK * 2);
  const dates = usable.map((p) => p.date);
  const byDate = new Map(usable.map((p) => [p.date, p]));
  const folds = X.foldsOf(dates);
  const sectors = [...new Set(usable.flatMap((p) => p.rows.map((r) => r.sector).filter(Boolean)))].sort();
  const baseKeys = [...F.BASELINE_FEATURES, ...sectors.map((s) => `sec_${s}`)];
  const withControls = (p) => p.rows.map((r) => ({
    ...r, regRiskOn: p.regime.riskOn ? 1 : 0, regBearish: p.regime.bearish ? 1 : 0,
    ...Object.fromEntries(sectors.map((s) => [`sec_${s}`, r.sector === s ? 1 : 0])),
  }));
  const target = (r) => r[netKey][horizon];
  const randScore = (r, d) => parseInt(K.sha(`${RANDOM_SEED}|${d}|${r.ticker}`).slice(0, 8), 16);

  const perDate = [];
  const foldReports = [];
  for (const fold of folds) {
    const trainByDate = fold.trainDates.map((d) => withControls(byDate.get(d)));
    const trainRows = trainByDate.flat();
    if (trainRows.length < 50) { foldReports.push({ fold: fold.fold, usable: false }); continue; }
    const prep = X.fitPreprocessor(trainRows, baseKeys);
    const y = trainRows.map(target);
    const modelB = X.ridgeFit(trainRows.map((r) => X.designVector(r, prep)), y, X.FROZEN.ridgeAlpha);
    // Shuffled-label control: permute targets WITHIN each training date (seeded), then fit
    // the identical pipeline. Any surviving "lift" is leakage or a ranking artifact.
    const rnd = K.lcg(SHUFFLE_SEED + fold.fold);
    const yShuf = [];
    for (const dayRows of trainByDate) {
      const vals = dayRows.map(target);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      yShuf.push(...vals);
    }
    const modelS = X.ridgeFit(trainRows.map((r) => X.designVector(r, prep)), yShuf, X.FROZEN.ridgeAlpha);
    if (!modelB || !modelS) { foldReports.push({ fold: fold.fold, usable: false }); continue; }
    for (const D of fold.testDates) {
      const rows = withControls(byDate.get(D));
      const ret = (score) => { const picks = X.topK(rows, score, topK); return picks.length ? mean(picks.map(target)) : null; };
      const rA = ret((r) => r.score);
      const rB = ret((r) => X.ridgePredict(modelB, X.designVector(r, prep)));
      const rS = ret((r) => X.ridgePredict(modelS, X.designVector(r, prep)));
      const rR = ret((r) => randScore(r, D));
      const rM = ret((r) => r.r10);
      if (![rA, rB, rS, rR, rM].every(Number.isFinite)) continue;
      perDate.push({ date: D, fold: fold.fold, names: rows.length, rA, rB, rS, rR, rM });
    }
    const f = perDate.filter((d) => d.fold === fold.fold);
    foldReports.push({
      fold: fold.fold, usable: true,
      trainDates: { n: fold.trainDates.length, first: fold.trainDates[0], last: fold.trainDates.at(-1) },
      purgedDates: fold.purgedDates.length,
      testDates: { n: f.length, first: f[0] && f[0].date, last: f.at(-1) && f.at(-1).date },
      liftMeanPct: f.length ? +mean(f.map((d) => d.rB - d.rA)).toFixed(4) : null,
    });
  }

  const series = (a, b) => perDate.map((d) => d[a] - d[b]);
  const summarize = (s) => {
    if (!s.length) return null;
    const t = X.pairedT(s), ci = X.bootstrapCI(s);
    const dropped = [...s].sort((x, y) => y - x).slice(3);   // drop the 3 BEST dates
    return {
      meanPct: +mean(s).toFixed(4), medianPct: +X.median(s).toFixed(4),
      winRate: +(s.filter((v) => v > 0).length / s.length).toFixed(4),
      pOneSided: t.pOneSided, pTwoSided: t.pTwoSided,
      ci95: ci ? { lo: ci.lo, hi: ci.hi } : null,
      drop3BestMeanPct: dropped.length ? +mean(dropped).toFixed(4) : null,
      maxDrawdownPct: X.maxDrawdown(s),
    };
  };
  const usableFolds = foldReports.filter((f) => f.usable);
  return {
    label, topK, horizon, netKey,
    joinedRows: usable.reduce((a, p) => a + p.rows.length, 0),
    tickers: new Set(usable.flatMap((p) => p.rows.map((r) => r.ticker))).size,
    candidateDates: panels.length, oosDates: perDate.length,
    arms: {
      A: { meanPct: +mean(perDate.map((d) => d.rA)).toFixed(4) },
      B: { meanPct: +mean(perDate.map((d) => d.rB)).toFixed(4) },
      momentum: { meanPct: +mean(perDate.map((d) => d.rM)).toFixed(4) },
      random: { meanPct: +mean(perDate.map((d) => d.rR)).toFixed(4) },
    },
    lift: summarize(series('rB', 'rA')),
    controls: {
      shuffledLift: summarize(series('rS', 'rA')),
      randomLift: summarize(series('rR', 'rA')),
      momentumLift: summarize(series('rM', 'rA')),
      ridgeVsMomentum: summarize(series('rB', 'rM')),
    },
    folds: foldReports, usableFolds: usableFolds.length,
    positiveFolds: usableFolds.filter((f) => f.liftMeanPct > 0).length,
  };
}

const fmtPct = (x, d = 3) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);

async function main() {
  const t0 = Date.now();
  const { panels: primaryPanels, attrition, candidateDates } = buildPanels(PRIMARY_UNIVERSE);
  const broad = broadUniverse();
  const { panels: broadPanels, attrition: broadAttr } = buildPanels(broad);

  const SPECS = [
    { id: 'primary_62_top10_5s', panels: primaryPanels, topK: 10, horizon: 5, netKey: 'net', primary: true },
    { id: 'broad_top10_5s', panels: broadPanels, topK: 10, horizon: 5, netKey: 'net' },
    { id: 'secondary_top5_5s', panels: primaryPanels, topK: 5, horizon: 5, netKey: 'net' },
    { id: 'secondary_top10_10s', panels: primaryPanels, topK: 10, horizon: 10, netKey: 'net' },
    { id: 'doubledcost_top10_5s', panels: primaryPanels, topK: 10, horizon: 5, netKey: 'netDoubled' },
  ];
  const runs = {};
  for (const s of SPECS) runs[s.id] = runLift(s.panels, { topK: s.topK, horizon: s.horizon, netKey: s.netKey, label: s.id });
  const P = runs.primary_62_top10_5s;
  const B = runs.broad_top10_5s;

  const family = SPECS.map((s) => ({ id: s.id, p: runs[s.id].lift && runs[s.id].lift.pOneSided })).filter((f) => Number.isFinite(f.p));
  const fdr = K.fdr(family, { alpha: 0.10 });
  const qOf = (id) => { const r = (fdr || []).find((f) => f.id === id); return r ? +r.q.toFixed(4) : null; };

  // ── Verdict (fail-closed guards first, then the predeclared gates) ──
  let verdict, reasons = [];
  if (!primaryPanels.length) { verdict = 'INSUFFICIENT_DATA'; reasons = ['zero reconstructed panels']; }
  else if (!P.oosDates) { verdict = 'INSUFFICIENT_DATA'; reasons = ['zero OOS portfolio dates']; }
  else if (P.oosDates < 40 || P.usableFolds < 2) { verdict = 'INSUFFICIENT_DATA'; reasons = [`OOS ${P.oosDates} / folds ${P.usableFolds} below floor`]; }
  else {
    const D = runs.doubledcost_top10_5s;
    if (P.oosDates < 100) reasons.push(`OOS dates ${P.oosDates} < 100`);
    if (!(P.lift.meanPct > 0)) reasons.push(`primary lift ${P.lift.meanPct} not positive`);
    if (!P.lift.ci95 || !(P.lift.ci95.lo > 0)) reasons.push('bootstrap 95% interval not entirely above zero');
    if (P.positiveFolds < 3) reasons.push(`positive folds ${P.positiveFolds} < 3`);
    if (!(Number.isFinite(qOf('primary_62_top10_5s')) && qOf('primary_62_top10_5s') <= 0.10)) reasons.push(`FDR q ${qOf('primary_62_top10_5s')} > 0.10`);
    if (!B.lift || !(B.lift.meanPct > 0)) reasons.push('sign flip (or missing result) on the broad quasi-OOS universe');
    if (!D.lift || !(D.lift.meanPct > 0)) reasons.push('lift does not survive doubled costs');
    const sh = P.controls.shuffledLift;
    if (!sh || Math.abs(sh.meanPct) > Math.abs(P.lift.meanPct) / 2 || (sh.ci95 && (sh.ci95.lo > 0 || sh.ci95.hi < 0)))
      reasons.push('shuffled-label control not clean — pipeline leakage or ranking artifact suspected');
    if (!(P.lift.drop3BestMeanPct > 0)) reasons.push('lift vanishes after dropping the 3 best dates (outlier-driven)');
    verdict = reasons.length ? 'NO_INCREMENTAL_ALPHA' : 'SHADOW_CANDIDATE';
  }

  // ── Interpretation — derived from the predeclared controls, not from taste ──
  const momBeatsRidge = P.controls.momentumLift && P.controls.momentumLift.meanPct >= P.lift.meanPct
    && P.controls.ridgeVsMomentum && !(P.controls.ridgeVsMomentum.meanPct > 0);
  const randomBeatsA = P.controls.randomLift && P.controls.randomLift.meanPct > 0 && P.controls.randomLift.ci95 && P.controls.randomLift.ci95.lo > 0;
  const interpretation = {
    momentumExplainsLift: !!momBeatsRidge,
    fixedOmegaBelowRandom: !!randomBeatsA,
    conclusion: momBeatsRidge
      ? 'The gates pass, but the momentum control explains the lift: plain r10 beats fixed OMEGA by at least as much as the ridge does, and the ridge does not beat plain r10 — the "training lift" is momentum exposure, not learned structure.'
        + (randomBeatsA ? ' A seeded random ranker also beats fixed OMEGA, so beat-A lifts sit on a below-random baseline.' : '')
        + ' Recommendation: do NOT build a ridge overlay; the repeat finding is that the fixed OMEGA score ranks poorly on its own universe (consistent with lib/omega-research-verdict.json).'
      : 'The momentum control does not explain the lift — the ridge adds something beyond r10 on this panel. Treat with survivorship caution before any further step.',
  };

  const artifact = {
    experimentId: EXPERIMENT_ID, studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    hypothesisProvenance: 'Generated from the OMEGA_SI_LEVEL_5D_TOP10 primary panel (B−A = +0.673%). The primary spec is confirmatory-in-form only; broad_top10_5s is the quasi-OOS check. Nothing here is fully out-of-sample.',
    frozenConfig: {
      ridgeAlpha: X.FROZEN.ridgeAlpha, folds: X.FROZEN.testFolds, purgeCohorts: X.FROZEN.purgeCohorts,
      bootstrap: X.FROZEN.bootstrap, axis: `SPY step-${STEP} from idx ${AXIS_START_IDX}`,
      primaryUniverse: `LIQUID_OPTIONS minus ETFs (${PRIMARY_UNIVERSE.length})`,
      broadUniverse: `LARGE ∪ SMALL_CAPS ∩ cache, ADV>=${BROAD_MIN_ADV / 1e6}M, top ${BROAD_MAX_NAMES} by ADV (got ${broad.length})`,
      features: F.BASELINE_FEATURES, specs: SPECS.map((s) => s.id),
      controls: ['shuffledLabelRidge', 'seededRandomRanker', 'r10MomentumRanker', 'drop3BestDates'],
      seeds: { shuffle: SHUFFLE_SEED, random: RANDOM_SEED },
    },
    dataSnapshot: {
      primary: { panelDates: primaryPanels.length, joinedRows: P.joinedRows, tickers: P.tickers, candidateDates, attrition },
      broad: { panelDates: broadPanels.length, joinedRows: B.joinedRows, tickers: B.tickers, attrition: broadAttr },
    },
    results: runs, fdr: { family: fdr, primaryQ: qOf('primary_62_top10_5s'), alpha: 0.10 },
    verdict, verdictReasons: reasons, interpretation,
    promotable: false, survivorshipProvenSafe: false,
    limitations: [
      'Hypothesis and primary panel share the same data (see hypothesisProvenance).',
      'Broad universe is the PRESENT-DAY LARGE/SMALL lists with a full-sample ADV screen — selection is not point-in-time; comparable momentum lifts previously deflated to no-edge on survivorship-complete panels.',
      'Ridge is trained on realized net residuals of an overlapping panel; per-date cross-sections are not independent.',
      'Same execution realism limits as research/89 (next-open fills, tiered costs, frozen SPY regime rule).',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  K.writeArtifact(ARTIFACT_DIR, 'result.json', artifact);
  fs.writeFileSync(path.join(RESULTS_DIR, 'ridge_lift.json'), JSON.stringify(artifact, null, 2) + '\n');

  const md = [];
  md.push(`# OMEGA ridge training lift — ${EXPERIMENT_ID}`, '');
  md.push(`> Research only. Does not affect live OMEGA. Generated ${artifact.generatedAt}.`, '');
  md.push(`**Verdict: \`${verdict}\`**${reasons.length ? ` — ${reasons.join('; ')}` : ' (all frozen gates passed — see interpretation before drawing conclusions)'}`, '');
  md.push('## Specs (B−A lift = trained ridge minus fixed OMEGA, net per cohort)');
  md.push('| spec | OOS | lift | 95% CI | folds+ | p(1s) | q |', '|---|---|---|---|---|---|---|');
  for (const s of SPECS) {
    const r = runs[s.id];
    md.push(`| ${s.id}${s.primary ? ' (PRIMARY)' : ''} | ${r.oosDates} | ${fmtPct(r.lift?.meanPct)} | ${r.lift?.ci95 ? `[${r.lift.ci95.lo}, ${r.lift.ci95.hi}]` : 'n/a'} | ${r.positiveFolds}/${r.usableFolds} | ${r.lift?.pOneSided ?? 'n/a'} | ${qOf(s.id) ?? 'n/a'} |`);
  }
  md.push('', '## Controls (primary universe)');
  for (const [name, c] of Object.entries(P.controls)) {
    md.push(`- ${name}: ${fmtPct(c?.meanPct)}/cohort${c?.ci95 ? ` CI [${c.ci95.lo}, ${c.ci95.hi}]` : ''}, p(1s) ${c?.pOneSided ?? 'n/a'}, drop-3-best ${fmtPct(c?.drop3BestMeanPct)}`);
  }
  md.push(`- Arm means/cohort: fixed OMEGA ${fmtPct(P.arms.A.meanPct)}, ridge ${fmtPct(P.arms.B.meanPct)}, r10 momentum ${fmtPct(P.arms.momentum.meanPct)}, random ${fmtPct(P.arms.random.meanPct)}.`);
  md.push(`- Broad universe (${B.tickers} names): ridge lift ${fmtPct(B.lift?.meanPct)} vs momentum lift ${fmtPct(B.controls.momentumLift?.meanPct)}, ridge-vs-momentum ${fmtPct(B.controls.ridgeVsMomentum?.meanPct)}, random lift ${fmtPct(B.controls.randomLift?.meanPct)}.`);
  md.push('', '## Interpretation', '', interpretation.conclusion, '', '## Limitations');
  for (const l of artifact.limitations) md.push(`- ${l}`);
  fs.writeFileSync(path.join(RESULTS_DIR, 'ridge_lift.md'), md.join('\n') + '\n');

  if (process.env.SI_REGISTER !== '0') K.recordExperiment({
    id: ID,
    hypothesis: 'A ridge (alpha=25, frozen preprocessing) trained on OMEGA\'s own published features adds net 5-session alpha over the FIXED production OMEGA score at top-10 on the options-liquid universe.',
    family: 'swing-ranking',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: { primaryPanelDates: primaryPanels.length, primaryRows: P.joinedRows, broadTickers: B.tickers, broadRows: B.joinedRows, oosDates: P.oosDates },
    codeVersion: VERSION,
    variationsAttempted: family.length,
    result: {
      verdict, verdictReasons: reasons,
      primaryLift: P.lift, broadLift: B.lift,
      controls: { momentumLift: P.controls.momentumLift?.meanPct, ridgeVsMomentum: P.controls.ridgeVsMomentum?.meanPct, randomLift: P.controls.randomLift?.meanPct, shuffledLift: P.controls.shuffledLift?.meanPct },
      interpretation,
    },
  });

  console.log(JSON.stringify({
    verdict, reasons, interpretation: interpretation.conclusion,
    primary: { oosDates: P.oosDates, lift: P.lift?.meanPct, ci: P.lift?.ci95, folds: `${P.positiveFolds}/${P.usableFolds}`, q: qOf('primary_62_top10_5s') },
    broad: { tickers: B.tickers, lift: B.lift?.meanPct, ci: B.lift?.ci95, folds: `${B.positiveFolds}/${B.usableFolds}` },
    controls: { momentumLift: P.controls.momentumLift?.meanPct, ridgeVsMomentum: P.controls.ridgeVsMomentum?.meanPct, randomLift: P.controls.randomLift?.meanPct, shuffledLift: P.controls.shuffledLift?.meanPct },
    runtimeMs: artifact.runtimeMs,
  }, null, 2));
  return artifact;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, EXPERIMENT_ID, ID, buildPanels, broadUniverse, runLift };
