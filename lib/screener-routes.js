// SCREENER-TRACKER ROUTE HANDLERS (fade / trend / daytrade / confluence) —
// extracted from api/tracker.js to de-godfile it. In lib/ so Vercel doesn't treat
// it as an endpoint; inline require('../lib/x') paths resolve unchanged from lib/.
const { LARGE: UNI_LARGE, SMALL_CAPS: UNI_SMALL, MICRO_CAPS: UNI_MICRO, SECTOR_OF } = require('./universe');
const { fetchDailyHistory } = require('./screener');
const { wilson } = require('./stats');
const { hasStore, readJSON, writeJSON,
        readFade, writeFade, writeFadeDay, readAllFadeDays,
        readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays,
        readDaytradeEng, writeDaytradeEng, writeDaytradeDay, readAllDaytradeDays,
        readConfluenceEng, writeConfluenceEng, writeConfluenceDay, readAllConfluenceDays } = require('./store');

async function runFadeOpt(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 120);
  const H = Math.max(5, parseInt(req.query.h, 10) || 21);
  const range = /^(2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  const trainFrac = Math.min(0.8, Math.max(0.4, parseFloat(req.query.trainfrac) || 0.6));
  const minTrainN = Math.max(3, parseInt(req.query.mintrain, 10) || 8);
  const priorK = Math.max(1, parseInt(req.query.priork, 10) || 20);   // shrinkage strength (pseudo-obs)
  const selThresh = Math.min(0.7, Math.max(0.5, parseFloat(req.query.sel) || 0.52));
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);

  const { analyzeInvertedV } = require('../lib/vreversal');
  const { buildMacroLookup } = require('../lib/macro');
  const [spyD, macro] = await Promise.all([fetchDailyHistory('SPY', range), buildMacroLookup(range).catch(() => null)]);
  const spyClose = {}; const spyDates = [];
  if (spyD) spyD.candles.forEach(c => { spyClose[c.date] = c.close; spyDates.push(c.date); });
  spyDates.sort();
  const datePos = {}; spyDates.forEach((d, i) => { datePos[d] = i; });
  const regimeAt = date => (macro ? (macro.at(date) || {}).regime || 'unknown' : 'unknown');

  // Trailing point-in-time beta of a stock vs SPY over the W bars ending at k
  // (returns aligned by date; no lookahead). Used to BETA-NEUTRALIZE the excess so
  // we separate genuine reversion alpha from a short-low-beta factor tilt.
  const betaAt = (c, k, W = 252) => {
    const lo = Math.max(1, k - W + 1); const sr = [], mr = [];
    for (let j = lo; j <= k; j++) {
      const sp = spyClose[c[j].date], sp1 = spyClose[c[j - 1].date]; if (sp == null || sp1 == null) continue;
      sr.push(c[j].close / c[j - 1].close - 1); mr.push(sp / sp1 - 1);
    }
    const n = sr.length; if (n < 30) return 1;
    const mm = mr.reduce((a, x) => a + x, 0) / n, ms = sr.reduce((a, x) => a + x, 0) / n;
    let cov = 0, varm = 0; for (let j = 0; j < n; j++) { cov += (sr[j] - ms) * (mr[j] - mm); varm += (mr[j] - mm) ** 2; }
    return varm > 0 ? cov / varm : 1;
  };

  const t0 = Date.now(), deadline = 50000;
  const sigs = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < 120) continue;
      const c = d.candles; let lastSig = -99;
      for (let k = 80; k < c.length - H; k++) {
        if (k - lastSig < 10) continue;
        const v = analyzeInvertedV(c.slice(0, k + 1)); if (!v) continue;
        lastSig = k;
        const date = c[k].date;
        if (spyClose[date] == null || spyClose[c[k + H].date] == null) continue;
        const fwd = ((c[k + H].close - c[k].close) / c[k].close) * 100;
        const sret = ((spyClose[c[k + H].date] - spyClose[date]) / spyClose[date]) * 100;
        const exc = fwd - sret;                       // raw vs SPY (1:1 — NOT beta-neutral)
        const beta = betaAt(c, k);
        const excB = fwd - beta * sret;               // beta-neutral residual alpha
        const g = v.geometry;
        sigs.push({
          t, date, regime: regimeAt(date), beta: +beta.toFixed(2),
          exc, beat: exc < 0 ? 1 : 0, shortAlpha: -exc,
          excB, beatB: excB < 0 ? 1 : 0, shortAlphaB: -excB,
          rsiPivot: g.rsiAtPivot, rise: g.risePct, vSharp: g.vSharpness, dropOff: g.dropOffHighPct, score: v.score,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sd = a => { if (a.length < 2) return 1; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; };
  // beatKey/alphaKey let us score the SAME signals raw ('beat'/'shortAlpha') or
  // beta-neutral ('beatB'/'shortAlphaB').
  const beatStats = (arr, beatKey = 'beat', alphaKey = 'shortAlpha') => {
    const n = arr.length; if (!n) return { n: 0 };
    const b = arr.reduce((s, x) => s + x[beatKey], 0); const ci = wilson(b, n);
    return { n, beatRate: +((b / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0), alpha: +mean(arr.map(x => x[alphaKey])).toFixed(2) };
  };
  const bothStats = arr => ({ raw: beatStats(arr, 'beat', 'shortAlpha'), betaNeutral: beatStats(arr, 'beatB', 'shortAlphaB'), avgBeta: +mean(arr.map(x => x.beta)).toFixed(2) });
  const byRegimeStats = (arr, bk = 'beat', ak = 'shortAlpha') => ({
    'risk-on': beatStats(arr.filter(x => x.regime === 'risk-on'), bk, ak),
    neutral: beatStats(arr.filter(x => x.regime === 'neutral'), bk, ak),
    'risk-off': beatStats(arr.filter(x => x.regime === 'risk-off'), bk, ak),
  });

  // GATE: the proven lever — only fade tops in risk-on/neutral.
  const gated = sigs.filter(s => s.regime === 'risk-on' || s.regime === 'neutral');

  // (A) SIGNAL-FEATURE SELECTION — does a more extreme top fade harder?
  // Composite "stretch" z-score: hotter RSI at the peak, steeper run-up, sharper
  // rollover, deeper drop already = a more exhausted blow-off.
  const feat = ['rsiPivot', 'rise', 'vSharp', 'dropOff'];
  const stats = {}; feat.forEach(f => { const a = gated.map(s => s[f]); stats[f] = { m: mean(a), s: sd(a) }; });
  gated.forEach(s => { s.stretch = feat.reduce((z, f) => z + (s[f] - stats[f].m) / stats[f].s, 0); });
  const tercile = (arr, key) => {
    const sorted = [...arr].sort((a, b) => a[key] - b[key]); const n = sorted.length;
    return {
      low: beatStats(sorted.slice(0, Math.floor(n / 3))),
      mid: beatStats(sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3))),
      high: beatStats(sorted.slice(Math.floor(2 * n / 3))),
    };
  };

  // (B) PER-STOCK OOS SELECTION with purge + shrinkage.
  const splitPos = Math.floor(trainFrac * spyDates.length);
  const splitDate = spyDates[splitPos] || spyDates[spyDates.length - 1];
  const purgeDate = spyDates[Math.max(0, splitPos - H)] || splitDate;       // train must end H bars before test
  const train = gated.filter(s => s.date < purgeDate);
  const test = gated.filter(s => s.date >= splitDate);
  const p0 = train.length ? mean(train.map(s => s.beat)) : 0.5;             // global prior beat-prob
  const a0 = p0 * priorK, b0 = (1 - p0) * priorK;
  const perStock = {};
  train.forEach(s => { (perStock[s.t] = perStock[s.t] || { n: 0, b: 0 }).n++; perStock[s.t].b += s.beat; });
  const selected = new Set();
  const stockTable = [];
  Object.entries(perStock).forEach(([t, v]) => {
    const post = (v.b + a0) / (v.n + a0 + b0);
    const keep = v.n >= minTrainN && post > selThresh;
    if (keep) selected.add(t);
    stockTable.push({ t, trainN: v.n, trainBeat: +((v.b / v.n) * 100).toFixed(0), postMean: +(post * 100).toFixed(0), selected: keep });
  });
  const testSelected = test.filter(s => selected.has(s.t));
  stockTable.sort((a, b) => b.postMean - a.postMean);

  // COST/BORROW: the fade is a SHORT held ~H sessions, market-neutral (2 legs).
  // Net per-trade cost ≈ borrow_annual·(H/252)  [stock short leg only]  +  round-trip
  // transaction cost across BOTH legs (stock + SPY hedge). Subtract from gross short
  // alpha and see if the edge survives. Large-caps are mostly general-collateral
  // (cheap borrow); the stress row models a harder-to-borrow / wider-spread world.
  const H_FRAC = H / 252;
  const costScenarios = [
    { name: 'retail-favorable', borrowAnnPct: 0.5, txnRoundTripPct: 0.08 },
    { name: 'realistic', borrowAnnPct: 2.0, txnRoundTripPct: 0.15 },
    { name: 'stress', borrowAnnPct: 6.0, txnRoundTripPct: 0.30 },
  ];
  const costOf = sc => +(sc.borrowAnnPct * H_FRAC + sc.txnRoundTripPct).toFixed(3);
  const netStats = (arr, cost) => {
    const n = arr.length; if (!n) return { n: 0 };
    const wins = arr.filter(s => (s.shortAlpha - cost) > 0).length; const ci = wilson(wins, n);
    return { n, netBeatRate: +((wins / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0), netAlpha: +mean(arr.map(s => s.shortAlpha - cost)).toFixed(2) };
  };
  const costAnalysis = {
    note: `Net of borrow (×${H}/252) + both-leg round-trip txn. grossAvgAlpha is the cushion. "gatedAll" = broad signal set; "selectedOOS" = the deployable high-conviction basket (per-stock selected, out-of-sample). Edge is actionable if selectedOOS netAlpha stays clearly positive.`,
    horizonDays: H, grossAvgAlpha: { gatedAll: +mean(gated.map(s => s.shortAlpha)).toFixed(2), selectedOOS: +mean(testSelected.map(s => s.shortAlpha)).toFixed(2) },
    scenarios: costScenarios.map(sc => ({ ...sc, totalCostPctPerTrade: costOf(sc), gatedAll: netStats(gated, costOf(sc)), selectedOOS: netStats(testSelected, costOf(sc)) })),
  };

  // Beta-neutral version of the per-stock selection: select on beta-neutral train
  // edge, test on beta-neutral outcome. Does picking stocks survive once beta is
  // removed (i.e. is it real selection, not a low-beta tilt)?
  const p0B = train.length ? mean(train.map(s => s.beatB)) : 0.5;
  const a0B = p0B * priorK, b0B = (1 - p0B) * priorK;
  const perStockB = {};
  train.forEach(s => { (perStockB[s.t] = perStockB[s.t] || { n: 0, b: 0 }).n++; perStockB[s.t].b += s.beatB; });
  const selectedB = new Set();
  Object.entries(perStockB).forEach(([t, v]) => { const post = (v.b + a0B) / (v.n + a0B + b0B); if (v.n >= minTrainN && post > selThresh) selectedB.add(t); });
  const testSelectedB = test.filter(s => selectedB.has(s.t));

  // STRETCH GATE validation: drop the top stretch tercile (the over-extended dead
  // zone) and check the remainder beats the full gated set — in-sample and OOS.
  // This is exactly what the live engine's high-stretch penalty does.
  const stretchSorted = [...gated].map(s => s.stretch).sort((a, b) => a - b);
  const hiBoundaryZ = stretchSorted.length ? stretchSorted[Math.floor((2 * stretchSorted.length) / 3)] : Infinity;
  const gatedExHigh = gated.filter(s => s.stretch < hiBoundaryZ);
  const testExHigh = test.filter(s => s.stretch < hiBoundaryZ);

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, horizonDays: H, namesScanned: tickers.length,
    totalSignals: sigs.length, gatedSignals: gated.length, macroAvailable: !!macro,
    gate: 'risk-on + neutral only (risk-off dropped)',
    BETA_VERDICT: {
      note: 'THE go/no-go. raw = excess vs SPY 1:1 (NOT beta-neutral); betaNeutral = stock_fwd − beta·SPY_fwd (residual alpha). If the edge is real selection it survives beta-neutralization; if betaNeutral beatRate/alpha collapse toward 50%/0, the "edge" was a short-low-beta factor tilt. avgBeta shows how low-beta the faded names are.',
      gated: bothStats(gated),
      gatedByRegimeRaw: byRegimeStats(gated, 'beat', 'shortAlpha'),
      gatedByRegimeBetaNeutral: byRegimeStats(gated, 'beatB', 'shortAlphaB'),
      fullUniverseByRegimeBetaNeutral: byRegimeStats(sigs, 'beatB', 'shortAlphaB'),
    },
    COST_ANALYSIS: costAnalysis,
    baselineGated: beatStats(gated),
    A_signalStretch: {
      note: 'Terciles of a composite top-exhaustion z-score (RSI@peak + run-up steepness + rollover sharpness + drop-so-far). FINDING: low/mid-stretch fade BETTER than high — the most blown-off tops are already exhausted. OOS split confirms whether that holds out-of-sample (purged train/test) before it is used as a live conviction lever.',
      byStretchTercile: tercile(gated, 'stretch'),
      byStretchTercileTrain: tercile(train, 'stretch'),
      byStretchTercileOOS: tercile(test, 'stretch'),
      byDetectorScoreTercile: tercile(gated, 'score'),
    },
    C_stretchGate: {
      note: 'The LIVE lever: drop the top stretch tercile (over-extended tops, ~zero edge) and compare to the full gated set. If gatedExHigh/oosExHigh beat gatedAll/oosAll on beatRate + alpha, the high-stretch penalty improves picks.',
      hiBoundaryZ: +hiBoundaryZ.toFixed(3),
      gatedAll: beatStats(gated), gatedExHigh: beatStats(gatedExHigh),
      oosAll: beatStats(test), oosExHigh: beatStats(testExHigh),
    },
    B_stockSelection: {
      note: 'PURGED train/test. Per-stock train hit-rate shrunk to the global prior (priorK pseudo-obs); select stocks with shrunk posterior > sel and trainN >= mintrain. Honest test: does TEST(selected) beat TEST(all)? If overfit, it will not.',
      trainFrac, minTrainN, priorK, selThresh, splitDate, purgeDate,
      globalTrainBeat: +(p0 * 100).toFixed(0),
      stocksTotal: Object.keys(perStock).length, stocksSelected: selected.size,
      testAll: beatStats(test), testAllByRegime: byRegimeStats(test),
      testSelected: beatStats(testSelected), testSelectedByRegime: byRegimeStats(testSelected),
      topStocks: stockTable.slice(0, 25),
      betaNeutral: {
        note: 'Same purged selection but on the BETA-NEUTRAL outcome. If testSelected here still beats testAll, selection is real alpha; if it flattens to ~50%, the picks were a beta artifact.',
        globalTrainBeatBN: +(p0B * 100).toFixed(0), stocksSelectedBN: selectedB.size,
        testAll: beatStats(test, 'beatB', 'shortAlphaB'),
        testSelected: beatStats(testSelectedB, 'beatB', 'shortAlphaB'),
        testSelectedByRegime: byRegimeStats(testSelectedB, 'beatB', 'shortAlphaB'),
      },
    },
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

// ── Fade engine ops : seed from history, live recommendations, learning tick ──
// The self-improving layer. fadeseed initializes per-stock posteriors from 5y of
// resolved inverted-V shorts; fadesignals turns today's live setups + the learned
// posteriors into ranked SHORT/cover recommendations; fadetick (cron) resolves
// matured logged signals → updates the engine → logs today's setups (continuous
// adaptation). All gated to risk-on/neutral (the proven lever).
const FADE_H = 21;   // resolution horizon (trading sessions) — matches the validation

// Scan a universe for CURRENT inverted-V short setups on the latest bar, tagging
// each with its trailing beta (for the engine's beta-bucket grouping).
async function scanFadeSetups(tickers, deadlineMs, t0, spyClose = {}) {
  const { analyzeInvertedV } = require('../lib/vreversal');
  const { betaVsSpy } = require('../lib/fade-engine');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadlineMs) return;
      let d; try { d = await fetchDailyHistory(t); } catch { continue; }
      if (!d || d.candles.length < 120) continue;
      const v = analyzeInvertedV(d.candles);
      if (v) out.push({ ticker: t, date: d.candles[d.candles.length - 1].date, signal: v, beta: betaVsSpy(d.candles, spyClose) });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out;
}

async function runFadeSeed(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 200);
  const range = /^(2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);
  const fe = require('../lib/fade-engine');
  const { analyzeInvertedV } = require('../lib/vreversal');
  const { buildMacroLookup } = require('../lib/macro');

  const [spyD, macro] = await Promise.all([fetchDailyHistory('SPY', range), buildMacroLookup(range).catch(() => null)]);
  const spyClose = {}; if (spyD) spyD.candles.forEach(c => { spyClose[c.date] = c.close; });
  const regimeAt = date => (macro ? (macro.at(date) || {}).regime || 'unknown' : 'unknown');

  // Trailing point-in-time beta at bar k (no lookahead) for the engine's group bucket.
  const betaAt = (c, k, W = 252) => {
    const lo = Math.max(1, k - W + 1); const sr = [], mr = [];
    for (let j = lo; j <= k; j++) { const sp = spyClose[c[j].date], sp1 = spyClose[c[j - 1].date]; if (sp == null || sp1 == null) continue; sr.push(c[j].close / c[j - 1].close - 1); mr.push(sp / sp1 - 1); }
    const n = sr.length; if (n < 30) return 1;
    const mm = mr.reduce((a, x) => a + x, 0) / n, ms = sr.reduce((a, x) => a + x, 0) / n;
    let cov = 0, vm = 0; for (let j = 0; j < n; j++) { cov += (sr[j] - ms) * (mr[j] - mm); vm += (mr[j] - mm) ** 2; }
    return vm > 0 ? +(cov / vm).toFixed(2) : 1;
  };

  const t0 = Date.now(), deadline = 50000;
  const sigs = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < 120) continue;
      const c = d.candles; let lastSig = -99;
      for (let k = 80; k < c.length - FADE_H; k++) {
        if (k - lastSig < 10) continue;
        const v = analyzeInvertedV(c.slice(0, k + 1)); if (!v) continue;
        lastSig = k;
        const date = c[k].date, regime = regimeAt(date);
        if (regime !== 'risk-on' && regime !== 'neutral') continue;        // gate
        if (spyClose[date] == null || spyClose[c[k + FADE_H].date] == null) continue;
        const fwd = (c[k + FADE_H].close - c[k].close) / c[k].close;
        const sret = (spyClose[c[k + FADE_H].date] - spyClose[date]) / spyClose[date];
        const shortAlpha = -((fwd - sret) * 100);                           // market-neutral short alpha %
        sigs.push({ ticker: t, date, alpha: shortAlpha, sector: SECTOR_OF[t] || '?', beta: betaAt(c, k), geom: v.geometry });
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  // Feed chronologically, grouped by month (a meaningful time-step for the decay/CUSUM
  // without over-forgetting across 5y).
  sigs.sort((a, b) => (a.date < b.date ? -1 : 1));
  const byMonth = {};
  sigs.forEach(s => { (byMonth[s.date.slice(0, 7)] = byMonth[s.date.slice(0, 7)] || []).push(s); });
  const state = fe.emptyState();
  Object.keys(byMonth).sort().forEach(m => fe.update(state, byMonth[m]));

  // Stretch normalization stats for the live high-stretch conviction penalty:
  // feature mean/sd over all seeded setups + the top-tercile z boundary (hiZ).
  // Live recommend() flags setups with stretchZ >= hiZ as over-extended (the
  // dead zone fadeopt validated OOS) and demotes their conviction.
  const G = sigs.map(s => s.geom).filter(Boolean);
  if (G.length >= 50) {
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; };
    const FEAT = [['rsiAtPivot', 'rsiPivot'], ['risePct', 'rise'], ['vSharpness', 'vSharp'], ['dropOffHighPct', 'dropOff']];
    const stats = {};
    FEAT.forEach(([gk, fk]) => { const a = G.map(g => g[gk]).filter(v => v != null); stats[fk] = { m: +mean(a).toFixed(4), s: +sd(a).toFixed(4) }; });
    state.stretch = { stats, hiZ: 0 };
    const zs = G.map(g => fe.stretchZ(g, state.stretch)).filter(z => z != null).sort((a, b) => a - b);
    state.stretch.hiZ = +zs[Math.floor((2 * zs.length) / 3)].toFixed(3);   // top-tercile boundary
  }

  if (hasStore()) await writeFade(fe.serialize(state));

  const table = Object.keys(state.stocks).map(t => fe.posterior(state, t)).sort((a, b) => b.expAlpha - a.expAlpha);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, namesScanned: tickers.length, gatedSignals: sigs.length,
    months: Object.keys(byMonth).length, ...fe.summary(state), saved: hasStore(),
    topShortable: table.filter(x => x.expAlpha > 0.3).slice(0, 25),
    weakest: table.slice(-10).reverse(),
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

async function runFadeSignals(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO
    : scope === 'all' ? [...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO] : UNI_LARGE;
  const tickers = [...new Set(lists)];
  const fe = require('../lib/fade-engine');
  const { fetchMacro } = require('../lib/macro');

  const [stateJson, macro, spyD] = await Promise.all([readFade(), fetchMacro().catch(() => null), fetchDailyHistory('SPY')]);
  if (!stateJson) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, seeded: false, message: 'Engine not seeded yet — run op=fadeseed first.', recommendations: [] });
  }
  const state = fe.load(stateJson);
  const regime = macro ? macro.regime : 'unknown';
  const spyClose = {}; if (spyD) spyD.candles.forEach(c => { spyClose[c.date] = c.close; });

  const t0 = Date.now();
  const setups = await scanFadeSetups(tickers, 50000, t0, spyClose);
  const recs = setups.map(s => {
    const sector = SECTOR_OF[s.ticker] || '?';
    const r = fe.recommend(state, { ticker: s.ticker, regime, signal: s.signal.signals, geometry: s.signal.geometry, sector, beta: s.beta });
    const sig = s.signal.signals;
    // The VALIDATED trade is a ~21-session market-neutral hold (short stock vs SPY);
    // stop/target are pattern REFERENCE only (the exits study found stop mgmt leaks).
    const geomOk = sig.target != null && sig.entry != null && sig.target < sig.entry && sig.stop > sig.entry;
    return { ...r, sector, beta: s.beta, tier: s.signal.tier, score: s.signal.score, geometry: s.signal.geometry, refLevels: sig, geomFavorable: geomOk };
  });
  const rank = { SHORT: 3, SHORT_LIGHT: 2, WATCH: 1, SKIP: 0 };
  recs.sort((a, b) => (rank[b.action] - rank[a.action]) || (b.expAlpha - a.expAlpha));
  const actionable = recs.filter(r => (r.action === 'SHORT' || r.action === 'SHORT_LIGHT') && r.geomFavorable);

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({
    ok: true, seeded: true, regime, holdSessions: FADE_H, ...fe.summary(state),
    updatedAt: state.updatedAt, setupsFound: setups.length, actionable: actionable.length,
    gateNote: regime === 'risk-off' ? 'Risk-off regime — ALL fades gated out (no edge here).' : 'Fades active (risk-on/neutral).',
    tradePlan: `Validated trade: SHORT the name, hold ~${FADE_H} sessions, market-neutral vs SPY; exit at horizon. expAlpha = expected per-trade short alpha %; netExpAlpha = after ~0.32% assumed cost. refLevels (stop/target) are pattern reference only. Size = conviction-scaled weight (capped 5%, halved in risk-on).`,
    recommendations: recs.slice(0, 40),
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

async function runFadeTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const fe = require('../lib/fade-engine');
  const { fetchMacro } = require('../lib/macro');
  const t0 = Date.now();

  // One-off maintenance: ?prune=YYYY-MM-DD wipes a stale/duplicate day file.
  if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
    await writeFadeDay(req.query.prune, []);
    return res.json({ ok: true, pruned: req.query.prune });
  }

  // 1) Resolve matured, still-open logged signals → learn ONCE, then PERSIST the
  //    resolution back to the ledger (resolve-once: never re-feed an outcome).
  //    Dedup by ticker|setupDate so a key never feeds the engine twice even if it
  //    appears in two files (defensive against any day-key collision).
  const days = await readAllFadeDays();
  const resolvedKeys = new Set();
  days.forEach(d => d.signals.forEach(s => { if (s.resolved) resolvedKeys.add(`${s.ticker}|${s.date}`); }));
  const openByTicker = {};
  days.forEach(d => d.signals.forEach(s => { if (!s.resolved) (openByTicker[s.ticker] = openByTicker[s.ticker] || []).push(s); }));
  const tickersToResolve = [...new Set(Object.keys(openByTicker).concat('SPY'))];
  const hist = new Map(); let i = 0;
  const rw = async () => { while (i < tickersToResolve.length) { const t = tickersToResolve[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 12 }, rw));
  const spy = hist.get('SPY') || [];
  const afterN = (candles, entryDate, n) => {        // bar n sessions after entryDate
    const idx = candles.findIndex(c => c.date >= entryDate);
    if (idx < 0 || idx + n >= candles.length) return null;
    return { close: candles[idx + n].close, entryClose: candles[idx].close, date: candles[idx + n].date };
  };
  const outcomes = []; let resolvedNow = 0;
  const changedDays = new Set();
  for (const d of days) {
    for (const s of d.signals) {
      if (s.resolved) continue;
      const key = `${s.ticker}|${s.date}`;
      const candles = hist.get(s.ticker); if (!candles) continue;
      const r = afterN(candles, s.date, FADE_H); if (!r) continue;        // not matured yet
      const sp = afterN(spy, s.date, FADE_H); if (!sp) continue;
      const dup = resolvedKeys.has(key);                                   // already resolved elsewhere → mark only, don't re-feed
      const fwd = (r.close - r.entryClose) / r.entryClose;
      const sret = (sp.close - sp.entryClose) / sp.entryClose;
      const exc = (fwd - sret) * 100;                                     // short alpha = -exc
      s.resolved = true; s.exitDate = r.date;
      s.fwdPct = +(fwd * 100).toFixed(2); s.spyPct = +(sret * 100).toFixed(2);
      s.excPct = +exc.toFixed(2); s.shortAlpha = +(-exc).toFixed(2); s.beat = exc < 0 ? 1 : 0;
      changedDays.add(d.date);
      if (!dup) { outcomes.push({ ticker: s.ticker, alpha: s.shortAlpha, sector: s.sector || SECTOR_OF[s.ticker] || '?', beta: s.beta }); resolvedKeys.add(key); resolvedNow++; }
    }
  }
  const state = fe.load(await readFade());
  if (outcomes.length) fe.update(state, outcomes);
  // Persist resolved day files.
  await Promise.all([...changedDays].map(date => {
    const day = days.find(x => x.date === date);
    return writeFadeDay(date, day.signals);
  }));

  // 2) Log today's setups (gated) for future resolution — with the engine's
  //    recommendation stamped on each so the track record can be sliced by action.
  const macro = await fetchMacro().catch(() => null);
  const regime = macro ? macro.regime : 'unknown';
  let logged = 0, logDate = null;
  if (regime === 'risk-on' || regime === 'neutral') {
    const spyClose = {}; spy.forEach(c => { spyClose[c.date] = c.close; });
    const setups = await scanFadeSetups([...new Set(UNI_LARGE)], 35000, t0, spyClose);
    if (setups.length) {
      logDate = setups[0].date;                                          // last trading date (consistent file key)
      const rows = setups.map(s => {
        const sector = SECTOR_OF[s.ticker] || '?';
        const rec = fe.recommend(state, { ticker: s.ticker, regime, signal: s.signal.signals, geometry: s.signal.geometry, sector, beta: s.beta });
        return { ticker: s.ticker, date: s.date, entry: s.signal.signals.entry, regime, tier: s.signal.tier,
          sector, beta: s.beta, action: rec.action, conviction: rec.conviction, expAlpha: rec.expAlpha, resolved: false };
      });
      await writeFadeDay(logDate, rows); logged = rows.length;
    }
  }

  await writeFade(fe.serialize(state));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, openBefore: Object.values(openByTicker).reduce((a, b) => a + b.length, 0), resolvedNow,
    beatRateResolved: outcomes.length ? +((outcomes.filter(o => (o.alpha || 0) > 0).length / outcomes.length) * 100).toFixed(0) : null,
    regime, loggedToday: logged, logDate, ...fe.summary(state),
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

// ── op=fadebook : the live TRACK RECORD of the engine's actual recommendations ──
// Reads the resolved fade ledger and reports how the picks REALLY did forward:
// overall beat-SPY rate (+Wilson LB) + market-neutral alpha, broken down by the
// recommendation the engine made at log time (SHORT vs SHORT_LIGHT vs WATCH) and
// by regime. This is the honest, hands-off scorecard — distinct from the backtest.
async function runFadeBook(req, res) {
  const days = await readAllFadeDays();
  // Dedup by ticker|setupDate (defensive against day-key collisions), prefer resolved.
  const uniq = new Map();
  days.forEach(d => d.signals.forEach(s => {
    const k = `${s.ticker}|${s.date}`; const prev = uniq.get(k);
    if (!prev || (s.resolved && !prev.resolved)) uniq.set(k, s);
  }));
  const all = [...uniq.values()];
  const resolved = all.filter(s => s.resolved && s.excPct != null);
  const open = all.filter(s => !s.resolved);

  const wil = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(s => s.beat).length; const ci = wilson(beats, n);
    const alpha = arr.reduce((a, s) => a + (s.shortAlpha || 0), 0) / n;
    return { n, beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0), avgAlpha: +alpha.toFixed(2) };
  };
  const byAction = {};
  ['SHORT', 'SHORT_LIGHT', 'WATCH', 'SKIP'].forEach(a => { byAction[a] = wil(resolved.filter(s => s.action === a)); });
  const byRegime = {};
  ['risk-on', 'neutral'].forEach(r => { byRegime[r] = wil(resolved.filter(s => s.regime === r)); });
  // Equity-style cumulative market-neutral alpha (sum of per-pick short alpha), chronological.
  const chrono = [...resolved].sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
  let cum = 0; const curve = chrono.map(s => { cum += s.shortAlpha || 0; return { date: s.exitDate, cumAlpha: +cum.toFixed(1) }; });
  // Best/worst individual picks (by short alpha).
  const ranked = [...resolved].sort((a, b) => (b.shortAlpha || 0) - (a.shortAlpha || 0));
  const slim = s => ({ ticker: s.ticker, logDate: s.date, exitDate: s.exitDate, action: s.action, shortAlpha: s.shortAlpha, beat: s.beat });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, totalLogged: all.length, resolved: resolved.length, stillOpen: open.length,
    overall: wil(resolved),
    actionableOnly: wil(resolved.filter(s => s.action === 'SHORT' || s.action === 'SHORT_LIGHT')),
    byAction, byRegime,
    cumAlphaPts: curve.length ? curve[curve.length - 1].cumAlpha : 0,
    equityCurveTail: curve.slice(-30),
    best: ranked.slice(0, 8).map(slim), worst: ranked.slice(-8).reverse().map(slim),
    note: 'LIVE forward track record of logged inverted-V short setups (resolved at the 21-session horizon). beat = stock underperformed SPY (the short won market-neutral). byAction shows whether the engine\'s SHORT-rated picks beat its WATCH/SKIP picks = does the conviction actually rank. This is hands-off & accrues daily via the warm cron; it is NOT the backtest. Empty/thin until ~21 sessions after the first fadetick.',
    generatedAt: new Date().toISOString(),
  });
}

