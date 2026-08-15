'use strict';
// Step 91 — OMEGA_SCORE_AUTOPSY_5D_TOP10: WHY does the fixed OMEGA score rank below
// random (and far below plain r10) on its own 5-session net-residual objective
// (research/90), and is there a TRANSPARENT re-specification that fixes it?
//
//   node research/91-omega-score-autopsy.js
//
// Part 1 — AUTOPSY (diagnostics, no hypotheses): per-date rank-IC vs net5 of the final
// score, its pre-penalty base, the penalty multiplier, each of the 8 weighted components
// and r10; plus per-penalty-flag outcome deltas. Where exactly does the ranking die?
//
// Part 2 — PREDECLARED FIX CANDIDATES (frozen family, BH-FDR across all ten tests =
// 5 variants x 2 universes; no other variants were tried):
//   V1_noPenalty     rank by the pre-penalty base (exhaustion multiplier removed)
//   V2_icPruned      per fold, TRAIN dates only: drop components with non-positive mean
//                    per-date IC; score = 100·Σ_kept(w·c)·penaltyMult (rule, not a fit)
//   V3_momentumTilt  fixed reweight {relStrength .30, momentumPersistence .25,
//                    volumeQuality .10, trendSmoothness .10, catalystPersistence .05,
//                    setupQuality .05, regime .05, modelResidual .10}, penalty kept
//   V4_blendR10      per-date z(score) + z(r10), equal weight
//   V5_r10           plain r10 — the bar every candidate must clear
//
// FIX-CANDIDATE GATES (frozen): lift over the current score with bootstrap CI lo > 0,
// >= 3/4 folds and q <= 0.10 on the primary universe; positive lift on the broad
// quasi-OOS universe; does NOT lose to plain r10 on either universe; survives dropping
// its 3 best dates. Ties broken by frozen simplicity order V1 > V3 > V2 > V4.
//
// Research only. Nothing here changes live OMEGA; a shipped scorer change is a separate,
// explicitly versioned step.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const X = require('../lib/research/si-experiment');
const F = require('../lib/research/si-features');
const O = require('../lib/omega-swing');
const { SECTOR_ETF } = require('../lib/omega-backfill');
const { SECTOR_OF, LARGE, SMALL_CAPS } = require('../lib/universe');
const { LIQUID_OPTIONS } = require('../lib/optionsflow');

const ID = 'omega-score-autopsy-2026-08';
const EXPERIMENT_ID = 'OMEGA_SCORE_AUTOPSY_5D_TOP10';
const VERSION = 'score-autopsy-v1';
const RESULTS_DIR = path.join(__dirname, 'results');
const ARTIFACT_DIR = path.join(K.DATA_DIR, 'omega-score-autopsy');
const H = 5, MAX_H = 10, MIN_PIT_BARS = 220, AXIS_START_IDX = 262, STEP = 5, TOP_K = 10;
const BROAD_MIN_ADV = 2e7, BROAD_MAX_NAMES = 500;
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'SMH']);
const PRIMARY_UNIVERSE = LIQUID_OPTIONS.filter((t) => !ETFS.has(t));
const SECTOR_SUPPLEMENT = { MSTR: 'Technology', BABA: 'Consumer Discretionary', MRVL: 'Technology', SNAP: 'Communication Services', GME: 'Consumer Discretionary', AMC: 'Communication Services', SHOP: 'Technology' };
const sectorOf = (t) => SECTOR_OF[t] || SECTOR_SUPPLEMENT[t] || null;
const COMPONENT_KEYS = Object.keys(O.SCORE_WEIGHTS);
const V3_WEIGHTS = Object.freeze({
  relStrength: 0.30, momentumPersistence: 0.25, volumeQuality: 0.10, trendSmoothness: 0.10,
  catalystPersistence: 0.05, setupQuality: 0.05, regime: 0.05, modelResidual: 0.10,
});
const SIMPLICITY_ORDER = ['V1_noPenalty', 'V3_momentumTilt', 'V2_icPruned', 'V4_blendR10'];
const mean = X.mean;

