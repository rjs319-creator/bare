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
async function scanFadeSetups(tickers, deadlineMs, t0, spyClose = {}, caches = []) {
  const { analyzeInvertedV } = require('../lib/vreversal');
  const { betaVsSpy } = require('../lib/fade-engine');
  const { cacheGet } = require('../lib/candle-cache');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadlineMs) return;
      // Cache-first (the warm daily candle cache covers the full universe instantly);
      // network only on a miss. This stops the deadline truncating the scan to the
      // alphabetically-first names. The cache's ~300 bars exceed the 120 fade needs.
      let candles = null;
      for (const doc of caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch { continue; } }
      if (!candles || candles.length < 120) continue;
      const v = analyzeInvertedV(candles);
      if (!v) continue;
      // Liquidity floor: shorting a thin name is dangerous (wide spread, hard
      // borrow/cover). Require ≥$3M/day avg dollar volume — the same tradeability
      // bar the Scoreboard diagnosis pointed to. Skip the filter if the cache has
      // no volume data (advUsd 0) so we don't drop names for a data gap.
      const recent = candles.slice(-20);
      const advUsd = recent.reduce((s, c) => s + c.close * (c.volume || 0), 0) / (recent.length || 1);
      if (advUsd > 0 && advUsd < 3_000_000) continue;
      out.push({ ticker: t, date: candles[candles.length - 1].date, signal: v, beta: betaVsSpy(candles, spyClose) });
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
  const { loadCandleCache } = require('../lib/candle-cache');
  const fadeCaches = await Promise.all(
    (scope === 'small' ? ['small'] : scope === 'micro' ? ['micro'] : scope === 'all' ? ['large', 'small', 'micro'] : ['large'])
      .map(sc => loadCandleCache(sc).catch(() => null)));
  const setups = await scanFadeSetups(rotateByDay(tickers), 50000, t0, spyClose, fadeCaches);
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
    const { loadCandleCache } = require('../lib/candle-cache');
    const fadeCache = await loadCandleCache('large').catch(() => null);
    const setups = await scanFadeSetups(rotateByDay([...new Set(UNI_LARGE)]), 35000, t0, spyClose, [fadeCache]);
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
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  // Fresh-mover lane first (cache-only, fast) so it always completes; then the 2y basket scan.
  const movers = await scanMoverUniverse(spyByDate, t0, deadline);
  const cands = await scanTrendUniverse(rotateByDay([...new Set(UNI_LARGE)]), deadline, t0);
  return { light, regime, breadthPct: Math.round(breadth * 100), cands, movers };
}

