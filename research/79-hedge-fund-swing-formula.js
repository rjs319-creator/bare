'use strict';

// Frozen hedge-fund-style swing formula diagnostic. This consumes the SAME
// gap/news-conditioned decision panels as experiments 77/78, so the output is an
// ablation/mechanism read, never fresh confirmation or a live-promotion artifact.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const PIT = require('./lib/pit');
const NF = require('../lib/research/news-alpha-features');
const HF = require('../lib/research/hedge-fund-swing-formula');
const { SECTOR_OF } = require('../lib/universe');

const ID = 'hedge-fund-swing-formula-diagnostic-2026-08';
const VERSION = 'hedge-fund-swing-formula-v6';
const DATA = path.join(__dirname, 'data');
const H = 21;
const TOP_K = 10;
const MIN_DOLLAR_VOL = 5e6;
const CURRENT_SYMBOLS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols || {}; }
  catch { return {}; }
})();
const EVENTS = JSON.parse(fs.readFileSync(path.join(DATA, 'gap-events-cause.json'), 'utf8'))
  .filter(x => x.date >= '2025-10-15');

function sectorOf(ticker) {
  return CURRENT_SYMBOLS[ticker] && CURRENT_SYMBOLS[ticker].sector
    || SECTOR_OF[ticker]
    || 'Other';
}

function loadRaw(sym) {
  try { return JSON.parse(fs.readFileSync(path.join(K.CACHE_DIR, `${sym}.json`), 'utf8')); }
  catch { return null; }
}

function newsFile(sym, date) {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10);
  return path.join(DATA, 'gapnews', `${sym}_${from}.json`);
}

function loadNews(sym, date) {
  try { const x = JSON.parse(fs.readFileSync(newsFile(sym, date), 'utf8')); return Array.isArray(x) ? x : []; }
  catch { return []; }
}

function asOfTimestamp(raw, lag = 0) {
  if (!raw) return null;
  const s = String(raw).trim().replace(' ', 'T');
  const ts = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ts) ? ts + lag : null;
}

function filedFundamentalsAsOf(income, decisionDate) {
  const cutoff = Date.parse(`${decisionDate}T20:00:00Z`);
  const q = (income || []).map(x => ({
    ...x,
    effectiveAt: asOfTimestamp(x.acceptedDate || x.filingDate || x.date,
      x.acceptedDate || x.filingDate ? 0 : PIT.LAG),
  })).filter(x => Number.isFinite(x.effectiveAt) && x.effectiveAt <= cutoff)
    .sort((a, b) => b.effectiveAt - a.effectiveAt);
  if (!q.length || !(q[0].revenue > 0)) return null;
  const cur = q[0], prev = q[1], yearAgo = q[4], priorYearAgo = q[5];
  const growth = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-9
    ? a / Math.abs(b) - 1 : null;
  const margin = x => x && x.revenue > 0 && Number.isFinite(x.operatingIncome)
    ? x.operatingIncome / x.revenue : null;
  const revNow = yearAgo ? growth(cur.revenue, yearAgo.revenue) : null;
  const revPrev = prev && priorYearAgo ? growth(prev.revenue, priorYearAgo.revenue) : null;
  const epsNow = yearAgo ? growth(cur.eps, yearAgo.eps) : null;
  const epsPrev = prev && priorYearAgo ? growth(prev.eps, priorYearAgo.eps) : null;
  const revAcceleration = Number.isFinite(revNow) && Number.isFinite(revPrev) ? revNow - revPrev : null;
  const epsAcceleration = Number.isFinite(epsNow) && Number.isFinite(epsPrev) ? epsNow - epsPrev : null;
  const marginChange = Number.isFinite(margin(cur)) && Number.isFinite(margin(prev)) ? margin(cur) - margin(prev) : null;
  if (![revAcceleration, epsAcceleration, marginChange].some(Number.isFinite)) return null;
  return {
    rawAcceleration: .45 * (revAcceleration ?? 0) + .30 * (epsAcceleration ?? 0) + .25 * (marginChange ?? 0),
    ttmRevenue: q.slice(0, 4).reduce((s, x) => s + (Number.isFinite(x.revenue) ? x.revenue : 0), 0),
    dilution: yearAgo && yearAgo.weightedAverageShsOut > 0 && cur.weightedAverageShsOut > 0
      ? cur.weightedAverageShsOut / yearAgo.weightedAverageShsOut - 1 : null,
  };
}