// ── Panels with full score decomposition ─────────────────────────────────────
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
  let scoreMismatches = 0, rowsTotal = 0;
  for (const D of dates) {
    const spyF = K.benchmarkForward(spy, spyIdx, D, H);
    if (spyF == null) continue;
    const spySlice = K.sliceAsOf(spy, D);
    const regime = F.spyRegime(spySlice);
    const ctxRegime = { riskOn: regime.riskOn, bearish: regime.bearish };
    const rows = [];
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < MIN_PIT_BARS || pit[pit.length - 1].date !== D) continue;
      const etf = SECTOR_ETF[sectorOf(t)];
      const sec = etf && sectorCandles[etf] ? K.sliceAsOf(sectorCandles[etf], D) : null;
      let card = null;
      try { card = O.evaluateCandidate({ ticker: t, candles: pit, bench: { spy: spySlice, sector: sec }, ctx: { regime: ctxRegime } }); } catch { card = null; }
      if (!card || !Number.isFinite(card.score)) continue;
      // Exact decomposition, replicating evaluateCandidate's score call.
      const f = card.features;
      const setup = O.detectSetups(f, pit, { regime: ctxRegime });
      const comp = O.scoreComponents(f, { regime: ctxRegime, setup, modelProb: card.pred ? card.pred.pPositive : null });
      const pen = O.exhaustionPenalty(f, { regime: ctxRegime });
      const base = 100 * COMPONENT_KEYS.reduce((s, k) => s + O.SCORE_WEIGHTS[k] * comp[k], 0);
      rowsTotal++;
      if (Math.abs(Math.min(Math.max(base * pen.mult, 0), 100) - card.score) > 0.15) scoreMismatches++;
      const cost = K.costFractions(f.dollarVol);
      const fwd = K.forwardFromNextOpen(v, D, H, attr);
      const net5 = fwd == null ? null : (fwd - spyF - cost.base) * 100;
      if (net5 == null) continue;
      rows.push({ ticker: t, score: card.score, base: +base.toFixed(4), penaltyMult: pen.mult, penaltyFlags: pen.flags, comp, r10: f.r10, net5 });
    }
    if (rows.length >= 20) panels.push({ date: D, rows });
  }
  return { panels, attrition: attr, candidateDates: dates.length, scoreMismatches, rowsTotal };
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

// ── Part 1: autopsy diagnostics ──────────────────────────────────────────────
function icSeries(panels, pick) {
  const out = [];
  for (const p of panels) {
    const xs = [], ys = [];
    for (const r of p.rows) { const v = pick(r); if (Number.isFinite(v)) { xs.push(v); ys.push(r.net5); } }
    const ic = X.spearman(xs, ys);
    if (ic != null) out.push(ic);
  }
  return out;
}
function icSummary(series) {
  if (series.length < 10) return null;
  const ci = X.bootstrapCI(series);
  return { meanIC: +mean(series).toFixed(4), ci95: ci ? { lo: ci.lo, hi: ci.hi } : null, dates: series.length };
}
function autopsy(panels) {
  const out = {
    finalScore: icSummary(icSeries(panels, (r) => r.score)),
    prePenaltyBase: icSummary(icSeries(panels, (r) => r.base)),
    penaltyMult: icSummary(icSeries(panels, (r) => r.penaltyMult)),
    r10: icSummary(icSeries(panels, (r) => r.r10)),
    components: {},
    penaltyFlagDeltas: {},
  };
  for (const k of COMPONENT_KEYS) out.components[k] = icSummary(icSeries(panels, (r) => r.comp[k]));
  const flagAgg = new Map();
  for (const p of panels) for (const r of p.rows) {
    for (const flag of r.penaltyFlags) {
      const a = flagAgg.get(flag) || { on: [], n: 0 };
      a.on.push(r.net5); a.n++; flagAgg.set(flag, a);
    }
  }
  const allNet = panels.flatMap((p) => p.rows.map((r) => r.net5));
  const allMean = mean(allNet);
  for (const [flag, a] of [...flagAgg.entries()].sort((x, y) => y[1].n - x[1].n)) {
    out.penaltyFlagDeltas[flag] = { n: a.n, flaggedMeanPct: +mean(a.on).toFixed(4), poolMeanPct: +allMean.toFixed(4), deltaPct: +(mean(a.on) - allMean).toFixed(4) };
  }
  return out;
}