// Fresh momentum movers: broadened universe (curated large + the free expanded universe),
// scanned from the pre-warmed candle caches only (fast, keeps the tick under budget). Names
// not yet warmed are simply skipped. The $150M $-vol + uptrend + RS gates live in the engine.
async function scanMoverUniverse(spyByDate, t0, deadline) {
  const { freshMoverCandidate } = require('../lib/trend');
  const { loadCandleCache, cacheGet } = require('../lib/candle-cache');
  const [cL, cE] = await Promise.all([
    loadCandleCache('large').catch(() => null), loadCandleCache('expanded').catch(() => null),
  ]);
  const expTk = cE && cE.data ? Object.keys(cE.data) : [];
  const universe = [...new Set([...UNI_LARGE, ...expTk])];
  const out = [];
  for (const t of universe) {
    if (Date.now() - t0 > deadline) break;
    let candles = null;
    for (const doc of [cL, cE]) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
    if (!candles) continue;
    const m = freshMoverCandidate(candles, spyByDate);
    if (m) { m.ticker = t; m.sector = SECTOR_OF[t] || 'Other'; m.date = candles[candles.length - 1].date; out.push(m); }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
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
  const movers = diversifyBasket(live.movers || [], 3, 12);       // sector-capped fresh-mover list
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, light: live.light, breadthPct: live.breadthPct, candidates: live.cands.length,
    basketSize: basket.length, basket: basket.slice(0, 15), holdHorizon: TREND_H,
    movers, moverCount: (live.movers || []).length,
    // The learner's influence here is already avoid-only (drifted veto; ordering is
    // momentum-based) — stated explicitly so the contract is auditable (posterior-rank).
    posteriorPolicy: POSTERIOR_POLICY_NOTE,
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
  const openTk = new Set();
  days.forEach(dd => {
    (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); });
    (dd.movers || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); });
  });
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
    // Fresh movers resolve for the Scoreboard/book only — they do NOT feed the basket learner.
    for (const p of (dd.movers || [])) {
      if (p.resolved) continue;
      const cands = hist.get(p.ticker); if (!cands) continue;
      const r = afterN(cands, p.date, TREND_H); if (!r) continue;
      const sp = afterN(spy, p.date, TREND_H); if (!sp) continue;
      const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
      p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
      changed.add(dd.date); resolvedNow++;
    }
  }
  const state = fe.load(await readTrendEng());
  if (outcomes.length) fe.update(state, outcomes);
  await Promise.all([...changed].map(dt => { const dd = days.find(x => x.date === dt); return writeTrendDay(dt, { light: dd.light, picks: dd.picks, movers: dd.movers }); }));

  // 2) Log today's light + basket for future resolution (scan bounded to fit 60s).
  const live = await computeTrendLive(t0, 45000);
  let logged = 0, logDate = null, color = null;
  if (live) {
    color = live.light.color;
    const picks = diversifyBasket(live.cands, 3, 15).map(c => ({ ticker: c.ticker, date: c.date, entry: c.price, mom: c.mom, sector: c.sector, resolved: false }));
    const movers = diversifyBasket(live.movers || [], 3, 12).map(c => ({ ticker: c.ticker, date: c.date, entry: c.price, ret5: c.ret5, rs: c.rs, score: c.score, sector: c.sector, resolved: false }));
    logDate = picks.length ? picks[0].date : (movers.length ? movers[0].date : new Date().toISOString().slice(0, 10));
    if (picks.length || movers.length) { await writeTrendDay(logDate, { light: live.light, picks, movers }); logged = picks.length; }
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
  const picks = [], moverPicks = [];
  days.forEach(dd => {
    (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push({ ...p, color: (dd.light || {}).color || 'yellow' }); });
    (dd.movers || []).forEach(p => { if (p.resolved && p.excPct != null) moverPicks.push(p); });
  });
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
    movers: { ...agg(moverPicks), stillOpen: days.reduce((a, dd) => a + (dd.movers || []).filter(p => !p.resolved).length, 0) },
    note: `Live forward (${TREND_H}-session) track record of logged Trend-Rider picks, split by the traffic light at entry. Green should beat red — the live proof the light discriminates. The 'movers' block tracks the fresh-momentum lane (excess vs SPY) — the falsification of the backtested +4.96%/21d edge. Accrues via the warm cron; thin until ~${TREND_H} sessions after first tick.`,
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
  const { computeFreshness } = require('../lib/freshness');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - ctx.t0 > ctx.deadline) return;
      let candles = null;
      for (const doc of ctx.caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch {} }
      if (!candles || candles.length < dt.AVG_VOL_WINDOW + 5) continue;
      const m = dt.dayMetrics(candles, ctx.spyByDate, undefined, ctx.pace || 1, ctx.todayET);
      if (!m) continue;
      // Strict A-tier, else relaxed B-tier ("building") when provided → more picks.
      let tier = null;
      if (dt.passesScan(m, params)) tier = 'A';
      else if (ctx.relaxed && dt.passesScan(m, ctx.relaxed)) tier = 'B';
      if (!tier) continue;
      const p = ctx.fe.posterior(ctx.state, t, { sector: SECTOR_OF[t] || '?' });
      if (p.drifted) continue;   // learner: this name's momentum picks stopped working
      // Wide 2.5×ATR stop (no today's-low floor) + an opening-range-breakout plan —
      // the evidence-based config from the intraday research (see FINDINGS.md).
      const lv = dt.tradeLevels(candles, { stopAtrMult: 2.5, useLowFloor: false });
      const orb = dt.orbLevels(candles);                        // next-session ORB entry plan
      const beta = ctx.fe.betaVsSpy(candles, ctx.spyByDate);    // for the beta-neutral view + sizing
      out.push({
        ticker: t, sector: SECTOR_OF[t] || '?', scan: params.key, tier,
        date: candles[candles.length - 1].date, score: dt.rankScore(m),
        // Per-ticker point-in-time freshness (candidateDate/dailyBarAsOf/dataAge/status).
        // barIsToday=false ⇒ this name is a stale prior-session bar, never live-actionable.
        freshness: computeFreshness({ barDate: m.candidateDate, cacheUpdatedAt: ctx.cacheUpdatedAt }),
        barIsToday: m.barIsToday, paced: m.paced,
        last: m.last, pctChange: m.pctChange, relVol: m.relVol, gapPct: m.gapPct,
        excessPct: m.excessPct, avgDollarVol: m.avgDollarVol, avgVol: m.avgVol, beta,
        entry: lv ? lv.entry : m.last, stop: lv ? lv.stop : null, target: lv ? lv.target : null,
        rr: lv ? lv.rr : null, riskPct: lv ? lv.riskPct : null, pullback: lv ? lv.pullback : null,
        orb,
        learnedExcess: p.expAlpha, confidence: p.pPos, nPriors: p.n,
        _cf: require('../lib/pcarry').pcarryPriceFeatures(candles),   // pcarry price features
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  // Rank by composite score, nudged by the per-stock learned tilt.
  out.sort((a, b) => (b.score + 8 * b.learnedExcess) - (a.score + 8 * a.learnedExcess));
  return out;
}

// Multi-day momentum-RUN scan over the union universe — catches the sustained-mover
// (FCEL-style) archetype that the single-day scans miss on continuation days.
async function scanDaytradeRuns(tickers, ctx) {
  const dt = require('../lib/daytrade');
  const { cacheGet } = require('../lib/candle-cache');
  const { computeFreshness } = require('../lib/freshness');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - ctx.t0 > ctx.deadline) return;
      let candles = null;
      for (const doc of ctx.caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch {} }
      if (!candles || candles.length < dt.AVG_VOL_WINDOW + dt.RUN_SCAN.minHighVolDays + 6) continue;
      const m = dt.dayMetrics(candles, ctx.spyByDate, undefined, ctx.pace || 1, ctx.todayET);
      if (!m) continue;
      // Strict A-tier, else relaxed B-tier ("building") — surfaces more runs on quiet tapes.
      let tier = null;
      if (dt.passesRunScan(m)) tier = 'A';
      else if (dt.passesRunScan(m, dt.RUN_SCAN_RELAXED)) tier = 'B';
      if (!tier) continue;
      const lv = dt.tradeLevels(candles, { stopAtrMult: 2.5, useLowFloor: false });
      out.push({
        ticker: t, sector: SECTOR_OF[t] || '?', scan: 'momentum_run', tier,
        date: candles[candles.length - 1].date, score: dt.runRankScore(m),
        freshness: computeFreshness({ barDate: m.candidateDate, cacheUpdatedAt: ctx.cacheUpdatedAt }),
        barIsToday: m.barIsToday, paced: m.paced,
        last: m.last, pctChange: m.pctChange, pct5d: m.pct5d, highVolDays5: m.highVolDays5,
        nearHighFrac5: m.nearHighFrac5, relVol: m.relVol, gapPct: m.gapPct,
        excessPct: m.excessPct, avgDollarVol: m.avgDollarVol, avgVol: m.avgVol,   // avgVol for card completeness (parity with the momentum/explosive rows)
        entry: lv ? lv.entry : m.last, stop: lv ? lv.stop : null, target: lv ? lv.target : null,
        rr: lv ? lv.rr : null,
        _cf: require('../lib/pcarry').pcarryPriceFeatures(candles),   // pcarry price features
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Attach the honest pcarry carry-odds to a pool of picks. News catalyst is fetched (bounded)
// only for `newsCap` picks; the rest use no catalyst (neutral). Mutates in place.
// LEGACY (log/tick paths only) — the LIVE board uses attachCarryPriceOnly + the bounded
// post-validation enrichCatalystCarry so ~100 news fetches can never run ahead of live
// validation inside the time-critical cycle.
async function attachCarry(pools, regime, newsCap = 60) {
  const { scorePcarry } = require('../lib/pcarry');
  const { fetchCompanyNews } = require('../lib/fundamentals');
  const { classifyGapCause } = require('../lib/gapgo');
  const all = pools.flat();
  const withNews = all.slice(0, newsCap);
  let i = 0;
  const worker = async () => {
    while (i < withNews.length) {
      const p = withNews[i++];
      try {
        const to = p.date, from = new Date(Date.parse(p.date) - 3 * 864e5).toISOString().slice(0, 10);
        const news = await fetchCompanyNews(p.ticker, from, to).catch(() => []);
        p._cat = classifyGapCause(news);
      } catch { p._cat = 'NONE'; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  for (const p of all) {
    const s = p._cf ? scorePcarry(p._cf, { scan: p.scan, catalyst: p._cat || 'NONE', regime }) : null;
    if (s) { p.carry = s.carry; p.overextended = s.overextended; p.nearHigh = s.nearHigh; p.carryDrivers = s.drivers; p.catalyst = p._cat || null; }
    delete p._cf; delete p._cat;
  }
}

// Price-features-only carry (NO network, catalyst neutral). `_cf` is RETAINED so the
// bounded post-validation catalyst enrichment can re-score just the displayed few.
function attachCarryPriceOnly(pools, regime) {
  const { scorePcarry } = require('../lib/pcarry');
  for (const p of pools.flat()) {
    const s = p._cf ? scorePcarry(p._cf, { scan: p.scan, catalyst: 'NONE', regime }) : null;
    if (s) {
      p.carry = s.carry; p.overextended = s.overextended; p.nearHigh = s.nearHigh;
      p.carryDrivers = s.drivers; p.catalyst = null; p.catalystBasis = 'not-fetched';
    }
  }
}

// Bounded, deadline-aware CATALYST enrichment AFTER live validation — news is fetched for
// the displayed actionable few only (never 60+ names ahead of validation), timestamped,
// and the carry odds re-scored with the catalyst known. Mutates picks in place; returns
// the set of enriched tickers so cards can be refreshed.
async function enrichCatalystCarry(picks, regime, { t0 = Date.now(), deadline = 50000, cap = 12 } = {}) {
  const { scorePcarry } = require('../lib/pcarry');
  const { fetchCompanyNews } = require('../lib/fundamentals');
  const { classifyGapCause } = require('../lib/gapgo');
  const targets = (picks || []).filter(p => p && p._cf).slice(0, cap);
  const enriched = new Set();
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      if (Date.now() - t0 > deadline) return;   // never risk the wall for display context
      const p = targets[i++];
      try {
        const to = p.date, from = new Date(Date.parse(p.date) - 3 * 864e5).toISOString().slice(0, 10);
        const news = await fetchCompanyNews(p.ticker, from, to).catch(() => []);
        const cat = classifyGapCause(news);
        const s = scorePcarry(p._cf, { scan: p.scan, catalyst: cat, regime });
        if (s) { p.carry = s.carry; p.overextended = s.overextended; p.nearHigh = s.nearHigh; p.carryDrivers = s.drivers; }
        p.catalyst = cat; p.catalystBasis = 'fetched-post-validation'; p.catalystAsOf = new Date().toISOString();
        enriched.add(p.ticker);
      } catch { /* neutral catalyst stands */ }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return enriched;
}

// Strip the internal carry feature vector before a pool ships in a response.
function sanitizeCarryInternals(pools) {
  for (const p of pools.flat()) { delete p._cf; delete p._cat; }
}

async function computeDaytradeLive(t0, deadline, { pace = false, expanded = false } = {}) {
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
  // Intraday volume pacing — LIVE DISPLAY ONLY (pace=true from runDaytrade). Prorate relVol
  // by the session fraction elapsed so mid-session partial-volume bars still populate the
  // scans. Guarded to only kick in when the latest bar IS today's forming session (so a
  // stale weekend/holiday bar or the daily warm cron is never paced). The tick/ledger
  // and backtest call with pace=false → paceFrac stays 1 (completed-bar semantics).
  const spyLastDate = spyD.candles[spyD.candles.length - 1].date;
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const paceFrac = (pace && spyLastDate === todayET) ? dt.sessionPaceFraction() : 1;
  // `todayET` flows to every dayMetrics call so pacing is applied per-ticker ONLY when THAT
  // name's own last bar is dated today — the intrinsic stale-candle guard (lib/daytrade,
  // lib/freshness). paceFrac remains a cheap SPY-level early-out; the per-ticker date check
  // is the actual correctness gate.
  // Cache-age provenance: the newest candle-cache write across the cap-band docs. This was
  // silently `undefined` before (the ctx never carried it) so cache age never reached
  // computeFreshness despite every scan passing it through.
  const cacheUpdatedAt = (() => {
    const ms = Math.max(...[cacheL, cacheS, cacheM].map(c => (c && Number.isFinite(c.updatedAt) ? c.updatedAt : 0)));
    return ms > 0 ? new Date(ms).toISOString() : null;
  })();
  const ctx = { spyByDate, t0, deadline, fe, state, pace: paceFrac, todayET, cacheUpdatedAt };
  const scan1 = await scanDaytradeUniverse(rotateByDay([...new Set(UNI_LARGE)]), dt.SCANS.momentum_liquid, { ...ctx, caches: [cacheL], relaxed: dt.SCANS.momentum_building });
  const scan2 = await scanDaytradeUniverse(rotateByDay([...new Set([...UNI_SMALL, ...UNI_MICRO])]), dt.SCANS.explosive_small, { ...ctx, caches: [cacheS, cacheM], relaxed: dt.SCANS.explosive_building });
  // Multi-day momentum-run scan over the union universe (reuses the same caches).
  const scan3 = await scanDaytradeRuns(rotateByDay([...new Set([...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO])]), { ...ctx, caches: [cacheL, cacheS, cacheM] });
  // 🌐 Expanded lane (live display only): run the SAME momentum_liquid gate over the
  // free full-market universe, EXCLUDING names already in the cap-band scans. Kept
  // out of the validated ledger (the tick logs scan1/2/3 only) so the tracked edge
  // stats stay clean — this is a broader-net watchlist, not part of the measured cohort.
  let scan4 = [];
  if (expanded) {
    const cacheE = await loadCandleCache('expanded').catch(() => null);
    if (cacheE && cacheE.data) {
      const capBand = new Set([...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO]);
      const expNew = Object.keys(cacheE.data).filter(t => !capBand.has(t));
      scan4 = await scanDaytradeUniverse(rotateByDay(expNew), dt.SCANS.momentum_liquid, { ...ctx, caches: [cacheE], relaxed: dt.SCANS.momentum_building });
    }
  }
  return { regime, condition, scan1, scan2, scan3, scan4, state, spyLastDate, paceFrac };
}

// Assign a 0-100 RELATIVE-strength score across a combined pool of picks (percentile of
// a z-blend of relVol + pctChange + excess-vs-SPY). Mutates a fresh copy — pure inputs.
function assignRelScores(pools) {
  const all = pools.flat();
  if (!all.length) return;
  const stat = key => { const v = all.map(p => p[key]).filter(x => x != null && isFinite(x)); const m = v.reduce((a, b) => a + b, 0) / (v.length || 1); const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length || 1)) || 1; return { m, sd }; };
  const rv = stat('relVol'), pc = stat('pctChange'), ex = stat('excessPct');
  const z = (x, s) => (x == null || !isFinite(x)) ? 0 : (x - s.m) / s.sd;
  all.forEach(p => { p._strength = z(p.relVol, rv) + z(p.pctChange, pc) + z(p.excessPct, ex); });
  const sorted = [...all].sort((a, b) => a._strength - b._strength);
  sorted.forEach((p, i) => { p.relScore = Math.round((all.length === 1 ? 1 : i / (all.length - 1)) * 100); });
}

// Build the day's BEST OPPORTUNITIES — now ranked by the honest pcarry CARRY ODDS across
// the WHOLE green pool (ML + runs + explosive). Explosive/overextended names are no longer
// hard-excluded; the model discounts them (low carry), so they naturally sort to the bottom
// — realizing the research finding (overextended blow-offs fade) as a soft, calibrated
// tilt instead of a hard gate.
// FADE-AVOIDANCE QUALITY GATE. The app's own forward tracker (op=daytradebook) showed the
// raw momentum/explosive picks LOSING ~4% excess vs SPY over 3 sessions — worst on the
// overextended/froth names — and the survivorship-corrected research (research/33, 26k
// candidate-days) found the ONLY durable, tradeable signal is FADE AVOIDANCE. So Best
// Opportunities is no longer a ranked view of the whole pool (where blow-offs "flowed
// through, discounted"); it's a strict filter that admits ONLY names the fade model does
// not flag: carry above the empirical beat-SPY base rate, NOT an overextended blow-off, and
// no dilution/M&A fade catalyst. Fewer, cleaner names beat a long list of fade traps — and
// on a day with no clean setups it returns [] (honest empty state), not backfilled junk.
const { GATE } = require('../lib/daytrade-config');
const BEST_CARRY_FLOOR = GATE.BEST_CARRY_FLOOR;          // above pcarry BASE_RATE (~49% beat-SPY)
const BEST_FADE_CATALYSTS = GATE.BEST_FADE_CATALYSTS;    // dilution / M&A pops that fade

// CURRENT-SESSION ACTIONABILITY GATE. A name may enter Best Opportunities (the "Actionable
// Now" lane) ONLY if it is live-actionable, never merely green on a stale prior-session bar.
// When the canonical lifecycle envelope is present (the live route stamps it), require
// `actionable === true`. For pure-pool callers without the envelope, fall back to requiring
// current-session freshness — a stale prior-session bar is NEVER admitted. This is the
// enforcement (not just a flag) that closes the split-brain: yesterday's +3.35% mover cannot
// masquerade as a live buy while the browser shows it down 10%.
function isActionableRow(p) {
  if (p.actionable === true) return true;
  if (p.actionable === false) return false;
  return p.barIsToday === true || !!(p.freshness && p.freshness.freshnessStatus === 'FRESH_TODAY');
}

// FADE-AVOIDANCE gate ONLY (freshness-agnostic): green + above-base-rate carry + not a blow-off
// + no dilution/M&A fade pop. Used at LOG time (op=daytradetick, completed bars) where freshness
// is not a factor, and as the quality half of the live actionable gate below.
function passesFadeGate(p) {
  return p.pctChange > 0                                  // green today
    && p.carry != null && p.carry >= BEST_CARRY_FLOOR     // model tilts positive, not just base-rate
    && !p.overextended                                    // not a blow-off (extADR < 3) — the #1 fade tell
    && !BEST_FADE_CATALYSTS.includes(p.catalyst);         // no dilution / M&A fade pop
}

// LIVE Best-Opportunities gate (best-gate-v2). ADMISSION answers the same-day intraday
// question INDEPENDENTLY of any multi-day model: the lifecycle envelope must be fully
// valid (actionable + current-session fresh + thesis + plan + a live plan present) and the
// execution gate must not have blocked. The 3-session pcarry odds and price overextension
// are RANKING/context inputs only (they answer a multi-day carry question and may no
// longer suppress a valid intraday setup); dilution/M&A fade catalysts stay excluded as a
// mechanical catalyst-class rule.
function passesQualityGate(p) {
  return p.actionable === true
    && p.currentSessionFresh === true
    && p.thesisValid === true
    && p.planValid === true
    && !!(p.livePlan && p.livePlan.entry > 0)
    && !(p.execution && p.execution.gate && p.execution.gate.blocked === true)
    && !BEST_FADE_CATALYSTS.includes(p.catalyst);
}

// gate-v2 ranking key: carry odds discounted for blow-off extension; unknown carry ranks
// at the base rate (never excluded for missing a multi-day model input).
function bestRankKey(p) {
  const carry = p.carry != null ? p.carry : GATE.CARRY_NEUTRAL;
  return carry - (p.overextended ? GATE.OVEREXTENDED_RANK_DISCOUNT : 0);
}

// Stamp fade-avoidance gate membership onto a pick at LOG time (pure, NO network) so the
// forward book (op=daytradebook → byGate) can measure whether the gate actually identifies
// the better-performing subset. Reuses the pick's precomputed pcarry price features (`_cf`);
// catalyst is left NEUTRAL here — the live display gate additionally excludes dilution/M&A
// news pops (needs a per-pick news fetch we deliberately skip in the cron), a small fidelity
// gap noted in the book. Returns { carry, overextended, gated }.
function stampGate(pick, regime) {
  const { scorePcarry } = require('../lib/pcarry');
  const s = pick && pick._cf ? scorePcarry(pick._cf, { scan: pick.scan, catalyst: 'NONE', regime }) : null;
  if (!s) return { carry: null, overextended: null, gated: false };
  const gated = passesFadeGate({ pctChange: pick.pctChange, carry: s.carry, overextended: s.overextended, catalyst: null });
  return { carry: s.carry, overextended: s.overextended, gated };
}

function buildBestOpportunities(pool, limit = 12) {
  const sgn = v => (v >= 0 ? '+' : '') + v;
  const why = p => {
    const bits = [];
    if (p.carry != null) bits.push(`${p.carry}% carry odds`);
    if (p.relVol) bits.push(`${p.relVol}× rel-vol`);
    if (p.pctChange >= 3) bits.push(`${sgn(p.pctChange)}% today`);
    if (p.nearHigh) bits.push('holding near high');
    else if (['FDA', 'GUIDE', 'CONTRACT'].includes(p.catalyst)) bits.push('✓ catalyst');
    return bits.slice(0, 3).join(' · ');
  };
  const SRC = { momentum_liquid: 'Momentum & Liquid', momentum_run: 'Multi-day run', explosive_small: 'Explosive small-cap', discovery: 'Live discovery' };
  return pool.filter(passesQualityGate)                   // intraday-validated admission (best-gate-v2)
    // Rank by carry odds DISCOUNTED for overextension (context, never exclusion); break
    // ties by the per-stock LEARNER tilt (fade-engine expAlpha), then relative strength.
    .sort((a, b) => (bestRankKey(b) - bestRankKey(a))
      || ((b.learnedExcess ?? 0) - (a.learnedExcess ?? 0))
      || (b.relScore ?? 0) - (a.relScore ?? 0))
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1, ticker: p.ticker, sector: p.sector, source: SRC[p.scan] || p.scan, relScore: p.relScore,
      gateVersion: GATE.VERSION,
      carry: p.carry, overextended: !!p.overextended, catalyst: p.catalyst || null,
      catalystBasis: p.catalystBasis ?? null, catalystAsOf: p.catalystAsOf ?? null,
      last: p.last, pctChange: p.pctChange, relVol: p.relVol, tier: p.tier || null,
      entry: p.entry, stop: p.stop, target: p.target, rr: p.rr, riskPct: p.riskPct, orb: p.orb || null,
      // Carry the full point-in-time metadata so the prominent card is a first-class live
      // representation (not a reduced card): freshness/barIsToday let the UI flag a stale
      // prior-session name, and avgVol/date complete the card. See lib/freshness.
      avgVol: p.avgVol ?? null, date: p.date ?? null,
      // Measured liquidity for downstream cost/eligibility: prefer the scanner's own
      // avgDollarVol; else derive from measured avgVol × last. Missing stays null (the
      // cost model then assumes the CONSERVATIVE tier, never the cheapest).
      avgDollarVol: p.avgDollarVol ?? (Number.isFinite(p.avgVol) && Number.isFinite(p.last) && p.last > 0 ? Math.round(p.avgVol * p.last) : null),
      barIsToday: p.barIsToday, paced: p.paced, freshness: p.freshness || null,
      // Canonical actionability envelope (present when the live route classified the pool via
      // lib/daytrade-actionability) — carried so the downstream Today normalizer and the UI
      // can gate on ACTIONABLE_NOW + freshness + thesis/plan validity, not raw relScore.
      lifecycleState: p.lifecycleState ?? null, actionable: p.actionable ?? null,
      thesisValid: p.thesisValid ?? null, planValid: p.planValid ?? null,
      currentSessionFresh: p.currentSessionFresh ?? null,
      explanation: p.explanation ?? null, reasonCodes: p.reasonCodes ?? null,
      candidateAsOf: p.candidateAsOf ?? p.date ?? null, intradayBarAsOf: p.intradayBarAsOf ?? null,
      quoteAsOf: p.quoteAsOf ?? null, validatedAt: p.validatedAt ?? null, planAsOf: p.planAsOf ?? p.date ?? null,
      currentPrice: p.currentPrice ?? p.last ?? null, lossFromDetectionPct: p.lossFromDetectionPct ?? null,
      // The live plan in force + execution/cost status + provenance the spec requires on
      // every actionable card (the projection previously dropped these).
      livePlan: p.livePlan ?? null,
      execution: p.execution ?? null,
      dayChangePct: p.dayChangePct ?? null,
      evidenceBasis: p.evidenceBasis ?? null,
      provisionalBreak: p.provisionalBreak ?? null,
      earlyState: p.earlyState ?? null,
      why: why(p),
      whyWrong: [
        p.livePlan && p.livePlan.stop != null ? `a completed 5-min close at/below the frozen stop $${p.livePlan.stop}` : null,
        'two completed closes below VWAP',
        p.dayChangePct != null ? 'a current-session collapse vs the prior close' : null,
        p.livePlan && p.livePlan.expiresAt ? `no follow-through before ${p.livePlan.expiresAt.slice(11, 16)} UTC (plan expiry)` : null,
      ].filter(Boolean).join(' · '),
    }));
}

// ── The ONE board computation, with a WRITER-AUTHORITY flag ─────────────────────
// mutate:false (public op=daytrade) — READ-ONLY PROJECTION: classifies the pool against the
//   persisted lifecycle records but NEVER saves records, NEVER emits alerts, NEVER captures
//   snapshots/rejections, and never runs the inline discovery scan. A public GET cannot
//   advance state.
// mutate:true (privileged op=daytradeboardtick) — the ONE authorized lifecycle mutator:
//   advance + persist + alerts + capture + rejection log + shadow scoring, under a lease.
async function computeDaytradeBoard({ t0 = Date.now(), mutate = false, source = 'page' } = {}) {
  const live = await computeDaytradeLive(t0, 45000, { pace: true, expanded: true });
  if (!live) return { status: 502, payload: { ok: false, error: 'No market data' } };
  const paced = live.paceFrac < 1;   // mid-session: relVol prorated to a full-day basis
  const riskOff = live.regime === 'risk-off';
  // HONEST regime policy: the "momentum fails in risk-off" finding is from the MULTI-DAY
  // swing research; no Day-Trade-specific intraday evidence supports HARD suppression (the
  // forward book's worst regime was risk-ON). Regime stays visible context + a carry input;
  // lists are only emptied if the pre-registered evidence gate ever passes.
  const { REGIME: REGIME_POLICY } = require('../lib/daytrade-config');
  const suppress = riskOff && REGIME_POLICY.HARD_SUPPRESS === true;
  // WIDER net → more picks surfaced (the honest carry-odds ranking keeps quality, so we
  // don't need tight caps). A-tier (strict) sorts ahead of B-tier (building).
  const ml = live.scan1.slice(0, 80);
  const es = live.scan2.slice(0, 60);
  const runs = (live.scan3 || []).slice(0, 60);
  const exp = (live.scan4 || []).slice(0, 40);   // 🌐 expanded lane (not in the tracked ledger)
  // Relative 0-100 strength score across ALL of today's picks ("vs the bunch").
  assignRelScores([ml, es, runs]);
  // Score the expanded lane on its OWN scale so it never shifts the validated pools' numbers.
  assignRelScores([exp]);
  // 🔮 pcarry — PRICE-FEATURES-ONLY at this point (no network): the ~100 per-ticker news
  // fetches that used to run HERE (before live validation, consuming its time budget) are
  // deferred to the bounded post-validation catalyst enrichment of the displayed few.
  attachCarryPriceOnly([exp, ml, es, runs], live.regime);
  // The experimental config selects the TOP HALF of Momentum & Liquid by rank score
  // (the only sub-scan that tested OOS-positive); flag those as preferred.
  const sorted = ml.map(p => p.score).sort((a, b) => a - b);
  const medScore = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  ml.forEach(p => { p.preferred = p.tier === 'A' && p.score >= medScore; });

  // ── BROAD INTRADAY DISCOVERY MERGE (lib/intraday-discovery) ──────────────────
  // Stage-A anomalies (full-universe CUSUM change detection, refreshed by op=discover) join
  // the candidate pool so a name absent from every daily shortlist can still be found,
  // validated and lifecycle-tracked THE SAME WAY as scan candidates. When no fresh persisted
  // doc exists, ONE scan runs inline (time-budgeted) so the board consumes the freshest scan
  // in the SAME cycle instead of one refresh later. Absent/failed → no discovery lane this
  // cycle (honest, no fabrication).
  let discovery = null, discoveryRanInline = false;
  try {
    if (mutate) {
      // Inline scan budget is REMAINING-time-aware: the gate inside loadOrRunDiscovery needs
      // ≥9s of headroom before `deadline`, and Stage-2 below self-truncates against its own
      // deadline — so a slow scan pass honestly forfeits the inline fallback (there is no time
      // to conjure) rather than risking the function wall. The 5-min external scheduler
      // (op=daytradescan) is the PRIMARY freshness source; this fallback only covers scheduler
      // gaps, and those gaps are now visible in op=daytradescanhealth instead of silent.
      const dres = await require('../lib/intraday-discovery').loadOrRunDiscovery({ now: new Date(), t0, deadline: 47000 });
      discovery = dres.doc; discoveryRanInline = !!dres.ranInline;
    } else {
      // READ-ONLY: consume the persisted scan only — a public GET never writes scan state.
      discovery = await require('../lib/intraday-discovery').loadRecentDiscovery({ now: new Date() });
    }
  } catch { discovery = null; }
  const anomalies = (discovery && discovery.anomalies) ? discovery.anomalies : [];
  // MERGE, never discard: a discovery observation on a ticker ALREADY in a daily scan is
  // fresh evidence about that ticker — it annotates the existing pick (`p.discovery`) so
  // Stage-2 selection and models see the CUSUM/z/shock/freshness fields. The remainder
  // (genuinely new names) becomes the discovery candidate lane.
  const disc = require('../lib/intraday-discovery').mergeDiscoveryEvidence([...ml, ...es, ...runs, ...exp], anomalies);

  // ── LIVE ACTIONABILITY OVERLAY (lib/daytrade-actionability) ──────────────────
  // The daily-cache scan + discovery are Stage-1. Stage-2 revalidates the GLOBALLY-ranked
  // top of the MERGED pool (all families + expanded + discovery — no family can consume the
  // budget) with current 5-min bars AND a live quote. The day's PERSISTED lifecycle records
  // are authoritative: hysteresis, cooldowns, post-entry locks, retirement and revival
  // survive refreshes, and every state change is a reason-coded, alertable transition.
  const { runActionability } = require('../lib/daytrade-actionability');
  const { loadLifecycleDay, saveLifecycleDay, appendSnapshots, hasDurableStore } = require('../lib/lifecycle-store');
  const { etDate } = require('../lib/freshness');
  const nowIso = new Date().toISOString();
  const sessionDay = etDate(new Date());
  const priorDoc = await loadLifecycleDay('daytrade', sessionDay).catch(() => ({ records: {} }));
  const act = await runActionability([...ml, ...es, ...runs, ...exp, ...disc], {
    now: nowIso, sessionDate: live.spyLastDate, t0, deadline: 52000, doStage2: true,
    priorRecords: priorDoc.records || {},
  });

  // ── MUTATION BLOCK — only the authenticated board tick may advance durable state ──
  // Alerts (two classes, deduped, budgeted), alert-mark stamping, ONE lifecycle save,
  // budget-rejection log, immutable transition capture, shadow scoring + observation
  // accounting. The read-only projection computes the same classification but persists
  // NOTHING and emits NOTHING.
  let alertsOut = { emitted: 0, alerts: [] };
  let alertError = null;
  let persist = { persisted: false, reason: mutate ? null : 'read-only-projection' };
  if (mutate) {
    try {
      alertsOut = await require('../lib/daytrade-alerts').emitDaytradeAlerts(act.transitions, {
        date: sessionDay, now: nowIso, earlyTransitions: act.earlyTransitions || [], records: act.records,
      });
    } catch (e) { alertError = String((e && e.message) || e); /* alerting must never take down the board — but the tick's health surfaces it */ }

    // Stamp emitted alerts back onto the lifecycle records BEFORE persisting, so "already
    // alerted" is durable (retire-suppression, the Managing lane, and dedup across restarts
    // all key off it). Save happens ONCE, after alerting — if the save fails, the alert log's
    // own id dedup still prevents re-emission next cycle.
    try {
      const { withAlertMarks } = require('../lib/daytrade-alerts');
      for (const a of alertsOut.alerts || []) {
        if (act.records[a.ticker]) act.records[a.ticker] = withAlertMarks(act.records[a.ticker], [a]);
      }
    } catch { /* stamping is best-effort */ }
    persist = await saveLifecycleDay('daytrade', sessionDay, act.records);

    // Durable budget-rejection log — every Stage-2 rejection with ticker/lane/priority/reason
    // and the candidate that occupied the marginal slot, so recall misses caused by budget can
    // be MEASURED (not inferred) by the capture/retrospective pipeline.
    try {
      if (act.selection && (act.selection.rejected || []).length) {
        const { appendStage2Rejections } = require('../lib/lifecycle-store');
        await appendStage2Rejections('daytrade', sessionDay, {
          at: nowIso, budget: act.selection.budget, laneCounts: act.selection.laneCounts,
          staleDecayed: act.selection.staleDecayed ?? null,
          rejected: act.selection.rejected.slice(0, 60),
        });
      }
    } catch { /* rejection log is research capture, never board-blocking */ }

    // Immutable capture: snapshot every reason-coded TRANSITION (bounded — the 30s cadence
    // would bloat an every-row capture; first-ACTIONABLE / first-retirement grading only
    // needs the change points). Grades live in a separate doc (op=lifecyclegrade).
    try {
      const { buildSnapshot } = require('../lib/lifecycle-capture');
      const laneOrder = new Map();
      [...act.lanes.actionableNow, ...act.lanes.reversalReclaim, ...act.lanes.armed, ...act.lanes.buildingWatch, ...act.lanes.tooExtended].forEach((c, i) => laneOrder.set(c.ticker, i));
      // SHADOW MODEL SCORING — BATCH: the champion/challenger artifact is loaded ONCE per
      // tick (never once per ticker) and applied to every transition's feature vector.
      // Outputs never touch ranking or display; the uncalibrated basis string travels with
      // each. Observed episodes are counted into the prospective shadow window.
      const shadowByTicker = {};
      try {
        const { scoreShadowBatch, recordShadowObservations } = require('../lib/model-registry');
        const scorable = act.transitions.slice(0, 12)
          .map(tr => ({ tr, x: act.byTicker[tr.ticker] }))
          .filter(({ x }) => x && x.ev && x.ev.metrics);
        const scores = scorable.length ? await scoreShadowBatch(scorable.map(({ x }) => x.ev.metrics)).catch(() => null) : null;
        if (scores) {
          scorable.forEach(({ tr }, i) => { if (scores[i]) shadowByTicker[tr.ticker] = scores[i]; });
          const observed = Object.keys(shadowByTicker).length;
          if (observed) await recordShadowObservations({ date: sessionDay, episodes: observed }).catch(() => null);
        }
      } catch { /* shadow scoring is research capture, never board-blocking */ }
      const snaps = act.transitions.map(tr => {
        const x = act.byTicker[tr.ticker];
        return x ? buildSnapshot({
          record: x.record,
          ev: {
            session: act.session, ...x.ev,
            runnerScore: x.card.runnerScore, dudScore: x.card.dudScore,
            scoreBasis: x.card.scoreBasis, scoreVersion: x.card.scoreVersion,
            shadowModel: shadowByTicker[tr.ticker] || null,
          },
          pick: x.pick,
          displayed: laneOrder.has(tr.ticker), displayPosition: laneOrder.has(tr.ticker) ? laneOrder.get(tr.ticker) : null,
          at: nowIso,
        }) : null;
      }).filter(Boolean);
      if (snaps.length) await appendSnapshots('daytrade', sessionDay, snaps);
    } catch { /* capture is best-effort; the lifecycle map is already persisted */ }
  }

  // POST-VALIDATION catalyst enrichment — news for the displayed actionable few ONLY
  // (bounded, deadline-aware, timestamped), then the affected cards refresh their carry/
  // catalyst context in place. News can no longer consume the validation budget.
  try {
    const actionTickers = new Set([...act.lanes.actionableNow, ...act.lanes.reversalReclaim].map(c => c.ticker));
    const targetPicks = [...ml, ...es, ...runs, ...exp, ...disc].filter(p => actionTickers.has(p.ticker));
    const enriched = await enrichCatalystCarry(targetPicks, live.regime, { t0, deadline: 54000, cap: 12 });
    for (const t of enriched) {
      const x = act.byTicker[t];
      const src = targetPicks.find(p => p.ticker === t);
      if (x && x.card && src) {
        x.card.carry = src.carry; x.card.overextended = src.overextended; x.card.nearHigh = src.nearHigh;
        x.card.carryDrivers = src.carryDrivers; x.card.catalyst = src.catalyst;
        x.card.catalystBasis = src.catalystBasis; x.card.catalystAsOf = src.catalystAsOf;
      }
    }
  } catch { /* catalyst context is display enrichment, never board-blocking */ }
  sanitizeCarryInternals([ml, es, runs, exp, disc]);

  // Re-project each displayed pool through its canonical (lifecycle-enriched) card so every
  // section — INCLUDING the expanded lane — carries lifecycleState / actionability /
  // freshness timestamps / thesis validity. No row ships without the envelope.
  const enrich = arr => arr.map(p => (act.byTicker[p.ticker] && act.byTicker[p.ticker].card) || p);
  const mlC = enrich(ml), esC = enrich(es), runsC = enrich(runs), expC = enrich(exp), discC = enrich(disc);

  // Day's best opportunities = the ACTIONABLE-NOW lane, quality-gated (fade avoidance) and
  // ranked by carry. Empty when nothing is live-actionable — an honest empty state, never a
  // backfill of stale prior-session names.
  const bestOpportunities = suppress ? [] : buildBestOpportunities(act.lanes.actionableNow);
  // Point-in-time freshness rollup across the displayed pools (each pick also carries its
  // own `freshness` object). staleCandidates = names whose newest bar is a PRIOR session —
  // surfaced (not hidden) so a stale bar can never quietly rank as a live event.
  const _shown = [...mlC, ...esC, ...runsC, ...expC];
  const staleCandidates = _shown.filter(p => p && p.barIsToday === false).length;
  // Active contract versions — every live response reports what produced it.
  const modelVersions = await (async () => {
    let champion = null;
    try {
      const c = await require('../lib/model-registry').getChampion();
      champion = c.artifact ? { version: c.version, mode: c.mode } : { version: null, kind: c.kind };
    } catch { champion = null; }
    return {
      policyVersion: require('../lib/daytrade-decision-policy').POLICY_VERSION,
      costModelVersion: require('../lib/intraday-costs').COST_MODEL_VERSION,
      gateVersion: GATE.VERSION,
      featureSchemaVersion: require('../lib/intraday-schema').FEATURE_SCHEMA_VERSION,
      champion,
      calibrator: null,   // no calibrated display model exists — probabilities are never shown
    };
  })();
  const payload = {
    ok: true, regime: live.regime, condition: live.condition, riskOff, horizon: DAYTRADE_H,
    strategyVersion: 'daytrade-early-runner-v2',
    // WRITER AUTHORITY: read-only projections cannot advance state or emit alerts; the
    // authenticated board tick is the one mutator.
    authority: mutate ? 'board-tick' : 'read-only-projection',
    readOnly: !mutate,
    modelVersions,
    // Honest regime policy: context + model input, NOT a validated intraday hard gate.
    regimePolicy: { hardSuppress: REGIME_POLICY.HARD_SUPPRESS, evidenceGate: REGIME_POLICY.EVIDENCE_GATE, note: REGIME_POLICY.NOTE, suppressedNow: suppress },
    // Session-aware, point-in-time freshness envelope. `session` tells the client whether
    // ANYTHING can be actionable right now; the *AsOf fields are the explicit provenance the
    // spec requires so a live quote is never shown beside a stale recommendation.
    session: act.session,
    dataFreshness: {
      sessionDate: live.spyLastDate, shown: _shown.length, staleCandidates,
      candidateAsOf: live.spyLastDate, validatedAt: act.generatedAt, generatedAt: new Date().toISOString(),
      liveValidated: act.liveValidated, liveValidationSkipped: act.liveValidationSkipped, degraded: act.degraded,
      deepPool: act.deepPool,
    },
    // Durable lifecycle authority + this cycle's transitions/alerts (dedup'd server-side).
    lifecycle: {
      durable: hasDurableStore(), persisted: !!persist.persisted, persistNote: persist.reason || null,
      tracked: Object.keys(act.records).length, transitions: act.transitions.length, alertsEmitted: alertsOut.emitted || 0,
      alertsSuppressed: alertsOut.suppressed ?? null, alertError,
      fetchDiagnostics: act.fetchDiagnostics || null, microProvider: act.microProvider ?? null,
    },
    // 🛰 Stage-A broad discovery (full-universe change detection) — WATCH candidates only,
    // validated through the same canonical pipeline. Null when no recent scan exists.
    discovery: discovery ? {
      generatedAt: discovery.generatedAt, coverage: discovery.coverage, universe: discovery.universe,
      session: discovery.session || null, ranInline: discoveryRanInline,
      mergedIntoScans: [...ml, ...es, ...runs, ...exp].filter(p => p.discovery).length,
      anomalies: discC,
    } : null,
    // Stage-2 selection diagnostics: which candidates got deep validation, via which lane
    // (management/revalidation/discovery reserve vs global rank), and who was budget-rejected.
    stage2Selection: act.selection || null,
    // ⭐ The ACTIONABLE-NOW lane — the ONLY buy-language section. Ranked, fade-avoidance-gated,
    // and every card current-session-validated. Empty when nothing is live-actionable.
    bestOpportunities,
    // Lifecycle lanes (clearly separated sections). Only bestOpportunities/reversalReclaim
    // carry buy language; the rest are watch/retired/prior-session context.
    lanes: {
      actionableNow: act.lanes.actionableNow,
      reversalReclaim: act.lanes.reversalReclaim,
      armed: act.lanes.armed,
      buildingWatch: act.lanes.buildingWatch,
      tooExtended: act.lanes.tooExtended,
      retiredToday: act.lanes.retiredToday,
      priorSessionWatch: act.lanes.priorSessionWatch,
      managing: act.lanes.managing,
      closed: act.lanes.closed,
    },
    laneCounts: act.counts,
    momentumLiquid: suppress ? [] : mlC,
    explosiveSmall: suppress ? [] : esC,
    // Multi-day momentum runs (FCEL-style) — an identification/watchlist of names ALREADY
    // moving, not a trade signal.
    momentumRun: runsC,
    // 🌐 Expanded-universe momentum lane — same gate, full free universe, NEW names only.
    // Now carries the SAME canonical lifecycle envelope (no unvalidated actionability);
    // still NOT in the validated ledger or the counts below.
    momentumExpanded: suppress ? [] : expC,
    counts: { momentumLiquid: live.scan1.length, momentumLiquidA: live.scan1.filter(p => p.tier === 'A').length, explosiveSmall: live.scan2.length, momentumRun: (live.scan3 || []).length, momentumExpanded: (live.scan4 || []).length, discovery: disc.length },
    // Intraday volume pacing — when the session is mid-flight, relVol is PROJECTED to a
    // full day (raw partial volume ÷ fraction of session elapsed) so the scans populate.
    paced, paceFraction: +live.paceFrac.toFixed(2),
    pacingNote: paced
      ? `Mid-session: relative volume is PROJECTED to a full day (only ${(live.paceFrac * 100).toFixed(0)}% of the session has elapsed). Volume-based picks are provisional and firm up as the day completes.`
      : null,
    ranking: {
      relScore: '0–100 relative strength vs the rest of today\'s picks (z-blend of relative volume, % move, and move vs SPY). Descriptive, not a predicted return.',
      carry: '🔮 pcarry = HONEST calibrated odds (%) that the name keeps carrying momentum over ~3 sessions, from price overextension + news catalyst + market regime + the scan\'s own base rate. THE HONEST TRUTH (research/33, survivorship-corrected 26k candidate-days): tradeable next-open continuation is ~coin-flip (OOS AUC 0.47–0.50) — the strongly-predictable part (AUC 0.70) lives in the un-tradeable overnight leg. So carry odds sit ~40–60% and mainly flag FADE RISK (overextended blow-offs, dilution/M&A pops, risk-off tape) to help you AVOID traps, not guarantee winners.',
      bestBasis: 'Best Opportunities admission is INTRADAY-validated (lifecycle actionable + current-session fresh + valid thesis + a live plan + execution checks) — best-gate-v2. The 3-session carry odds and overextension only shape the RANKING (overextended names sort down, unknown carry ranks at the base rate); a multi-day model can no longer suppress a valid intraday setup. Dilution/M&A fade catalysts remain excluded.',
    },
    // Evidence-based-but-UNPROVEN upgrade from the intraday research (research/intraday).
    config: {
      name: 'Opening-range-breakout stacked',
      status: 'experimental',
      rules: [
        'Selection: top-half Momentum & Liquid by rank (explosive small-cap excluded — tested negative out-of-sample)',
        'Entry: opening-range breakout NEXT session (wait ~30 min, enter only on a break of the opening-range high) — do not buy the gap/close',
        'Exit: stop ~2.5×ATR, target 1:2, ~3-session time stop',
      ],
      caveat: 'Tested out-of-sample positive (+1.56%/trade, 3 of 4 years) but FAILED formal overfitting control — deflated Sharpe 0.59 (<0.95) and walk-forward selection did not survive. Treat as a disciplined paper-trading config to confirm forward, NOT a proven edge.',
    },
    learnerUpdatedAt: live.state.updatedAt, generatedAt: new Date().toISOString(),
  };
  return {
    status: 200,
    payload,
    tick: {
      sessionDay, session: act.session, source,
      candidatesAttempted: (act.deepPool || []).length, candidatesValidated: act.liveValidated,
      transitions: act.transitions.length,
      alertsEmitted: alertsOut.emitted || 0, alertsSuppressed: alertsOut.suppressed ?? null, alertError,
      persisted: !!persist.persisted, persistNote: persist.reason || null,
      fetchDiagnostics: act.fetchDiagnostics || null,
      degraded: act.degraded === true,
    },
  };
}

// op=daytrade — PUBLIC READ-ONLY board projection. Cannot advance lifecycle state, cannot
// emit alerts, cannot write scan state — the authenticated op=daytradeboardtick is the one
// mutator (Phase-10C writer authority).
async function runDaytrade(req, res) {
  const out = await computeDaytradeBoard({ t0: Date.now(), mutate: false, source: 'page' });
  // Actionable state is time-sensitive — a 15-min CDN cache + 1-day stale-while-revalidate
  // would serve a "buy now" that already failed. Keep it near-live (≈ the client's 30s price
  // cadence); NO long stale-while-revalidate on actionable results.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');
  return res.status(out.status).json(out.payload);
}

// op=daytradeboardtick — the ONE authorized lifecycle mutator (PRIVILEGED — bearer
// CRON_SECRET via api/tracker). Lease-guarded so overlapping schedulers cannot double-write;
// writes a per-tick health record; FAILS VISIBLY (non-200) when lifecycle persistence or
// alert emission fails while a durable store is configured.
const BOARD_TICK_LEASE_KEY = 'lifecycle/daytrade/board-tick-lease.json';
const BOARD_TICK_HEALTH_KEY = 'lifecycle/daytrade/boardtick-health.json';
const BOARD_TICK_LEASE_MS = 55 * 1000;

async function runDaytradeBoardTick(req, res) {
  const t0 = Date.now();
  const nowIso = new Date().toISOString();
  const { readJSON: rj, writeJSON: wj, hasStore: hs } = require('../lib/store');
  // Lease: a tick inside another tick's window yields (the CDN cannot coalesce an
  // authenticated POST-style op, so the lease is the overlap guard).
  if (hs()) {
    try {
      const lease = await rj(BOARD_TICK_LEASE_KEY, null);
      if (lease && lease.at && Date.now() - Date.parse(lease.at) < BOARD_TICK_LEASE_MS) {
        return res.status(200).json({ ok: true, skipped: 'lease-held', leaseAt: lease.at });
      }
      await wj(BOARD_TICK_LEASE_KEY, { at: nowIso }, 0);
    } catch { /* lease is best-effort; the alert-id dedup bounds double-emission */ }
  }
  let out;
  try {
    out = await computeDaytradeBoard({ t0, mutate: true, source: req.query.source || 'scheduler' });
  } catch (e) {
    out = { status: 500, payload: { ok: false, error: String((e && e.message) || e) }, tick: null };
  }
  const tick = out.tick || {};
  // Health contract: persistence or alert failure while durable storage exists = a FAILED
  // tick (visible to the scheduler), even though the payload may still describe the board.
  const failed = out.status !== 200
    || (hs() && tick.persisted !== true)
    || tick.alertError != null;
  const health = {
    lastAttemptAt: nowIso,
    lastSuccessAt: failed ? undefined : nowIso,
    lastError: failed ? (tick.alertError || tick.persistNote || (out.payload && out.payload.error) || 'persist-failed') : null,
    lastDurationMs: Date.now() - t0,
    source: tick.source || 'scheduler',
    session: tick.session || null,
    candidatesAttempted: tick.candidatesAttempted ?? null,
    candidatesValidated: tick.candidatesValidated ?? null,
    transitions: tick.transitions ?? null,
    alertsEmitted: tick.alertsEmitted ?? null,
    alertsSuppressed: tick.alertsSuppressed ?? null,
    persisted: tick.persisted ?? null,
    fetchDiagnostics: tick.fetchDiagnostics || null,
    degraded: tick.degraded ?? null,
    expectedNextAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  if (hs()) {
    try {
      const prior = await rj(BOARD_TICK_HEALTH_KEY, {});
      await wj(BOARD_TICK_HEALTH_KEY, {
        ...prior, ...health,
        lastSuccessAt: health.lastSuccessAt || prior.lastSuccessAt || null,
        consecutiveErrors: failed ? ((prior.consecutiveErrors || 0) + 1) : 0,
      }, 0);
    } catch { /* health writing is best-effort */ }
  }
  return res.status(failed ? 500 : 200).json({
    ok: !failed,
    tick: health,
    board: { transitions: tick.transitions, alertsEmitted: tick.alertsEmitted, persisted: tick.persisted },
    ...(failed ? { error: health.lastError } : {}),
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
        // Feed the per-stock fade-engine learner from the single-day momentum/explosive
        // setups only. Multi-day RUN picks resolve (for the book's byRunTier A-vs-B split)
        // but are a different setup — keep them out of the learner that nudges those scans.
        if (p.scan !== 'momentum_run') outcomes.push({ ticker: p.ticker, alpha: p.excPct, sector: p.sector || SECTOR_OF[p.ticker] || '?' });
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
      // Log strict A-tier momentum_liquid (the historical tracked set) PLUS the relaxed
      // B-tier ("building") momentum_liquid, each STAMPED with its tier so the book can
      // compare B vs A forward returns. B is kept OUT of the legacy A-tier aggregates in
      // runDaytradeBook (isB filter) so history stays comparable. Explosive small-cap as before.
      const picks = [
        ...live.scan1.filter(p => p.tier === 'A').slice(0, 15),
        ...live.scan1.filter(p => p.tier === 'B').slice(0, 15),
        ...live.scan2.filter(p => p.tier === 'A').slice(0, 15),   // strict explosive only; relaxed B is display-only
        // Multi-day RUN picks, strict A + relaxed B, each stamped so the book can compare
        // B-vs-A run forward returns. Runs are a NEW tracked scan (no history) and are kept
        // out of the legacy overall/byScan/byRegime aggregates in runDaytradeBook.
        ...(live.scan3 || []).filter(p => p.tier === 'A').slice(0, 15),
        ...(live.scan3 || []).filter(p => p.tier === 'B').slice(0, 15),
      ].map(c => {
        // Fade-avoidance gate membership, stamped at log time (pure, no extra network) so
        // op=daytradebook can compare the gated subset's forward excess vs the rest.
        const g = stampGate(c, live.regime);
        return { ticker: c.ticker, scan: c.scan, tier: c.tier || 'A', date: logDate, entry: c.last, score: c.score, sector: c.sector, carry: g.carry, gated: g.gated, resolved: false };
      });
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
  // A relaxed B-tier momentum_liquid pick (tagged tier:'B'). Historical picks predate
  // the tier stamp → undefined tier → treated as A so the legacy record is unchanged.
  const isB = p => p.scan === 'momentum_liquid' && p.tier === 'B';
  const isRun = p => p.scan === 'momentum_run';              // NEW tracked scan — never in legacy history
  const legacy = picks.filter(p => !isB(p) && !isRun(p));    // A-tier momentum + explosive (comparable to history)
  const ml = picks.filter(p => p.scan === 'momentum_liquid');
  const runs = picks.filter(isRun);
  // FADE-AVOIDANCE GATE forward test. Picks logged AFTER the gate deploy carry a boolean
  // `gated` flag (undefined on older picks → excluded here so the comparison is clean). The
  // headline: does the gate-passing subset actually beat the rest on forward 3-session excess?
  const gateFlagged = picks.filter(p => typeof p.gated === 'boolean');
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length,
    stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(legacy),
    byScan: { momentum_liquid: agg(ml.filter(p => !isB(p))), explosive_small: agg(picks.filter(p => p.scan === 'explosive_small')), momentum_run: agg(runs) },
    // The requested A-vs-B comparisons: same scan + universe, only the entry gate differs.
    byTier: { A: agg(ml.filter(p => !isB(p))), B: agg(ml.filter(isB)) },
    byRunTier: { A: agg(runs.filter(p => p.tier === 'A')), B: agg(runs.filter(p => p.tier !== 'A')) },
    byRegime: { 'risk-on': agg(legacy.filter(p => p.regime === 'risk-on')), neutral: agg(legacy.filter(p => p.regime === 'neutral')), 'risk-off': agg(legacy.filter(p => p.regime === 'risk-off')) },
    // Does the fade-avoidance gate pick the better subset? gated = passed the gate at log time.
    byGate: { gated: agg(gateFlagged.filter(p => p.gated)), ungated: agg(gateFlagged.filter(p => !p.gated)) },
    note: `Live forward (${DAYTRADE_H}-session) excess-vs-SPY record of logged day-trade picks. overall/byScan/byRegime = A-tier momentum + explosive (comparable to history); byTier compares strict A vs relaxed B momentum_liquid; byRunTier compares strict A vs relaxed B multi-day RUN picks. byGate = the fade-avoidance quality gate test (gated vs ungated forward excess; only picks logged after the gate deploy carry the flag; catalyst-neutral so it omits the live gate's dilution/M&A news exclusion). Accrues via the warm cron; all splits are thin until ~${DAYTRADE_H} sessions after the first tick post-deploy.`,
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
const CONFLUENCE_MIN_BULL = 3;        // SCAN/LOG bar: keep ≥3/5 so the ledger keeps
                                      // accumulating a track record across the FULL universe.
const CONFLUENCE_DISPLAY_BULL = 4;    // LIVE SCREENER shows only STRONG agreement (4★/5★) —
                                      // the validation harness found any edge only appears at 4/5.
const CONFLUENCE_MIN_FAMILIES = 2;    // A "Confluence" LABEL requires ≥2 INDEPENDENT evidence
                                      // families (family-v1): 4 correlated trend votes are ONE
                                      // confirmation dressed up, not confluence. Single-family
                                      // names keep accruing in the ledger (with singleFamily
                                      // flagged) but can no longer qualify for display.

// Rotate a universe list by a per-day offset so that if a scan is ever cut short
// (cold candle cache → slow Yahoo fallback hitting the deadline), the truncation
// doesn't permanently favor the alphabetically-first names (the "only A/B in the
// logs" bug). When the cache is warm the whole list is scanned and order is moot.
function rotateByDay(arr) {
  const n = arr.length; if (n < 2) return arr;
  const day = Math.floor(Date.now() / 864e5);
  const off = (day * 97) % n;          // 97 is coprime-ish to typical sizes → good spread
  return arr.slice(off).concat(arr.slice(0, off));
}
const STRAT_K = 0.1;                  // (diagnostic only — see confluenceStratWeights)
const STRAT_DECAY = 0.95;             // EWMA decay for per-strategy edge (diagnostic)
const CONFLUENCE_STRAT_KEY = 'apex/confluence-strat.json';

// DEFECT #6 (confluence attribution). The per-strategy EWMA credits the FULL
// realized 21-session excess to EVERY strategy that voted bullish — with 4 of 5
// strategies in ONE correlated trend family that is quadruple-counted, non-marginal
// attribution, so the learned weights were never a per-strategy edge estimate.
//
// LIVE WEIGHTS ARE FROZEN AT EQUAL (1.0). The EWMA keeps accruing as a DIAGNOSTIC
// (stratEdgeSummary) but can no longer alter production ranking. Learned weights
// return only when BOTH hold:
//   • the strategy registry promotes 'confluence-marginal' to production
//     (a reviewable data change — never a wording/UI edit), AND
//   • a validated marginal-attribution artifact (lib/confluence-marginal.js,
//     purged walk-forward, family-level, baseline-beating) supplies the weights.
// Absent either, this fails closed to equal weights.
const CONFLUENCE_FROZEN_WEIGHT = 1;
function confluenceStratWeights(stratState, opts = {}) {
  const cf = require('../lib/confluence');
  const { isTradeEligible } = require('../lib/strategy-gate');
  const approved = isTradeEligible('confluence-marginal', opts.registry);
  const art = opts.marginalArtifact;
  const validArtifact = !!(approved && art && art.version && art.weights && art.verdict === 'PASS');
  const w = {};
  for (const s of cf.STRATEGIES) {
    w[s] = validArtifact && Number.isFinite(art.weights[s])
      ? +Math.max(0.3, Math.min(2, art.weights[s])).toFixed(2)
      : CONFLUENCE_FROZEN_WEIGHT;
  }
  return w;
}
function stratEdgeSummary(stratState) {
  const cf = require('../lib/confluence');
  return cf.STRATEGIES.map(s => ({ strategy: s, ewmaExc: stratState[s] ? +stratState[s].ewma.toFixed(2) : 0, n: stratState[s] ? stratState[s].n : 0 }));
}

// Learned-posterior rank influence (non-daytrade backlog 2026-08). The per-ticker
// posterior (lib/fade-engine) is learned from close-to-close PROXY grading — no fills,
// no stops, no costs — yet its expAlpha carried a promote-direction weight in live
// ranks, and the Confluence tick ledgers the top slice of that boosted sort (the
// learner shaping its own training data). Its one registry-validated use is as an
// AVOID filter, so influence is fail-closed AVOID-ONLY: drifted names still sink or
// drop, but the boost term is weight-0 until BOTH the registry promotes
// 'posterior-rank' AND the caller supplies a version-matched PASS artifact.
// Mirrors confluenceStratWeights (no caller passes an artifact until one is earned).
const POSTERIOR_BOOST_WEIGHT = 8;
function posteriorRankWeight(opts = {}) {
  const { isTradeEligible } = require('../lib/strategy-gate');
  const art = opts.artifact;
  const approved = isTradeEligible('posterior-rank', opts.registry);
  return approved && !!(art && art.version && art.verdict === 'PASS') ? POSTERIOR_BOOST_WEIGHT : 0;
}
const POSTERIOR_POLICY_NOTE = 'avoid-only (fail-closed): the per-ticker learned posterior is graded close-to-close (proxy, no fills or costs), so it may sink/drop drifted names but cannot boost or reorder a live rank until a validated incremental-lift artifact is registry-promoted (posterior-rank). learnedExcess/confidence are annotation, not rank inputs.';

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
        // family-v1: independent-evidence ranking key + how many INDEPENDENT families
        // agree, and a flag for single-factor "confluence" (e.g. all-trend agreement).
        indepScore: r.indepScore, maxIndepScore: r.maxIndepScore, familyBull: r.familyBull,
        familyBullCount: r.familyBullCount, singleFamily: r.singleFamily,
        perStrategy: r.perStrategy, freshTriggers: r.freshTriggers, excess21d: exc,
        beta: ctx.fe.betaVsSpy(candles, ctx.spyByDate),
        entry: lv ? lv.entry : last, stop: lv ? lv.stop : null, target: lv ? lv.target : null,
        rr: lv ? lv.rr : null, riskPct: lv ? lv.riskPct : null, pullback: lv ? lv.pullback : null,
        learnedExcess: p.expAlpha, confidence: p.pPos, nPriors: p.n,
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  // Rank by the independent-evidence score (family-v1), not raw agreement — a name with
  // trend + mean-reversion confirmation outranks one with more correlated trend votes.
  // The learned-posterior boost is gated (posteriorRankWeight, weight-0 while shadow):
  // this sort also decides the tick's ledger slice, so an unvalidated boost here would
  // let the learner pick its own training data.
  const wPost = ctx.wPost || 0;
  out.sort((a, b) => (b.indepScore + wPost * b.learnedExcess) - (a.indepScore + wPost * a.learnedExcess));
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
  const wPost = posteriorRankWeight();
  const ctx = { spyByDate, t0, deadline, fe, state, weights, condition, minBull: CONFLUENCE_MIN_BULL, wPost };
  const large = await scanConfluenceUniverse(rotateByDay([...new Set(UNI_LARGE)]), { ...ctx, caches: [cL] });
  const small = await scanConfluenceUniverse(rotateByDay([...new Set([...UNI_SMALL, ...UNI_MICRO])]), { ...ctx, caches: [cS, cM] });
  return { regime, condition, large, small, state, stratState, weights, wPost, spyLastDate: spyD.candles[spyD.candles.length - 1].date };
}

// op=confluence — live screener (regime-gated display).
async function runConfluence(req, res) {
  const t0 = Date.now();
  const live = await computeConfluenceLive(t0, 45000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const riskOff = live.regime === 'risk-off';
  // Live screener prefers STRONG (4★/5★) agreement; the ledger logs ≥3★.
  const wPost = live.wPost || 0;
  const ranked = [...live.large, ...live.small]
    .sort((a, b) => (b.indepScore + wPost * b.learnedExcess) - (a.indepScore + wPost * a.learnedExcess));
  // Family admission (non-daytrade redesign 2026-08): raw 3-of-5 / 4-of-5 votes cannot
  // qualify when every vote is one price-trend family — the label requires independent
  // evidence. Applies to BOTH the strong bar and the relaxed fallback.
  const multiFamily = p => (p.familyBullCount ?? 0) >= CONFLUENCE_MIN_FAMILIES;
  const strong = ranked.filter(p => p.bullishCount >= CONFLUENCE_DISPLAY_BULL && multiFamily(p));
  // Never leave the tab empty on a calm day: if nothing clears the strong 4/5
  // bar, fall back to the ≥3/5 names the ledger already tracks, flagged moderate —
  // still requiring independent families (an honest empty list beats a fake one).
  const relaxed = strong.length === 0;
  const picks = (relaxed ? ranked.filter(p => p.bullishCount >= CONFLUENCE_MIN_BULL && multiFamily(p)) : strong).slice(0, 25);
  const effectiveBull = relaxed ? CONFLUENCE_MIN_BULL : CONFLUENCE_DISPLAY_BULL;
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, regime: live.regime, condition: live.condition, favor: require('../lib/confluence').COND_FAVOR,
    riskOff, horizon: CONFLUENCE_H, minBull: effectiveBull, minFamilies: CONFLUENCE_MIN_FAMILIES, relaxed,
    weights: live.weights,
    weightsPolicy: 'frozen-equal — per-strategy EWMA attribution is non-marginal (full credit to every correlated voter), so learned weights are disabled until a validated marginal artifact is registry-promoted (confluence-marginal)',
    posteriorPolicy: POSTERIOR_POLICY_NOTE,
    strategyEdge: stratEdgeSummary(live.stratState),
    strategyEdgeNote: 'DIAGNOSTIC ONLY — EWMA of full-credit (non-marginal) attribution; does not alter ranking.',
    // Defect #7 — explicit semantics for every number this tab shows.
    scoreSemantics: {
      score: 'weighted vote sum (0..maxScore) — ranking only, never a probability',
      indepScore: 'correlation-discounted independent-evidence rank — ranking only',
      confidence: "per-stock fade-engine posterior P(excess>0) built from that name's own BACKTESTED history — a model estimate, not a live calibrated probability",
      probability: null,
      calibrationStatus: 'uncalibrated',
      displayWhenNull: require('./rank-semantics').PROBABILITY_UNAVAILABLE_TEXT,
    },
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
        // per-STRATEGY EWMA — DIAGNOSTIC ONLY (defect #6). This attribution hands the
        // full realized excess to every bullish voter (4/5 strategies are one correlated
        // trend family → quadruple-counted credit), so it is NOT marginal attribution.
        // It keeps accruing for the diagnostics panel, but confluenceStratWeights no
        // longer reads it: live weights are frozen equal until the registry promotes a
        // validated marginal artifact (lib/confluence-marginal.js).
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
    // Use a larger deadline (vs 40s) so the resolve phase above doesn't starve the
    // scan — a starved scan only covers the alphabetically-first names (the "only
    // A/B" bug). Stays within the ~60s function budget (resolve is capped ~15s).
    const live = await computeConfluenceLive(t0, 55000);
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

// op=confluencemarginal — SHADOW marginal-attribution report (defect #6). Reads the
// resolved confluence ledger and runs the family-level, date-level, purged
// walk-forward marginal learner against equal-weight / vote-count / placebo
// baselines on identical paired dates. Weight-0: this report is evidence for a
// human registry decision — it never touches live weights or ranking.
async function runConfluenceMarginal(req, res) {
  const CM = require('../lib/confluence-marginal');
  const days = await readAllConfluenceDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push(p); }));
  const report = CM.marginalReport(picks);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, ...report,
    liveWeightsPolicy: 'frozen-equal until strategy-registry promotes confluence-marginal AND a PASS artifact exists (confluenceStratWeights fails closed)',
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

// ── 🧬 COIL RADAR — pre-explosion detector ──────────────────────────────────
// Flags QUIET, COILED names (volatility contracted, volume dried up, tight base)
// before an ABNORMAL upside break — deliberately NOT momentum/already-running names.
// Each pick carries a calibrated, empirically-measured break probability (see lib/coil.js).
function coilReasons(f) {
  const r = [];
  // Lead with the two scored "vs its own history" drivers (the backtest winner).
  if (f.bbPctile != null && f.bbPctile <= 0.15) r.push(`Bollinger squeeze — tightest band width in ${Math.round((1 - f.bbPctile) * 126)}+ of the last 126 sessions (${(f.bbPctile * 100).toFixed(0)}th pctile)`);
  if (f.hvPctile != null && f.hvPctile <= 0.20) r.push(`Realized volatility in only the ${(f.hvPctile * 100).toFixed(0)}th percentile of its past year — compressed vs its own norm`);
  if (f.rangeTight != null && f.rangeTight <= 0.25) r.push(`Tight 20-day base (${(f.rangeTight * 100).toFixed(0)}% range)`);
  if (f.atrRatio != null && f.atrRatio <= 0.85) r.push(`10-day ATR only ${(f.atrRatio).toFixed(2)}× the 50-day — volatility contracting`);
  if (f.vdu != null && f.vdu <= 0.7) r.push(`Volume dried up (${(f.vdu).toFixed(2)}× the 50-day) — sellers exhausted`);
  if (f.obvSlope != null && f.obvSlope > 0.15) r.push(`Quiet accumulation (OBV rising under a flat price)`);
  if (f.ret20 != null && f.ret20 <= 0.03) r.push(`Not extended — flat/down ${(f.ret20 * 100).toFixed(0)}% over 20d (early, not chasing)`);
  return r.slice(0, 5);
}

// Shared scan: build the scope's cohort (from the candle cache, falling back to live
// fetch) and rank it by coil score. Reused by the live view AND the daily ledger tick.
async function scanCoilCohort(scopeQ, deadline = 40000) {
  const coil = require('./coil');
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const calScope = scopeQ === 'large' ? 'large' : 'small';   // micro/expanded share the small calibration
  const cacheDoc = await loadCandleCache(scopeQ).catch(() => null);
  // 'expanded' (the free full-market universe) has no hard-coded list — its tickers
  // ARE the keys of its candle cache. The cap-band lists drive the others.
  const list = scopeQ === 'expanded' ? Object.keys((cacheDoc && cacheDoc.data) || {})
    : scopeQ === 'micro' ? UNI_MICRO : scopeQ === 'small' ? UNI_SMALL : UNI_LARGE;
  const tickers = [...new Set(list)];
  const cohort = [];
  const t0 = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let candles = null, meta = null;
      if (cacheDoc) { const e = cacheGet(cacheDoc, t); if (e && e.candles) { candles = e.candles; meta = e.meta; } }
      if (!candles) { try { const d = await fetchDailyHistory(t); if (d) { candles = d.candles; meta = d.meta; } } catch {} }
      if (candles && candles.length >= 60) cohort.push({ ticker: t, candles, meta });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  // COHORT VINTAGE GATE. The coil score is a CROSS-SECTIONAL percentile: a name is
  // ranked against its peers. Scoring names whose newest bar is a different session
  // compares today's compression against last week's and calls the result one ranking.
  // The `expanded` cache is compiled by a manual, resumable scan (op=universescan →
  // op=universecompile) that no cron runs, so its entries age freely — live on
  // 2026-08-05 the merged cohort was 2,122 stale of 3,169, i.e. two thirds of every
  // coil percentile was computed against bars from other sessions.
  //
  // Fix: adjudicate ONE authoritative session (the modal newest-bar date) and rank only
  // the names that carry it. Excluded names are counted, never silently dropped.
  const vintage = cohortFreshness(cohort);
  const atSession = vintage.decisionSession
    ? cohort.filter(r => r.candles[r.candles.length - 1].date === vintage.decisionSession)
    : [];
  const excludedStale = cohort.length - atSession.length;
  return {
    calScope,
    cohortCount: cohort.length,
    rankedCount: atSession.length,
    decisionSession: vintage.decisionSession,
    excludedStale,
    ranked: coil.rankCoil(atSession, calScope),
  };
}

// Full-universe coil scan: rank each cap band with ITS OWN calibration (large has a
// different empirical break curve than small/micro), then merge by coil strength.
// Each name keeps its band-appropriate break probability. Cheap when caches are warm.
async function scanCoilFull() {
  const [lg, sm, mi, ex] = await Promise.all([
    scanCoilCohort('large'), scanCoilCohort('small'), scanCoilCohort('micro'), scanCoilCohort('expanded'),
  ]);
  return mergeCoilScopes([['large', lg], ['small', sm], ['micro', mi], ['expanded', ex]]);
}

// CROSS-SCOPE VINTAGE GATE (pure — `scopes` is [[name, scanResult], …]).
//
// Each scope adjudicates its own session; merging them blindly would re-introduce the
// mixed-vintage ranking one level up (the cap-band caches are rebuilt by the daily warm
// cron, the `expanded` cache is not). The merged board keeps only the scopes that agree
// with the NEWEST adjudicated session; the rest are reported with their own vintage so the
// lag is visible rather than blended away.
//
// Kept pure and exported ON PURPOSE: the first cut of this merge inlined the logic and
// silently dropped `ranked` from the returned object, which 500'd op=coil in production
// while a source-scan test passed. Shape belongs in a unit test, not in a regex.
function mergeCoilScopes(scopes) {
  const sessions = (scopes || []).map(([, r]) => r && r.decisionSession).filter(Boolean).sort();
  const decisionSession = sessions.length ? sessions[sessions.length - 1] : null;
  const admitted = (scopes || []).filter(([, r]) => r && r.decisionSession && r.decisionSession === decisionSession);
  const excludedScopes = (scopes || [])
    .filter(([, r]) => !r || !r.decisionSession || r.decisionSession !== decisionSession)
    .map(([name, r]) => ({ scope: name, decisionSession: (r && r.decisionSession) || null, names: (r && r.rankedCount) || 0, reason: (r && r.decisionSession) ? 'behind the newest adjudicated session' : 'no dated bars' }));

  // Dedupe (expanded overlaps the cap-band lists) — keep the first (cap-band) ranking.
  const seen = new Set(); const ranked = [];
  for (const r of admitted.flatMap(([, x]) => (x && x.ranked) || []).sort((a, b) => b.score - a.score)) {
    if (seen.has(r.ticker)) continue; seen.add(r.ticker); ranked.push(r);
  }
  return {
    ranked,
    cohortCount: (scopes || []).reduce((a, [, r]) => a + ((r && r.cohortCount) || 0), 0),
    rankedCount: ranked.length,
    decisionSession,
    excludedStale: (scopes || []).reduce((a, [, r]) => a + ((r && r.excludedStale) || 0), 0),
    excludedScopes,
    byScope: Object.fromEntries((scopes || []).map(([name, r]) => [name, { scanned: (r && r.cohortCount) || 0, atSession: (r && r.rankedCount) || 0, session: (r && r.decisionSession) || null }])),
  };
}

// 20-session average dollar volume through the newest bar. Null (never 0) when the
// history is too short — an unknown liquidity must stay unknown, because downstream the
// cost model treats unknown as the CONSERVATIVE tier while 0 would read as "no volume".
function avgDollarVol(candles, n = 20) {
  const c = candles || [];
  if (c.length < n) return null;
  let dv = 0;
  for (let k = c.length - n; k < c.length; k++) {
    const b = c[k];
    if (!(b.close > 0) || !(b.volume >= 0)) return null;
    dv += b.close * b.volume;
  }
  return Math.round(dv / n);
}

// The session a candle-cache cohort could actually observe: the MODAL newest-bar date
// across its rows (the max alone would let one stray row speak for the cohort). Returns
// the count at that session and how many rows are behind it, so partial coverage is
// visible instead of implied. Null when nothing carries a dated bar — which correctly
// leaves the source without a cutoff rather than inventing one.
function cohortFreshness(rows) {
  const tally = new Map();
  for (const r of rows || []) {
    const c = r && r.candles;
    const d = c && c.length ? c[c.length - 1].date : null;
    if (d) tally.set(d, (tally.get(d) || 0) + 1);
  }
  if (!tally.size) return { decisionSession: null, atSession: 0, behind: 0 };
  let decisionSession = null, atSession = -1;
  for (const [d, n] of tally) {
    // Most-common wins; ties break to the NEWER session.
    if (n > atSession || (n === atSession && d > decisionSession)) { decisionSession = d; atSession = n; }
  }
  let behind = 0;
  for (const [d, n] of tally) if (d < decisionSession) behind += n;
  return { decisionSession, atSession, behind };
}

// Map a ranked row → the API pick object (incl. breakout trade plan + rank score).
function buildCoilPick(r, scope = 'small') {
  const coil = require('./coil');
  const probPct = r.prob ? r.prob.pct : null;
  const plan = r.candles ? coil.coilTradePlan(r.candles, r.candles.length - 1, probPct) : null;
  // Canonical prediction — keeps the EMPIRICAL abnormal-excursion rate (extra) strictly
  // separate from the executable, cost-aware trade probabilities (uncalibrated model).
  const prediction = coil.coilPrediction({ prob: r.prob, plan, percentile: r.percentile, scope });
  const ex = plan ? plan.executable : null;
  return {
    ticker: r.ticker,
    company: (r.meta && (r.meta.shortName || r.meta.longName)) || null,
    sector: SECTOR_OF[r.ticker] || 'Other',
    price: r.feats.price,
    // LIQUIDITY PROVENANCE. The scan already holds the candles this is computed from, but
    // the pick published only `price` — so every downstream liquidity check (the
    // pre-ranking data gate's coverage rule, the cost tier, the sizing discipline) saw a
    // row with NO liquidity evidence and had to fail it closed. 20-session average dollar
    // volume through the pick's own last bar; null when the history is too short to say.
    dollarVol: avgDollarVol(r.candles, 20),
    lastBarDate: r.candles && r.candles.length ? r.candles[r.candles.length - 1].date : null,
    percentile: r.percentile,                          // a RANK, not a probability
    // Explicit score/probability semantics (defect #7): coilScore + percentile are
    // RANKING numbers; the only calibrated number here is the abnormal-EXCURSION
    // rate, whose exact outcome is named below — it is never a trade win rate.
    rankSemantics: require('./rank-semantics').describeRank({
      rankScore: +r.score.toFixed(2), rankPercentile: r.percentile,
      calibrationStatus: 'uncalibrated', evidenceClass: 'rankOnly',
    }),
    // ── The abnormal-EXCURSION rate: EMPIRICAL, calibrated — but NOT a trade win rate ──
    abnormalExpansionPct: probPct,                     // P(abnormal +excursion in ~10d) — the ONLY calibrated number
    abnormalExpansionOutcome: probPct != null ? `abnormal upside excursion (max gain ≥ σ-threshold) within the coil horizon — NOT a profitable-trade probability` : null,
    explodeProbPct: probPct,                           // back-compat alias (same empirical excursion rate)
    majorBreakPct: r.prob ? r.prob.pctMajor : null,
    lift: r.prob ? r.prob.lift : null,
    band: r.prob ? r.prob.band : null,
    decile: r.prob ? r.prob.decile : null,
    // ── The EXECUTABLE trade probabilities: cost-aware, UNCALIBRATED barrier model ──
    executable: ex ? {
      pTrigger: ex.pTrigger,                           // P(breakout trigger fills in-window)
      pTargetBeforeStopGivenFill: ex.pTargetBeforeStopGivenFill,
      pProfitableNetGivenFill: ex.pProfitableNetGivenFill,
      expectedNetR: ex.expectedNetR,                   // net of round-trip cost
      severeLossProbability: ex.severeLossProbability,
      calibrationStatus: ex.calibrationStatus,         // 'model-estimate' — do NOT read as validated
      uncertaintyInterval: ex.uncertaintyInterval,
    } : null,
    prediction,                                        // full canonical contract object
    coilScore: +r.score.toFixed(2),
    // Breakout trade plan (buy the break above the coil, not the quiet).
    entry: plan ? plan.entry : null,
    stop: plan ? plan.stop : null,
    target: plan ? plan.target : null,
    riskPct: plan ? plan.riskPct : null,
    rewardPct: plan ? plan.rewardPct : null,
    rr: plan ? plan.rr : null,
    // NOTE: picks are ranked by COIL STRENGTH (coilScore), the validated signal. An
    // Expected-R / R:R ranking was tested and REMOVED — it backtested INVERTED (tight
    // high-R:R stops get whipsawed → worst realized trades). See research/COIL-RADAR.md.
    metrics: {
      squeezePctile: r.feats.bbPctile != null ? +(r.feats.bbPctile * 100).toFixed(0) : null,   // scored: lower = tighter vs own history
      hvPctile: r.feats.hvPctile != null ? +(r.feats.hvPctile * 100).toFixed(0) : null,          // scored
      atrRatio: r.feats.atrRatio != null ? +r.feats.atrRatio.toFixed(2) : null,
      bbWidthPct: r.feats.bbWidth != null ? +(r.feats.bbWidth * 100).toFixed(0) : null,
      rangeTightPct: r.feats.rangeTight != null ? +(r.feats.rangeTight * 100).toFixed(0) : null,
      vdu: r.feats.vdu != null ? +r.feats.vdu.toFixed(2) : null,
      ret20Pct: r.feats.ret20 != null ? +(r.feats.ret20 * 100).toFixed(0) : null,
      aboveSma200: r.feats.aboveSma200,
    },
    reasons: coilReasons(r.feats),
  };
}

async function runCoil(req, res) {
  const coil = require('./coil');
  const scopeQ = (req.query.scope || 'all').toLowerCase();
  const limit = Math.max(5, Math.min(60, parseInt(req.query.limit, 10) || 25));
  const isFull = scopeQ === 'all';
  const scan = isFull ? { calScope: 'mixed', ...(await scanCoilFull()) } : await scanCoilCohort(scopeQ);
  const { calScope, cohortCount, ranked, decisionSession, rankedCount, excludedStale } = scan;
  // Rank by COIL STRENGTH (coilScore) — the signal validated to concentrate abnormal
  // breaks. rankCoil already returns strongest-coil-first, so just number them.
  const pickScope = calScope === 'mixed' ? 'small' : calScope;
  const picks = (ranked || []).slice(0, limit).map(r => buildCoilPick(r, pickScope)).map((p, i) => ({ rank: i + 1, ...p }));
  const cohort = { length: cohortCount };

  const cal = coil.CALIBRATION[calScope] || coil.CALIBRATION.small;
  // DECLARED INFORMATION CUTOFF (lib/data-gates). The session is now ADJUDICATED by the
  // scan — every ranked name carries that exact bar date — so the cutoff describes the
  // rows actually served, not the modal date of a mixed-vintage pile.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true, scope: scopeQ, namesScanned: cohort.length, horizonDays: coil.COIL_HORIZON,
    freshness: {
      decisionSession: decisionSession || null,
      // Names read but NOT ranked because their newest bar predates the adjudicated
      // session. A large number here means a cache is lagging, not that the market is
      // quiet — the `expanded` cache has no cron and is the usual cause.
      staleCandidates: excludedStale ?? 0,
      counts: { scanned: cohortCount, atDecisionSession: rankedCount ?? ranked.length },
      byScope: scan.byScope || null,
      excludedScopes: scan.excludedScopes || null,
      basis: 'one adjudicated session per cohort — a cross-sectional percentile may not mix bar vintages',
    },
    baseRatePct: cal.base25,
    picks,
    method: {
      what: 'Pre-explosion "coil" detector — quiet, volatility-contracted names BEFORE an abnormal upside break (not momentum/already-running names).',
      explosion: `An abnormal break = forward ${coil.COIL_HORIZON}-session max gain ≥ ${coil.COIL_SIGMA}× the name\'s own trailing daily volatility (a genuine regime break, not a big % a high-vol name hits by noise).`,
      probability: `explodeProbPct is the EMPIRICAL break rate of the matching coil-score decile from a ~2y point-in-time study — honest single-digit-to-low-teens odds, base rate ${cal.base25}%. Model = Bollinger-Squeeze-Rank (winner of an 11-variant out-of-sample bake-off). Top-decile coils break ~2× as often as the least-coiled, stable out-of-sample.`,
      ranking: 'Picks are ranked by COIL STRENGTH (the validated break-likelihood signal). An Expected-R / R:R ranking was tested and dropped — it backtested INVERTED (tight, high-R:R stops get whipsawed → worst realized trades).',
      caveat: 'Modest edge. Timing/direction of the eventual break is often driven by exogenous catalysts (news/earnings) this price-only model cannot see. Paper-track before sizing.',
    },
    // Event-driven backtest of the actual breakout trade plan (enter/stop/target),
    // point-in-time over ~2y, conservative stop-first fills. Honest, not curve-fit.
    systemBacktest: isFull
      ? { scope: 'all-cap', triggerRatePct: 49, winRatePct: 16, avgRPerEntered: 0.08, verdict: 'full-universe blend — each name carries its own cap-band break odds; treat as a watchlist, paper-trade first' }
      : scopeQ === 'large'
      ? { scope: 'large-cap', triggerRatePct: 51, winRatePct: 14, avgRPerEntered: 0.03, verdict: 'roughly break-even in R — treat as a watchlist, not a standalone system' }
      : { scope: 'small/micro-cap', triggerRatePct: 48, winRatePct: 17, avgRPerEntered: 0.12, verdict: 'modestly positive in R (a few ~3R winners carry a low win rate) — paper-trade first' },
    generatedAt: new Date().toISOString(),
  });
}

// op=coiltick — daily cron: log today's coil observations so each can later be
// auto-resolved against the abnormal-break AND executable-trade outcomes.
// Pre-move redesign (Phase 3): beyond the v1 top-15 small/large picks, every
// available scope (micro + expanded when their candle caches exist) is captured,
// plus a DETERMINISTIC decile-stratified control sample across the whole score
// distribution — the coverage a reliability curve needs (lib/coil-capture.js).
// Coil ranking/scoring itself is untouched.
const COIL_TICK_SCOPES = ['small', 'large', 'micro', 'expanded'];
async function runCoilTick(req, res) {
  const { hasStore, writeCoilDay } = require('./store');
  const { buildCoilTickRows, COIL_CAPTURE_VERSION } = require('./coil-capture');
  if (!hasStore()) return res.json({ ok: false, skipped: 'no blob store' });
  const date = new Date().toISOString().slice(0, 10);
  const logged = [];
  const scopesCaptured = [];
  const scopesMissing = [];
  for (const scope of COIL_TICK_SCOPES) {
    let scan = null;
    try { scan = await scanCoilCohort(scope, 20000); } catch { scopesMissing.push(scope); continue; }
    if (!scan || !scan.ranked.length) { scopesMissing.push(scope); continue; }  // cache unavailable → recorded, not imputed
    const rows = buildCoilTickRows({ ranked: scan.ranked, scope, calScope: scan.calScope, cohortCount: scan.cohortCount });
    logged.push(...rows);
    scopesCaptured.push({ scope, calScope: scan.calScope, cohort: scan.cohortCount, rows: rows.length });
  }
  if (logged.length) await writeCoilDay(date, { picks: logged, captureVersion: COIL_CAPTURE_VERSION, scopesCaptured, scopesMissing });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged: logged.length, captureVersion: COIL_CAPTURE_VERSION, scopesCaptured, scopesMissing });
}