// ── op=trendopt : go/no-go for the Trend-Rider strategy + traffic light ─────
// Strategy: long names in a confirmed uptrend (close > rising 200DMA & > 50DMA)
// with positive 12-1 momentum, kept only if in the top tercile of momentum that
// day (relative-momentum filter). Forward H-session return + excess vs SPY.
// Traffic light (per date, point-in-time): SPY trend + Kaufman efficiency + sector
// breadth + macro risk regime → green/yellow/red. THE test: do forward returns in
// green >> red (does the light discriminate), and does the strategy beat SPY OOS?
async function runTrendOpt(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 120);
  const H = Math.max(10, parseInt(req.query.h, 10) || 63);
  const range = /^(2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  // Sensitivity knobs (defaults = the live config). Used to check the green≫red
  // discrimination isn't a single-parameter artifact.
  const topFrac = Math.min(1, Math.max(0.1, parseFloat(req.query.topfrac) || 0.34));
  const gThresh = parseInt(req.query.green, 10) || 65;        // green climate cutoff
  const yThresh = parseInt(req.query.yellow, 10) || 45;       // yellow cutoff
  const momLb = parseInt(req.query.momlb, 10) || 252;         // momentum lookback (252=12mo, 126=6mo)
  const momSkip = parseInt(req.query.momskip, 10) || 21;      // skip recent (1mo) to dodge reversal
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);
  const { buildMacroLookup } = require('../lib/macro');
  const SEC = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU', 'XLC'];

  const [spyD, macro, ...secD] = await Promise.all([
    fetchDailyHistory('SPY', range), buildMacroLookup(range).catch(() => null),
    ...SEC.map(s => fetchDailyHistory(s, range).catch(() => null)),
  ]);
  if (!spyD || spyD.candles.length < 300) return res.status(502).json({ ok: false, error: 'No benchmark data' });
  const spy = spyD.candles, spyCl = spy.map(c => c.close), spyClose = {}; spy.forEach(c => { spyClose[c.date] = c.close; });
  const sma = (arr, p, i) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += arr[k]; return s / p; };
  const effRatio = (cl, i, n) => { if (i < n) return 0; let den = 0; for (let j = i - n + 1; j <= i; j++) den += Math.abs(cl[j] - cl[j - 1]); return den > 0 ? Math.abs(cl[i] - cl[i - n]) / den : 0; };
  const betaAt = (c, k, W = 252) => {
    const lo = Math.max(1, k - W + 1); const sr = [], mr = [];
    for (let j = lo; j <= k; j++) { const sp = spyClose[c[j].date], sp1 = spyClose[c[j - 1].date]; if (sp == null || sp1 == null) continue; sr.push(c[j].close / c[j - 1].close - 1); mr.push(sp / sp1 - 1); }
    const n = sr.length; if (n < 30) return 1;
    const mm = mr.reduce((a, x) => a + x, 0) / n, ms = sr.reduce((a, x) => a + x, 0) / n;
    let cov = 0, vm = 0; for (let j = 0; j < n; j++) { cov += (sr[j] - ms) * (mr[j] - mm); vm += (mr[j] - mm) ** 2; }
    return vm > 0 ? cov / vm : 1;
  };

  // Sector 200DMA per date for breadth.
  const secMaps = secD.filter(Boolean).map(d => { const cl = d.candles.map(c => c.close), m = {}; d.candles.forEach((c, i) => { m[c.date] = { c: c.close, s200: sma(cl, 200, i) }; }); return m; });

  // Climate timeline (point-in-time) per SPY date.
  const climate = {};
  spy.forEach((c, i) => {
    const s200 = sma(spyCl, 200, i), s200p = sma(spyCl, 200, i - 21);
    if (s200 == null || s200p == null) { climate[c.date] = { score: 50, color: 'yellow' }; return; }
    const trendComp = spyCl[i] > s200 ? (s200 > s200p ? 1 : 0.5) : 0;
    const eff = Math.min(effRatio(spyCl, i, 63) * 1.5, 1);
    let above = 0, tot = 0; secMaps.forEach(m => { const r = m[c.date]; if (r && r.s200 != null) { tot++; if (r.c > r.s200) above++; } });
    const breadth = tot ? above / tot : 0.5;
    const regime = macro ? (macro.at(c.date) || {}).regime || 'neutral' : 'neutral';
    const risk = regime === 'risk-on' ? 1 : regime === 'neutral' ? 0.5 : 0;
    const score = Math.round(100 * (0.30 * trendComp + 0.25 * eff + 0.25 * breadth + 0.20 * risk));
    climate[c.date] = { score, color: score >= gThresh ? 'green' : score >= yThresh ? 'yellow' : 'red' };
  });

  // Per-ticker candidate records.
  const t0 = Date.now(), deadline = 50000; const recs = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < 300) continue;
      const c = d.candles, cl = c.map(x => x.close);
      for (let k = Math.max(252, momLb); k < c.length - H; k++) {
        const s200 = sma(cl, 200, k), s200p = sma(cl, 200, k - 21), s50 = sma(cl, 50, k);
        if (s200 == null || s200p == null || s50 == null) continue;
        if (!(cl[k] > s200 && s200 > s200p && cl[k] > s50)) continue;     // confirmed uptrend
        const mom = cl[k - momSkip] / cl[k - momLb] - 1; if (mom <= 0) continue;  // positive momentum
        const date = c[k].date; if (spyClose[date] == null || spyClose[c[k + H].date] == null) continue;
        const fwd = (c[k + H].close / cl[k] - 1) * 100, sfwd = (spyClose[c[k + H].date] / spyClose[date] - 1) * 100;
        const beta = betaAt(c, k);
        recs.push({ date, ticker: t, mom, fwd, exc: fwd - sfwd, excB: fwd - beta * sfwd, color: (climate[date] || {}).color || 'yellow' });
      }
    }
  };
  await Promise.all(Array.from({ length: 14 }, worker));

  // Relative-momentum filter: per date keep top tercile by 12-1 momentum.
  const byDate = {}; recs.forEach(r => (byDate[r.date] = byDate[r.date] || []).push(r));
  const picks = [];
  Object.values(byDate).forEach(arr => { arr.sort((a, b) => b.mom - a.mom); const n = Math.max(1, Math.floor(arr.length * topFrac)); for (let j = 0; j < n; j++) picks.push(arr[j]); });

  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const exc = arr.map(x => x.exc), beats = exc.filter(x => x > 0).length, ci = wilson(beats, n);
    return { n, avgRet: +mean(arr.map(x => x.fwd)).toFixed(2), avgExc: +mean(exc).toFixed(2), avgExcBetaAdj: +mean(arr.map(x => x.excB)).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  const dates = [...new Set(picks.map(p => p.date))].sort();
  const splitDate = dates[Math.floor(0.6 * dates.length)] || dates[dates.length - 1];
  const oosPick = picks.filter(p => p.date >= splitDate);
  const dayMix = { green: 0, yellow: 0, red: 0 }; Object.values(climate).forEach(c => { if (dayMix[c.color] != null) dayMix[c.color]++; });

  // Episode-clustering check: are a climate's picks spread across many independent
  // selloffs, or concentrated in one V-recovery (low EFFECTIVE N → a Wilson LB on
  // pick count is a mirage)? Group entry dates into episodes (gap > gapDays = new
  // episode). A real timing edge beats SPY across MULTIPLE separate episodes.
  function episodeBreakdown(arr, gapDays = 21) {
    const byDate = {}; arr.forEach(p => (byDate[p.date] = byDate[p.date] || []).push(p));
    const ds = Object.keys(byDate).sort(); const eps = []; let cur = null;
    for (const dt of ds) {
      const ms = Date.parse(dt);
      if (cur && (ms - cur.lastMs) / 86400000 <= gapDays) { cur.dates.push(dt); cur.lastMs = ms; }
      else { cur = { start: dt, lastMs: ms, dates: [dt] }; eps.push(cur); }
    }
    return eps.map(e => {
      const ps = e.dates.flatMap(dt => byDate[dt]); const beats = ps.filter(p => p.exc > 0).length;
      return { start: e.start, end: e.dates[e.dates.length - 1], tradingDates: e.dates.length, picks: ps.length,
        beatRate: +((beats / ps.length) * 100).toFixed(0), avgExc: +mean(ps.map(p => p.exc)).toFixed(2), avgExcBetaAdj: +mean(ps.map(p => p.excB)).toFixed(2) };
    });
  }
  const climColor = /^(green|yellow|red)$/.test(req.query.climate || '') ? req.query.climate : 'red';
  const climPicks = picks.filter(p => p.color === climColor);
  const climEpisodes = episodeBreakdown(climPicks);
  const posEps = climEpisodes.filter(e => e.avgExc > 0).length;

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, horizonDays: H, namesScanned: tickers.length, candidates: recs.length, picks: picks.length,
    climateDayMix: dayMix, currentLight: climate[spy[spy.length - 1].date] || null,
    strategyOverall: agg(picks),
    byClimate: { green: agg(picks.filter(p => p.color === 'green')), yellow: agg(picks.filter(p => p.color === 'yellow')), red: agg(picks.filter(p => p.color === 'red')) },
    oosByClimate: { splitDate, green: agg(oosPick.filter(p => p.color === 'green')), yellow: agg(oosPick.filter(p => p.color === 'yellow')), red: agg(oosPick.filter(p => p.color === 'red')) },
    clustering: {
      climate: climColor, picks: climPicks.length, distinctDates: new Set(climPicks.map(p => p.date)).size,
      episodeCount: climEpisodes.length, positiveEpisodes: posEps,
      note: `Effective N for the ${climColor} climate = independent episodes, NOT pick count. If picks cluster into 1-2 episodes, the Wilson LB on pick count is a mirage. A real timing edge is positive across MOST episodes.`,
      episodes: climEpisodes,
    },
    note: `Trend+momentum longs, ${H}-session forward return & excess vs SPY. avgRet = raw forward return (what you actually make long); avgExc = vs SPY; avgExcBetaAdj = alpha after beta. THE test: green avgRet/beatRate should clearly exceed red. oosByClimate confirms it holds out-of-sample. clustering = is a climate's edge real (many episodes) or one V-recovery (?climate=red|green).`,
    generatedAt: new Date().toISOString(),
  });
}

