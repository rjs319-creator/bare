'use strict';
// Frozen diagnostic: does point-in-time CFTC TFF positioning (COT) add incremental
// information to the app's 5- and 10-session swing selection? Falsification-first pass
// on the proposed COT/OMEGA build: the full production spine (snapshots, tracker ops,
// shadow logging, UI) is only worth building if THIS shows anything.
//
// Two families, all frozen up front, FDR across every attempt:
//   TIMING  — 9 date-level features (leveraged-fund z-scores per market, ES asset-mgr z,
//             ES/NQ crowding-reversal flags) vs the top-10 strategy's forward net excess.
//   RANKING — paired top-10 lift of a predeclared interaction: when ES/NQ leveraged funds
//             are crowded-long AND unwinding, demote the top momentum tercile by 10 pts.
//
// Anti-leakage: joins go through cot-features.asOfJoin (report date + 4 calendar days).
//   node research/87-cot-incremental.js
const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const { screenTicker } = require('../lib/screener');
const ENGINE = require('../lib/swing-screener-engine');
const { parseCotRows, cotFeatureSeries, asOfJoin } = require('../lib/research/cot-features');

const ID = 'cot-incremental-2026-08';
const VERSION = 'cot-incremental-v1';
const HORIZONS = [5, 10], MIN_HISTORY = 280, MIN_ADV = 5e6, TOP_K = 10, DEMOTE = 10;
const BOOT_B = 1000, BOOT_BLOCK = 21, BOOT_SEED = 20260813;
const MARKETS = { ES: '13874+', NQ: '20974+', RTY: '239742', VIX: '1170E1', TY: '043602', DX: '098662' };
const args = Object.fromEntries(process.argv.slice(2).map((a, i, x) => a.startsWith('--') ? [a.slice(2), x[i + 1]] : null).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 1500);

// Moving-block bootstrap of an arbitrary statistic over a date-ordered paired series.
function blockBootstrap(series, statFn, { B = BOOT_B, L = BOOT_BLOCK, seed = BOOT_SEED } = {}) {
  const n = series.length;
  const obs = statFn(series);
  if (obs == null || n < L + 5) return { obs, ci95: null, p: null, B: 0 };
  const rnd = K.lcg(seed);
  const stats = [];
  const nBlocks = Math.ceil(n / L);
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let k = 0; k < nBlocks; k++) {
      const start = Math.floor(rnd() * (n - L + 1));
      for (let j = start; j < start + L && sample.length < n; j++) sample.push(series[j]);
    }
    const s = statFn(sample);
    if (s != null) stats.push(s);
  }
  if (stats.length < B * 0.8) return { obs, ci95: null, p: null, B: stats.length };
  stats.sort((a, b) => a - b);
  const q = (f) => stats[Math.min(stats.length - 1, Math.floor(f * stats.length))];
  const below = stats.filter(s => s <= 0).length / stats.length;
  return { obs: +obs.toFixed(4), ci95: { lo: +q(0.025).toFixed(4), hi: +q(0.975).toFixed(4) },
    p: +(2 * Math.min(below, 1 - below)).toFixed(4), B: stats.length };
}

const spearman = (rows) => K.rankIC(rows.map(r => r.x), rows.map(r => r.y));
const groupDiff = (rows) => {
  const on = rows.filter(r => r.x === 1).map(r => r.y), off = rows.filter(r => r.x === 0).map(r => r.y);
  return on.length >= 5 && off.length >= 5 ? K.mean(on) - K.mean(off) : null;
};