function addRanks(rows) {
  const fields = ['marketResidual', 'sectorResidual', 'entryRaw', 'fundamentalRaw', 'newsRaw',
    'downsideRaw', 'extensionRaw', 'consumedRaw', 'costRaw'];
  for (const field of fields) {
    const ranks = HF.averageTieRanks(rows.map(r => r[field]));
    rows.forEach((r, i) => { r[`${field}Rank`] = ranks[i] == null ? .5 : ranks[i]; });
  }
  for (const r of rows) {
    const features = {
      momentum: r.sectorResidualRank,
      entry: r.entryRawRank,
      fundamental: r.fundamentalRawRank,
      news: r.newsRawRank,
      downside: r.downsideRawRank,
      extension: r.extensionRawRank,
      consumed: r.consumedRawRank,
      cost: r.costRawRank,
      conditionalNews: r.conditionalNews,
    };
    r.scores = {
      marketResidual: r.marketResidualRank,
      sectorNeutralResidual: r.sectorResidualRank,
      residualPlusEntry: .70 * r.sectorResidualRank + .30 * r.entryRawRank,
      coreFundamental: HF.scoreFormula(features, { includeNews: false, riskAdjust: false }),
      conditionalNews: HF.scoreFormula(features, { includeNews: true, riskAdjust: false }),
      riskAdjusted: HF.scoreFormula(features, { includeNews: true, riskAdjust: true }),
      fullGatedRegime: r.riskGate ? -Infinity
        : HF.scoreFormula(features, { includeNews: true, riskAdjust: true }),
    };
  }
}

const ARMS = Object.freeze([
  'marketResidual', 'sectorNeutralResidual', 'residualPlusEntry', 'coreFundamental',
  'conditionalNews', 'riskAdjusted', 'fullGatedRegime',
]);

function picks(panel, arm) {
  return panel.rows.filter(r => Number.isFinite(r.scores[arm]))
    .sort((a, b) => b.scores[arm] - a.scores[arm] || a.ticker.localeCompare(b.ticker))
    .slice(0, TOP_K);
}

function perDateValue(panel, arm, key = 'netBase') {
  const top = picks(panel, arm);
  if (arm !== 'fullGatedRegime') return top.length >= TOP_K ? HF.mean(top.map(r => r[key])) * 100 : null;
  const returnKey = key === 'netDoubled' ? 'netReturnDoubled' : 'netReturnBase';
  // The regime multiplier sizes the long book and leaves the balance in cash.
  // A vetoed slot is also cash rather than a reason to discard the entire date.
  const filledFraction = top.length / TOP_K;
  const selectedReturn = top.length ? HF.mean(top.map(r => r[returnKey])) : 0;
  return (panel.regime.multiplier * filledFraction * selectedReturn - panel.spyForward) * 100;
}

function summarizeArm(panels, arm) {
  const rows = panels.map(p => ({ date: p.date, value: perDateValue(p, arm) })).filter(x => Number.isFinite(x.value));
  const summary = K.summarizeByDate(rows, { horizonBars: H });
  const doubled = K.summarizeByDate(panels.map(p => ({ date: p.date, value: perDateValue(p, arm, 'netDoubled') }))
    .filter(x => Number.isFinite(x.value)), { horizonBars: H });
  const ic = panels.map(p => {
    const usable = p.rows.filter(r => Number.isFinite(r.scores[arm]));
    return K.rankIC(usable.map(r => r.scores[arm]), usable.map(r => r.netBase));
  }).filter(Number.isFinite);
  return { ...summary, rankIC: ic.length ? +HF.mean(ic).toFixed(5) : null,
    rankICDates: ic.length, doubledCostAvg: doubled && doubled.avg };
}

function pairedLift(panels, challenger, control) {
  return K.summarizeByDate(panels.map(p => {
    const a = perDateValue(p, challenger), b = perDateValue(p, control);
    return Number.isFinite(a) && Number.isFinite(b) ? { date: p.date, value: a - b } : null;
  }).filter(Boolean), { horizonBars: H });
}