// ── Trend Rider live: traffic light + basket, self-learning, tracking ───────
const TREND_H = 21;   // live tracking horizon (sessions) — faster feedback than the 63d backtest
const TREND_SEC = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU', 'XLC'];

// Diversified basket: top by momentum but capped per sector (avoid a 20-semi book).
function diversifyBasket(cands, maxPerSec = 3, n = 20) {
  const bySec = {}, out = [];
  for (const c of cands) {                       // cands already momentum-sorted desc
    const s = c.sector || '?'; bySec[s] = (bySec[s] || 0);
    if (bySec[s] >= maxPerSec) continue;
    bySec[s]++; out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

async function scanTrendUniverse(tickers, deadlineMs, t0) {
  const { trendCandidate } = require('../lib/trend');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadlineMs) return;
      let d; try { d = await fetchDailyHistory(t, '2y'); } catch { continue; }  // 2y: need 252d momentum + 200DMA
      if (!d || d.candles.length < 260) continue;
      const c = trendCandidate(d.candles);
      if (c) { c.ticker = t; c.date = d.candles[d.candles.length - 1].date; c.sector = SECTOR_OF[t] || '?'; out.push(c); }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  out.sort((a, b) => b.mom - a.mom);
  return out;
}

// Shared: compute today's climate light + ranked candidate basket.
async function computeTrendLive(t0, deadline) {
  const trend = require('../lib/trend');
  const { fetchMacro } = require('../lib/macro');
  const [spyD, macro, ...secD] = await Promise.all([
    fetchDailyHistory('SPY'), fetchMacro().catch(() => null),
    ...TREND_SEC.map(s => fetchDailyHistory(s).catch(() => null)),
  ]);
  if (!spyD) return null;
  const spyCl = spyD.candles.map(c => c.close);
  let above = 0, tot = 0;
  secD.filter(Boolean).forEach(d => { const cl = d.candles.map(c => c.close), i = cl.length - 1; const s = trend.sma(cl, 200, i); if (s != null) { tot++; if (cl[i] > s) above++; } });
  const breadth = tot ? above / tot : 0.5;
  const regime = macro ? macro.regime : 'neutral';
  const light = trend.computeClimate(spyCl, breadth, regime);
  const cands = await scanTrendUniverse([...new Set(UNI_LARGE)], deadline, t0);
  return { light, regime, breadthPct: Math.round(breadth * 100), cands };
}

async function runTrend(req, res) {
  const fe = require('../lib/fade-engine');
  const t0 = Date.now();
  const live = await computeTrendLive(t0, 45000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const state = fe.load(await readTrendEng());
  // Concentrate on the very top momentum names (sensitivity test: topfrac 0.20 beat
  // 0.34/0.50), but keep a 3-per-sector cap for diversification. Then drop names the
  // learner flagged as drifted.
  const basket = diversifyBasket(live.cands, 3, 15).map(c => {
    const p = fe.posterior(state, c.ticker, { sector: c.sector });
    return { ...c, learnedExcess: p.expAlpha, confidence: p.pPos, nPriors: p.n, drifted: p.drifted };
  }).filter(c => !c.drifted);                                     // engine drops names that stopped trending well
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, light: live.light, breadthPct: live.breadthPct, candidates: live.cands.length,
    basketSize: basket.length, basket: basket.slice(0, 15), holdHorizon: TREND_H,
    learnerUpdatedAt: state.updatedAt, generatedAt: new Date().toISOString(),
  });
}