// op=coilbook — read the ledger, resolve every matured pick against fresh candles, and
// report predicted-vs-realized break rate (the honest calibration reliability of the %).
async function runCoilBook(req, res) {
  const coil = require('./coil');
  const { hasStore, readAllCoilDays } = require('./store');
  const { wilson } = require('./stats');
  if (!hasStore()) return res.json({ ok: true, resolved: 0, open: 0, days: 0, buckets: [] });
  const days = await readAllCoilDays();
  const all = [];
  days.forEach(d => (d.picks || []).forEach(p => all.push({ ...p, date: d.date })));

  // resolve, fetching each ticker's candles once
  const byTicker = new Map();
  all.forEach(p => { if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, []); byTicker.get(p.ticker).push(p); });
  const candleCache = new Map();
  const tickers = [...byTicker.keys()];
  let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); candleCache.set(t, d && d.candles); } catch { candleCache.set(t, null); } } };
  await Promise.all(Array.from({ length: 16 }, worker));

  const resolved = [];
  let open = 0;
  for (const p of all) {
    const candles = candleCache.get(p.ticker);
    const r = candles ? coil.resolveBreak(candles, p.date, p.dailyVol) : null;
    if (!r) { open++; continue; }
    resolved.push({ ...p, ...r });
  }

  // Reliability: predicted prob vs realized break rate, overall and by band.
  const brokeN = resolved.filter(r => r.broke).length;
  const predMean = resolved.length ? +(resolved.reduce((s, r) => s + r.explodeProbPct, 0) / resolved.length).toFixed(1) : null;
  const realized = resolved.length ? +(100 * brokeN / resolved.length).toFixed(1) : null;
  const ci = wilson(brokeN, resolved.length);
  const BANDS = ['high', 'elevated', 'normal', 'quiet'];
  const buckets = BANDS.map(b => {
    const rs = resolved.filter(r => r.band === b);
    const bk = rs.filter(r => r.broke).length;
    return { band: b, n: rs.length, predictedPct: rs.length ? +(rs.reduce((s, r) => s + r.explodeProbPct, 0) / rs.length).toFixed(1) : null, realizedPct: rs.length ? +(100 * bk / rs.length).toFixed(1) : null };
  }).filter(x => x.n > 0);
  const recent = resolved.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 20)
    .map(r => ({ ticker: r.ticker, date: r.date, band: r.band, predictedPct: r.explodeProbPct, broke: r.broke, mfePct: r.mfePct, thresholdPct: r.thresholdPct }));

  // Phase 3 reliability battery: two-stage (abnormal break vs executable trade)
  // per scope + band + selected-vs-controls + chronological halves. Wrapped —
  // a reporting failure must never break the legacy calibration read.
  let reliability = null;
  try { reliability = require('./coil-reliability').buildCoilReliability(all, candleCache); } catch { reliability = null; }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true, days: days.length, resolved: resolved.length, open,
    predictedBreakPct: predMean, realizedBreakPct: realized,
    realizedCi: { lo: +(ci.lo * 100).toFixed(1), hi: +(ci.hi * 100).toFixed(1) },
    horizonDays: coil.COIL_HORIZON,
    byBand: buckets,
    reliability,
    recent,
    note: `Every logged coil pick is auto-resolved: did it make an abnormal upside break (≥${coil.COIL_SIGMA}× its own ${coil.COIL_HORIZON}d vol) within ${coil.COIL_HORIZON} sessions? 'realizedBreakPct' is the honest out-of-sample hit rate to compare against the model's 'predictedBreakPct'.`,
    generatedAt: new Date().toISOString(),
  });
}