async function main(options = {}) {
  const t0 = Date.now();
  const { dataset, spy, spyIdx, attrition } = K.loadUniverse({ minBars: 180, minAdv: 1e6, maxNames: 12000 });
  const symbols = [...new Set(EVENTS.map(x => x.sym))];
  const raw = new Map(symbols.map(t => [t, loadRaw(t)]).filter(x => x[1]));
  const byDate = new Map();
  for (const e of EVENTS) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }

  const panels = [];
  let eligibleEvents = 0, gatedEvents = 0, conditionalNewsEvents = 0;
  for (const [date, events] of [...byDate].sort((a, b) => a[0].localeCompare(b[0]))) {
    const spyForward = K.benchmarkForward(spy, spyIdx, date, H);
    const regime = HF.regimeMultiplier(spy, date);
    if (spyForward == null || !regime) continue;
    const rows = [];
    for (const e of events) {
      const d = dataset.get(e.sym), rr = raw.get(e.sym);
      if (!d || !rr) continue;
      const pit = K.sliceAsOf(d.candles, date);
      if (pit.length < 160 || pit.at(-1).date !== date) continue;
      const fwd = K.forwardFromNextOpen(d, date, H);
      const momentum = HF.betaResidualMomentum(d.candles, spy, date);
      const entry = HF.entryFeatures(d.candles, date);
      if (fwd == null || !momentum || !entry) continue;
      const downside = HF.downsideRisk(d.candles, spy, date, momentum.beta);
      const fundamental = filedFundamentalsAsOf(rr.income, date);
      const articles = loadNews(e.sym, date);
      const news = NF.improvedNewsFeature({ articles, stock: d.candles, benchmark: spy,
        decisionDate: date, ttmRevenue: fundamental && fundamental.ttmRevenue });
      const flags = NF.newsRiskFlags(articles, { decisionDate: date });
      const dollarVol = HF.mean(pit.slice(-20).map(x => x.close * x.volume));
      if (!(dollarVol >= MIN_DOLLAR_VOL) || !Number.isFinite(downside)) continue;
      const costs = K.costFractions(dollarVol);
      const conditionalNews = news.score > 0 && news.strongest
        && news.strongest.materiality >= .55
        && news.strongest.underreaction >= .55
        && entry.volumeConfirmation >= 1.20
        && news.consumedPenalty < 50;
      const riskGate = flags.offeringOrDilution || flags.guidanceCutOrMiss || flags.binaryLegalOrClinical
        || (fundamental && fundamental.dilution > .15) || news.consumedPenalty >= 75
        || entry.extensionInAtr > 5;
      rows.push({
        ticker: e.sym,
        sector: sectorOf(e.sym),
        marketResidual: momentum.residualMomentum,
        entryRaw: entry.entryQuality,
        fundamentalRaw: fundamental ? fundamental.rawAcceleration : null,
        newsRaw: news.score,
        downsideRaw: downside,
        extensionRaw: Math.max(0, entry.extensionInAtr),
        consumedRaw: news.consumedPenalty,
        costRaw: costs.base,
        conditionalNews,
        riskGate,
        regimeMultiplier: regime.multiplier,
        netBase: fwd - spyForward - costs.base,
        netDoubled: fwd - spyForward - costs.doubled,
        netReturnBase: fwd - costs.base,
        netReturnDoubled: fwd - costs.doubled,
      });
    }
    if (rows.length < TOP_K) continue;
    // Cross-sectional sector neutralization. Sectors with one name still remove
    // the same-date market component through the preceding beta residualization.
    const sectorMean = new Map();
    for (const r of rows) {
      if (!sectorMean.has(r.sector)) sectorMean.set(r.sector, []);
      sectorMean.get(r.sector).push(r.marketResidual);
    }
    for (const r of rows) r.sectorResidual = r.marketResidual - HF.mean(sectorMean.get(r.sector));
    addRanks(rows);
    eligibleEvents += rows.length;
    gatedEvents += rows.filter(r => r.riskGate).length;
    conditionalNewsEvents += rows.filter(r => r.conditionalNews).length;
    const spyI = spyIdx.get(date);
    const labelEndDate = spyI != null && spy[spyI + H] ? spy[spyI + H].date : null;
    panels.push({ date, rows, regime, spyForward, labelEndDate });
  }

  if (options.panelsOnly) return {
    version: VERSION, panels, attrition,
    counts: { eligibleEvents, gatedEvents, conditionalNewsEvents },
  };

  const results = Object.fromEntries(ARMS.map(a => [a, summarizeArm(panels, a)]));
  const lifts = {
    sectorNeutralization: pairedLift(panels, 'sectorNeutralResidual', 'marketResidual'),
    entryQuality: pairedLift(panels, 'residualPlusEntry', 'sectorNeutralResidual'),
    filedFundamentals: pairedLift(panels, 'coreFundamental', 'residualPlusEntry'),
    conditionalNews: pairedLift(panels, 'conditionalNews', 'coreFundamental'),
    riskAdjustment: pairedLift(panels, 'riskAdjusted', 'conditionalNews'),
    gatesAndRegime: pairedLift(panels, 'fullGatedRegime', 'riskAdjusted'),
    fullVsSimpleBaseline: pairedLift(panels, 'fullGatedRegime', 'marketResidual'),
  };
  const finalLift = lifts.fullVsSimpleBaseline;
  const verdict = finalLift && finalLift.ci95.lo > 0 && finalLift.positiveBlocks >= 3
    ? 'PROMISING_DIAGNOSTIC_NEEDS_PROSPECTIVE_CONFIRMATION' : 'NO_CONFIRMED_INCREMENTAL_ALPHA';
  const result = {
    studyId: ID,
    version: VERSION,
    contract: {
      formula: HF.FORMULA,
      arms: ARMS,
      horizonSessions: H,
      topK: TOP_K,
      entry: 'next-session open',
      outcome: 'cost-net excess versus SPY',
      momentum: '126→21 skip-recent stock return minus estimated beta × SPY return; then same-date sector demeaning',
      fundamentals: 'filed revenue-growth acceleration, EPS-growth acceleration and operating-margin change; analyst revisions omitted because PIT validation fails',
      news: 'materiality × underreaction × time decay; boost activates only with materiality, volume confirmation and an unconsumed move',
      hardGates: ['offering/dilution news', 'guidance cut/miss', 'legal/clinical binary risk',
        'filed dilution >15%', 'news reaction substantially consumed', 'extension >5 ATR'],
      regime: 'SPY 200-session trend × 20-session realized-volatility exposure multiplier (cash for unallocated exposure)',
      portfolio: 'up to ten equal-weight names; vetoed slots remain in cash, so no date is discarded for too few survivors',
    },
    data: {
      first: panels[0] && panels[0].date,
      last: panels.at(-1) && panels.at(-1).date,
      dates: panels.length,
      candidates: eligibleEvents,
      gatedCandidates: gatedEvents,
      conditionalNewsCandidates: conditionalNewsEvents,
      attrition,
    },
    results,
    lifts,
    verdict,
    promotable: false,
    holdoutStatus: 'DIAGNOSTIC_ONLY — dates and formula families were previously examined in experiments 77/78',
    limitations: [
      'Gap-event-conditioned universe only; not a broad all-stock portfolio replay.',
      'Analyst estimate revisions are omitted because the local revision history is PIT_UNPROVEN.',
      'Sector classifications are current approximations, not point-in-time classifications.',
      'Daily news timestamps cannot isolate intraday pre-publication price movement.',
      'Overlapping 21-session windows are dependence-adjusted but are not an executable monthly equity curve.',
      'The price cache is survivorship-reduced, not survivorship-proven-safe.',
    ],
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - t0,
  };
  const artifact = K.writeArtifact(path.join(DATA, 'hedge-fund-swing-formula'), 'result.json', result);
  K.recordExperiment({
    id: ID,
    hypothesis: 'A market/sector-neutral residual-momentum core plus entry quality, filed fundamental acceleration, conditional material-news boost, risk-adjusted ranking, hard vetoes and regime scaling improves cost-net top-k excess over the simple residual-momentum baseline.',
    family: 'swing-ranking',
    frozenConfig: result.contract,
    dataSnapshot: result.data,
    codeVersion: VERSION,
    testDates: { first: result.data.first, last: result.data.last, n: result.data.dates },
    variationsAttempted: ARMS.length,
    result: { results, lifts, verdict },
    correctedSignificance: 'date-level paired lift; HAC + effective-N Student-t + seeded 21-session moving-block bootstrap',
    costStress: { baseCostsApplied: true, doubledCostsReported: true },
    decision: 'NOT PROMOTED — diagnostic data were previously consumed',
    reason: `${verdict}; analyst revisions unavailable on a validated PIT basis; future prospective dates required.`,
    artifact,
  });
  console.log(JSON.stringify({ ...result, artifact: artifact.file }, null, 2));
  return result;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, buildPanels: () => main({ panelsOnly: true }), filedFundamentalsAsOf, addRanks, ARMS };
