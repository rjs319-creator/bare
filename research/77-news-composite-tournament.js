'use strict';
// NEWS + TECHNICAL + FUNDAMENTAL + RECENT PERFORMANCE: 100-formula tournament.
//
// Selection discipline:
//   * Features use data knowable by each decision date.
//   * Formula choice is expanding-window walk-forward on the first 80% of dates.
//   * ONE formula is locked from that development region, then evaluated once on the
//     final 20% chronological holdout. The holdout is not used to tune weights.
//   * The 100 attempts are one hypothesis family; the winner must survive the
//     data-snooping haircut, costs, SPY-relative outcomes, and stability gates.
//
// The historical news archive is gap-event-conditioned and begins 2025-10-15. This
// experiment can judge whether the composite improves that bounded candidate set; it
// cannot establish alpha across the whole stock universe.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const PIT = require('./lib/pit');
const { screenTicker } = require('../lib/screener');
const ENGINE = require('../lib/swing-screener-engine');
const NF = require('../lib/research/news-alpha-features');

const ID = 'news-composite-100-formula-2026-08';
const VERSION = 'news-composite-tournament-v2';
const DATA = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA, 'gap-events-cause.json');
const NEWS_DIR = path.join(DATA, 'gapnews');
const H = 21, TOP_K = 10, FAMILY_N = 100, DEV_FRAC = 0.8, MIN_TRAIN_DATES = 50;
const NEWS_FLOOR = '2025-10-15';

const mean = K.mean;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const r = (x, n = 4) => Number.isFinite(x) ? +x.toFixed(n) : null;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const month = d => d.slice(0, 7);

function newsFile(sym, date) {
  const from = new Date(Date.parse(date) - 3 * 86400000).toISOString().slice(0, 10);
  return path.join(NEWS_DIR, `${sym}_${from}.json`);
}
function loadNews(sym, date) { try { const x = JSON.parse(fs.readFileSync(newsFile(sym, date), 'utf8')); return Array.isArray(x) ? x : []; } catch { return []; } }
function loadRaw(sym) { try { return JSON.parse(fs.readFileSync(path.join(K.CACHE_DIR, `${sym}.json`), 'utf8')); } catch { return null; } }

function fundamentalsAsOf(income, decisionDate) {
  const cutoff = Date.parse(decisionDate + 'T20:00:00Z');
  const rows = (income || []).map(x => {
    const raw = x.acceptedDate || x.filingDate || x.date;
    const eff = Date.parse(raw) + ((x.acceptedDate || x.filingDate) ? 0 : PIT.LAG);
    return { ...x, eff };
  }).filter(x => Number.isFinite(x.eff) && x.eff <= cutoff).sort((a, b) => b.eff - a.eff);
  if (!rows.length || !(rows[0].revenue > 0)) return null;
  const cur = rows[0], prev = rows[1], year = rows[4] || rows[3];
  const growth = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-9 ? a / Math.abs(b) - 1 : null;
  return {
    profitable: cur.netIncome > 0 ? 1 : 0,
    netMargin: cur.netIncome / cur.revenue,
    opMargin: cur.operatingIncome / cur.revenue,
    revGrowth: year ? growth(cur.revenue, year.revenue) : null,
    epsGrowth: year ? growth(cur.eps, year.eps) : null,
    marginChange: prev && prev.revenue > 0 ? cur.operatingIncome / cur.revenue - prev.operatingIncome / prev.revenue : null,
    dilution: year && year.weightedAverageShsOut > 0 ? cur.weightedAverageShsOut / year.weightedAverageShsOut - 1 : null,
  };
}

function rawFundamentalScore(f) {
  if (!f) return null; // missing is neutralized cross-sectionally, never treated as bad
  return clamp(0.22 * f.profitable + 0.2 * clamp((f.netMargin + .2) / .5, 0, 1)
    + 0.15 * clamp((f.opMargin + .2) / .5, 0, 1) + 0.18 * clamp(((f.revGrowth ?? 0) + .2) / .8, 0, 1)
    + 0.12 * clamp(((f.epsGrowth ?? 0) + .5) / 2, 0, 1) + 0.08 * clamp(((f.marginChange ?? 0) + .1) / .2, 0, 1)
    + 0.05 * clamp(1 - Math.max(0, f.dilution ?? 0) / .25, 0, 1), 0, 1);
}