async function main() {
  const t0 = Date.now();
  const rawCot = JSON.parse(fs.readFileSync(path.join(K.DATA_DIR, 'cot', 'raw.json'), 'utf8'));
  const parsed = parseCotRows(rawCot);
  const feats = {};
  for (const [key, code] of Object.entries(MARKETS)) {
    if (!parsed.get(code)) throw new Error(`COT market missing from raw download: ${key} (${code})`);
    feats[key] = cotFeatureSeries(parsed.get(code));
  }

  const { dataset, spy, spyIdx, attrition: universeAttrition } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  const maxH = Math.max(...HORIZONS);
  const dates = [];
  for (let i = 262; i <= spy.length - 1 - maxH; i += STEP) dates.push(spy[i].date);
  const attr = K.newAttrition();
  const panels = [];
  for (const D of dates) {
    const spyF = {}; let ok = true;
    for (const H of HORIZONS) { spyF[H] = K.benchmarkForward(spy, spyIdx, D, H); if (spyF[H] == null) ok = false; }
    if (!ok) continue;
    const spySlice = K.sliceAsOf(spy, D), spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });
    const screened = [], pits = new Map();
    for (const [ticker, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < 220 || pit[pit.length - 1].date !== D) continue;
      const r = screenTicker(pit, { symbol: ticker }, { gate: 'relaxed', spyByDate });
      if (!r || !r.factors) continue;
      r.ticker = r.ticker || ticker; r.lastBarDate = D; screened.push(r); pits.set(ticker, pit);
    }
    if (screened.length < 20) continue;
    const sel = ENGINE.selectCandidates({ rows: screened, scope: 'large', spyCandles: spySlice, now: new Date(D + 'T23:59:00Z') });
    const rows = [];
    for (const c of sel.cohort || []) {
      const v = dataset.get(c.ticker), pit = pits.get(c.ticker); if (!v || !pit) continue;
      const q = c.quant && c.quant.score; if (!Number.isFinite(q) || (c.factors.dollarVol || 0) < MIN_ADV) continue;
      const cost = K.costFractions(c.factors.dollarVol);
      const mom = pit.length >= 64 && pit[pit.length - 64].close > 0
        ? pit[pit.length - 1].close / pit[pit.length - 64].close - 1 : null;
      const net = {};
      for (const H of HORIZONS) {
        const fwd = K.forwardFromNextOpen(v, D, H, attr);
        net[H] = fwd == null ? null : fwd - spyF[H] - cost.base;
      }
      if (HORIZONS.some(H => net[H] == null)) continue;
      rows.push({ ticker: c.ticker, production: q, momentum63: mom, net });
    }
    if (rows.length < 20) continue;
    const cot = {};
    for (const key of Object.keys(MARKETS)) cot[key] = asOfJoin(feats[key], D);
    panels.push({ date: D, rows, cot });
  }

  // Per-date strategy return (top-10 by production) per horizon.
  const strat = {};
  for (const H of HORIZONS) {
    strat[H] = panels.map(p => ({
      date: p.date, cot: p.cot,
      ret: K.mean(p.rows.slice().sort((a, b) => b.production - a.production).slice(0, TOP_K).map(r => r.net[H])) * 100,
    }));
  }

  // TIMING battery — 9 frozen date-level features.
  const TIMING = [
    ['ES.lev.z52', p => p.cot.ES && p.cot.ES.lev && p.cot.ES.lev.z52, spearman],
    ['NQ.lev.z52', p => p.cot.NQ && p.cot.NQ.lev && p.cot.NQ.lev.z52, spearman],
    ['RTY.lev.z52', p => p.cot.RTY && p.cot.RTY.lev && p.cot.RTY.lev.z52, spearman],
    ['VIX.lev.z52', p => p.cot.VIX && p.cot.VIX.lev && p.cot.VIX.lev.z52, spearman],
    ['TY.lev.z52', p => p.cot.TY && p.cot.TY.lev && p.cot.TY.lev.z52, spearman],
    ['DX.lev.z52', p => p.cot.DX && p.cot.DX.lev && p.cot.DX.lev.z52, spearman],
    ['ES.assetMgr.z52', p => p.cot.ES && p.cot.ES.assetMgr && p.cot.ES.assetMgr.z52, spearman],
    ['ES.lev.crowdingReversal', p => p.cot.ES && p.cot.ES.lev ? (p.cot.ES.lev.crowdingReversal ? 1 : 0) : null, groupDiff],
    ['NQ.lev.crowdingReversal', p => p.cot.NQ && p.cot.NQ.lev ? (p.cot.NQ.lev.crowdingReversal ? 1 : 0) : null, groupDiff],
  ];
  const timing = {};
  for (const H of HORIZONS) {
    for (const [name, pick, statFn] of TIMING) {
      const series = strat[H]
        .map(s => ({ x: pick(s), y: s.ret }))
        .filter(r => Number.isFinite(r.x) && Number.isFinite(r.y));
      timing[`${name}@${H}d`] = { n: series.length, ...blockBootstrap(series, statFn) };
    }
  }

  // RANKING interaction — paired top-10 lift of the crowding demotion, clustered by date.
  const ranking = {};
  for (const H of HORIZONS) {
    for (const mkt of ['ES', 'NQ']) {
      const liftRows = [];
      let activeDates = 0;
      for (const p of panels) {
        const active = !!(p.cot[mkt] && p.cot[mkt].lev && p.cot[mkt].lev.crowdingReversal);
        if (active) activeDates++;
        const moms = p.rows.map(r => r.momentum63).filter(Number.isFinite).sort((a, b) => a - b);
        const cut = moms.length ? moms[Math.floor(moms.length * 2 / 3)] : Infinity;
        const scoreOf = r => r.production - (active && Number.isFinite(r.momentum63) && r.momentum63 >= cut ? DEMOTE : 0);
        const base = p.rows.slice().sort((a, b) => b.production - a.production).slice(0, TOP_K);
        const adj = p.rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, TOP_K);
        liftRows.push({ date: p.date, value: (K.mean(adj.map(r => r.net[H])) - K.mean(base.map(r => r.net[H]))) * 100 });
      }
      const s = K.summarizeByDate(liftRows, { horizonBars: H });
      if (s) delete s.perDateCounts;
      ranking[`${mkt}.crowdDemote@${H}d`] = { ...s, activeDates };
    }
  }

  // FDR across everything attempted.
  const attempted = [
    ...Object.entries(timing).filter(([, v]) => v.p != null).map(([id, v]) => ({ id, p: v.p })),
    ...Object.entries(ranking).filter(([, v]) => v && v.ci95).map(([id, v]) => ({ id, p: K.pValue(v) })),
  ];
  const corrected = K.fdr(attempted);
  const survivors = (corrected || []).filter(f => f && f.survives).map(f => f.id);
  const positiveRankingSurvivor = survivors.some(id => ranking[id] && ranking[id].ci95.lo > 0);
  const verdict = panels.length < 60 ? 'INSUFFICIENT_DATA'
    : positiveRankingSurvivor ? 'PROMISING_SHADOW_ONLY'
      : survivors.length ? 'TIMING_ASSOCIATION_ONLY' : 'NO_INCREMENTAL_ALPHA';

  const artifact = {
    studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    frozenConfig: {
      markets: MARKETS, horizons: HORIZONS, topK: TOP_K, demote: DEMOTE, step: STEP, maxNames: MAX_NAMES,
      availability: 'report date + 4 calendar days (cot-features.asOfJoin, the only join door)',
      bootstrap: { B: BOOT_B, blockLen: BOOT_BLOCK, seed: BOOT_SEED },
      battery: '9 timing features x 2 horizons + 2 crowding-demotion interactions x 2 horizons, FDR across all 22',
    },
    dataSnapshot: {
      cotRows: rawCot.length,
      cotRange: { first: rawCot.length && String(rawCot[0].report_date_as_yyyy_mm_dd).slice(0, 10), reports: rawCot.length / 6 },
      panelDates: panels.length,
      panelRange: panels.length ? { first: panels[0].date, last: panels[panels.length - 1].date } : null,
    },
    universeAttrition, outcomeAttrition: attr,
    timing, ranking, fdr: corrected, fdrSurvivors: survivors, verdict,
    promotable: false, survivorshipProvenSafe: false,
    limitations: [
      'Substrate is the generic swing cohort ranked by the production score at 5/10 sessions, not the OMEGA ensemble score — a positive here justifies the OMEGA-native build, a null makes it unnecessary.',
      'Survivorship-reduced cache; no live promotion permitted.',
      'COT features are date-level: they cannot reorder a cross-section except through the predeclared interactions.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'cot-incremental'), 'result.json', artifact);
  K.recordExperiment({
    id: ID,
    hypothesis: 'Point-in-time CFTC TFF positioning (levered-fund z-scores, crowding-reversal flags) improves 5/10-session swing selection, either by timing the cohort or via predeclared crowding x momentum interactions.',
    family: 'macro-overlay',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: artifact.dataSnapshot,
    codeVersion: VERSION,
    variationsAttempted: attempted.length,
    result: { verdict, fdrSurvivors: survivors, ranking, timingHeadlines: Object.fromEntries(Object.entries(timing).filter(([, v]) => v.p != null && v.p < 0.1)) },
  });
  console.log(JSON.stringify({ verdict, fdrSurvivors: survivors, artifact: written.file, runtimeMs: artifact.runtimeMs }, null, 2));
  return artifact;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, ID, VERSION };