async function runTrendTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const fe = require('../lib/fade-engine');
  const t0 = Date.now();
  try {
  // One-off maintenance: ?prune=YYYY-MM-DD wipes a stale day file.
  if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
    await writeTrendDay(req.query.prune, { light: null, picks: [] });
    return res.json({ ok: true, pruned: req.query.prune });
  }

  // 1) Resolve matured logged picks → learn (per-stock trend quality), persist.
  //    Bounded by a time budget so the heavier scan below still fits in 60s.
  const days = await readAllTrendDays();
  const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
  const tk = [...openTk, 'SPY'];
  const hist = new Map(); let i = 0;
  const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 12 }, rw));
  const spy = hist.get('SPY') || [];
  const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
  const outcomes = []; const changed = new Set(); let resolvedNow = 0;
  for (const dd of days) {
    for (const p of (dd.picks || [])) {
      if (p.resolved) continue;
      const cands = hist.get(p.ticker); if (!cands) continue;
      const r = afterN(cands, p.date, TREND_H); if (!r) continue;
      const sp = afterN(spy, p.date, TREND_H); if (!sp) continue;
      const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
      p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
      outcomes.push({ ticker: p.ticker, alpha: p.excPct, sector: p.sector || SECTOR_OF[p.ticker] || '?', beta: p.beta });
      changed.add(dd.date); resolvedNow++;
    }
  }
  const state = fe.load(await readTrendEng());
  if (outcomes.length) fe.update(state, outcomes);
  await Promise.all([...changed].map(dt => { const dd = days.find(x => x.date === dt); return writeTrendDay(dt, { light: dd.light, picks: dd.picks }); }));

  // 2) Log today's light + basket for future resolution (scan bounded to fit 60s).
  const live = await computeTrendLive(t0, 45000);
  let logged = 0, logDate = null, color = null;
  if (live) {
    color = live.light.color;
    const picks = diversifyBasket(live.cands, 3, 15).map(c => ({ ticker: c.ticker, date: c.date, entry: c.price, mom: c.mom, sector: c.sector, resolved: false }));
    logDate = picks.length ? picks[0].date : new Date().toISOString().slice(0, 10);
    if (picks.length) { await writeTrendDay(logDate, { light: live.light, picks }); logged = picks.length; }
  }
  await writeTrendEng(fe.serialize(state));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, lightToday: color, ...fe.summary(state), elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