// ─────────────────────────── GAP-AND-GO ───────────────────────────
// Unscheduled catalyst gap-up continuation — the first deflation-surviving event edge
// (research/intraday exp07/08/09). Scans the full universe for today's >=3% gap-ups on
// liquid names, FILTERS OUT earnings-reaction gaps (the validated edge is unscheduled
// only), tiers by gap size (the validated monotone rank), and attaches the ORB plan.
const GAP_H = 3;   // hold horizon (sessions) — matches the research's <=3-session hold
const { roundTripCostPct } = require('./costs');
// Liquidity tier for the gap ledger's cost model, from the ADV logged with the pick.
// Unknown ADV fails toward 'small' (conservative), never toward 'liquid'.
function gapCostTier(advUsd) {
  if (!Number.isFinite(advUsd) || advUsd <= 0) return 'small';
  if (advUsd >= 50_000_000) return 'liquid';
  if (advUsd >= 10_000_000) return 'small';
  return 'micro';
}

async function scanGapUniverse(tickers, spyByDate, caches, t0, deadline, todayET = null) {
  const { scoreGapGo } = require('../lib/gapgo');
  const { cacheGet } = require('../lib/candle-cache');
  const { computeFreshness } = require('../lib/freshness');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      // Prefer the pre-warmed candle cache (fast, keeps the cron tick under budget);
      // only hit Yahoo on a miss.
      let candles = null;
      for (const doc of caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch { continue; } }
      if (!candles) continue;
      const s = scoreGapGo(candles, spyByDate, todayET); if (!s) continue;
      out.push({
        ticker: t, sector: SECTOR_OF[t] || '?', date: candles[candles.length - 1].date, ...s,
        // A gap on a stale prior-session bar is NOT the current official session's gap.
        freshness: computeFreshness({ barDate: s.candidateDate }),
      });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out;
}