function performanceFeatures(candles, spy, date) {
  const idx = candles.findIndex(x => x.date === date), bi = spy.findIndex(x => x.date === date);
  if (idx < 126 || bi < 126) return null;
  const ret = (s, i, n) => s[i].close / s[i - n].close - 1;
  const recent = .55 * (ret(candles, idx, 21) - ret(spy, bi, 21)) + .45 * (ret(candles, idx, 63) - ret(spy, bi, 63));
  return { recent, mom126: ret(candles, idx, 126), dailyEventMove: ret(candles, idx, 1) - ret(spy, bi, 1) };
}

function rank01(rows, key) {
  const vals = rows.map((x, i) => [x[key], i]).filter(x => Number.isFinite(x[0])).sort((a, b) => a[0] - b[0]);
  if (!vals.length) return;
  // Average ranks for ties. News is sparse, so order-breaking equal zeroes would create
  // a large fake signal whose direction depended only on the event input order.
  for (let lo = 0; lo < vals.length;) {
    let hi = lo + 1; while (hi < vals.length && vals[hi][0] === vals[lo][0]) hi++;
    const avgRank = vals.length === 1 ? .5 : ((lo + hi - 1) / 2) / (vals.length - 1);
    for (let k = lo; k < hi; k++) rows[vals[k][1]][`${key}Rank`] = avgRank;
    lo = hi;
  }
  rows.forEach(x => { if (!Number.isFinite(x[`${key}Rank`])) x[`${key}Rank`] = .5; });
}

function topReturn(rows, spec) {
  const ranked = rows.map(x => ({ ...x, formulaScore: NF.formulaScore(x.f, spec) }))
    .sort((a, b) => b.formulaScore - a.formulaScore || a.ticker.localeCompare(b.ticker)).slice(0, TOP_K);
  return ranked.length ? mean(ranked.map(x => x.netExcess)) * 100 : null;
}

function evalSpec(panels, spec) {
  const series = panels.map(p => ({ date: p.date, value: topReturn(p.rows, spec) })).filter(x => Number.isFinite(x.value));
  const summary = K.summarizeByDate(series, { horizonBars: H });
  return { spec, summary, avg: summary && summary.avg, p: summary && K.pValue(summary), series };
}

function choose(panels, specs) {
  return specs.map(s => evalSpec(panels, s)).sort((a, b) => (b.avg ?? -Infinity) - (a.avg ?? -Infinity) || a.spec.id.localeCompare(b.spec.id))[0];
}

function downsideAdjustedScore(e) {
  if (!e || !Number.isFinite(e.avg)) return -Infinity;
  const s = e.summary;
  return e.avg - .35 * (s.sd || 0) - (s.positiveBlocks < 3 ? .5 : 0);
}