async function runTrendBook(req, res) {
  const days = await readAllTrendDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push({ ...p, color: (dd.light || {}).color || 'yellow' }); }));
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(p => p.excPct > 0).length, ci = wilson(beats, n);
    return { n, avgRet: +(arr.reduce((s, p) => s + (p.fwdPct || 0), 0) / n).toFixed(2), avgExc: +(arr.reduce((s, p) => s + p.excPct, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length, stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(picks),
    byClimate: { green: agg(picks.filter(p => p.color === 'green')), yellow: agg(picks.filter(p => p.color === 'yellow')), red: agg(picks.filter(p => p.color === 'red')) },
    note: `Live forward (${TREND_H}-session) track record of logged Trend-Rider picks, split by the traffic light at entry. Green should beat red — the live proof the light discriminates. Accrues via the warm cron; thin until ~${TREND_H} sessions after first tick.`,
    generatedAt: new Date().toISOString(),
  });
}

// ── Day-Trade momentum / relative-volume screener ──────────────────────────
// The EOD realization of the two Finviz day-trading setups (lib/daytrade.js):
// Scan 1 (Momentum & Liquid) over LARGE, Scan 2 (Explosive Small-Cap) over
// SMALL+MICRO. Self-learns per-stock via the shared fade-engine posterior, gates
// on the macro regime (the app's #1 proven lever), and is validated OOS by
// op=daytradeopt before any live claim. Forward horizon = a few sessions.
const DAYTRADE_H = 3;