// Shared compute for the live screener + the cron tick (absolute deadline from t0).
// opts.skipFadeCauses (opt-in) also skips offering/M&A gaps in `take` (default off).
async function computeGapLive(t0, deadline, opts = {}) {
  const { isEarningsAdjacent } = require('../lib/fundamentals');
  const { fetchMacro } = require('../lib/macro');
  const spyD = await fetchDailyHistory('SPY');
  if (!spyD) return null;
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  let regime = 'neutral'; try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}

  const { loadCandleCache } = require('../lib/candle-cache');
  const [cL, cS, cM, cE] = await Promise.all([
    loadCandleCache('large').catch(() => null), loadCandleCache('small').catch(() => null),
    loadCandleCache('micro').catch(() => null), loadCandleCache('expanded').catch(() => null),
  ]);
  const expandedTk = cE && cE.data ? Object.keys(cE.data) : [];   // the free full-market universe (Phase 2)
  const universe = rotateByDay([...new Set([...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO, ...expandedTk])]);
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const raw = await scanGapUniverse(universe, spyByDate, [cL, cS, cM, cE], t0, deadline, todayET);

  // Skip-earnings filter: drop earnings-reaction gaps (they don't continue — the whole
  // inversion behind this edge). Adjacency is one Finnhub call per gapper; unknown (no
  // key / failure) is KEPT but flagged so we never silently hide a name.
  let earningsExcluded = 0;
  const kept = []; let j = 0;
  const worker = async () => {
    while (j < raw.length) {
      const p = raw[j++];
      const e = await isEarningsAdjacent(p.ticker, 1).catch(() => ({ adjacent: null, earningsDate: null }));
      if (e.adjacent === true) { earningsExcluded++; continue; }
      kept.push({ ...p, earningsCheck: e.adjacent === null ? 'unknown' : 'clear', nextEarnings: e.earningsDate || null });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // Meta-label (#1) + fractional-Kelly sizing (#2). continuationScore (gap+relVol+
  // regime) is the validated take/skip rank (top-third beat bottom in 6/6 years OOS);
  // suggestedRiskPct is 0.25x-fractional Kelly by tier, score-scaled, zeroed risk-off.
  // Gap-cause tagging (research/27 + ALPHA-RESEARCH-2026-07 "Round 2"). One Finnhub
  // company-news call per kept gapper, bounded + deadline-guarded. Cause is ALWAYS
  // computed (logged forward to accrue >=150/class before it's trusted); the FADE skip
  // (offerings/M&A fade in the pilot) only affects `take` when opts.skipFadeCauses is on.
  const { fetchCompanyNews } = require('../lib/fundamentals');
  const { continuationScore, gapTake, suggestedRiskPct, classifyGapCause, metaProb, metaTier } = require('../lib/gapgo');
  let ci = 0;
  const causeWorker = async () => {
    while (ci < kept.length) {
      const p = kept[ci++];
      if (Date.now() - t0 > deadline) { p.cause = 'NONE'; continue; }
      const from = new Date(Date.parse(p.date) - 3 * 864e5).toISOString().slice(0, 10);
      const news = await fetchCompanyNews(p.ticker, from, p.date).catch(() => []);
      p.cause = classifyGapCause(news);
    }
  };
  await Promise.all(Array.from({ length: 8 }, causeWorker));


  kept.forEach(p => {
    p.continuationScore = continuationScore(p.gapPct, p.relVol, regime);
    p.take = gapTake(p.continuationScore, regime, { cause: p.cause, skipFadeCauses: !!opts.skipFadeCauses });
    p.suggestedRiskPct = suggestedRiskPct(p.tier, p.continuationScore, regime);
    // Forward-tracked meta-label (exp11): logged + ledger-split HIGH/LOW, NOT a gate.
    p.metaProb = metaProb(p.metaFeat, regime);
    p.metaTier = metaTier(p.metaProb);
  });
  kept.sort((a, b) => b.continuationScore - a.continuationScore);   // validated rank (gap+relVol+regime)
  return {
    regime,
    strong: kept.filter(p => p.tier === 'STRONG'),
    moderate: kept.filter(p => p.tier === 'MODERATE'),
    earningsExcluded, scanned: universe.length,
    spyLastDate: spyD.candles[spyD.candles.length - 1].date,
  };
}

// op=gapgo — live screener. Today's unscheduled (non-earnings) gap-ups, ORB plan attached.
async function runGapGo(req, res) {
  // Opt-in FADE skip (offerings/M&A). Default OFF — the gap-cause pilot is directional,
  // not confirmed (single regime, 32% news coverage), so the ledger accrues first.
  const skipFadeCauses = req.query.skipfade === '1' || req.query.skip === 'fade';
  const live = await computeGapLive(Date.now(), 42000, { skipFadeCauses });
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const { regime, strong, moderate, earningsExcluded, scanned } = live;
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  const _gaps = [...strong, ...moderate];
  return res.json({
    ok: true, regime, horizon: GAP_H, skipFadeCauses,
    strategyVersion: 'gapgo-v1',   // the ONE registered scoring identity (registry/contract/ledger/normalizer)
    dataFreshness: { sessionDate: live.spyLastDate, shown: _gaps.length, staleCandidates: _gaps.filter(p => p && p.barIsToday === false).length, generatedAt: new Date().toISOString() },
    strong, moderate,
    counts: { strong: strong.length, moderate: moderate.length, earningsExcluded, scanned },
    config: {
      name: 'Unscheduled Gap-and-Go (ORB continuation)',
      status: 'forward-tracked-challenger',
      rules: [
        'Signal: overnight gap-up ≥5% (STRONG) or 3–5% (MODERATE) on a liquid name ($10M+ ADV)',
        'Skip earnings: earnings-reaction gaps are FILTERED OUT — they don\'t continue (one-time repricing)',
        'Entry (as graded): the durable decision is logged after the gap session closes, so the verified record enters on the NEXT session\'s opening-range breakout (wait ~30 min, buy-stop at the OR high — never chase the open). The live view above is a same-session preview; the graded contract never trades the session that produced the decision.',
        'Exit: ~2.5×ATR stop, 1:2 target, ≤3-session time stop',
        'Gap-cause: each gap is tagged by cause (offering/M&A = FADE, FDA/guidance/contract = CONTINUE). A recent-window pilot showed offerings & buyouts fade — the "🩳 Skip fades" toggle is OPT-IN while the forward ledger accrues.',
      ],
      evidence: 'Backtested survivorship-free intraday (2022–2025, 450 fills): +1.89%/trade net, PF 1.47, positive all 4 calendar years, held-out half matches (+1.89%), Deflated Sharpe 0.99, PBO 0.46, survives 20 bps extra slippage and tail trimming. Independently re-verified 2026-08-02 from cached 5-minute data. Earnings gap-ups underperformed non-earnings in every bucket — hence the skip-earnings rule.',
      caveat: 'NOT proven alpha — a forward-tracked challenger with frozen parameters. The rig universe was a hand-selected 51-name list; the held-out date-clustered t-stat is only ~1.5 (< 2); the LIQUID 25-name half had NEGATIVE held-out expectancy; P&L is lumpy/right-skewed (a few runners carry it); one 3.5-year regime cycle. Promotion requires a fresh prospective sample on the live ledger — with these exact rules, no parameter changes — showing cost-net positive expectancy, PF > 1, and a date-clustered lower confidence bound above zero.',
    },
    generatedAt: new Date().toISOString(),
  });
}

// op=gapgotick — cron: resolve matured picks (fwd 3-session excess vs SPY) → log today's.
async function runGapGoTick(req, res) {
  const { hasStore, writeGapDay, readAllGapDays } = require('./store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const t0 = Date.now();
  try {
    if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
      await writeGapDay(req.query.prune, { picks: [] });
      return res.json({ ok: true, pruned: req.query.prune });
    }
    // 1) Resolve matured picks.
    const days = await readAllGapDays();
    const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
    const tk = [...openTk, 'SPY'];
    const hist = new Map(); let i = 0;
    const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 12 }, rw));
    const spy = hist.get('SPY') || [];
    const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
    const changed = new Set(); let resolvedNow = 0;
    for (const dd of days) {
      for (const p of (dd.picks || [])) {
        if (p.resolved) continue;
        const cands = hist.get(p.ticker); if (!cands) continue;
        const r = afterN(cands, p.date, GAP_H); if (!r) continue;
        const sp = afterN(spy, p.date, GAP_H); if (!sp) continue;
        const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
        p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
        // Cost-net alongside gross (gross never overwritten): tier from the pick's logged
        // ADV; legacy picks without advUsd take the conservative 'small' tier, never 'liquid'.
        p.costPct = roundTripCostPct(gapCostTier(p.advUsd));
        p.netExcPct = +(p.excPct - p.costPct).toFixed(2);
        changed.add(dd.date); resolvedNow++;
      }
    }
    await Promise.all([...changed].map(d2 => { const dd = days.find(x => x.date === d2); return writeGapDay(d2, { regime: dd.regime, picks: dd.picks }); }));

    // 2) Log today's gappers (earnings-filtered). Absolute 45s scan budget from t0 so the
    //    resolve + scan stay under the cron function limit.
    const live = await computeGapLive(t0, 45000);
    let logged = 0, logDate = null;
    if (live) {
      logDate = live.spyLastDate;
      // Freeze the decision at log time: take/score/version/decision-timestamp persist on
      // the row, so the verified channel grades the decision that was actually made — and
      // can prove it may only trade sessions AFTER the data cutoff (lib/gapgo.js).
      const { freezeGapLedgerPick } = require('../lib/gapgo');
      const decisionTs = new Date().toISOString();
      const picks = [...live.strong, ...live.moderate]
        .filter(p => p.earningsCheck !== 'unknown')     // only log confirmed-unscheduled gaps
        .map(p => freezeGapLedgerPick(p, { decisionTs, sessionDate: logDate }));
      if (picks.length && logDate) { await writeGapDay(logDate, { regime: live.regime, picks }); logged = picks.length; }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=gapgobook — live forward track record by tier (the self-validation of the edge).
async function runGapGoBook(req, res) {
  const { readAllGapDays } = require('./store');
  const days = await readAllGapDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push({ ...p, regime: dd.regime || 'neutral' }); }));
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(p => p.excPct > 0).length, ci = wilson(beats, n);
    const out = { n, avgRet: +(arr.reduce((s, p) => s + (p.fwdPct || 0), 0) / n).toFixed(2), avgExc: +(arr.reduce((s, p) => s + p.excPct, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
    // Cost-net lane (picks resolved since the cost model shipped carry netExcPct).
    const net = arr.filter(p => Number.isFinite(p.netExcPct));
    if (net.length) {
      const nb = net.filter(p => p.netExcPct > 0).length, nci = wilson(nb, net.length);
      out.netN = net.length;
      out.avgNetExc = +(net.reduce((s, p) => s + p.netExcPct, 0) / net.length).toFixed(2);
      out.netBeatRate = +((nb / net.length) * 100).toFixed(0);
      out.netWilsonLo = +(nci.lo * 100).toFixed(0);
    }
    return out;
  };
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length,
    stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(picks),
    byTier: { STRONG: agg(picks.filter(p => p.tier === 'STRONG')), MODERATE: agg(picks.filter(p => p.tier === 'MODERATE')) },
    // FORWARD-TRACK of the exp11 meta-label (rank-IC~0 in backtest → NO LIFT). The live OOS
    // test: do HIGH-meta picks beat LOW-meta? If byMeta.HIGH ≈ byMeta.LOW once ~40/class
    // resolve, the backtest was right and the flag retires. Only picks logged AFTER the meta
    // model shipped carry metaTier (older picks fall in `unscored`).
    byMeta: { HIGH: agg(picks.filter(p => p.metaTier === 'HIGH')), LOW: agg(picks.filter(p => p.metaTier === 'LOW')), unscored: agg(picks.filter(p => !p.metaTier)) },
    metaTarget: 40,
    // Forward gap-cause ledger. The pilot (offerings/M&A FADE vs FDA/guidance CONTINUE)
    // is NOT confirmed; this accrues live to reach ~150/class across regimes before the
    // opt-in FADE skip is trusted. `causeTarget` marks that bar.
    byCause: ['FADE_OFFERING', 'MA', 'FDA', 'CONTRACT', 'GUIDE', 'OTHER', 'NONE']
      .reduce((o, k) => { o[k] = agg(picks.filter(p => (p.cause || 'NONE') === k)); return o; }, {}),
    causeTarget: 150,
    note: `Live forward (${GAP_H}-session) excess-vs-SPY record of logged unscheduled gap-up picks, by tier AND by gap-cause. Accrues via the warm cron; thin until ~${GAP_H} sessions after the first tick. This is a daily-close PROXY of the intraday ORB strategy — directionally confirms the edge, doesn't reproduce intraday fills. The by-cause split tests whether offerings/M&A fade (opt-in skip) — untrusted until ~${150}/class.`,
    generatedAt: new Date().toISOString(),
  });
}

