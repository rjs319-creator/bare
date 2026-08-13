'use strict';
// Frozen shadow experiment: do a literal multi-contraction VCP or a strict Minervini
// trend template add incremental 21-session information to the production swing score?
// Modeled on research/76-fvg-swing-incremental.js. Never changes live selection.
const path = require('node:path');
const K = require('./lib/experiment-kit');
const { screenTicker } = require('../lib/screener');
const ENGINE = require('../lib/swing-screener-engine');
const { minerviniTemplate, detectVcp, geminiVcpScreen } = require('../lib/research/trend-template-vcp');

const ID = 'vcp-template-swing-incremental-2026-08';
const VERSION = 'vcp-template-swing-v2';  // v2 adds the Gemini-suggested screen as a competing variant
const H = 21, MIN_HISTORY = 280, MIN_ADV = 5e6, TOP_K = 10, BOOST = 10;
const args = Object.fromEntries(process.argv.slice(2).map((a, i, x) => a.startsWith('--') ? [a.slice(2), x[i + 1]] : null).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 1500);

async function main() {
  const t0 = Date.now();
  const { dataset, spy, spyIdx, attrition: universeAttrition } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  const dates = [];
  for (let i = 262; i <= spy.length - 1 - H; i += STEP) dates.push(spy[i].date);
  const attr = K.newAttrition();
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
      const template = minerviniTemplate(pit, pit.length - 1);
      const vcp = detectVcp(pit, pit.length - 1);
      const gemini = geminiVcpScreen(pit, pit.length - 1);
      const cost = K.costFractions(c.factors.dollarVol);
      rows.push({
        ticker: c.ticker, production: q,
        templatePass: !!(template && template.pass), vcp: !!(vcp && vcp.isVcp),
        gemini: !!(gemini && gemini.signal),
        excess: fwd - spyF, net: fwd - spyF - cost.base,
      });
    }
    if (rows.length >= 20) panels.push({ date: D, rows });
  }

  const variants = {
    production: r => r.production,
    productionPlusTemplate: r => r.production + (r.templatePass ? BOOST : 0),
    productionPlusVcp: r => r.production + (r.vcp ? BOOST : 0),
    productionPlusGemini: r => r.production + (r.gemini ? BOOST : 0),
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

  // Hard-filter variant: production rank restricted to template passers (the literal
  // "trade only template stocks" rule). Dates without enough passers are counted, not padded.
  const filteredDaily = []; let thinFilterDates = 0;
  for (const p of panels) {
    const passers = p.rows.filter(r => r.templatePass).sort((a, b) => b.production - a.production);
    if (passers.length < 5) { thinFilterDates++; continue; }
    filteredDaily.push({ date: p.date, value: K.mean(passers.slice(0, TOP_K).map(r => r.net)) * 100 });
  }
  results.templateHardFilter = { topKNet: K.summarizeByDate(filteredDaily, { horizonBars: H }), thinFilterDates, usableDates: filteredDaily.length };

  // Within-date matched confirmed-vs-control, one flavor per signal (as in 76).
  const matched = { template: [], vcp: [], gemini: [] };
  for (const p of panels) {
    for (const [key, flag] of [['template', 'templatePass'], ['vcp', 'vcp'], ['gemini', 'gemini']]) {
      const yes = p.rows.filter(r => r[flag]), no = p.rows.filter(r => !r[flag]);
      if (!yes.length || !no.length) continue;
      const diffs = yes.map(y => {
        const control = no.slice().sort((a, b) => Math.abs(a.production - y.production) - Math.abs(b.production - y.production))[0];
        return y.net - control.net;
      });
      matched[key].push({ date: p.date, value: K.mean(diffs) * 100 });
    }
  }
  const matchedLift = {
    template: K.summarizeByDate(matched.template, { horizonBars: H }),
    vcp: K.summarizeByDate(matched.vcp, { horizonBars: H }),
    gemini: K.summarizeByDate(matched.gemini, { horizonBars: H }),
  };

  // Paired top-K lift of each boost variant over production.
  const incremental = {};
  for (const key of ['productionPlusTemplate', 'productionPlusVcp', 'productionPlusGemini']) {
    const liftRows = [];
    for (const p of panels) {
      const base = p.rows.slice().sort((x, y) => y.production - x.production).slice(0, TOP_K);
      const plus = p.rows.map(r => ({ ...r, s: variants[key](r) })).sort((x, y) => y.s - x.s).slice(0, TOP_K);
      liftRows.push({ date: p.date, value: (K.mean(plus.map(r => r.net)) - K.mean(base.map(r => r.net))) * 100 });
    }
    incremental[key] = K.summarizeByDate(liftRows, { horizonBars: H });
  }

  const signalRates = {
    templatePass: K.mean(panels.map(p => p.rows.filter(r => r.templatePass).length / p.rows.length)),
    vcp: K.mean(panels.map(p => p.rows.filter(r => r.vcp).length / p.rows.length)),
    gemini: K.mean(panels.map(p => p.rows.filter(r => r.gemini).length / p.rows.length)),
  };
  const anyPositive = Object.values(incremental).some(s => s && s.ci95.lo > 0)
    || Object.values(matchedLift).some(s => s && s.ci95.lo > 0);
  const verdict = anyPositive ? 'PROMISING_SHADOW_ONLY' : 'NO_CONFIRMED_INCREMENTAL_EDGE';

  const artifact = {
    studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    frozenConfig: { horizon: H, topK: TOP_K, boost: BOOST, step: STEP, maxNames: MAX_NAMES,
      template: 'minervini-strict-v1', vcp: 'multi-contraction-v1 (2-5 shrinking pullbacks, tight final leg, volume dry-up)',
      gemini: 'gemini-vcp-v1 (SMA stack + 1y>20%, within 15% of 52w high, ATR14/close<5%, ATR14<ATR50, 21d range<10%)' },
    dates: panels.length, universeAttrition, outcomeAttrition: attr, signalRates,
    results, matchedConfirmedVsControl: matchedLift, incrementalTopKLift: incremental,
    verdict, promotable: false, survivorshipProvenSafe: false,
    limitations: [
      'Survivorship-reduced cache; no live promotion permitted.',
      'One frozen VCP definition on daily closes; intraday structure is not tested.',
      'Matched control matches on production score within date, not a full causal model.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'vcp-template-swing'), 'result.json', artifact);
  K.recordExperiment({
    id: ID,
    hypothesis: 'A literal multi-contraction VCP and/or a strict Minervini trend template add cost-net 21-session top-10 excess over the production swing score.',
    family: 'swing-ranking',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: { dates: panels.length, universe: universeAttrition },
    codeVersion: VERSION,
    variationsAttempted: Object.keys(variants).length + 1,
    result: { verdict, incrementalTopKLift: incremental, matchedConfirmedVsControl: matchedLift, signalRates },
  });
  console.log(JSON.stringify({ ...artifact, artifact: written.file }, null, 2));
  return artifact;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, ID, VERSION };
