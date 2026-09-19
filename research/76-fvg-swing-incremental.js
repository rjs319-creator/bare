'use strict';
// Frozen shadow experiment: does a conventional bullish 3-candle FVG add incremental
// 21-session information to the production swing score? Never changes live selection.
const path = require('node:path');
const K = require('./lib/experiment-kit');
const { screenTicker } = require('../lib/screener');
const ENGINE = require('../lib/swing-screener-engine');
const { bullishFvgFeature } = require('../lib/fair-value-gap');

const ID = 'fvg-swing-incremental-2026-08';
const VERSION = 'fvg-swing-v1';
const H = 21, MIN_HISTORY = 280, MIN_ADV = 5e6, TOP_K = 10;
const args = Object.fromEntries(process.argv.slice(2).map((a, i, x) => a.startsWith('--') ? [a.slice(2), x[i + 1]] : null).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 1500);

async function main() {
  const t0 = Date.now();
  const { dataset, spy, spyIdx, attrition: universeAttrition } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  const dates = [];
  for (let i = 262; i <= spy.length - 1 - H; i += STEP) dates.push(spy[i].date);
  const attr = K.newAttrition(); attr.noScore = 0;
  const panels = [];
  for (const D of dates) {
    const spyF = K.benchmarkForward(spy, spyIdx, D, H); if (spyF == null) continue;
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
      const fwd = K.forwardFromNextOpen(v, D, H, attr); if (fwd == null) continue;
      const q = c.quant && c.quant.score; if (!Number.isFinite(q) || (c.factors.dollarVol || 0) < MIN_ADV) continue;
      const fv = bullishFvgFeature(pit, { maxAge: 42, atr: c.factors.atr });
      const cost = K.costFractions(c.factors.dollarVol);
      rows.push({ ticker: c.ticker, production: q, fvg: fv.score, confirmed: fv.present && fv.score >= 55,
        excess: fwd - spyF, net: fwd - spyF - cost.base });
    }
    if (rows.length >= 20) panels.push({ date: D, rows });
  }

  const variants = {
    production: r => r.production,
    fvgOnly: r => r.fvg,
    productionPlusFvg: r => r.production + 0.15 * r.fvg,
  };
  const results = {};
  for (const [name, score] of Object.entries(variants)) {
    const daily = [], ics = [];
    for (const p of panels) {
      const rows = p.rows.map(r => ({ ...r, score: score(r) })).filter(r => Number.isFinite(r.score));
      const ic = K.rankIC(rows.map(r => r.score), rows.map(r => r.excess)); if (ic != null) ics.push(ic);
      const top = rows.sort((a, b) => b.score - a.score).slice(0, TOP_K);
      daily.push({ date: p.date, value: K.mean(top.map(r => r.net)) * 100 });
    }
    const s = K.summarizeByDate(daily, { horizonBars: H });
    results[name] = { rankIC: K.mean(ics), topKNet: s, pValue: K.pValue(s) };
  }
  const matched = [];
  for (const p of panels) {
    const yes = p.rows.filter(r => r.confirmed), no = p.rows.filter(r => !r.confirmed);
    if (!yes.length || !no.length) continue;
    const diffs = yes.map(y => {
      const control = no.slice().sort((a, b) => Math.abs(a.production - y.production) - Math.abs(b.production - y.production))[0];
      return y.net - control.net;
    });
    matched.push({ date: p.date, value: K.mean(diffs) * 100 });
  }
  const matchedLift = K.summarizeByDate(matched, { horizonBars: H });
  const liftRows = [];
  const a = results.productionPlusFvg.topKNet.series || [];
  // summarizeByDate does not guarantee exposed series; recompute paired top-k lift directly.
  for (const p of panels) {
    const base = p.rows.slice().sort((x, y) => y.production - x.production).slice(0, TOP_K);
    const plus = p.rows.slice().sort((x, y) => (y.production + .15*y.fvg) - (x.production + .15*x.fvg)).slice(0, TOP_K);
    liftRows.push({ date: p.date, value: (K.mean(plus.map(r => r.net)) - K.mean(base.map(r => r.net))) * 100 });
  }
  const incrementalLift = K.summarizeByDate(liftRows, { horizonBars: H });
  const passed = incrementalLift && incrementalLift.ci95.lo > 0 && matchedLift && matchedLift.ci95.lo > 0;
  const artifact = { studyId: ID, version: VERSION, frozenConfig: { horizon: H, maxAge: 42, confirmationScore: 55, fvgWeight: .15, topK: TOP_K, step: STEP, maxNames: MAX_NAMES },
    dates: panels.length, universeAttrition, results, matchedConfirmedVsControl: matchedLift, incrementalTopKLift: incrementalLift,
    verdict: passed ? 'PROMISING_SHADOW_ONLY' : 'NO_CONFIRMED_INCREMENTAL_EDGE', promotable: false,
    limitations: ['Survivorship-reduced cache; no live promotion permitted.', 'One frozen daily-candle FVG definition; intraday FVGs are not tested.', 'FVG confirmation is matched on production score within date, not a full causal model.'],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString() };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'fvg-swing'), 'result.json', artifact);
  console.log(JSON.stringify({ ...artifact, artifact: written.file }, null, 2));
  return artifact;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, ID, VERSION };