// ── Part 2: variants through the frozen purged walk-forward ──────────────────
function zByDate(rows, pick) {
  const z = F.crossSectionalZ(rows.map(pick));
  return new Map(rows.map((r, i) => [r.ticker, z[i]]));
}
function runVariants(panels, label) {
  const dates = panels.map((p) => p.date);
  const byDate = new Map(panels.map((p) => [p.date, p]));
  const folds = X.foldsOf(dates);
  const perDate = [];
  const foldReports = [];
  const v2Kept = {};
  for (const fold of folds) {
    // V2's rule: components with positive mean per-date IC on TRAIN dates only.
    const trainPanels = fold.trainDates.map((d) => byDate.get(d));
    const kept = COMPONENT_KEYS.filter((k) => {
      const s = icSeries(trainPanels, (r) => r.comp[k]);
      return s.length >= 10 && mean(s) > 0;
    });
    v2Kept[fold.fold] = kept;
    const keptSet = kept.length ? kept : COMPONENT_KEYS;   // degenerate fold falls back to the full set
    for (const D of fold.testDates) {
      const p = byDate.get(D);
      const rows = p.rows;
      const zScore = zByDate(rows, (r) => r.score);
      const zR10 = zByDate(rows, (r) => r.r10);
      const scoreOf = {
        A_current: (r) => r.score,
        V1_noPenalty: (r) => r.base,
        V2_icPruned: (r) => 100 * keptSet.reduce((s, k) => s + O.SCORE_WEIGHTS[k] * r.comp[k], 0) * r.penaltyMult,
        V3_momentumTilt: (r) => 100 * COMPONENT_KEYS.reduce((s, k) => s + V3_WEIGHTS[k] * r.comp[k], 0) * r.penaltyMult,
        V4_blendR10: (r) => (zScore.get(r.ticker) ?? 0) + (zR10.get(r.ticker) ?? 0),
        V5_r10: (r) => r.r10,
      };
      const rec = { date: D, fold: fold.fold, names: rows.length };
      let ok = true;
      for (const [name, fn] of Object.entries(scoreOf)) {
        const picks = X.topK(rows, fn, TOP_K);
        const v = picks.length ? mean(picks.map((r) => r.net5)) : null;
        if (!Number.isFinite(v)) ok = false;
        rec[name] = v;
      }
      if (ok) perDate.push(rec);
    }
    const f = perDate.filter((d) => d.fold === fold.fold);
    foldReports.push({
      fold: fold.fold, usable: f.length > 0, testDates: f.length, purgedDates: fold.purgedDates.length,
      trainDates: { n: fold.trainDates.length, first: fold.trainDates[0], last: fold.trainDates.at(-1) },
      v2Kept: kept,
      lifts: Object.fromEntries(['V1_noPenalty', 'V2_icPruned', 'V3_momentumTilt', 'V4_blendR10', 'V5_r10']
        .map((v) => [v, f.length ? +mean(f.map((d) => d[v] - d.A_current)).toFixed(4) : null])),
    });
  }
  const summarize = (s) => {
    if (!s.length) return null;
    const t = X.pairedT(s), ci = X.bootstrapCI(s);
    const dropped = [...s].sort((x, y) => y - x).slice(3);
    return {
      meanPct: +mean(s).toFixed(4), medianPct: +X.median(s).toFixed(4),
      winRate: +(s.filter((v) => v > 0).length / s.length).toFixed(4),
      pOneSided: t.pOneSided, ci95: ci ? { lo: ci.lo, hi: ci.hi } : null,
      drop3BestMeanPct: dropped.length ? +mean(dropped).toFixed(4) : null,
    };
  };
  const variants = {};
  for (const v of ['V1_noPenalty', 'V2_icPruned', 'V3_momentumTilt', 'V4_blendR10', 'V5_r10']) {
    const liftSeries = perDate.map((d) => d[v] - d.A_current);
    const vsR10Series = perDate.map((d) => d[v] - d.V5_r10);
    const usableFolds = foldReports.filter((f) => f.usable);
    variants[v] = {
      liftOverCurrent: summarize(liftSeries),
      vsR10MeanPct: vsR10Series.length ? +mean(vsR10Series).toFixed(4) : null,
      positiveFolds: usableFolds.filter((f) => Number.isFinite(f.lifts[v]) && f.lifts[v] > 0).length,
      usableFolds: usableFolds.length,
    };
  }
  return {
    label, oosDates: perDate.length,
    armMeans: Object.fromEntries(['A_current', 'V1_noPenalty', 'V2_icPruned', 'V3_momentumTilt', 'V4_blendR10', 'V5_r10']
      .map((k) => [k, perDate.length ? +mean(perDate.map((d) => d[k])).toFixed(4) : null])),
    variants, folds: foldReports, v2Kept,
  };
}