async function scanDaytradeUniverse(tickers, params, ctx) {
  const dt = require('../lib/daytrade');
  const { cacheGet } = require('../lib/candle-cache');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - ctx.t0 > ctx.deadline) return;
      let candles = null;
      for (const doc of ctx.caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch {} }
      if (!candles || candles.length < dt.AVG_VOL_WINDOW + 5) continue;
      const m = dt.dayMetrics(candles, ctx.spyByDate);
      if (!m || !dt.passesScan(m, params)) continue;
      const p = ctx.fe.posterior(ctx.state, t, { sector: SECTOR_OF[t] || '?' });
      if (p.drifted) continue;   // learner: this name's momentum picks stopped working
      const lv = dt.tradeLevels(candles);                       // entry / stop / target / R:R
      const beta = ctx.fe.betaVsSpy(candles, ctx.spyByDate);    // for the beta-neutral view + sizing
      out.push({
        ticker: t, sector: SECTOR_OF[t] || '?', scan: params.key,
        date: candles[candles.length - 1].date, score: dt.rankScore(m),
        last: m.last, pctChange: m.pctChange, relVol: m.relVol, gapPct: m.gapPct,
        excessPct: m.excessPct, avgDollarVol: m.avgDollarVol, beta,
        entry: lv ? lv.entry : m.last, stop: lv ? lv.stop : null, target: lv ? lv.target : null,
        rr: lv ? lv.rr : null, riskPct: lv ? lv.riskPct : null, pullback: lv ? lv.pullback : null,
        learnedExcess: p.expAlpha, confidence: p.pPos, nPriors: p.n,
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  // Rank by composite score, nudged by the per-stock learned tilt.
  out.sort((a, b) => (b.score + 8 * b.learnedExcess) - (a.score + 8 * a.learnedExcess));
  return out;
}

async function computeDaytradeLive(t0, deadline) {
  const { loadCandleCache } = require('../lib/candle-cache');
  const fe = require('../lib/fade-engine');
  const { fetchMacro } = require('../lib/macro');
  const dt = require('../lib/daytrade');
  const spyD = await fetchDailyHistory('SPY');
  if (!spyD) return null;
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  let regime = 'neutral';
  try { const macro = await fetchMacro(); if (macro) regime = macro.regime; } catch {}
  const state = fe.load(await readDaytradeEng());
  const [cacheL, cacheS, cacheM] = await Promise.all([
    loadCandleCache('large').catch(() => null),
    loadCandleCache('small').catch(() => null),
    loadCandleCache('micro').catch(() => null),
  ]);
  const condition = require('../lib/confluence').marketCondition(spyD.candles, regime);
  const ctx = { spyByDate, t0, deadline, fe, state };
  const scan1 = await scanDaytradeUniverse([...new Set(UNI_LARGE)], dt.SCANS.momentum_liquid, { ...ctx, caches: [cacheL] });
  const scan2 = await scanDaytradeUniverse([...new Set([...UNI_SMALL, ...UNI_MICRO])], dt.SCANS.explosive_small, { ...ctx, caches: [cacheS, cacheM] });
  return { regime, condition, scan1, scan2, state, spyLastDate: spyD.candles[spyD.candles.length - 1].date };
}

// op=daytrade — live screener (regime-gated display).
async function runDaytrade(req, res) {
  const t0 = Date.now();
  const live = await computeDaytradeLive(t0, 45000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const riskOff = live.regime === 'risk-off';
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, regime: live.regime, condition: live.condition, riskOff, horizon: DAYTRADE_H,
    // Momentum/breakout fails in risk-off (the project's core finding) → stand down.
    momentumLiquid: riskOff ? [] : live.scan1.slice(0, 20),
    explosiveSmall: riskOff ? [] : live.scan2.slice(0, 20),
    counts: { momentumLiquid: live.scan1.length, explosiveSmall: live.scan2.length },
    learnerUpdatedAt: live.state.updatedAt, generatedAt: new Date().toISOString(),
  });
}

// op=daytradetick — cron: resolve matured picks → learn → log today's picks.
async function runDaytradeTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const fe = require('../lib/fade-engine');
  const t0 = Date.now();
  try {
    if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
      await writeDaytradeDay(req.query.prune, { picks: [] });
      return res.json({ ok: true, pruned: req.query.prune });
    }
    // 1) Resolve matured picks (forward H-session excess vs SPY) → learn.
    const days = await readAllDaytradeDays();
    const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
    const tk = [...openTk, 'SPY'];
    const hist = new Map(); let i = 0;
    const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 12 }, rw));
    const spy = hist.get('SPY') || [];
    const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
    const outcomes = []; const changed = new Set(); let resolvedNow = 0;
    for (const dd of days) {
      for (const p of (dd.picks || [])) {
        if (p.resolved) continue;
        const cands = hist.get(p.ticker); if (!cands) continue;
        const r = afterN(cands, p.date, DAYTRADE_H); if (!r) continue;
        const sp = afterN(spy, p.date, DAYTRADE_H); if (!sp) continue;
        const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
        p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
        outcomes.push({ ticker: p.ticker, alpha: p.excPct, sector: p.sector || SECTOR_OF[p.ticker] || '?' });
        changed.add(dd.date); resolvedNow++;
      }
    }
    const state = fe.load(await readDaytradeEng());
    if (outcomes.length) fe.update(state, outcomes);
    await Promise.all([...changed].map(dt2 => { const dd = days.find(x => x.date === dt2); return writeDaytradeDay(dt2, { regime: dd.regime, picks: dd.picks }); }));

    // 2) Log today's picks (counterfactually — ALL regimes — so the learner sees
    //    risk-off outcomes too; dedup by candle date).
    const live = await computeDaytradeLive(t0, 40000);
    let logged = 0, logDate = null;
    if (live) {
      logDate = live.spyLastDate;
      const picks = [...live.scan1.slice(0, 15), ...live.scan2.slice(0, 15)]
        .map(c => ({ ticker: c.ticker, scan: c.scan, date: logDate, entry: c.last, score: c.score, sector: c.sector, resolved: false }));
      if (picks.length) { await writeDaytradeDay(logDate, { regime: live.regime, picks }); logged = picks.length; }
    }
    await writeDaytradeEng(fe.serialize(state));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, ...fe.summary(state), elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=daytradebook — live forward track record by scan + regime.
async function runDaytradeBook(req, res) {
  const days = await readAllDaytradeDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push({ ...p, regime: dd.regime || 'neutral' }); }));
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(p => p.excPct > 0).length, ci = wilson(beats, n);
    return { n, avgRet: +(arr.reduce((s, p) => s + (p.fwdPct || 0), 0) / n).toFixed(2), avgExc: +(arr.reduce((s, p) => s + p.excPct, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length,
    stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(picks),
    byScan: { momentum_liquid: agg(picks.filter(p => p.scan === 'momentum_liquid')), explosive_small: agg(picks.filter(p => p.scan === 'explosive_small')) },
    byRegime: { 'risk-on': agg(picks.filter(p => p.regime === 'risk-on')), neutral: agg(picks.filter(p => p.regime === 'neutral')), 'risk-off': agg(picks.filter(p => p.regime === 'risk-off')) },
    note: `Live forward (${DAYTRADE_H}-session) excess-vs-SPY record of logged day-trade picks, by scan and macro regime. Accrues via the warm cron; thin until ~${DAYTRADE_H} sessions after the first tick.`,
    generatedAt: new Date().toISOString(),
  });
}

// op=daytradeopt — VALIDATION harness (validate-first). Replays a scan point-in-time
// over multi-year history → forward H-session excess vs SPY, split by regime + OOS.
async function runDaytradeOpt(req, res) {
  const dt = require('../lib/daytrade');
  const { buildMacroLookup } = require('../lib/macro');
  const scope = (req.query.scope || 'large').toLowerCase();
  const H = Math.max(1, parseInt(req.query.h, 10) || DAYTRADE_H);
  const range = /^(2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 150);
  const params = (scope === 'small' || scope === 'micro') ? dt.SCANS.explosive_small : dt.SCANS.momentum_liquid;
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);

  const [spyD, macro] = await Promise.all([fetchDailyHistory('SPY', range), buildMacroLookup(range).catch(() => null)]);
  if (!spyD || spyD.candles.length < 60) return res.status(502).json({ ok: false, error: 'No benchmark data' });
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  const W = dt.AVG_VOL_WINDOW;
  // Point-in-time trailing-252d beta vs SPY → the beta-neutral residual (strips the
  // part of the move that was just the market). Answers "is the edge alpha or beta?"
  const betaAt = (c, k, BW = 252) => {
    const lo = Math.max(1, k - BW + 1); const sr = [], mr = [];
    for (let j = lo; j <= k; j++) { const sp = spyByDate[c[j].date], sp1 = spyByDate[c[j - 1].date]; if (sp == null || sp1 == null) continue; sr.push(c[j].close / c[j - 1].close - 1); mr.push(sp / sp1 - 1); }
    const n = sr.length; if (n < 30) return 1;
    const mm = mr.reduce((a, x) => a + x, 0) / n, ms = sr.reduce((a, x) => a + x, 0) / n;
    let cov = 0, vm = 0; for (let j = 0; j < n; j++) { cov += (sr[j] - ms) * (mr[j] - mm); vm += (mr[j] - mm) ** 2; }
    return vm > 0 ? cov / vm : 1;
  };
  const t0 = Date.now(), deadline = 50000; const recs = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < W + H + 5) continue;
      const c = d.candles;
      for (let k = W + 1; k < c.length - H; k++) {
        const m = dt.dayMetrics(c.slice(k - W - 1, k + 1), spyByDate);   // metrics as-of day k
        if (!m || !dt.passesScan(m, params)) continue;
        const date = c[k].date; if (spyByDate[date] == null || spyByDate[c[k + H].date] == null) continue;
        const fwd = (c[k + H].close / c[k].close - 1) * 100, sfwd = (spyByDate[c[k + H].date] / spyByDate[date] - 1) * 100;
        const beta = betaAt(c, k);
        recs.push({ date, exc: fwd - sfwd, excB: fwd - beta * sfwd, fwd, beta, regime: macro ? (macro.at(date) || {}).regime || 'neutral' : 'neutral' });
      }
    }
  };
  await Promise.all(Array.from({ length: 14 }, worker));

  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const exc = arr.map(x => x.exc), beats = exc.filter(x => x > 0).length, ci = wilson(beats, n);
    const beatsBN = arr.filter(x => x.excB > 0).length, ciBN = wilson(beatsBN, n);
    return {
      n, avgExc: +mean(exc).toFixed(2), avgRet: +mean(arr.map(x => x.fwd)).toFixed(2),
      beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +((ci.lo) * 100).toFixed(0),
      avgBeta: +mean(arr.map(x => x.beta)).toFixed(2),
      avgExcBN: +mean(arr.map(x => x.excB)).toFixed(2),
      beatRateBN: +((beatsBN / n) * 100).toFixed(0), wilsonLoBN: +((ciBN.lo) * 100).toFixed(0),
    };
  };
  const dates = [...new Set(recs.map(r => r.date))].sort();
  const split = dates[Math.floor(0.6 * dates.length)] || dates[dates.length - 1];
  const oos = recs.filter(r => r.date >= split);
  const byReg = arr => ({ 'risk-on': agg(arr.filter(r => r.regime === 'risk-on')), neutral: agg(arr.filter(r => r.regime === 'neutral')), 'risk-off': agg(arr.filter(r => r.regime === 'risk-off')) });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, scan: params.key, range, horizonDays: H, namesScanned: tickers.length, signals: recs.length,
    overall: agg(recs), byRegime: byReg(recs),
    oos: { split, all: agg(oos), ...byReg(oos) },
    note: `Day-trade ${params.key} scan replayed point-in-time; forward ${H}-session excess vs SPY. Honest test: does the setup beat the market, hold OOS, and survive across regimes? (The project's prior: momentum is weak + regime-dependent.)`,
    generatedAt: new Date().toISOString(),
  });
}