// ─────────────────────────── DOWN-DAY MODE ───────────────────────────
// On a red / risk-off tape the long-momentum screeners empty out by design, and
// chasing the names "holding up" is a proven trap (research/42: red-day "leaders"
// win ~50% at the next open and mean-revert down). Down-Day Mode routes each name
// to the play that actually fits a red tape — an oversold-bounce LONG (V-Reversal,
// validated red-tape-specific edge in research/43) or an overheated/rollover SHORT
// — and leads with the honest reality so a trader sizes down or sits out instead
// of forcing longs. Ledger tracks the BOUNCE longs (the new, validated lane).
const DOWNDAY_H = 3;   // hold horizon (sessions) — the horizon the red-day bounce edge peaks at

async function computeDownDayLive(t0, deadline) {
  const { classify, tapeState, DOWNDAY_REALITY } = require('../lib/downday');
  const { fetchMacro } = require('../lib/macro');
  const { loadCandleCache, cacheGet } = require('../lib/candle-cache');
  const spyD = await fetchDailyHistory('SPY');
  if (!spyD) return null;
  const sc = spyD.candles, spyLastDate = sc[sc.length - 1].date;
  const spyChangePct = sc.length >= 2 ? (sc[sc.length - 1].close / sc[sc.length - 2].close - 1) * 100 : 0;
  let regime = 'neutral'; try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}
  const tape = tapeState(spyChangePct, regime);

  const [cL, cS, cM, cE] = await Promise.all([
    loadCandleCache('large').catch(() => null), loadCandleCache('small').catch(() => null),
    loadCandleCache('micro').catch(() => null), loadCandleCache('expanded').catch(() => null),
  ]);
  const caches = [cL, cS, cM, cE];
  const expandedTk = cE && cE.data ? Object.keys(cE.data) : [];
  const universe = [...new Set([...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO, ...expandedTk])];

  const bounces = [], fades = []; let i = 0;
  const worker = async () => {
    while (i < universe.length) {
      const t = universe[i++]; if (Date.now() - t0 > deadline) return;
      let candles = null;
      for (const doc of caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) continue;
      const c = classify(candles);
      if (!c) continue;
      const row = { ticker: t, sector: SECTOR_OF[t] || '?', date: candles[candles.length - 1].date, ...c };
      (c.bucket === 'bounce' ? bounces : fades).push(row);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  bounces.sort((a, b) => b.downScore - a.downScore);

  // LEARNED SHORT-ANNOTATION (posterior-rank gate, non-daytrade backlog 2026-08): the
  // fade-engine posterior is graded close-to-close (proxy), so its influence here is
  // AVOID-ONLY — drifted names (edge stopped reverting) sink to the bottom, but the
  // posterior may no longer be the primary sort key deciding WHICH shorts are served.
  // Ordering is the pattern score (shipped behavior); learnedExcess/confidence ride
  // along as annotation. The boost path returns only via posteriorRankWeight().
  const wPost = posteriorRankWeight();
  try {
    const fe = require('../lib/fade-engine');
    const { readFade } = require('./store');
    const stateJson = await readFade();
    if (stateJson) {
      const st = fe.load(stateJson);
      for (const f of fades) {
        const p = fe.posterior(st, f.ticker, { sector: f.sector });
        f.learnedExcess = +(+p.expAlpha).toFixed(3); f.confidence = p.pPos; f.drifted = p.drifted; f.nPriors = p.n;
      }
      fades.sort((a, b) => (a.drifted ? 1 : 0) - (b.drifted ? 1 : 0)
        || (wPost ? (b.learnedExcess || 0) - (a.learnedExcess || 0) : 0)
        || b.score - a.score);
    } else { fades.sort((a, b) => b.score - a.score); }
  } catch { fades.sort((a, b) => b.score - a.score); }

  // FORCED-SELLING REVERSION bucket: read CERN's live signaled events (one cheap Blob read,
  // NOT the heavy engine). direction === -1 = LONG the reversion (fire-sale / forced downgrade
  // dislocations that mechanically overshoot and tend to revert). Especially apt on a red tape.
  let reversion = [];
  try {
    const { readCern } = require('./store');
    const st = await readCern();
    if (st && Array.isArray(st.ledger)) {
      reversion = st.ledger
        .filter(e => e.status === 'SIGNALED' && e.signal && e.direction === -1 && e.signal.side === 'long')
        .map(e => ({
          ticker: e.symbol, type: e.type, side: 'long', sector: SECTOR_OF[e.symbol] || '?',
          entry: e.signal.entryPrice, stop: e.signal.stop, target: e.signal.target,
          predMu: e.signal.predMu, pProfit: e.signal.pProfit, horizon: e.signal.horizon,
          regime: e.signal.regime, dateMs: e.dateMs,
        }))
        .sort((a, b) => (b.pProfit || 0) - (a.pProfit || 0));
    }
  } catch { /* CERN not configured → no reversion bucket */ }

  return { tape, regime, bounces, fades, reversion, reality: DOWNDAY_REALITY, scanned: universe.length, spyLastDate };
}

// op=downday — live router: oversold-bounce longs + overheated shorts for a red tape,
// led by the backtested reality panel.
async function runDownDay(req, res) {
  const live = await computeDownDayLive(Date.now(), 42000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const { tape, regime, bounces, fades, reversion, reality, scanned, spyLastDate } = live;
  // RESEARCH-CONTROL LABELING (non-daytrade backlog 2026-08): the ledger only logs
  // bounces on a RED tape (the validated sleeve), but the display path serves rows on
  // every tape. Non-red rows are the strategy's own research controls — the sample that
  // showed the bounce edge is flat/negative off the red tape — so each row now says so
  // explicitly instead of relying on banner prose. Red-day short/reversion rows stay
  // unlabeled here only because their (research, borrow-gated) status is already carried
  // by the caveat + eligibility; non-red days label ALL buckets.
  const labelControls = rows => (tape.down ? rows : rows.map(r => ({
    ...r, researchControl: true,
    controlReason: 'non-red tape — outside the validated red-tape sleeve; research control, never ledgered or actionable',
  })));
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, tape, regime, horizon: DOWNDAY_H, spyLastDate,
    displayMode: tape.down ? 'active-red-tape' : 'research-controls',
    bounces: labelControls(bounces.slice(0, 15)), fades: labelControls(fades.slice(0, 10)), reversion: labelControls((reversion || []).slice(0, 10)),
    counts: { bounces: bounces.length, fades: fades.length, reversion: (reversion || []).length, scanned },
    posteriorPolicy: POSTERIOR_POLICY_NOTE,
    reality,
    config: {
      name: 'Down-Day Mode — reversion / short / sit-out router',
      status: 'validated-lead',
      rules: [
        'Activates on a red / risk-off tape (SPY down on the day, or macro risk-off).',
        'NO "buy the leaders" lane: on red days, names holding up green win ~50% at the next open and mean-revert DOWN (research/42). Chasing strength is negative selection.',
        'Oversold Bounce (long): a capitulation → turn (V-Reversal). Earns +0.3–0.8%/3d excess vs SPY ON red days — but is flat/negative on normal days, so it is red-tape-specific. Earlier/less-confirmed turns bounce more (catch it early).',
        'Overheated (short): the mirror — a blow-off top rolling over. Ranked by pattern score; the fade-engine\'s per-stock learned edge is ANNOTATION (avoid-only: graded close-to-close, so it may sink drifted names but not order the list — posterior-rank gate).',
        'Forced-Selling Reversion (long): CERN\'s live fire-sale / forced-downgrade dislocations — mechanical selling overshoots and tends to revert. Especially apt on a red tape.',
        'Sit Out is a position: modest edges, ~50-56% win — size down, be selective, or wait for the tape to turn.',
      ],
      evidence: `Backtested 2y point-in-time, entry at the TRADEABLE next-day open, excess vs SPY (research/42-43). Momentum-long "leaders" on red days: win ${reality.leaderWinPct}%, +${reality.leaderExcessH1}%/1d then negative (${reality.leaderVerdict}). V-Reversal bounce on red days: EMERGING +${reality.bounceEmergingExcessH3}%/3d (win ${reality.bounceEmergingWinPct}%), WATCH +${reality.bounceWatchExcessH3}%/3d (win ${reality.bounceWatchWinPct}%) — vs ${reality.bounceNormalDayExcessH3}% on normal days.`,
      caveat: 'Edges are small and the win rates barely clear 50% — this is a "trade less / trade the right side" tool, not an alpha spigot. Bounce is a ~3-session mean-reversion, not a trend. Short side is not independently ledger-validated here (it reuses the Overheated pattern). Forward-tracked on the Scoreboard before sizing up.',
    },
    generatedAt: new Date().toISOString(),
  });
}