const fmtPct = (x, d = 3) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);

async function main() {
  const t0 = Date.now();
  const primary = buildPanels(PRIMARY_UNIVERSE);
  const broadList = broadUniverse();
  const broad = buildPanels(broadList);
  if (primary.scoreMismatches / Math.max(1, primary.rowsTotal) > 0.01) throw new Error(`score decomposition mismatch on ${primary.scoreMismatches}/${primary.rowsTotal} rows`);

  const autopsyPrimary = autopsy(primary.panels);
  const autopsyBroad = autopsy(broad.panels);
  const runPrimary = runVariants(primary.panels, 'primary_62');
  const runBroad = runVariants(broad.panels, 'broad');

  // FDR across ALL ten attempted lift tests (5 variants x 2 universes).
  const family = [];
  for (const [uni, run] of [['primary', runPrimary], ['broad', runBroad]]) {
    for (const [v, r] of Object.entries(run.variants)) {
      if (r.liftOverCurrent && Number.isFinite(r.liftOverCurrent.pOneSided)) family.push({ id: `${uni}.${v}`, p: r.liftOverCurrent.pOneSided });
    }
  }
  const fdr = K.fdr(family, { alpha: 0.10 });
  const qOf = (id) => { const r = (fdr || []).find((f) => f.id === id); return r ? +r.q.toFixed(4) : null; };

  // ── Fix-candidate gates (frozen; see header) ──
  const qualifies = (v) => {
    const p = runPrimary.variants[v], b = runBroad.variants[v];
    if (!p || !p.liftOverCurrent) return { ok: false, why: ['no primary result'] };
    const why = [];
    if (!(p.liftOverCurrent.meanPct > 0)) why.push('primary lift not positive');
    if (!p.liftOverCurrent.ci95 || !(p.liftOverCurrent.ci95.lo > 0)) why.push('primary CI not above zero');
    if (p.positiveFolds < 3) why.push(`folds ${p.positiveFolds}/${p.usableFolds}`);
    if (!(Number.isFinite(qOf(`primary.${v}`)) && qOf(`primary.${v}`) <= 0.10)) why.push(`q ${qOf(`primary.${v}`)}`);
    if (!b || !b.liftOverCurrent || !(b.liftOverCurrent.meanPct > 0)) why.push('broad lift not positive');
    if (!(p.vsR10MeanPct >= 0)) why.push(`loses to r10 on primary (${p.vsR10MeanPct})`);
    if (!b || !(b.vsR10MeanPct >= 0)) why.push(`loses to r10 on broad (${b && b.vsR10MeanPct})`);
    if (!(p.liftOverCurrent.drop3BestMeanPct > 0)) why.push('outlier-driven (drop-3-best <= 0)');
    return { ok: why.length === 0, why };
  };
  const gateReport = Object.fromEntries(SIMPLICITY_ORDER.map((v) => [v, qualifies(v)]));
  const fixCandidate = SIMPLICITY_ORDER.find((v) => gateReport[v].ok) || null;
  const verdict = !primary.panels.length || !runPrimary.oosDates ? 'INSUFFICIENT_DATA'
    : fixCandidate ? 'SHADOW_CANDIDATE' : 'NO_INCREMENTAL_ALPHA';

  const artifact = {
    experimentId: EXPERIMENT_ID, studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    motivation: 'research/90: fixed OMEGA score ranks below RANDOM and far below r10 on its own 5-session net-residual objective. This autopsy locates the damage and tests a frozen family of transparent re-specifications.',
    frozenConfig: {
      horizon: H, topK: TOP_K, folds: X.FROZEN.testFolds, purgeCohorts: X.FROZEN.purgeCohorts,
      bootstrap: X.FROZEN.bootstrap, axis: `SPY step-${STEP} from idx ${AXIS_START_IDX}`,
      primaryUniverse: `LIQUID_OPTIONS minus ETFs (${PRIMARY_UNIVERSE.length})`,
      broadUniverse: `LARGE ∪ SMALL_CAPS ∩ cache, ADV>=${BROAD_MIN_ADV / 1e6}M, top ${BROAD_MAX_NAMES} (got ${broadList.length})`,
      variants: ['V1_noPenalty', 'V2_icPruned (train-IC rule)', `V3_momentumTilt ${JSON.stringify(V3_WEIGHTS)}`, 'V4_blendR10', 'V5_r10'],
      simplicityOrder: SIMPLICITY_ORDER, fdrFamily: '5 variants x 2 universes = 10 one-sided lift tests',
    },
    dataSnapshot: {
      primary: { panelDates: primary.panels.length, rows: primary.rowsTotal, candidateDates: primary.candidateDates, scoreMismatches: primary.scoreMismatches, attrition: primary.attrition },
      broad: { panelDates: broad.panels.length, tickers: broadList.length, attrition: broad.attrition },
    },
    autopsy: { primary: autopsyPrimary, broad: autopsyBroad },
    variants: { primary: runPrimary, broad: runBroad },
    fdr: { family: fdr, alpha: 0.10 },
    gateReport, fixCandidate, verdict,
    promotable: false, survivorshipProvenSafe: false,
    limitations: [
      'Same panels/universes as research/89-90; the misranking finding motivated this study, so the primary spec is not fresh data (the broad universe is the quasi-OOS check).',
      'Present-day universes — apparent momentum strength may deflate on survivorship-complete panels.',
      'Diagnostic ICs are descriptive; only the ten predeclared lift tests carry q-values.',
      'A shipped scorer change is a separate versioned step; this study alone authorizes nothing live.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  K.writeArtifact(ARTIFACT_DIR, 'result.json', artifact);
  fs.writeFileSync(path.join(RESULTS_DIR, 'omega_score_autopsy.json'), JSON.stringify(artifact, null, 2) + '\n');

  const md = [];
  md.push(`# OMEGA score autopsy — ${EXPERIMENT_ID}`, '');
  md.push(`> Research only; changes nothing live. Generated ${artifact.generatedAt}.`, '');
  md.push(`**Verdict: \`${verdict}\`** — fix candidate: ${fixCandidate ? `**${fixCandidate}**` : 'none qualified'}`, '');
  md.push('## Autopsy — mean per-date rank-IC vs 5-session net residual (primary universe)');
  md.push('| signal | mean IC | 95% CI |', '|---|---|---|');
  const icRow = (name, s) => `| ${name} | ${s ? s.meanIC : 'n/a'} | ${s && s.ci95 ? `[${s.ci95.lo}, ${s.ci95.hi}]` : 'n/a'} |`;
  md.push(icRow('final score', autopsyPrimary.finalScore));
  md.push(icRow('pre-penalty base', autopsyPrimary.prePenaltyBase));
  md.push(icRow('penalty multiplier', autopsyPrimary.penaltyMult));
  md.push(icRow('r10 (reference)', autopsyPrimary.r10));
  for (const k of COMPONENT_KEYS) md.push(icRow(`component: ${k} (w=${O.SCORE_WEIGHTS[k]})`, autopsyPrimary.components[k]));
  md.push('', '### Penalty flags — flagged-name outcomes vs pool (primary)');
  md.push('| flag | n | flagged mean | pool mean | delta |', '|---|---|---|---|---|');
  for (const [flag, d] of Object.entries(autopsyPrimary.penaltyFlagDeltas)) {
    md.push(`| ${flag} | ${d.n} | ${fmtPct(d.flaggedMeanPct)} | ${fmtPct(d.poolMeanPct)} | ${fmtPct(d.deltaPct)} |`);
  }
  md.push('', '## Variants — top-10 lift over the current score');
  md.push('| variant | universe | OOS | lift | 95% CI | folds+ | q | vs r10 |', '|---|---|---|---|---|---|---|---|');
  for (const [uni, run] of [['primary', runPrimary], ['broad', runBroad]]) {
    for (const [v, r] of Object.entries(run.variants)) {
      const L = r.liftOverCurrent;
      md.push(`| ${v} | ${uni} | ${run.oosDates} | ${fmtPct(L?.meanPct)} | ${L?.ci95 ? `[${L.ci95.lo}, ${L.ci95.hi}]` : 'n/a'} | ${r.positiveFolds}/${r.usableFolds} | ${qOf(`${uni}.${v}`) ?? 'n/a'} | ${fmtPct(r.vsR10MeanPct)} |`);
    }
  }
  md.push('', '## Gate report');
  for (const [v, g] of Object.entries(gateReport)) md.push(`- ${v}: ${g.ok ? '**QUALIFIES**' : `fails — ${g.why.join('; ')}`}`);
  md.push('', '## Limitations');
  for (const l of artifact.limitations) md.push(`- ${l}`);
  fs.writeFileSync(path.join(RESULTS_DIR, 'omega_score_autopsy.md'), md.join('\n') + '\n');

  if (process.env.SI_REGISTER !== '0') K.recordExperiment({
    id: ID,
    hypothesis: 'The fixed OMEGA score misranks its own cohort because identifiable components/penalties carry negative information; a transparent frozen re-specification exists that beats the current score without losing to plain r10.',
    family: 'swing-ranking',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: { primaryPanelDates: primary.panels.length, primaryRows: primary.rowsTotal, broadTickers: broadList.length, oosDates: runPrimary.oosDates },
    codeVersion: VERSION,
    variationsAttempted: family.length,
    result: {
      verdict, fixCandidate, gateReport,
      autopsyHeadlines: {
        finalScoreIC: autopsyPrimary.finalScore, prePenaltyBaseIC: autopsyPrimary.prePenaltyBase,
        penaltyMultIC: autopsyPrimary.penaltyMult, r10IC: autopsyPrimary.r10,
      },
      variantHeadlines: Object.fromEntries(Object.entries(runPrimary.variants).map(([v, r]) => [v, { lift: r.liftOverCurrent?.meanPct, vsR10: r.vsR10MeanPct, q: qOf(`primary.${v}`) }])),
    },
  });

  console.log(JSON.stringify({
    verdict, fixCandidate,
    autopsy: {
      finalScoreIC: autopsyPrimary.finalScore?.meanIC, baseIC: autopsyPrimary.prePenaltyBase?.meanIC,
      penaltyIC: autopsyPrimary.penaltyMult?.meanIC, r10IC: autopsyPrimary.r10?.meanIC,
      componentICs: Object.fromEntries(COMPONENT_KEYS.map((k) => [k, autopsyPrimary.components[k]?.meanIC])),
    },
    variants: Object.fromEntries(Object.entries(runPrimary.variants).map(([v, r]) => [v, { lift: r.liftOverCurrent?.meanPct, ci: r.liftOverCurrent?.ci95, folds: `${r.positiveFolds}/${r.usableFolds}`, q: qOf(`primary.${v}`), vsR10: r.vsR10MeanPct }])),
    broadVariants: Object.fromEntries(Object.entries(runBroad.variants).map(([v, r]) => [v, { lift: r.liftOverCurrent?.meanPct, vsR10: r.vsR10MeanPct }])),
    gateReport, runtimeMs: artifact.runtimeMs,
  }, null, 2));
  return artifact;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, EXPERIMENT_ID, ID };