async function main() {
  const t0 = Date.now(), specs = NF.generateFormulaFamily(FAMILY_N);
  const events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')).filter(x => x.date >= NEWS_FLOOR);
  const tickers = [...new Set(events.map(x => x.sym))];
  const { dataset, spy, spyIdx, attrition: universeAttrition } = K.loadUniverse({ minBars: 180, minAdv: 1e6, maxNames: 12000 });
  const raw = new Map(tickers.map(t => [t, loadRaw(t)]).filter(x => x[1]));
  const byDate = new Map(); for (const e of events) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
  const panels = [], missing = { noPrice: 0, noForward: 0, noNews: 0, noTechnical: 0, noFundamentals: 0 };

  for (const [date, evs] of [...byDate].sort((a, b) => a[0].localeCompare(b[0]))) {
    const spyF = K.benchmarkForward(spy, spyIdx, date, H); if (spyF == null) continue;
    const spySlice = K.sliceAsOf(spy, date), spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });
    const screened = [], inputs = [];
    for (const e of evs) {
      const d = dataset.get(e.sym), rr = raw.get(e.sym); if (!d || !rr) { missing.noPrice++; continue; }
      const pit = K.sliceAsOf(d.candles, date); if (pit.length < 160 || pit[pit.length - 1].date !== date) { missing.noPrice++; continue; }
      const perf = performanceFeatures(d.candles, spy, date); if (!perf) { missing.noPrice++; continue; }
      const fwd = K.forwardFromNextOpen(d, date, H); if (fwd == null) { missing.noForward++; continue; }
      const tech = screenTicker(pit, { symbol: e.sym }, { gate: 'relaxed', spyByDate });
      if (!tech || !tech.factors) { missing.noTechnical++; continue; }
      tech.ticker = e.sym; tech.lastBarDate = date; screened.push(tech);
      const articles = loadNews(e.sym, date); if (!articles.length) missing.noNews++;
      const news = NF.newsImpactFeature({ articles, stock: d.candles, benchmark: spy, decisionDate: date });
      const fundamentals = fundamentalsAsOf(rr.income, date); if (!fundamentals) missing.noFundamentals++;
      const cost = K.costFractions(tech.factors.dollarVol);
      inputs.push({ ticker: e.sym, tech, newsRaw: news.score, fundamentalRaw: rawFundamentalScore(fundamentals), recentRaw: perf.recent,
        netExcess: fwd - spyF - cost.base, positiveArticles: news.positiveArticles, eventCause: e.cause });
    }
    if (inputs.length < TOP_K) continue;
    // Technical composite is the exact production same-date quant score.
    const sel = ENGINE.selectCandidates({ rows: screened, scope: 'large', spyCandles: spySlice, now: new Date(date + 'T23:59:00Z') });
    const q = new Map((sel.cohort || []).map(x => [x.ticker, x.quant && x.quant.score]));
    const rows = inputs.filter(x => Number.isFinite(q.get(x.ticker))).map(x => ({ ...x, technicalRaw: q.get(x.ticker) }));
    if (rows.length < TOP_K) continue;
    for (const key of ['newsRaw', 'technicalRaw', 'fundamentalRaw', 'recentRaw']) rank01(rows, key);
    rows.forEach(x => { x.f = { news: x.newsRawRank, technical: x.technicalRawRank, fundamental: x.fundamentalRawRank, recent: x.recentRawRank }; });
    panels.push({ date, rows });
  }
  if (panels.length < 80) throw new Error(`insufficient panels: ${panels.length}`);

  const split = Math.floor(panels.length * DEV_FRAC), dev = panels.slice(0, split), holdout = panels.slice(split);
  // Expanding walk-forward in development: choose using only strictly prior panels.
  const wf = [];
  for (let i = MIN_TRAIN_DATES; i < dev.length; i++) {
    const winner = choose(dev.slice(0, i), specs);
    const value = topReturn(dev[i].rows, winner.spec);
    wf.push({ date: dev[i].date, value, selectedFormula: winner.spec.id });
  }
  const walkForward = K.summarizeByDate(wf, { horizonBars: H });

  // Lock using a conservative development objective; ties deterministic by id.
  const devEvals = specs.map(s => evalSpec(dev, s)).sort((a, b) => downsideAdjustedScore(b) - downsideAdjustedScore(a) || a.spec.id.localeCompare(b.spec.id));
  const locked = devEvals[0];
  const hold = evalSpec(holdout, locked.spec);
  const positiveAllDev = devEvals.filter(x => Object.values(x.spec.weights).every(v => v > 0));
  const lockedPositiveAll = positiveAllDev[0] || null;
  const positiveAllHoldout = lockedPositiveAll ? evalSpec(holdout, lockedPositiveAll.spec) : null;
  const newsOnly = evalSpec(holdout, specs[0]);
  const techOnly = evalSpec(holdout, specs[1]);
  const fundOnly = evalSpec(holdout, specs[2]);
  const recentOnly = evalSpec(holdout, specs[3]);
  const equal = K.summarizeByDate(holdout.map(p => ({ date: p.date, value: mean(p.rows.map(x => x.netExcess)) * 100 })), { horizonBars: H });
  const pairedLift = K.summarizeByDate(holdout.map(p => ({ date: p.date, value: topReturn(p.rows, locked.spec) - topReturn(p.rows, specs[1]) })), { horizonBars: H });

  // Deflated selection read: compare locked holdout mean with empirical dispersion of all
  // 100 holdout means. This is diagnostic only; the holdout itself was never used to select.
  const allHold = specs.map(s => evalSpec(holdout, s));
  const holdMeans = allHold.map(x => x.avg).filter(Number.isFinite), dispersion = sd(holdMeans);
  const snoopingZ = dispersion ? (hold.avg - mean(holdMeans)) / dispersion : null;
  const selectedCounts = Object.entries(wf.reduce((o, x) => { o[x.selectedFormula] = (o[x.selectedFormula] || 0) + 1; return o; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }));

  const wouldPassFreshHoldout = hold.summary && hold.summary.avg > 0 && hold.summary.ci95.lo > 0
    && pairedLift && pairedLift.ci95.lo > 0 && hold.summary.positiveBlocks >= 3
    && walkForward && walkForward.avg > 0;
  // v1 opened the terminal dates with an invalid tie-ranker. v2 repairs that bug, but
  // those dates can no longer be called sealed confirmation. Preserve the corrected
  // diagnostics and require genuinely future data for any alpha claim.
  const passed = false;
  const artifact = {
    studyId: ID, version: VERSION,
    frozenConfig: { familySize: FAMILY_N, horizonSessions: H, topK: TOP_K, developmentFraction: DEV_FRAC,
      minTrainingDates: MIN_TRAIN_DATES, entry: 'next-session open', outcome: 'net excess vs SPY', newsHalfLifeSessions: NF.HALF_LIFE_SESSIONS },
    data: { coverage: 'gap-event-conditioned news archive', first: panels[0].date, last: panels.at(-1).date, dates: panels.length,
      developmentDates: dev.length, holdoutDates: holdout.length, candidates: panels.reduce((s, p) => s + p.rows.length, 0),
      positiveNewsCandidates: panels.reduce((s, p) => s + p.rows.filter(x => x.newsRaw > 0).length, 0), missing, universeAttrition },
    lockedFormula: locked.spec, development: locked.summary, expandingWalkForward: walkForward,
    holdout: hold.summary, holdoutComparisons: { newsOnly: newsOnly.summary, technicalOnly: techOnly.summary,
      fundamentalOnly: fundOnly.summary, recentOnly: recentOnly.summary, equalCandidate: equal, pairedLiftVsTechnical: pairedLift },
    intendedPositiveComposite: lockedPositiveAll ? { lockedFormula: lockedPositiveAll.spec,
      development: lockedPositiveAll.summary, holdout: positiveAllHoldout.summary } : null,
    selectionDiagnostics: { formulasAttempted: FAMILY_N, developmentTop10: devEvals.slice(0, 10).map(x => ({ id: x.spec.id, avg: x.avg, adjusted: r(downsideAdjustedScore(x)) })),
      walkForwardSelectionCounts: selectedCounts.slice(0, 10), holdoutFormulaMeanDispersion: r(dispersion), lockedVsFamilyHoldoutZ: r(snoopingZ) },
    holdoutIntegrity: { status: 'CONSUMED_BY_INVALID_V1', issue: 'v1 assigned different percentile ranks to tied news scores; v2 uses average tied ranks',
      correctedRunWouldPassFreshHoldoutGates: !!wouldPassFreshHoldout, consequence: 'diagnostic only; genuinely future dates required for confirmation' },
    verdict: passed ? 'HOLDOUT_ALPHA_CANDIDATE' : 'NO_CONFIRMED_ALPHA', promotable: false,
    limitations: ['News history begins 2025-10-15 and is conditioned on gap-event candidates; results do not generalize to the whole swing universe.',
      'Headline lexicon sentiment is deterministic and auditable but less nuanced than a timestamped trained news model.',
      'Daily bars associate news with observed price response; they cannot causally isolate pre-publication from post-publication intraday movement.',
      'Survivorship-reduced price cache and short historical window prohibit live promotion regardless of result.'],
    generatedAt: new Date().toISOString(), runtimeMs: Date.now() - t0,
  };
  const out = K.writeArtifact(path.join(DATA, 'news-composite-tournament'), 'result.json', artifact);
  K.recordExperiment({ id: ID, hypothesis: 'A decaying positive-news reaction combined with technical, PIT fundamental, and recent relative-performance composites adds net 21-session alpha versus SPY and technical ranking alone.',
    frozenConfig: artifact.frozenConfig, dataSnapshot: artifact.data, codeVersion: VERSION, testDates: { first: panels[0].date, last: panels.at(-1).date, n: panels.length },
    variationsAttempted: FAMILY_N, result: { lockedFormula: locked.spec.id, holdout: hold.summary, pairedLiftVsTechnical: pairedLift, walkForward },
    correctedSignificance: { method: 'corrected chronological diagnostic after invalid v1 tie handling', holdoutUsedOnce: false,
      reason: 'terminal dates were exposed by invalid v1; v2 cannot reuse them as sealed confirmation' },
    costStress: { baseCostsApplied: true }, decision: 'NOT PROMOTED', reason: `${artifact.verdict}; bounded gap-news coverage and survivorship-reduced cache.` , artifact: out });
  console.log(JSON.stringify({ ...artifact, artifact: out.file }, null, 2));
  return artifact;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, fundamentalsAsOf, rawFundamentalScore, performanceFeatures, rank01 };