// op=downdaytick — cron: resolve matured bounce picks (fwd 3-session excess vs SPY) →
// log today's bounces IF the tape was red (the validated use case keeps the ledger clean).
async function runDownDayTick(req, res) {
  const { hasStore, writeDownDay, readAllDownDays } = require('./store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const t0 = Date.now();
  try {
    if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
      await writeDownDay(req.query.prune, { picks: [] });
      return res.json({ ok: true, pruned: req.query.prune });
    }
    // 1) Resolve matured bounce picks.
    const days = await readAllDownDays();
    const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
    const tk = [...openTk, 'SPY'];
    const hist = new Map(); let i = 0;
    const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 12 }, rw));
    const spy = hist.get('SPY') || [];
    const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
    const changed = new Set(); let resolvedNow = 0;
    for (const dd of days) {
      for (const p of (dd.picks || [])) {
        if (p.resolved) continue;
        const cands = hist.get(p.ticker); if (!cands) continue;
        const r = afterN(cands, p.date, DOWNDAY_H); if (!r) continue;
        const sp = afterN(spy, p.date, DOWNDAY_H); if (!sp) continue;
        const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
        p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(fwd - sfwd).toFixed(2); p.exitDate = r.date;
        changed.add(dd.date); resolvedNow++;
      }
    }
    await Promise.all([...changed].map(d2 => { const dd = days.find(x => x.date === d2); return writeDownDay(d2, { tape: dd.tape, picks: dd.picks }); }));

    // 2) Log today's bounces — only on a red / risk-off tape (where the edge lives).
    const live = await computeDownDayLive(t0, 45000);
    let logged = 0, logDate = null, wasRed = null;
    if (live) {
      logDate = live.spyLastDate; wasRed = live.tape.down;
      if (live.tape.down) {
        const picks = live.bounces.slice(0, 15).map(p => ({
          ticker: p.ticker, tier: p.tier, downScore: p.downScore, date: p.date,
          entry: p.signals.entry, sector: p.sector, severity: live.tape.severity, resolved: false,
        }));
        if (picks.length && logDate) { await writeDownDay(logDate, { tape: live.tape, picks }); logged = picks.length; }
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, wasRedTape: wasRed, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=downdaybook — forward record of the bounce longs by tier + tape severity.
async function runDownDayBook(req, res) {
  const { readAllDownDays } = require('./store');
  const days = await readAllDownDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push(p); }));
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
    byTier: { WATCH: agg(picks.filter(p => p.tier === 'WATCH')), EMERGING: agg(picks.filter(p => p.tier === 'EMERGING')), CONFIRMED: agg(picks.filter(p => p.tier === 'CONFIRMED')) },
    bySeverity: { heavy: agg(picks.filter(p => p.severity === 'heavy')), moderate: agg(picks.filter(p => p.severity === 'moderate')), light: agg(picks.filter(p => p.severity === 'light')) },
    note: `Live forward (${DOWNDAY_H}-session) excess-vs-SPY record of oversold-bounce longs logged on RED tapes. Tests the backtested red-day edge (EMERGING/WATCH bounce, earlier turns stronger). Thin until ~${DOWNDAY_H} sessions after the first red-day tick.`,
    generatedAt: new Date().toISOString(),
  });
}

// ─────────────────────────── GAP-DOWN CONTINUATION (short) ───────────────────────────
// The mirror of Gap & Go, validated in research/44-45: an unscheduled gap-DOWN continues
// lower. Short the break of the opening-range LOW. Its own lane (works best OFF red days).
const GAPDOWN_H = 3;   // hold horizon (sessions)

async function scanGapDownUniverse(tickers, spyByDate, caches, t0, deadline) {
  const { scoreGapDown } = require('../lib/gapdown');
  const { cacheGet } = require('../lib/candle-cache');
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let candles = null;
      for (const doc of caches) { if (doc) { const e = cacheGet(doc, t); if (e && e.candles) { candles = e.candles; break; } } }
      if (!candles) { try { const d = await fetchDailyHistory(t); candles = d && d.candles; } catch { continue; } }
      if (!candles) continue;
      const s = scoreGapDown(candles, spyByDate); if (!s) continue;
      out.push({ ticker: t, sector: SECTOR_OF[t] || '?', date: candles[candles.length - 1].date, ...s });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out;
}