// ── Confluence screener (5 classic strategies, self-learning) ──────────────
// Runs EMA-cross / Supertrend / RSI-MR / MACD / price-action over the universe and
// ranks names by how many strategies AGREE bullish. Two self-learners: a per-STOCK
// fade-engine posterior (which names' confluence actually continues) AND per-STRATEGY
// weights learned from realized edge (the algo re-weights what works). Regime-gated;
// validated OOS by op=confluenceopt. Forward horizon = 21 sessions (trend strategies).
const CONFLUENCE_H = 21;
const CONFLUENCE_MIN_BULL = 3;        // need a majority of the 5 strategies to agree
const STRAT_K = 0.1;                  // +1% avg realized excess → +0.1 confluence weight
const STRAT_DECAY = 0.95;             // EWMA decay for per-strategy edge
const CONFLUENCE_STRAT_KEY = 'apex/confluence-strat.json';

function confluenceStratWeights(stratState) {
  const cf = require('../lib/confluence');
  const w = {};
  for (const s of cf.STRATEGIES) {
    const e = stratState && stratState[s] ? stratState[s].ewma : 0;
    w[s] = +Math.max(0.3, Math.min(2, 1 + e * STRAT_K)).toFixed(2);   // learned, clamped
  }
  return w;
}
function stratEdgeSummary(stratState) {
  const cf = require('../lib/confluence');
  return cf.STRATEGIES.map(s => ({ strategy: s, ewmaExc: stratState[s] ? +stratState[s].ewma.toFixed(2) : 0, n: stratState[s] ? stratState[s].n : 0 }));
}

async function scanConfluenceUniverse(tickers, ctx) {
  const cf = require('../lib/confluence');
  const dt = require('../lib/daytrade');
  const { cacheGet } = require('../lib/candle-cache');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - ctx.t0 > ctx.deadline) return;
      let candles = null;
      for (const doc of ctx.caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch {} }
      if (!candles || candles.length < cf.MIN_BARS) continue;
      const r = cf.confluence(candles, ctx.weights, ctx.condition);
      if (!r || r.bullishCount < ctx.minBull) continue;
      const p = ctx.fe.posterior(ctx.state, t, { sector: SECTOR_OF[t] || '?' });
      if (p.drifted) continue;                                  // per-stock learner drop
      const di = candles.length - 1, dj = di - CONFLUENCE_H;
      const last = candles[di].close;
      let exc = null;
      if (dj >= 0 && ctx.spyByDate[candles[di].date] != null && ctx.spyByDate[candles[dj].date] != null) {
        exc = +(((last / candles[dj].close - 1) - (ctx.spyByDate[candles[di].date] / ctx.spyByDate[candles[dj].date] - 1)) * 100).toFixed(2);
      }
      const lv = dt.tradeLevels(candles);
      out.push({
        ticker: t, sector: SECTOR_OF[t] || '?', date: candles[di].date, last: +last.toFixed(2),
        score: r.score, maxScore: r.maxScore, bullishCount: r.bullishCount, bull: r.bull, matched: r.matched,
        perStrategy: r.perStrategy, freshTriggers: r.freshTriggers, excess21d: exc,
        beta: ctx.fe.betaVsSpy(candles, ctx.spyByDate),
        entry: lv ? lv.entry : last, stop: lv ? lv.stop : null, target: lv ? lv.target : null,
        rr: lv ? lv.rr : null, riskPct: lv ? lv.riskPct : null, pullback: lv ? lv.pullback : null,
        learnedExcess: p.expAlpha, confidence: p.pPos, nPriors: p.n,
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  out.sort((a, b) => (b.score + 8 * b.learnedExcess) - (a.score + 8 * a.learnedExcess));
  return out;
}

async function computeConfluenceLive(t0, deadline) {
  const { loadCandleCache } = require('../lib/candle-cache');
  const fe = require('../lib/fade-engine');
  const { fetchMacro } = require('../lib/macro');
  const spyD = await fetchDailyHistory('SPY');
  if (!spyD) return null;
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  let regime = 'neutral';
  try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}
  const state = fe.load(await readConfluenceEng());
  const stratState = (await readJSON(CONFLUENCE_STRAT_KEY, null)) || {};
  const weights = confluenceStratWeights(stratState);
  const condition = require('../lib/confluence').marketCondition(spyD.candles, regime);
  const [cL, cS, cM] = await Promise.all([
    loadCandleCache('large').catch(() => null), loadCandleCache('small').catch(() => null), loadCandleCache('micro').catch(() => null),
  ]);
  const ctx = { spyByDate, t0, deadline, fe, state, weights, condition, minBull: CONFLUENCE_MIN_BULL };
  const large = await scanConfluenceUniverse([...new Set(UNI_LARGE)], { ...ctx, caches: [cL] });
  const small = await scanConfluenceUniverse([...new Set([...UNI_SMALL, ...UNI_MICRO])], { ...ctx, caches: [cS, cM] });
  return { regime, condition, large, small, state, stratState, weights, spyLastDate: spyD.candles[spyD.candles.length - 1].date };
}

// op=confluence — live screener (regime-gated display).
async function runConfluence(req, res) {
  const t0 = Date.now();
  const live = await computeConfluenceLive(t0, 45000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const riskOff = live.regime === 'risk-off';
  const picks = [...live.large, ...live.small].sort((a, b) => (b.score + 8 * b.learnedExcess) - (a.score + 8 * a.learnedExcess)).slice(0, 25);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, regime: live.regime, condition: live.condition, favor: require('../lib/confluence').COND_FAVOR,
    riskOff, horizon: CONFLUENCE_H, minBull: CONFLUENCE_MIN_BULL,
    weights: live.weights, strategyEdge: stratEdgeSummary(live.stratState),
    picks: riskOff ? [] : picks, count: picks.length,
    learnerUpdatedAt: live.state.updatedAt, generatedAt: new Date().toISOString(),
  });
}

// op=confluencetick — cron: resolve matured picks → learn (per-stock + per-strategy) → log.
async function runConfluenceTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const fe = require('../lib/fade-engine');
  const t0 = Date.now();
  try {
    if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
      await writeConfluenceDay(req.query.prune, { picks: [] });
      return res.json({ ok: true, pruned: req.query.prune });
    }
    const days = await readAllConfluenceDays();
    const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
    const tk = [...openTk, 'SPY'];
    const hist = new Map(); let i = 0;
    const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 12 }, rw));
    const spy = hist.get('SPY') || [];
    const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
    const outcomes = []; const changed = new Set(); let resolvedNow = 0;
    const stratState = (await readJSON(CONFLUENCE_STRAT_KEY, null)) || {};
    for (const dd of days) {
      for (const p of (dd.picks || [])) {
        if (p.resolved) continue;
        const cands = hist.get(p.ticker); if (!cands) continue;
        const r = afterN(cands, p.date, CONFLUENCE_H); if (!r) continue;
        const sp = afterN(spy, p.date, CONFLUENCE_H); if (!sp) continue;
        const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
        p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
        outcomes.push({ ticker: p.ticker, alpha: p.excPct, sector: p.sector || SECTOR_OF[p.ticker] || '?' });
        // per-STRATEGY learning: attribute this pick's excess to each strategy that voted bullish.
        for (const s of (p.bull || [])) {
          const cur = stratState[s] || { ewma: 0, n: 0 };
          cur.ewma = STRAT_DECAY * cur.ewma + (1 - STRAT_DECAY) * p.excPct; cur.n++;
          stratState[s] = cur;
        }
        changed.add(dd.date); resolvedNow++;
      }
    }
    const state = fe.load(await readConfluenceEng());
    if (outcomes.length) {
      fe.update(state, outcomes);
      stratState.updatedAt = new Date().toISOString();
      await writeJSON(CONFLUENCE_STRAT_KEY, stratState, 0);
    }
    await Promise.all([...changed].map(dt2 => { const dd = days.find(x => x.date === dt2); return writeConfluenceDay(dt2, { regime: dd.regime, picks: dd.picks }); }));

    // Log today's picks (counterfactually, all regimes) with the firing strategies.
    const live = await computeConfluenceLive(t0, 40000);
    let logged = 0, logDate = null;
    if (live) {
      logDate = live.spyLastDate;
      const picks = [...live.large.slice(0, 15), ...live.small.slice(0, 15)]
        .map(c => ({ ticker: c.ticker, date: logDate, entry: c.last, score: c.score, bull: c.bull, sector: c.sector, resolved: false }));
      if (picks.length) { await writeConfluenceDay(logDate, { regime: live.regime, picks }); logged = picks.length; }
    }
    await writeConfluenceEng(fe.serialize(state));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, ...fe.summary(state), strategyEdge: stratEdgeSummary(stratState), elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=confluencebook — live forward track record overall + by strategy + regime.