async function computeGapDownLive(t0, deadline) {
  const { isEarningsAdjacent } = require('../lib/fundamentals');
  const { fetchMacro } = require('../lib/macro');
  const spyD = await fetchDailyHistory('SPY');
  if (!spyD) return null;
  const spyByDate = {}; spyD.candles.forEach(c => { spyByDate[c.date] = c.close; });
  let regime = 'neutral'; try { const m = await fetchMacro(); if (m) regime = m.regime; } catch {}
  const spyC = spyD.candles;
  const spyChangePct = spyC.length >= 2 ? +((spyC[spyC.length - 1].close / spyC[spyC.length - 2].close - 1) * 100).toFixed(2) : 0;

  const { loadCandleCache } = require('../lib/candle-cache');
  const [cL, cS, cM, cE] = await Promise.all([
    loadCandleCache('large').catch(() => null), loadCandleCache('small').catch(() => null),
    loadCandleCache('micro').catch(() => null), loadCandleCache('expanded').catch(() => null),
  ]);
  const expandedTk = cE && cE.data ? Object.keys(cE.data) : [];
  const universe = rotateByDay([...new Set([...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO, ...expandedTk])]);
  const raw = await scanGapDownUniverse(universe, spyByDate, [cL, cS, cM, cE], t0, deadline);

  // Skip-earnings filter (like Gap & Go): earnings gap-downs may be a one-time repricing.
  let earningsExcluded = 0;
  const kept = []; let j = 0;
  const worker = async () => {
    while (j < raw.length) {
      const p = raw[j++];
      const e = await isEarningsAdjacent(p.ticker, 1).catch(() => ({ adjacent: null, earningsDate: null }));
      if (e.adjacent === true) { earningsExcluded++; continue; }
      kept.push({ ...p, earningsCheck: e.adjacent === null ? 'unknown' : 'clear', nextEarnings: e.earningsDate || null });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  kept.sort((a, b) => a.gapPct - b.gapPct);   // most-negative first = the validated monotone rank
  return {
    regime, spyChangePct,
    strong: kept.filter(p => p.tier === 'STRONG'),
    moderate: kept.filter(p => p.tier === 'MODERATE'),
    earningsExcluded, scanned: universe.length,
    spyLastDate: spyC[spyC.length - 1].date,
  };
}

// op=gapdown — live gap-down continuation shorts (ORB-low breakdown), earnings-filtered.
async function runGapDown(req, res) {
  const live = await computeGapDownLive(Date.now(), 42000);
  if (!live) return res.status(502).json({ ok: false, error: 'No market data' });
  const { regime, spyChangePct, strong, moderate, earningsExcluded, scanned, spyLastDate } = live;
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  const _gd = [...strong, ...moderate];
  return res.json({
    ok: true, regime, horizon: GAPDOWN_H, spyChangePct, strong, moderate, spyLastDate,
    // DECLARED INFORMATION CUTOFF: the benchmark axis the gap was measured against was
    // already computed here and simply never published, so the pre-ranking gate saw a
    // source that could not attest which session it observed.
    dataFreshness: { sessionDate: spyLastDate, shown: _gd.length, staleCandidates: _gd.filter(p => p && p.barIsToday === false).length, generatedAt: new Date().toISOString() },
    counts: { strong: strong.length, moderate: moderate.length, earningsExcluded, scanned },
    config: {
      name: 'Gap-Down Continuation (ORB-low breakdown short)',
      status: 'validated-lead',
      // Fail-closed short honesty: this app has no borrow feed, so EVERY short here is
      // RESEARCH/WATCH only (`actionable:false`), never a live actionable short.
      borrowDataAvailable: false,
      executionNote: 'No borrow feed wired — all shorts are research/watch only (fail-closed). Confirm borrow availability and fee with your broker before shorting.',
      rules: [
        'Signal: overnight gap-DOWN ≤ −5% (STRONG) or −3 to −5% (MODERATE) on a liquid name ($10M+ ADV).',
        'EXECUTION (fail-closed): borrow availability/fee is unknown to this app, so every name is a RESEARCH/WATCH lead, not an actionable short. Verify you can borrow it — and at what fee — before shorting.',
        'Skip earnings: earnings gap-downs are FILTERED OUT — they may be a one-time repricing that doesn\'t continue.',
        'Entry: short the break of the opening-range LOW (wait ~30 min; do not chase the gap-down open). Stop 2.5×ATR above the OR, 1:2 target, ≤3-session hold.',
        'Rank by gap size (the validated monotone rank — bigger gap-down continues more).',
      ],
      evidence: 'Backtested 2y PIT, tradeable next-open entry, SHORT excess vs SPY (research/44-45): clean monotone dose-response (−3% +0.53%/3d → −5% +1.01% → −7% +1.50%), win 54–57%, positive all 3 years. Broad-based (top-5 trades only 5.4% of P&L, positive median) and survives in liquid names ($150M+ +0.35%).',
      caveat: 'SHORT FRICTIONS thin it: net of round-trip cost 0%→+1.01%, 0.4%→+0.61%, 0.8%→+0.21% — and the biggest gross edge is in $25–50M names, the hardest to borrow. Prefer liquid names you can actually short. It is an IDIOSYNCRATIC-weakness edge (stronger on non-red days), NOT a broad-market-down tool. Daily-close proxy; confirm with the intraday OR-low break. Forward-tracked before sizing up.',
    },
    generatedAt: new Date().toISOString(),
  });
}

// op=gapdowntick — cron: resolve matured shorts (fwd 3-session SHORT excess vs SPY) → log today's.
async function runGapDownTick(req, res) {
  const { hasStore, writeGapDownDay, readAllGapDownDays } = require('./store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const t0 = Date.now();
  try {
    if (req.query.prune && /^\d{4}-\d{2}-\d{2}$/.test(req.query.prune)) {
      await writeGapDownDay(req.query.prune, { picks: [] });
      return res.json({ ok: true, pruned: req.query.prune });
    }
    const days = await readAllGapDownDays();
    const openTk = new Set(); days.forEach(dd => (dd.picks || []).forEach(p => { if (!p.resolved) openTk.add(p.ticker); }));
    const tk = [...openTk, 'SPY'];
    const hist = new Map(); let i = 0;
    const rw = async () => { while (i < tk.length) { if (Date.now() - t0 > 15000) return; const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
    await Promise.all(Array.from({ length: 12 }, rw));
    const spy = hist.get('SPY') || [];
    const afterN = (cands, date, n) => { const idx = cands.findIndex(c => c.date >= date); if (idx < 0 || idx + n >= cands.length) return null; return { c1: cands[idx + n].close, c0: cands[idx].close, date: cands[idx + n].date }; };
    const changed = new Set(); let resolvedNow = 0;
    for (const dd of days) {
      for (const p of (dd.picks || [])) {
        if (p.resolved) continue;
        const cands = hist.get(p.ticker); if (!cands) continue;
        const r = afterN(cands, p.date, GAPDOWN_H); if (!r) continue;
        const sp = afterN(spy, p.date, GAPDOWN_H); if (!sp) continue;
        const fwd = (r.c1 / r.c0 - 1) * 100, sfwd = (sp.c1 / sp.c0 - 1) * 100;
        // SHORT excess: positive = the name underperformed SPY = the short paid.
        p.resolved = true; p.fwdPct = +fwd.toFixed(2); p.excPct = +(-(fwd - sfwd)).toFixed(2); p.exitDate = r.date;
        changed.add(dd.date); resolvedNow++;
      }
    }
    await Promise.all([...changed].map(d2 => { const dd = days.find(x => x.date === d2); return writeGapDownDay(d2, { regime: dd.regime, picks: dd.picks }); }));

    const live = await computeGapDownLive(t0, 45000);
    let logged = 0, logDate = null;
    if (live) {
      logDate = live.spyLastDate;
      const picks = [...live.strong, ...live.moderate]
        .filter(p => p.earningsCheck !== 'unknown')
        .map(p => ({ ticker: p.ticker, tier: p.tier, gapPct: p.gapPct, date: p.date, entry: p.plan.trigger, sector: p.sector, short: true, resolved: false }));
      if (picks.length && logDate) { await writeGapDownDay(logDate, { regime: live.regime, picks }); logged = picks.length; }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, resolvedNow, loggedToday: logged, logDate, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=gapdownbook — live forward SHORT track record by tier (self-validation).
async function runGapDownBook(req, res) {
  const { readAllGapDownDays } = require('./store');
  const days = await readAllGapDownDays();
  const picks = [];
  days.forEach(dd => (dd.picks || []).forEach(p => { if (p.resolved && p.excPct != null) picks.push(p); }));
  const agg = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const beats = arr.filter(p => p.excPct > 0).length, ci = wilson(beats, n);
    return { n, avgExc: +(arr.reduce((s, p) => s + p.excPct, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days.length, resolved: picks.length,
    stillOpen: days.reduce((a, dd) => a + (dd.picks || []).filter(p => !p.resolved).length, 0),
    overall: agg(picks),
    byTier: { STRONG: agg(picks.filter(p => p.tier === 'STRONG')), MODERATE: agg(picks.filter(p => p.tier === 'MODERATE')) },
    note: `Live forward (${GAPDOWN_H}-session) SHORT excess-vs-SPY record of logged gap-down shorts, by tier (positive = the short paid). Daily-close proxy of the intraday OR-low breakdown; accrues via the warm cron. Costs NOT deducted — subtract ~0.4–0.8% for borrow/slippage.`,
    generatedAt: new Date().toISOString(),
  });
}

// op=timing — batch entry-timing lights. POST { picks:[{ticker,stop,target,trigger,avgVol}] }
// → live 1-10 timing grade per ticker (10 = 🟢 optimal moment to buy, 1 = 🔴 worst). Used
// by the pick cards, refreshed every ~20 min (and on tab refresh) from the client. Cheap:
// one Yahoo intraday chart per ticker, no re-scan.
// Active (possibly learned) timing weights — the adaptive tuner promotes here. Falls back
// to the shipped defaults. Memoized per request via the store's cache-busting read.
async function loadTimingWeights() {
  const { DEFAULT_WEIGHTS } = require('../lib/timing');
  try {
    const { readJSON, hasStore } = require('./store');
    if (!hasStore()) return DEFAULT_WEIGHTS;
    // Central adaptive policy: 'disable' reverts to shipped weights even when a
    // tuned doc exists (the doc stays on record, just not in force).
    if ((await require('./adaptive-layers').layerPolicy('timing-tune')) === 'disable') return DEFAULT_WEIGHTS;
    const w = await readJSON('timing/weights.json', null);
    return (w && w.weights) ? w.weights : DEFAULT_WEIGHTS;
  } catch { return DEFAULT_WEIGHTS; }
}

async function runTiming(req, res) {
  const { scoreTiming, fetchTimingSnapshot } = require('../lib/timing');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const picks = (body && Array.isArray(body.picks)) ? body.picks.slice(0, 60) : null;   // bound the batch
  if (!picks) return res.status(400).json({ ok: false, error: 'expected JSON { picks: [{ticker, stop?, target?, trigger?, avgVol?}] }' });

  const t0 = Date.now();
  const weights = await loadTimingWeights();
  const results = {}; let i = 0;
  const worker = async () => {
    while (i < picks.length) {
      const p = picks[i++]; if (Date.now() - t0 > 25000) return;
      if (!p || !p.ticker) continue;
      const snap = await fetchTimingSnapshot(p.ticker, p.avgVol != null ? +p.avgVol : null).catch(() => null);
      // Bind the lifecycle/thesis context (when the client sends it) so the timing light can
      // never grade a stale, failed, or not-yet-valid setup as a buy moment.
      const context = (p.lifecycleState != null || p.thesisValid != null || p.currentSessionFresh != null || p.stopBreached != null || p.breakoutFailed != null)
        ? { lifecycleState: p.lifecycleState, thesisValid: p.thesisValid, planValid: p.planValid,
            currentSessionFresh: p.currentSessionFresh, breakoutFailed: p.breakoutFailed, stopBreached: p.stopBreached,
            lossFromDetectionAtr: p.lossFromDetectionAtr }
        : null;
      results[p.ticker.toUpperCase()] = scoreTiming(snap, { stop: p.stop, target: p.target, trigger: p.trigger }, weights, context);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, timing: results, at: new Date().toISOString() });
}

// op=timinglog — cron: grade today's day-trade picks with a LIVE snapshot (active weights)
// and log grade + factor values + entry price to the timing ledger. Makes the grade
// ACCOUNTABLE — op=timingbook resolves these to forward returns later.
async function runTimingLog(req, res) {
  const { hasStore, writeTimingDay } = require('./store');
  const { nowET } = require('./stats');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const t0 = Date.now();
  const { scoreTiming, fetchTimingSnapshot } = require('../lib/timing');
  const weights = await loadTimingWeights();
  let live; try { live = await computeDaytradeLive(t0, 30000); } catch { live = null; }
  if (!live) return res.json({ ok: false, error: 'no market data' });
  const pool = [...(live.scan1 || []), ...(live.scan2 || []), ...(live.scan3 || [])];
  const seen = new Set();
  const uniq = pool.filter(p => p.ticker && !seen.has(p.ticker) && seen.add(p.ticker)).slice(0, 50);
  const graded = []; let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const p = uniq[i++]; if (Date.now() - t0 > 45000) return;
      const lv = p.orb || {};
      const levels = { stop: lv.stop ?? p.stop, target: lv.target ?? p.target, trigger: lv.trigger ?? p.entry, avgVol: p.avgVol };
      const snap = await fetchTimingSnapshot(p.ticker, p.avgVol).catch(() => null);
      const g = scoreTiming(snap, levels, weights);
      if (g && g.score != null && g.price > 0) graded.push({ ticker: p.ticker, scan: p.scan, grade: g.score, light: g.light, factors: g.factors, price: g.price, resolved: false });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const date = nowET().date;
  if (graded.length) await writeTimingDay(date, { weightsVersion: (await (async () => { try { const { readJSON } = require('./store'); const w = await readJSON('timing/weights.json', null); return w && w.version ? w.version : 'shipped'; } catch { return 'shipped'; } })()), picks: graded });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged: graded.length, elapsedMs: Date.now() - t0 });
}

// Resolve logged timing grades to forward DAYTRADE_H-session excess-vs-SPY returns.
async function resolveTimingRows() {
  const { readAllTimingDays } = require('./store');
  const days = await readAllTimingDays();
  const rows = [];
  const openTk = new Set(); days.forEach(d => (d.picks || []).forEach(p => openTk.add(p.ticker)));
  const tk = [...openTk, 'SPY']; const hist = new Map(); let i = 0;
  const rw = async () => { while (i < tk.length) { const t = tk[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 12 }, rw));
  const spy = hist.get('SPY') || [];
  const afterN = (c, date, n) => { const idx = c.findIndex(x => x.date >= date); if (idx < 0 || idx + n >= c.length) return null; return { c0: c[idx].close, c1: c[idx + n].close }; };
  // Learning-input discipline: only MATURED outcomes (afterN demands the full horizon), only
  // COST-NET returns (conservative 'small' tier — the ledger stores no per-pick ADV), and only
  // INDEPENDENT episodes (the same ticker re-logged while its previous window is still open is
  // one trade, not a fresh observation — first appearance wins, cooldown = the hold window).
  const timingCost = roundTripCostPct('small') / 100;
  const EPISODE_COOLDOWN_DAYS = 5;                       // ≈ DAYTRADE_H sessions in calendar days
  const lastSeen = new Map();
  for (const d of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) for (const p of (d.picks || [])) {
    const prev = lastSeen.get(p.ticker);
    if (prev && (new Date(d.date) - new Date(prev)) / 86400000 < EPISODE_COOLDOWN_DAYS) continue;
    const c = hist.get(p.ticker); if (!c) continue;
    const r = afterN(c, d.date, DAYTRADE_H), s = afterN(spy, d.date, DAYTRADE_H); if (!r || !s) continue;
    lastSeen.set(p.ticker, d.date);
    const excGross = (r.c1 / r.c0 - 1) - (s.c1 / s.c0 - 1);
    rows.push({ date: d.date, ticker: p.ticker, grade: p.grade, f: p.factors, fwd: excGross - timingCost, fwdGross: excGross });
  }
  return { rows, days: days.length };
}

// op=timingbook — the timing grade's LIVE ACCOUNTABILITY: realized forward excess return by
// grade bucket + rank-IC. Answers "does a greener light actually mark a better entry?"
async function runTimingBook(req, res) {
  const { rows, days } = await resolveTimingRows();
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const spearman = (xs, ys) => { const n = xs.length; if (n < 20) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => r[i] = k); return r; }; const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { const a = rx[i] - m, b = ry[i] - m; num += a * b; dx += a * a; dy += b * b; } return (dx && dy) ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null; };
  const bucket = (lo, hi) => { const s = rows.filter(r => r.grade >= lo && r.grade <= hi); return { n: s.length, avgExc: +(mean(s.map(r => r.fwd)) * 100).toFixed(2), beatRate: s.length ? +((s.filter(r => r.fwd > 0).length / s.length) * 100).toFixed(0) : 0 }; };
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, daysLogged: days, resolved: rows.length,
    ic: spearman(rows.map(r => r.grade), rows.map(r => r.fwd)),
    byBucket: { green: bucket(7, 10), amber: bucket(4, 6), red: bucket(1, 3) },
    horizon: DAYTRADE_H,
    note: `Forward ${DAYTRADE_H}-session COST-NET excess-vs-SPY (conservative small-cap round-trip haircut) of each logged pick's FIRST appearance per episode, split by the timing light it showed. Green should beat amber should beat red for the grade to be earning its keep; the IC (grade→forward) is the one-number scorecard. Accrues via the daily cron.`,
    generatedAt: new Date().toISOString(),
  });
}

// op=timingtune — cron/manual: the SELF-IMPROVEMENT loop. Fit challenger weights from the
// resolved ledger, promote only if they beat the active weights out-of-sample by a margin
// on enough resolved picks (else stay put). Bounded step. Dormant until the ledger matures.
async function runTimingTune(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  const { championChallenger, DEFAULT_WEIGHTS } = require('../lib/timing-adapt');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const active = await loadTimingWeights();
  const { rows } = await resolveTimingRows();
  const cc = championChallenger(rows, active);
  let version = 'shipped';
  try { const cur = await readJSON('timing/weights.json', null); version = cur && cur.version ? cur.version : 'shipped'; } catch {}
  // Central adaptive policy: 'freeze'/'disable' block adoption of a new tune —
  // the champion/challenger diagnostics still run and are reported.
  const tunePolicy = await require('./adaptive-layers').layerPolicy('timing-tune');
  const policyBlockedAdoption = cc.promoted && tunePolicy !== 'allow';
  if (cc.promoted && !policyBlockedAdoption) {
    const newVersion = `v${(parseInt(String(version).replace(/\D/g, ''), 10) || 0) + 1}`;
    await writeJSON('timing/weights.json', { weights: cc.weights, version: newVersion, prevWeights: active, promotedAt: new Date().toISOString(), reason: cc.reason, resolved: cc.resolved, oosIc: cc.oosIcChallenger }, 0);
    version = newVersion;
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, ...cc, promoted: cc.promoted && !policyBlockedAdoption, policyBlockedAdoption, adaptivePolicy: tunePolicy, version, activeWeights: (cc.promoted && !policyBlockedAdoption) ? cc.weights : active, defaultWeights: DEFAULT_WEIGHTS });
}

module.exports = { runFadeOpt, runFadeSeed, runFadeSignals, runFadeTick, runFadeBook,
  runTrendOpt, runTrend, runTrendTick, runTrendBook,
  runDaytrade, runDaytradeBoardTick, computeDaytradeBoard, runDaytradeTick, runDaytradeBook, runDaytradeOpt,
  runConfluence, runConfluenceTick, runConfluenceBook, runConfluenceOpt, runConfluenceMarginal, confluenceStratWeights,
  posteriorRankWeight, POSTERIOR_POLICY_NOTE,
  runCoil, runCoilTick, runCoilBook, cohortFreshness, avgDollarVol, mergeCoilScopes,
  runGapGo, runGapGoTick, runGapGoBook,
  runDownDay, runDownDayTick, runDownDayBook,
  runGapDown, runGapDownTick, runGapDownBook,
  runTiming, runTimingLog, runTimingBook, runTimingTune,
  assignRelScores, buildBestOpportunities, stampGate,
  computeDaytradeLive };   // exported for the shadow lifecycle board (lib/lifecycle-routes)