async function runConfluenceBook(req, res) {
  const cf = require('../lib/confluence');
  const days = await readAllConfluenceDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push({ ...p, regime: dd.regime || 'neutral' }); }));
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(p => p.excPct > 0).length, ci = wilson(beats, n);
    return { n, avgExc: +(arr.reduce((s, p) => s + p.excPct, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  const byStrategy = {};
  for (const s of cf.STRATEGIES) byStrategy[s] = agg(picks.filter(p => (p.bull || []).includes(s)));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length, stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(picks), byStrategy,
    byRegime: { 'risk-on': agg(picks.filter(p => p.regime === 'risk-on')), neutral: agg(picks.filter(p => p.regime === 'neutral')), 'risk-off': agg(picks.filter(p => p.regime === 'risk-off')) },
    note: `Live forward (${CONFLUENCE_H}-session) excess-vs-SPY record of logged confluence picks, sliced by the strategies that voted for each. Accrues via the warm cron; thin until ~${CONFLUENCE_H} sessions after the first tick.`,
    generatedAt: new Date().toISOString(),
  });
}

// op=confluenceopt — VALIDATION harness. Replays the confluence rule AND each strategy
// individually, point-in-time over multi-year history → forward excess vs SPY, regime +
// OOS split. Answers: does confluence beat the market, and which strategies carry it?
async function runConfluenceOpt(req, res) {
  const cf = require('../lib/confluence');
  const { buildMacroLookup } = require('../lib/macro');
  const scope = (req.query.scope || 'large').toLowerCase();
  const H = Math.max(1, parseInt(req.query.h, 10) || CONFLUENCE_H);
  const range = /^(2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 120);
  const minBull = Math.max(1, parseInt(req.query.minbull, 10) || CONFLUENCE_MIN_BULL);
  // IMPROVEMENT LEVERS (test whether anything creates edge over raw confluence):
  const useRs = req.query.rs === '1';                  // require the name to be OUTPERFORMING SPY (rel-strength)
  const regimeGate = req.query.regimegate === '1';     // drop risk-off signals (the app's #1 proven lever)
  const freshOnly = req.query.fresh === '1';           // require a FRESH trigger this bar (not just persistent state)
  const topFrac = Math.min(1, Math.max(0, parseFloat(req.query.topfrac) || 1));   // per-date keep top-fraction by momentum
  const MOM = 63;
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);
  const [spyD, macro] = await Promise.all([fetchDailyHistory('SPY', range), buildMacroLookup(range).catch(() => null)]);
  if (!spyD || spyD.candles.length < 250) return res.status(502).json({ ok: false, error: 'No benchmark data' });
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });

  // MARKET CONDITION from SPY: efficiency ratio (trend vs chop) + 200DMA + macro regime.
  // The top-trader thesis: each strategy only works in ITS condition — trend-followers
  // in trending tapes, RSI mean-reversion in choppy tapes.
  const spyCl = spyD.candles.map(c => c.close);
  const smaAtIdx = (arr, p, idx) => { if (idx + 1 < p) return null; let s = 0; for (let j = idx - p + 1; j <= idx; j++) s += arr[j]; return s / p; };
  const erAt = (idx, n = 63) => { if (idx < n) return 0; let den = 0; for (let j = idx - n + 1; j <= idx; j++) den += Math.abs(spyCl[j] - spyCl[j - 1]); return den > 0 ? Math.abs(spyCl[idx] - spyCl[idx - n]) / den : 0; };
  const spyCond = {};
  spyD.candles.forEach((c, idx) => { const s200 = smaAtIdx(spyCl, 200, idx); spyCond[c.date] = { er: erAt(idx), above200: s200 != null && c.close > s200 }; });
  const ER_TREND = 0.35, ER_CHOP = 0.22;
  const marketCond = (date, regime) => {
    if (regime === 'risk-off') return 'riskoff';
    const sc = spyCond[date]; if (!sc) return 'mixed';
    if (sc.er >= ER_TREND && sc.above200) return 'trending';
    if (sc.er < ER_CHOP) return 'choppy';
    return 'mixed';
  };
  const FAVOR = { ema: 'trending', supertrend: 'trending', macd: 'trending', priceAction: 'trending', rsi: 'choppy' };

  const t0 = Date.now(), deadline = 50000;
  const recs = [];                       // confluence (>=minBull) signals, with lever fields
  const condRecs = [];                   // CONDITION-MATCHED signals (right strategy, right tape)
  const perStrat = {}; cf.STRATEGIES.forEach(s => perStrat[s] = []);   // each strategy's bullish-bar fwd excess
  const perStratCond = {}; cf.STRATEGIES.forEach(s => perStratCond[s] = {});   // ...split by market condition
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < cf.MIN_BARS + H + 5) continue;
      const c = d.candles, ind = cf.computeIndicators(c);
      for (let k = 205; k < c.length - H; k++) {
        const s = cf.strategyScoresAt(ind, c, k); if (!s) continue;
        const date = c[k].date; if (spyByDate[date] == null || spyByDate[c[k + H].date] == null) continue;
        const fwd = (c[k + H].close / c[k].close - 1) * 100, sfwd = (spyByDate[c[k + H].date] / spyByDate[date] - 1) * 100;
        const exc = fwd - sfwd, regime = macro ? (macro.at(date) || {}).regime || 'neutral' : 'neutral';
        const cond = marketCond(date, regime);
        const bull = cf.STRATEGIES.filter(st => s[st] === 1);
        for (const st of bull) { perStrat[st].push({ exc, regime }); (perStratCond[st][cond] = perStratCond[st][cond] || []).push(exc); }
        // condition-matched signal: only count strategies bullish IN their favorable tape.
        const matched = bull.filter(st => FAVOR[st] === cond);
        if ((cond === 'trending' && matched.length >= 2) || (cond === 'choppy' && matched.length >= 1)) {
          condRecs.push({ date, exc, fwd, regime, cond, matchedN: matched.length });
        }
        if (bull.length < minBull) continue;
        // lever inputs: relative strength (name vs SPY over MOM) + fresh trigger.
        const kp = k - MOM; let mom = null, rs = false;
        if (kp >= 0 && spyByDate[c[kp].date] != null) {
          mom = c[k].close / c[kp].close - 1;
          rs = mom > (spyByDate[c[k].date] / spyByDate[c[kp].date] - 1);
        }
        const fresh = !!(s.emaFresh || s.stFlip || s.macdFresh);
        recs.push({ date, exc, fwd, regime, nBull: bull.length, mom, rs, fresh });
      }
    }
  };
  await Promise.all(Array.from({ length: 14 }, worker));

  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(x => x.exc > 0).length, ci = wilson(beats, n);
    return { n, avgExc: +mean(arr.map(x => x.exc)).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  const byReg = arr => ({ 'risk-on': agg(arr.filter(r => r.regime === 'risk-on')), neutral: agg(arr.filter(r => r.regime === 'neutral')), 'risk-off': agg(arr.filter(r => r.regime === 'risk-off')) });
  const oosOf = arr => { const ds = [...new Set(arr.map(r => r.date))].sort(); const sp = ds[Math.floor(0.6 * ds.length)] || ds[ds.length - 1]; return { split: sp, all: agg(arr.filter(r => r.date >= sp)) }; };

  // Apply the improvement levers to build the "improved" signal set.
  let improved = recs;
  if (regimeGate) improved = improved.filter(r => r.regime !== 'risk-off');
  if (useRs) improved = improved.filter(r => r.rs);
  if (freshOnly) improved = improved.filter(r => r.fresh);
  if (topFrac < 1) {
    const byDate = {}; improved.forEach(r => (byDate[r.date] = byDate[r.date] || []).push(r));
    improved = [];
    Object.values(byDate).forEach(arr => { arr.sort((a, b) => (b.mom || -9) - (a.mom || -9)); const keep = Math.max(1, Math.floor(arr.length * topFrac)); for (let j = 0; j < keep; j++) improved.push(arr[j]); });
  }
  const perStrategy = {}; cf.STRATEGIES.forEach(s => perStrategy[s] = { overall: agg(perStrat[s]), byRegime: byReg(perStrat[s]) });

  // THE top-trader test: each strategy IN its favorable tape vs OUT of it.
  const aggE = arr => agg((arr || []).map(exc => ({ exc })));
  const byCondition = {};
  cf.STRATEGIES.forEach(s => {
    const favor = FAVOR[s], pc = perStratCond[s];
    const inFavor = pc[favor] || [];
    const outFavor = Object.keys(pc).filter(k => k !== favor).flatMap(k => pc[k]);
    byCondition[s] = { favorCond: favor, inFavor: aggE(inFavor), outOfFavor: aggE(outFavor), trending: aggE(pc.trending), choppy: aggE(pc.choppy), riskoff: aggE(pc.riskoff), mixed: aggE(pc.mixed) };
  });
  const condMatched = { n: condRecs.length, overall: agg(condRecs), oos: oosOf(condRecs), byCond: { trending: agg(condRecs.filter(r => r.cond === 'trending')), choppy: agg(condRecs.filter(r => r.cond === 'choppy')) } };

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, horizonDays: H, minBull, namesScanned: tickers.length, confluenceSignals: recs.length,
    levers: { rs: useRs, regimeGate, freshOnly, topFrac },
    byCondition, conditionMatched: condMatched,
    confluence: { overall: agg(recs), byRegime: byReg(recs), oos: oosOf(recs) },
    improved: { n: improved.length, overall: agg(improved), byRegime: byReg(improved), oos: oosOf(improved) },
    perStrategy,
    note: `Confluence (>=${minBull}/5) replayed point-in-time; fwd ${H}-session excess vs SPY. 'improved' applies levers (rs/regimegate/fresh/topfrac) — does any combo finally beat the market OOS?`,
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runFadeOpt, runFadeSeed, runFadeSignals, runFadeTick, runFadeBook,
  runTrendOpt, runTrend, runTrendTick, runTrendBook,
  runDaytrade, runDaytradeTick, runDaytradeBook, runDaytradeOpt,
  runConfluence, runConfluenceTick, runConfluenceBook, runConfluenceOpt };
