// Pick-tracking endpoint — two ops behind one function (Hobby plan caps a
// deployment at 12 Serverless Functions, so logging + scoring share a file):
//   GET /api/tracker?op=track[&force=1]    → snapshot today's picks to storage
//   GET /api/tracker  (or ?op=scoreboard)  → realized forward-return scoreboard
//   GET /api/tracker?op=apexlog[&force=1]  → log today's Apex/Loaded signals
//   GET /api/tracker?op=ghostlog[&force=1] → log today's Ghost/Stalking signals
//   GET /api/tracker?op=archive            → snapshot per-ticker mentions + options baselines
//   POST /api/tracker?op=insideringest     → receive EDGAR Form 4 history (external builder)
//   GET /api/tracker?op=insider            → insider-history coverage snapshot
//   GET /api/tracker?op=fundbuild          → resumable point-in-time fundamentals build
//   GET /api/tracker?op=fundamentals       → fundamentals coverage snapshot
//   GET /api/tracker?op=cerntick           → run one CERN daily cycle (warm cron)
//   GET /api/tracker?op=cern               → CERN engine state for the Events tab
//   GET /api/tracker?op=cernlockprobe      → read-only lockup-feed liquidity probe
//   GET /api/tracker?op=drift              → Apex model drift / health (Module 3)
//   GET /api/tracker?op=recalibrate        → re-optimize pillar weights (Module 2)
//   GET /api/tracker?op=model              → active model weights / version (for client)
//   GET /api/tracker?op=narrative[&force=1] → weekly market-narrative tag
const { fetchOptionsBaseline } = require('../lib/options-baseline');
const { fetchQuarterlySeries } = require('../lib/earnings');
const { CERN } = require('../lib/cern');
const { LARGE: UNI_LARGE, SMALL_CAPS: UNI_SMALL, MICRO_CAPS: UNI_MICRO, SECTOR_OF } = require('../lib/universe');
const { writeDay, readAllPicks, hasStore, writeApexDay, readAllApex, writeGhostDay, readAllGhost, writeArchiveDay,
        readModel, writeModel, readNarrative, writeNarrative, readBackfill, writeBackfill,
        readResolved, writeResolved, readExits, writeExits, readLongShort, writeLongShort, readPead, writePead,
        readInsider, writeInsider, readFundamentals, writeFundShard, readCern, writeCern,
        writeEdgeDay, readAllEdge,
        readFade, writeFade, writeFadeDay, readAllFade, readAllFadeDays,
        readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays,
        readDaytradeEng, writeDaytradeEng, writeDaytradeDay, readAllDaytradeDays,
        readConfluenceEng, writeConfluenceEng, writeConfluenceDay, readAllConfluenceDays,
        writePredictDay, readAllPredictDays,
        writePredmktDay, readAllPredmktDays,
        readSharpEvents, writeSharpEvents,
        writeBriefDay, readAllBriefDays,
        readNotifyFeed, writeNotifyFeed,
        writeCStudyDay, readAllCStudyDays,
        readJSON, writeJSON } = require('../lib/store');
const { fetchDailyHistory } = require('../lib/screener');
const { wilson } = require('../lib/stats');
const { runPredict, runPredictTick, runCrowd, runCrowdTick, runBrief, runBriefTick, runTape, runAlertFeed } = require('../lib/predict-routes');
const { runFadeOpt, runFadeSeed, runFadeSignals, runFadeTick, runFadeBook,
        runTrendOpt, runTrend, runTrendTick, runTrendBook,
        runDaytrade, runDaytradeTick, runDaytradeBook, runDaytradeOpt,
        runConfluence, runConfluenceTick, runConfluenceBook, runConfluenceOpt } = require('../lib/screener-routes');
const { runAlertsIngest, runAlerts, runAlertsGrade } = require('../lib/alerts-routes');
const { analyzeVReversal } = require('../lib/vreversal');
const apex = require('../lib/apex');
const { recalibrate } = require('../lib/recalibrate');
const { runBackfill } = require('../lib/backfill');
const { runResearch } = require('../lib/research');
const { runExitStudy } = require('../lib/exits');
const { runLongShort } = require('../lib/longshort');
const { runPEAD, runReactionPEAD } = require('../lib/pead');
const { resolveTrade } = require('../lib/outcome');

const BASE_VERSION = 'v2026.Q2';

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

// ── op=track : log today's Screener + Momentum picks ───────────────────────
async function getJSON(path) {
  const r = await fetch('https://' + HOST + path, { headers: { 'x-warm': '1' } });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

function nowET() {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const wd = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return { date, isWeekend: wd === 'Sat' || wd === 'Sun' };
}

async function runTrack(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isWeekend } = nowET();
  // Skip weekends so we don't log 2-3 duplicate cohorts of the same Friday snapshot.
  if (isWeekend && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'weekend', date, count: 0 });
  }

  const ts = Date.now();
  const picks = [];
  const seen = new Set();
  const add = rec => {
    const key = `${rec.section}:${rec.tier}:${rec.scope || ''}:${rec.ticker}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(rec);
  };

  for (const scope of ['large', 'small', 'micro']) {
    try {
      const d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : ''));
      (d.results || []).forEach(r => {
        if (!r.ticker || !r.status || r.price == null) return;
        add({ date, ts, ticker: r.ticker, company: r.company || null, section: 'screener', tier: r.status, scope, entry: r.price });
      });
    } catch { /* scope failed — skip */ }
  }
  try {
    const d = await getJSON('/api/momentum');
    (d.strongBuys || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongBuy', scope: null, entry: c.price }));
    (d.strongSells || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongSell', scope: null, entry: c.price }));
  } catch { /* momentum failed — skip */ }

  let url = null, err = null;
  try { const r = await writeDay(date, picks); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, count: picks.length, url, error: err, at: new Date().toISOString() });
}

// ── op=scoreboard : realized forward returns per section / tier ─────────────
const HORIZONS = [['1w', 5], ['1m', 21], ['3m', 63]]; // label → trading days

function forwardReturn(candles, pick, bars) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= candles.length) return null; // horizon hasn't elapsed yet
  const entry = pick.entry || candles[idx].close;
  if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (pick.tier === 'StrongSell') ret = -ret; // short: positive = profitable
  return ret;
}

function summarizeReturns(arr) {
  if (!arr.length) return null;
  const n = arr.length;
  const wins = arr.filter(x => x > 0);
  const losses = arr.filter(x => x <= 0);
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  return {
    n,
    avg: +avg.toFixed(2),
    winRate: +((wins.length / n) * 100).toFixed(0),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
  };
}

async function runScoreboard(req, res) {
  const rawPicks = await readAllPicks();
  const rawGhost = await readAllGhost();   // GAI-tier outcomes (GHOST / STALKING)
  if (!rawPicks.length && !rawGhost.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: hasStore(), totalPicks: 0, loggedRows: 0, groups: [], generatedAt: new Date().toISOString() });
  }

  // First-appearance only: earliest record per section:tier:ticker so a name that
  // stays listed for days isn't over-weighted. Raw daily log is left untouched.
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const firstSeen = new Map();
  for (const p of [...rawPicks].sort(byDate)) {
    const key = `${p.section}:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Ghost ledger → its own "Ghost" section (GHOST/STALKING tiers); records carry
  // date/entry/tier already, so they flow through the same grouping + resolution.
  for (const p of [...rawGhost].sort(byDate)) {
    const key = `Ghost:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Ghost' });
  }
  const picks = [...firstSeen.values()];

  const tickers = [...new Set(picks.map(p => p.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  const groups = {};
  for (const p of picks) {
    const gkey = `${p.section}:${p.tier}`;
    const g = groups[gkey] || (groups[gkey] = { section: p.section, tier: p.tier, picks: 0, h: {} });
    g.picks++;
    const candles = hist.get(p.ticker);
    if (!candles) continue;
    for (const [hk, bars] of HORIZONS) {
      const r = forwardReturn(candles, p, bars);
      if (r == null) continue;
      (g.h[hk] = g.h[hk] || []).push(r);
    }
  }

  const out = Object.values(groups).map(g => ({
    section: g.section,
    tier: g.tier,
    picks: g.picks,
    horizons: Object.fromEntries(HORIZONS.map(([hk]) => [hk, summarizeReturns(g.h[hk] || [])])),
  })).sort((a, b) => a.section === b.section ? a.tier.localeCompare(b.tier) : a.section.localeCompare(b.section));

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.json({ configured: true, totalPicks: picks.length, loggedRows: rawPicks.length + rawGhost.length, groups: out, generatedAt: new Date().toISOString() });
}

// ── op=apexlog : log today's Apex/Loaded signals to the ledger ─────────────
async function runApexLog(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isWeekend } = nowET();
  if (isWeekend && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'weekend', date, count: 0 });
  }

  const ts = Date.now();
  let regime = 'NEUTRAL';
  const byTicker = new Map();          // first/best record per ticker
  const RANK = { apex: 2, loaded: 1 };

  // Score with the active recalibrated weights if a Module 2 re-fit is live,
  // else the static Module 1 presets — so the ledger matches the live tab.
  const model = await readModel();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  const activeWeights = active && active.weights ? active.weights : null;
  // Tag every signal with this week's dominant market narrative (sentiment layer).
  const nar = await readNarrative();
  const narrativeTag = nar ? nar.tag : null;

  // Large first — it carries the market-regime read used to score every scope.
  for (const scope of ['large', 'small', 'micro']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { continue; }
    if (scope === 'large') regime = apex.rawRegime(d.regime);
    const weights = (activeWeights && activeWeights[regime]) || apex.PRESETS[regime];
    (d.results || []).forEach(c => {
      if (!c.ticker || !c.status || c.price == null) return;
      const { pillars, score, tier } = apex.scoreCandidate(c, regime, weights);
      if (tier !== 'apex' && tier !== 'loaded') return;  // log only Apex / Loaded
      const lv = c.levels || {}, m = c.metrics || {};
      const rec = {
        date, ts, ticker: c.ticker, company: c.company || null, scope, tier, score, pillars, regime,
        narrativeTag,
        entry: lv.entry != null ? lv.entry : c.price,
        pivot: m.pivot != null ? m.pivot : null,
        stop: lv.stop != null ? lv.stop : null,
        target: lv.target != null ? lv.target : (lv.resistance != null ? lv.resistance : null),
        status: c.status,
      };
      const prev = byTicker.get(c.ticker);
      if (!prev || RANK[tier] > RANK[prev.tier] || (RANK[tier] === RANK[prev.tier] && score > prev.score)) byTicker.set(c.ticker, rec);
    });
  }
  const signals = [...byTicker.values()];

  let url = null, err = null;
  try { const r = await writeApexDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, count: signals.length, url, error: err, at: new Date().toISOString() });
}

// ── op=ghostlog : log today's GHOST/STALKING signals to the ghost ledger ────
// The 6-pillar Ghost score is computed server-side in /api/screener (c.ghost),
// so this op just reads it back and persists first/best per ticker — the future
// adaptive engine resolves these. Logs Ghost + Stalking only (Watch is noise).
async function runGhostLog(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isWeekend } = nowET();
  if (isWeekend && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'weekend', date, count: 0 });
  }

  const ts = Date.now();
  let regime = 'neutral';
  const byTicker = new Map();
  const RANK = { GHOST: 2, STALKING: 1 };

  for (const scope of ['large', 'small', 'micro']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { continue; }
    if (scope === 'large' && d.ghost && d.ghost.regime) regime = d.ghost.regime;
    (d.results || []).forEach(c => {
      const g = c.ghost;
      if (!g || !c.ticker || c.price == null) return;
      if (g.tier !== 'GHOST' && g.tier !== 'STALKING') return;   // log Ghost / Stalking only
      const lv = c.levels || {}, m = c.metrics || {};
      const ins = c.insider || null;
      const rec = {
        date, ts, ticker: c.ticker, company: c.company || null, scope,
        tier: g.tier, score: g.score, pillars: g.pillars, strongPillars: g.strongPillars,
        regime: d.ghost ? d.ghost.regime : regime,
        insiderNet: ins && ins.net ? ins.net.value : null,
        entry: lv.entry != null ? lv.entry : c.price,
        pivot: m.pivot != null ? m.pivot : null,
        stop: lv.stop != null ? lv.stop : null,
        target: lv.target != null ? lv.target : (lv.resistance != null ? lv.resistance : null),
        status: c.status || null,
      };
      const prev = byTicker.get(c.ticker);
      if (!prev || RANK[g.tier] > RANK[prev.tier] || (RANK[g.tier] === RANK[prev.tier] && g.score > prev.score)) byTicker.set(c.ticker, rec);
    });
  }
  const signals = [...byTicker.values()];

  let url = null, err = null;
  try { const r = await writeGhostDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, count: signals.length, url, error: err, at: new Date().toISOString() });
}

// ── Edge Book helpers — position-signed forward return + SPY benchmark ──────
// Position return: raw stock forward return over `bars`, signed by side (a short
// profits when the stock falls). SPY return over the same window is the market
// benchmark; excess = position − SPY is "did this pick beat the market".
function posReturn(candles, pick, bars) {
  let idx = -1; for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null; const tgt = idx + bars; if (tgt >= candles.length) return null;
  const entry = pick.entry || candles[idx].close; if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (pick.side === 'short') ret = -ret;
  return ret;
}
function spyReturnAt(spyCandles, date, bars) {
  let idx = -1; for (let k = 0; k < spyCandles.length; k++) { if (spyCandles[k].date <= date) idx = k; else break; }
  if (idx < 0) return null; const tgt = idx + bars; if (tgt >= spyCandles.length) return null;
  return ((spyCandles[tgt].close - spyCandles[idx].close) / spyCandles[idx].close) * 100;
}
function corr(a, b) {
  const n = a.length; if (n < 2) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

// ── op=edgelog : snapshot today's two-sleeve Edge Book (paper) ──────────────
// Sleeve A = top-quintile CONVICTION longs (regime-gated), from the live screener.
// Sleeve B = CERN forced-flow TRADE/PROBE decisions. Logged daily to edge/<date>;
// op=edgebook later resolves each sleeve's beat-SPY rate + the cross-sleeve
// correlation — the empirical test of the orthogonal-overlay thesis.
async function runEdgeLog(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.', count: 0 });
  const { date, isWeekend } = nowET();
  if (isWeekend && req.query.force !== '1') return res.status(200).json({ ok: true, skipped: 'weekend', date, count: 0 });

  const ts = Date.now();
  const byKey = new Map();
  let regime = 'neutral';

  // Sleeve A — conviction longs from the screener (large + small pools), regime-gated.
  for (const scope of ['large', 'small']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { continue; }
    if (scope === 'large' && d.conviction && d.conviction.regime) regime = d.conviction.regime;
    if (!(d.conviction && d.conviction.longOk)) continue;          // regime gate: no longs in risk-off
    (d.results || []).forEach(c => {
      const cv = c.conviction;
      if (!cv || !cv.sleeveA || !c.ticker || c.price == null) return;
      const lv = c.levels || {};
      const rec = { date, ts, sleeve: 'A', ticker: c.ticker, company: c.company || null, side: 'long',
        score: cv.score, pctile: cv.pctile, scope, regime: d.conviction.regime,
        entry: lv.entry != null ? lv.entry : c.price };
      const k = 'A:' + c.ticker, prev = byKey.get(k);
      if (!prev || cv.score > prev.score) byKey.set(k, rec);
    });
  }

  // Sleeve B — CERN forced-flow decisions (paper TRADE / PROBE).
  let cernCount = 0;
  try {
    const state = await readCern();
    if (state) {
      const cern = CERN.load(state);
      for (const e of cern.s.ledger) {
        if (e.status !== 'SIGNALED' || !e.signal) continue;
        if (e.signal.action !== 'TRADE' && e.signal.action !== 'PROBE') continue;
        const k = 'B:' + e.symbol; if (byKey.has(k)) continue;
        byKey.set(k, { date, ts, sleeve: 'B', ticker: e.symbol, side: e.signal.side, action: e.signal.action,
          type: e.type, score: e.signal.pProfit != null ? Math.round(e.signal.pProfit * 100) : null,
          predMu: e.signal.predMu, pProfit: e.signal.pProfit, regime: e.signal.regime, entry: e.signal.entryPrice });
        cernCount++;
      }
    }
  } catch {}

  const picks = [...byKey.values()];
  const aCount = picks.filter(p => p.sleeve === 'A').length;
  let url = null, err = null;
  try { const r = await writeEdgeDay(date, picks); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, sleeveA: aCount, sleeveB: cernCount, count: picks.length, url, error: err, at: new Date().toISOString() });
}

// ── op=edgebook : resolve each sleeve's beat-SPY rate + cross-sleeve correlation
async function runEdgeBook(req, res) {
  const raw = await readAllEdge();
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (!raw.length) return res.json({ configured: hasStore(), picks: 0, sleeves: [], note: 'No Edge Book history yet — the warm cron logs it daily.', generatedAt: new Date().toISOString() });

  // First-appearance dedup per sleeve:ticker:side.
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const first = new Map();
  for (const p of [...raw].sort(byDate)) { const k = `${p.sleeve}:${p.ticker}:${p.side}`; if (!first.has(k)) first.set(k, p); }
  const picks = [...first.values()];

  const spyD = await fetchDailyHistory('SPY'); const spy = spyD ? spyD.candles : null;
  const tickers = [...new Set(picks.map(p => p.ticker))];
  const hist = new Map(); let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  const H = 21;                                   // 1-month horizon for headline beat-rate + correlation
  for (const p of picks) {
    p.excess = null;
    const candles = hist.get(p.ticker); if (!candles || !spy) continue;
    const pr = posReturn(candles, p, H), sr = spyReturnAt(spy, p.date, H);
    if (pr != null && sr != null) p.excess = +(pr - sr).toFixed(2);
  }

  const summarize = sleeve => {
    const ps = picks.filter(p => p.sleeve === sleeve), resolved = ps.filter(p => p.excess != null);
    const wins = resolved.filter(p => p.excess > 0).length, ci = resolved.length ? wilson(wins, resolved.length) : { lo: 0, hi: 0 };
    return { sleeve, total: ps.length, resolved: resolved.length, pending: ps.length - resolved.length,
      beatSpyRate: resolved.length ? +(wins / resolved.length).toFixed(3) : null, wilsonLo: +ci.lo.toFixed(3),
      avgExcessVsSpy: resolved.length ? +(resolved.reduce((a, p) => a + p.excess, 0) / resolved.length).toFixed(2) : null };
  };

  // Cross-sleeve correlation of daily mean excess — the overlay thesis (wants ~0).
  const dailyMean = sleeve => { const m = new Map(); for (const p of picks) { if (p.sleeve !== sleeve || p.excess == null) continue; if (!m.has(p.date)) m.set(p.date, []); m.get(p.date).push(p.excess); } const o = {}; for (const [d, a] of m) o[d] = a.reduce((x, y) => x + y, 0) / a.length; return o; };
  const aM = dailyMean('A'), bM = dailyMean('B'), common = Object.keys(aM).filter(d => d in bM);
  const correlation = common.length >= 8 ? +corr(common.map(d => aM[d]), common.map(d => bM[d])).toFixed(3) : null;

  return res.json({ configured: true, picks: picks.length, horizonDays: H,
    sleeves: [summarize('A'), summarize('B')],
    crossSleeve: { pairedDates: common.length, correlation,
      note: common.length >= 8 ? 'Pearson corr of daily mean excess — the overlay thesis wants this ~0 (uncorrelated streams diversify).' : 'Need ≥8 dates where BOTH sleeves traded — still accruing.' },
    generatedAt: new Date().toISOString() });
}

// ── op=vreversal : live scan for V-shaped reversals (tiered + buy/sell levels) ─
// Scans the universe (default all scopes), runs the pure detector on each name's
// daily candles, returns tiered candidates (CONFIRMED/EMERGING/WATCH) with entry,
// stop, target and R:R. Time-boxed; cached behind the CDN like the screener.
async function runVReversal(req, res) {
  const scope = (req.query.scope || 'all').toLowerCase();
  const lists = scope === 'large' ? UNI_LARGE : scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO
    : [...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO];
  const tickers = [...new Set(lists)];
  const t0 = Date.now(), deadline = 50000;
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      try {
        const d = await fetchDailyHistory(t);
        if (d && d.candles.length >= 80) {
          const v = analyzeVReversal(d.candles);
          if (v) { v.ticker = t; v.price = +lastClose(d.candles).toFixed(2); out.push(v); }
        }
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 18 }, worker));
  const RANK = { CONFIRMED: 3, EMERGING: 2, WATCH: 1 };
  out.sort((a, b) => (RANK[b.tier] - RANK[a.tier]) || (b.score - a.score));
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, scope, scanned: tickers.length, found: out.length,
    tiers: { CONFIRMED: out.filter(x => x.tier === 'CONFIRMED').length, EMERGING: out.filter(x => x.tier === 'EMERGING').length, WATCH: out.filter(x => x.tier === 'WATCH').length },
    results: out.slice(0, 80), elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}
const lastClose = candles => candles[candles.length - 1].close;

// ── op=vreversaltest : does the V-reversal pattern actually have edge? ───────
// Replays the SAME detector over history; whenever a V fires, records the
// forward H-day return and the excess vs SPY, aggregated by tier. ≥10-bar dedup
// so one ongoing V isn't counted every day.
//
// The long side LOSES (falling-knife), so the live question is the FADE: short
// the snapback (market-neutral vs SPY). On a 2y window that fade shows alpha —
// but the whole edge-hunt has been burned 3× by risk-on-window artifacts, so
// this defaults to range=5y and SPLITS THE FADE BY MACRO REGIME. A fade that is
// real (not a bull-market beta accident) must keep alpha — beatsMkt Wilson LB
// > 50% — in NEUTRAL and RISK-OFF too, not only risk-on.
async function runVReversalTest(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 120);
  const H = Math.max(5, parseInt(req.query.h, 10) || 21);
  const range = /^(1y|2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  // pattern: 'v' (bottom; long-side, fade=short), 'invertedv' (top; short IS the
  // primary trade — read the `fade` block), 'sweep' (bullish liquidity sweep; long
  // primary), 'sweepshort' (bearish liquidity sweep; the short = `fade` block).
  const p = (req.query.pattern || '').toLowerCase();
  const KNOWN = ['invertedv', 'sweep', 'sweepshort', 'donchian', 'rsi2', 'pullback'];
  const pattern = p === 'top' ? 'invertedv' : p === 'sweeptop' ? 'sweepshort' : KNOWN.includes(p) ? p : 'v';
  const { analyzeInvertedV, analyzeLiquiditySweep } = require('../lib/vreversal');
  const { donchianBreakout, rsi2Reversion, maPullback } = require('../lib/techstrats');
  const DETECTORS = {
    v: analyzeVReversal,
    invertedv: analyzeInvertedV,
    sweep: c => analyzeLiquiditySweep(c, { dir: 1 }),
    sweepshort: c => analyzeLiquiditySweep(c, { dir: -1 }),
    donchian: donchianBreakout,
    rsi2: rsi2Reversion,
    pullback: maPullback,
  };
  const detect = DETECTORS[pattern];
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);

  const { buildMacroLookup } = require('../lib/macro');
  const [spyD, macro] = await Promise.all([
    fetchDailyHistory('SPY', range),
    buildMacroLookup(range).catch(() => null),
  ]);
  const spyClose = {};
  if (spyD) spyD.candles.forEach(c => { spyClose[c.date] = c.close; });
  const regimeAt = date => (macro ? (macro.at(date) || {}).regime || 'unknown' : 'unknown');

  const t0 = Date.now(), deadline = 50000;
  const blank = () => ({ CONFIRMED: [], EMERGING: [], WATCH: [] });
  const byTier = blank();
  const byRegime = { 'risk-on': blank(), neutral: blank(), 'risk-off': blank(), unknown: blank() };
  let i = 0, signals = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < 120) continue;
      const c = d.candles; let lastSig = -99;
      for (let k = 80; k < c.length - H; k++) {
        if (k - lastSig < 10) continue;                          // dedup overlapping signals
        const v = detect(c.slice(0, k + 1)); if (!v) continue;
        lastSig = k;
        const entry = c[k].close, fwd = ((c[k + H].close - entry) / entry) * 100;
        let exc = null;
        if (spyClose[c[k].date] != null && spyClose[c[k + H].date] != null) {
          const sret = ((spyClose[c[k + H].date] - spyClose[c[k].date]) / spyClose[c[k].date]) * 100;
          exc = fwd - sret;
        }
        if (!byTier[v.tier]) continue;
        const rec = { fwd, exc };
        byTier[v.tier].push(rec);
        byRegime[regimeAt(c[k].date)][v.tier].push(rec);
        signals++;
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  const avg = a => (a.length ? a.reduce((s, b) => s + b, 0) / a.length : null);
  const summ = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const fwd = arr.map(x => x.fwd), exc = arr.filter(x => x.exc != null).map(x => x.exc);
    const win = fwd.filter(x => x > 0).length;
    const longBeat = exc.filter(x => x > 0).length, longCi = exc.length ? wilson(longBeat, exc.length) : { lo: 0 };
    // FADE = short the signal (vs long SPY). Wins when the stock UNDERperforms SPY.
    const fadeBeat = exc.filter(x => x < 0).length, fadeCi = exc.length ? wilson(fadeBeat, exc.length) : { lo: 0 };
    const nakedShortWin = fwd.filter(x => x < 0).length;
    return {
      n,
      long: {
        winRate: +((win / n) * 100).toFixed(0), avgFwd: +avg(fwd).toFixed(2),
        beatSpyRate: exc.length ? +((longBeat / exc.length) * 100).toFixed(0) : null, wilsonLo: +(longCi.lo * 100).toFixed(0),
        avgExcessVsSpy: exc.length ? +avg(exc).toFixed(2) : null,
      },
      fade: {
        beatsMktRate: exc.length ? +((fadeBeat / exc.length) * 100).toFixed(0) : null, wilsonLo: +(fadeCi.lo * 100).toFixed(0),
        alpha: exc.length ? +(-avg(exc)).toFixed(2) : null,           // market-neutral: short stock + long SPY
        nakedShortAvg: +(-avg(fwd)).toFixed(2), nakedShortWinRate: +((nakedShortWin / n) * 100).toFixed(0),
      },
    };
  };
  const tierSet = obj => ({ CONFIRMED: summ(obj.CONFIRMED), EMERGING: summ(obj.EMERGING), WATCH: summ(obj.WATCH) });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, pattern, horizonDays: H, namesScanned: tickers.length, totalSignals: signals,
    primaryTrade: (pattern === 'invertedv' || pattern === 'sweepshort')
      ? 'fade block = the primary SHORT (short stock vs long SPY)'
      : 'long block = the primary trade (buy); fade = short it',
    macroAvailable: !!macro,
    byTier: tierSet(byTier),
    byRegime: {
      'risk-on': tierSet(byRegime['risk-on']),
      neutral: tierSet(byRegime.neutral),
      'risk-off': tierSet(byRegime['risk-off']),
    },
    note: 'Per tier: LONG = buying the V (loses); FADE = shorting it vs long SPY. fade.beatsMktRate Wilson LB > 50% = real relative edge. byRegime splits the SAME signals by the as-of macro regime — a durable fade must keep fade.wilsonLo > 50% in NEUTRAL and RISK-OFF, not only risk-on (the artifact that killed exits/PEAD/conviction). fade.nakedShortAvg = naked short P&L (negative in bull tape even with alpha).',
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

// ── op=fadeopt : can the inverted-V SHORT be made to actually work? ─────────
// Honest optimization of the fade: (A) does signal "stretch" (how extreme the top
// is) predict bigger fade wins, and (B) does PER-STOCK selection generalize OUT
// OF SAMPLE? Stock selection is tested with a PURGED train/test split + Bayesian
// shrinkage of each stock's train hit-rate toward the global prior (so we don't
// just chase in-sample winners). Regime-gated to risk-on/neutral throughout (the
// proven lever). beatMkt for a SHORT = the stock UNDERperforms SPY (exc < 0).
// 🧪 Screener-tracker handlers (fade/trend/daytrade/confluence) live in
// lib/screener-routes.js — imported at top, dispatched below.


// 🔮 Predict-suite handlers (predict/brief/crowd/sharp/tape/alerts) live in
// lib/predict-routes.js — imported at top, dispatched below.

// ── op=archive : snapshot today's per-ticker mention counts + options ───────
// THE unrecoverable data capture. Social-mention counts (StockTwits trending)
// and option-chain snapshots can't be reconstructed historically, so we persist
// one panel per day. Universe = today's socially-trending names (the natural
// join key for a mentions × options study). One Blob write per run.
async function fetchTrendingStockTwits() {
  try {
    const r = await fetch('https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    return (await r.json()).symbols || [];
  } catch { return []; }
}

async function runArchive(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date } = nowET();
  const ts = Date.now();

  const trending = await fetchTrendingStockTwits();
  // Each trending symbol carries the social-mention proxy (watchlist_count) and
  // its rank in the trending list (1 = hottest right now).
  const base = trending.map((s, i) => ({
    ticker: String(s.symbol || '').toUpperCase(),
    company: s.title || null,
    mentions: s.watchlist_count || 0,     // StockTwits watchers — the mention-count proxy
    trendRank: i + 1,
  })).filter(r => r.ticker);

  // Attach a numeric options baseline per name (Yahoo chain, nearest expiry).
  let i = 0;
  async function worker() {
    while (i < base.length) {
      const idx = i++;
      try { base[idx].options = await fetchOptionsBaseline(base[idx].ticker); }
      catch { base[idx].options = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, base.length) }, worker));

  const withOpts = base.filter(r => r.options).length;
  let url = null, err = null;
  try {
    const r = await writeArchiveDay(date, base, { ts, source: 'stocktwits+yahoo-options', count: base.length, withOptions: withOpts });
    url = r.url;
  } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, count: base.length, withOptions: withOpts, url, error: err, at: new Date().toISOString() });
}

// ── op=insideringest : receive EDGAR Form 4 history from the external builder ─
// The full-universe EDGAR pull is too slow for a Vercel function, so an external
// box (lib/edgar via scripts/build-insider.js) builds it and POSTs per-ticker
// transaction lists here. Merges per ticker into apex/insider.json.
async function runInsiderIngest(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const token = process.env.INSIDER_INGEST_TOKEN;
  if (token && (req.headers['x-ingest-token'] || req.query.token) !== token) {
    return res.status(401).json({ ok: false, error: 'bad ingest token' });
  }
  const doc = (await readInsider()) || { tickers: {} };
  if (!doc.tickers) doc.tickers = {};
  if (req.query.reset === '1') { doc.tickers = {}; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  // Accept { tickers: { T: [txs] } } (bulk) or { ticker, txs } (single).
  const bulk = body && body.tickers && typeof body.tickers === 'object' ? body.tickers
    : (body && body.ticker && Array.isArray(body.txs)) ? { [String(body.ticker).toUpperCase()]: body.txs } : null;
  if (!bulk) return res.status(400).json({ ok: false, error: 'expected JSON { tickers:{T:[txs]} } or { ticker, txs:[] }' });

  let merged = 0, txCount = 0;
  for (const t in bulk) {
    if (!Array.isArray(bulk[t])) continue;
    doc.tickers[t.toUpperCase()] = bulk[t];   // replace that ticker's history wholesale
    merged++; txCount += bulk[t].length;
  }
  doc.updatedAt = new Date().toISOString();
  let err = null;
  try { await writeInsider(doc); } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, mergedTickers: merged, txReceived: txCount, totalTickers: Object.keys(doc.tickers).length, error: err });
}

// ── op=insider : coverage snapshot of the stored EDGAR insider history ───────
async function runInsider(req, res) {
  const doc = (await readInsider()) || { tickers: {} };
  const tickers = doc.tickers || {};
  const names = Object.keys(tickers);
  const withTx = names.filter(t => Array.isArray(tickers[t]) && tickers[t].length);
  const totalTx = names.reduce((s, t) => s + (Array.isArray(tickers[t]) ? tickers[t].length : 0), 0);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, updatedAt: doc.updatedAt || null,
    tickers: names.length, withTransactions: withTx.length, totalTransactions: totalTx,
    sample: withTx.slice(0, 8).map(t => ({ ticker: t, txs: tickers[t].length })),
  });
}

// ── op=fundbuild : resumable server-side build of point-in-time fundamentals ─
// Finnhub key is server-side only, so (unlike EDGAR) this runs ON Vercel. Free
// Finnhub is ~60 req/min, so we throttle and TIME-BOX each call, checkpointing to
// Blob and returning a cursor; re-invoke with ?start=<nextStart> until done.
//   GET /api/tracker?op=fundbuild&scope=large&limit=80[&start=0&reset=1]
async function runFundBuild(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.FINNHUB_API_KEY) return res.status(200).json({ ok: false, error: 'FINNHUB_API_KEY missing' });
  const scope = (req.query.scope || 'large').toLowerCase();
  const list = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  const universe = [...new Set(list)].slice(0, limit || list.length);
  const start = Math.max(0, parseInt(req.query.start, 10) || 0);
  const throttle = Math.max(0, parseInt(req.query.throttle, 10) || 1100);  // ~60/min default
  const deadline = 45000, t0 = Date.now();

  // Each call builds an INDEPENDENT shard (no shared-doc read-modify-write → no
  // lost-update race). The shard key is pinned to `start`, so re-running a batch
  // just overwrites its own shard idempotently.
  const batch = {};
  let i = start, fetched = 0, withSeries = 0;
  for (; i < universe.length; i++) {
    if (Date.now() - t0 > deadline) break;
    const t = universe[i];
    try {
      const series = await fetchQuarterlySeries(t);
      batch[t] = series || [];
      fetched++; if (series && series.length) withSeries++;
    } catch { batch[t] = []; }
    if (throttle && i < universe.length - 1) await new Promise(r => setTimeout(r, throttle));
  }
  let err = null;
  try { await writeFundShard(`${scope}-${String(start).padStart(5, '0')}`, batch); } catch (e) { err = String(e && e.message || e); }
  const done = i >= universe.length;
  return res.status(err ? 502 : 200).json({
    ok: !err, scope, universe: universe.length, shard: `${scope}-${String(start).padStart(5, '0')}`,
    processedThisCall: fetched, withSeries, nextStart: done ? null : i, done, error: err,
  });
}

// ── op=fundamentals : coverage snapshot of stored quarterly series ──────────
async function runFundamentals(req, res) {
  const doc = (await readFundamentals()) || { tickers: {} };
  const t = doc.tickers || {};
  const names = Object.keys(t);
  const withSeries = names.filter(k => Array.isArray(t[k]) && t[k].length);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, updatedAt: doc.updatedAt || null, tickers: names.length, withSeries: withSeries.length,
    sample: withSeries.slice(0, 8).map(k => ({ ticker: k, quarters: t[k].length, latest: t[k][t[k].length - 1].period })),
  });
}

// ── op=cerntick : run one CERN daily cycle (detect + tick) and persist ──────
// Loads engine state, scans the universe for forced-flow events, advances the
// ledger, resolves matured signals (the Bayesian learning), and saves. Triggered
// by the warm cron. The archive is the moat — persisted, never pruned.
async function runCernTickOp(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    const state = await readCern();
    const cern = state ? CERN.load(state) : new CERN();
    const { runCernTick } = require('../lib/cern-run');
    const summary = await runCernTick(cern, { nowMs: Date.now() });
    let err = null;
    try { await writeCern(cern.s); } catch (e) { err = String(e && e.message || e); }
    return res.status(err ? 502 : 200).json({ ok: !err, ...summary, error: err, at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'CERN tick failed: ' + (e && e.message || e) });
  }
}

// ── op=cern : engine state for the ⚡ Events tab ────────────────────────────
async function runCern(req, res) {
  const state = await readCern();
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  if (!state) return res.json({ ok: true, configured: false, note: 'CERN has not run yet — the warm cron will populate it.' });
  const cern = CERN.load(state);
  const open = cern.s.ledger.filter(e => e.status === 'SIGNALED' && e.signal).map(e => ({
    id: e.id, symbol: e.symbol, type: e.type, action: e.signal.action, side: e.signal.side,
    entry: +(e.signal.entryPrice || 0).toFixed(2), stop: e.signal.stop != null ? +e.signal.stop.toFixed(2) : null,
    target: e.signal.target != null ? +e.signal.target.toFixed(2) : null,
    predMu: +e.signal.predMu.toFixed(3), pProfit: +e.signal.pProfit.toFixed(2),
    size: +(e.signal.size || 0).toFixed(4), horizon: e.signal.horizon, regime: e.signal.regime, dateMs: e.signal.dateMs,
  }));
  return res.json({
    ok: true, configured: true,
    posteriors: cern._posteriorSummary(),
    open, pendingCount: cern.s.ledger.filter(e => e.status === 'PENDING').length,
    archiveCount: cern.s.archive.length,
    candidates: cern.s.candidates.slice(-10),
    drift: cern.s.changeLog.filter(c => c.type === 'DRIFT').slice(-10),
    explorationBudget: cern.s.explorationBudget,
  });
}

// ── op=cernfsprobe : read-only health check for the FIRE_SALE feed ─────────
// Confirms the FMP etf-holder source works on this key (the one piece that can't
// be tested without server-side creds) and shows current outflow status per ETF.
// Does NOT touch CERN state. ?etf=ARKK to probe a specific fund's holdings.
async function runCernFsProbe(req, res) {
  const { FIRESALE_ETFS, fetchEtfHoldings, detectEtfOutflow } = require('../lib/firesale');
  res.setHeader('Cache-Control', 'no-store');
  const probeEtf = (req.query.etf || 'ARKK').toUpperCase();
  // ?sim=1 dry-runs the full 3d pipeline with loosened thresholds against live
  // ETF bars (read-only — never writes CERN state) to prove the integrated chain:
  // outflow → holdings → aggregated forced names. Calm tape won't trip real gates,
  // so this is the only way to exercise the end-to-end path without a real dump.
  if (req.query.sim === '1') {
    const stressed = [];
    await Promise.all(FIRESALE_ETFS.map(async e => {
      try {
        const d = await fetchDailyHistory(e, '1y'); if (!d) return;
        const bars = d.candles.map(b => ({ ...b, dateMs: Date.parse(b.date + 'T00:00:00Z') }));
        const o = detectEtfOutflow(bars, { dropMin: 0.0, volRatioMin: 1.0 }); // loosened
        if (o) stressed.push({ etf: e, ...o });
      } catch {}
    }));
    const forced = new Map();
    for (const s of stressed) {
      const hs = await fetchEtfHoldings(s.etf);
      for (const h of hs) { if (h.weight < 0.02) continue; const cur = forced.get(h.ticker) || { dollars: 0, etfs: [] }; cur.dollars += h.weight * s.redeemedDollars; cur.etfs.push(s.etf); forced.set(h.ticker, cur); }
    }
    const ranked = [...forced.entries()].sort((a, b) => b[1].dollars - a[1].dollars).slice(0, 15);
    return res.json({ ok: true, sim: true, note: 'loosened thresholds, read-only — proves the chain, NOT real signals',
      stressedEtfs: stressed.map(s => ({ etf: s.etf, dumpPct: s.dumpPct, volRatio: s.volRatio })),
      forcedNames: ranked.map(([t, f]) => ({ t, forcedDollarsM: +(f.dollars / 1e6).toFixed(1), etfs: f.etfs })) });
  }
  let holdings = [];
  try { holdings = await fetchEtfHoldings(probeEtf); } catch (e) {}
  const outflow = {};
  await Promise.all(FIRESALE_ETFS.map(async e => {
    try { const d = await fetchDailyHistory(e, '1y'); if (d) { const o = detectEtfOutflow(d.candles.map((b, i, a) => ({ ...b, dateMs: Date.parse(b.date + 'T00:00:00Z') }))); outflow[e] = o ? { dumpPct: o.dumpPct, volRatio: o.volRatio } : null; } } catch { outflow[e] = 'fetch-failed'; }
  }));
  return res.json({
    ok: true,
    holdingsSource: { etf: probeEtf, source: 'yahoo-topHoldings', count: holdings.length, top: holdings.sort((a, b) => b.weight - a.weight).slice(0, 10).map(h => ({ t: h.ticker, w: +(h.weight * 100).toFixed(2) })) },
    outflow,
  });
}

// ── op=cernlockprobe : read-only health check for the LOCKUP_EXPIRY feed ───
// Joins the IPO-lockup calendar with each name's trailing avg daily dollar
// volume so the liquidity floor (lib/cern-run MIN_LOCKUP_DOLLAR_VOL) can be
// tuned against real data. Does NOT touch CERN state. ?floor=<usd> to test a cut.
async function runCernLockProbe(req, res) {
  const { fetchLockupExpiries } = require('../lib/ipo');
  res.setHeader('Cache-Control', 'no-store');
  const floor = Number(req.query.floor) || 3_000_000;
  let locks = [];
  try { locks = await fetchLockupExpiries({ nowMs: Date.now() }); } catch (e) {}
  const rows = [];
  let i = 0;
  const worker = async () => {
    while (i < locks.length) {
      const l = locks[i++];
      try {
        const d = await fetchDailyHistory(l.ticker, '1y');
        if (!d || d.candles.length < 30) { rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: null, bars: false }); continue; }
        const w = d.candles.slice(-40);
        const adv = w.reduce((s, b) => s + (b.close || 0) * (b.volume || 0), 0) / w.length;
        rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: +(adv / 1e6).toFixed(2), bars: true });
      } catch { rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: null, bars: false }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, locks.length) }, worker));
  rows.sort((a, b) => (b.advUsdM || 0) - (a.advUsdM || 0));
  const withBars = rows.filter(r => r.bars);
  const countsByFloor = {};
  for (const f of [1, 3, 5, 10]) countsByFloor['ge_' + f + 'M'] = withBars.filter(r => r.advUsdM >= f).length;
  return res.json({
    ok: true, found: locks.length, withBars: withBars.length,
    floorUsd: floor, passFloor: withBars.filter(r => r.advUsdM * 1e6 >= floor).length,
    countsByFloor, rows,
  });
}

// ── op=drift : resolve outcomes + live-vs-baseline health (Module 3) ───────
// Resolution runs against each signal's OWN logged stop/target (lib/outcome),
// so the ledger measures the strategy you'd actually trade — not a fixed barrier.
const resolveApex = (candles, sig) => resolveTrade(candles, sig.date, sig.entry, sig.stop, sig.target);

// Wilson score interval for a binomial proportion (z=1.645 → ~90%).

function aggApex(arr) {
  const n = arr.length;
  if (!n) return { n: 0, winRate: null, profitFactor: null, wins: 0, losses: 0, expired: 0, wonCount: 0 };
  const wins = arr.filter(s => s.won);
  const sumWin = arr.filter(s => s.r > 0).reduce((a, s) => a + s.r, 0);
  const sumLoss = Math.abs(arr.filter(s => s.r <= 0).reduce((a, s) => a + s.r, 0));
  const ci = wilson(wins.length, n);
  return {
    n,
    winRate: Math.round((wins.length / n) * 100),
    winRateCI: { lo: Math.round(ci.lo * 100), hi: Math.round(ci.hi * 100), level: 90 },
    wonCount: wins.length,
    profitFactor: sumLoss > 0 ? +(sumWin / sumLoss).toFixed(2) : (sumWin > 0 ? 99 : 0),
    wins: arr.filter(s => s.outcome === 'WIN').length,
    losses: arr.filter(s => s.outcome === 'LOSS').length,
    expired: arr.filter(s => s.outcome === 'EXPIRED').length,
  };
}

const btRegimeOf = regime => (regime === 'RISK_OFF' ? 'off' : 'on'); // backtest split is binary (SPY vs 200-DMA)
const winRateOf = arr => (arr.length ? Math.round((arr.filter(s => s.won).length / arr.length) * 100) : null);
const pfOf = arr => { let w = 0, l = 0; arr.forEach(s => { if (s.r > 0) w += s.r; else l += Math.abs(s.r); }); return l > 0 ? +(w / l).toFixed(2) : (w > 0 ? 99 : 0); };

// Baseline for drift. PREFERRED: the historical backfill seed, which resolves
// with the EXACT same lib/outcome rule against the same logged levels as the live
// ledger — so the comparison is apples-to-apples. Weighted by the live window's
// regime mix. Falls back to the ATR backtest only if no seed exists.
function baselineFor(window, seed, bt) {
  const seedSignals = seed && Array.isArray(seed.signals) ? seed.signals : null;
  if (seedSignals && seedSignals.length >= 50) {
    const byReg = { RISK_ON: [], NEUTRAL: [], RISK_OFF: [] };
    seedSignals.forEach(s => { if (byReg[s.regime]) byReg[s.regime].push(s); });
    const mix = { RISK_ON: 0, NEUTRAL: 0, RISK_OFF: 0 };
    window.forEach(s => { if (mix[s.regime] != null) mix[s.regime]++; });
    let wSum = 0, wr = 0, pf = 0;
    for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
      const seg = byReg[R]; if (!seg.length || !mix[R]) continue;
      const segWR = winRateOf(seg), segPF = pfOf(seg);
      if (segWR == null) continue;
      wr += segWR * mix[R]; pf += segPF * mix[R]; wSum += mix[R];
    }
    if (wSum) return { winRate: Math.round(wr / wSum), profitFactor: +(pf / wSum).toFixed(2), source: 'historical seed · by regime (same resolution as live)' };
    // No regime overlap → seed overall.
    const all = Object.values(byReg).flat();
    return { winRate: winRateOf(all), profitFactor: pfOf(all), source: 'historical seed · overall (same resolution as live)' };
  }
  // Fallback: ATR backtest (methodology differs — flagged in the UI).
  if (!bt || !bt.regimeSplit) return null;
  const counts = { on: 0, off: 0 };
  window.forEach(s => counts[btRegimeOf(s.regime)]++);
  let wSum = 0, wr = 0, pf = 0;
  for (const k of ['on', 'off']) {
    const seg = bt.regimeSplit[k];
    if (!seg || !seg.n || !counts[k]) continue;
    wr += seg.winRate * counts[k]; pf += seg.profitFactor * counts[k]; wSum += counts[k];
  }
  if (!wSum) { const o = bt.overall || {}; return { winRate: o.winRate ?? null, profitFactor: o.profitFactor ?? null, source: 'ATR backtest · overall (different methodology)' }; }
  return { winRate: Math.round(wr / wSum), profitFactor: +(pf / wSum).toFixed(2), source: 'ATR backtest · by regime (different methodology)' };
}

function regimeMix(arr) {
  const m = { RISK_ON: 0, NEUTRAL: 0, RISK_OFF: 0 };
  arr.forEach(s => { if (m[s.regime] != null) m[s.regime]++; });
  return m;
}

// Read the whole ledger, dedupe to first-appearance per ticker:tier, resolve
// each signal's outcome. A terminal outcome (WIN/LOSS/EXPIRED) never changes, so
// it's cached in apex/resolved.json — only OPEN/uncached signals trigger a price
// fetch, keeping drift + recalibrate cheap as the ledger grows. Shared by both.
const ledgerKey = s => `${s.ticker}|${s.tier}|${s.date}`;

async function resolveLedger() {
  const raw = await readAllApex();
  const firstSeen = new Map();
  for (const s of [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const key = `${s.ticker}:${s.tier}`;
    if (!firstSeen.has(key)) firstSeen.set(key, s);
  }
  const sigs = [...firstSeen.values()];

  const cache = await readResolved();
  // Only fetch history for tickers that still have an uncached signal.
  const need = [...new Set(sigs.filter(s => !cache[ledgerKey(s)]).map(s => s.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => { while (i < need.length) { const t = need[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ } } };
  await Promise.all(Array.from({ length: Math.min(8, need.length) }, worker));

  const resolved = [];
  let openCount = 0, cacheChanged = false;
  for (const s of sigs) {
    let r = cache[ledgerKey(s)];
    if (!r) {
      const candles = hist.get(s.ticker);
      if (!candles) { openCount++; continue; }
      const out = resolveApex(candles, s);
      if (out.outcome === 'OPEN') { openCount++; continue; }
      r = { outcome: out.outcome, r: out.r, hold: out.hold, exitDate: out.exitDate };
      cache[ledgerKey(s)] = r; cacheChanged = true; // cache terminal outcomes only
    }
    resolved.push({ ...s, ...r, won: r.outcome === 'WIN' || (r.outcome === 'EXPIRED' && r.r > 0) });
  }
  if (cacheChanged) { try { await writeResolved(cache); } catch { /* best-effort */ } }
  return { sigs, resolved, openCount };
}

async function runDrift(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: false, status: 'PENDING', note: 'Blob storage not configured.', resolvedCount: 0, generatedAt: new Date().toISOString() });
  }
  const { sigs, resolved, openCount } = await resolveLedger();

  if (!sigs.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: true, status: 'PENDING', minSignals: 15, totalSignals: 0, resolvedCount: 0, openCount: 0, note: 'No Apex signals logged yet — the ledger fills as the daily cron runs.', generatedAt: new Date().toISOString() });
  }

  // Trailing 60 calendar days of resolved signals; fall back to all resolved
  // while the ledger is still young so the panel isn't empty.
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  let window = resolved.filter(s => s.date >= cutoff);
  if (window.length < 15 && resolved.length > window.length) window = resolved;

  const live = aggApex(window);

  let baseline = null;
  try {
    const seed = await readBackfill();
    const bt = (seed && Array.isArray(seed.signals) && seed.signals.length >= 50) ? null : await getJSON('/api/backtest?scope=large&months=12');
    baseline = baselineFor(window, seed, bt);
  } catch { /* baseline unavailable */ }

  // Asymmetric, sample-aware status:
  //  • BROKEN (drastic — auto-recalibrates) needs the Wilson UPPER bound below
  //    baseline−15, so a small noisy sample can't trip a false alarm.
  //  • DEGRADING (soft "reduce size" heads-up) uses the point estimate below
  //    baseline−5, so it warns early without over-reacting.
  let status = 'PENDING';
  if (window.length >= 15 && baseline && baseline.winRate != null) {
    const base = baseline.winRate;
    status = live.winRateCI.hi < base - 15 ? 'BROKEN'
           : live.winRate < base - 5 ? 'DEGRADING'
           : 'HEALTHY';
  }

  // Failure forensics — group losses by their dominant (highest) pillar.
  const fails = window.filter(s => s.outcome === 'LOSS');
  const byProfile = {};
  for (const s of fails) {
    const pl = s.pillars || {};
    const dom = apex.KEYS.reduce((best, k) => ((pl[k] ?? 0) > (pl[best] ?? -1) ? k : best), 'p1');
    (byProfile[dom] = byProfile[dom] || { key: dom, label: apex.PILLAR_LABEL[dom], count: 0 }).count++;
  }
  const forensics = Object.values(byProfile)
    .map(p => ({ ...p, pct: fails.length ? Math.round((p.count / fails.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // Win rate by narrative tag (observational; "significant" once a tag has ≥30).
  const byTag = {};
  for (const s of window) {
    const tag = s.narrativeTag || 'UNTAGGED';
    const g = byTag[tag] || (byTag[tag] = { tag, n: 0, wins: 0 });
    g.n++; if (s.won) g.wins++;
  }
  const narrativeBreakdown = Object.values(byTag)
    .map(g => ({ tag: g.tag, n: g.n, winRate: Math.round((g.wins / g.n) * 100), significant: g.n >= 30 }))
    .sort((a, b) => b.n - a.n);

  // Active recalibrated model (if any) + standing ablation-review flags.
  const model = await readModel();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  const narrative = await readNarrative();

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.json({
    configured: true,
    status,
    minSignals: 15,
    totalSignals: sigs.length,
    resolvedCount: resolved.length,
    windowCount: window.length,
    windowMode: window.length === resolved.length ? 'all-resolved' : 'trailing-60d',
    openCount,
    live,
    baseline,
    regimeMix: regimeMix(window),
    forensics,
    failCount: fails.length,
    narrativeBreakdown,
    narrative,
    model: active ? { id: active.id, label: active.label, effectiveDate: active.effectiveDate } : null,
    ablationFlags: (active && active.ablationFlags) || [],
    recommendRecalibration: status === 'BROKEN',  // auto-recalibration hook (Module 2)
    generatedAt: new Date().toISOString(),
  });
}

// ── op=recalibrate : Module 2 walk-forward re-optimization ─────────────────
function quarterOf(d) { return `${d.getUTCFullYear()}.Q${Math.floor(d.getUTCMonth() / 3) + 1}`; }

// Flag a pillar whose marginal contribution stayed negative across the last two
// recalibrations (review, don't auto-zero).
function ablationFlagsFor(diag, prevVersion) {
  const flags = [];
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const cur = diag.regimes[R];
    if (!cur || !cur.ablation) continue;
    const prevAbl = prevVersion && prevVersion.regimes && prevVersion.regimes[R] && prevVersion.regimes[R].ablation;
    for (const a of cur.ablation) {
      if (a.marginal >= 0) continue;
      const p = prevAbl && prevAbl.find(x => x.key === a.key);
      if (p && p.marginal < 0) flags.push({ regime: R, pillar: a.key, label: a.label, note: 'negative marginal 2 recalibrations running — review' });
    }
  }
  return flags;
}

async function runRecalibrate(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  // Data source: live ledger (default), the historical backfill seed, or both.
  // The backfill's Pillar 3 is synthetic, so any source that includes it pins P3.
  const source = ['live', 'backfill', 'all'].includes(req.query.source) ? req.query.source : 'live';
  const pick = s => ({ regime: s.regime, pillars: s.pillars, status: s.status, date: s.date, won: s.won, r: s.r });
  let dataset = [], resolvedCount = 0;
  if (source !== 'backfill') { const { resolved } = await resolveLedger(); resolvedCount = resolved.length; dataset = dataset.concat(resolved.map(pick)); }
  if (source !== 'live') { const bf = await readBackfill(); if (bf && Array.isArray(bf.signals)) dataset = dataset.concat(bf.signals.map(pick)); }
  const usesBackfill = source !== 'live';
  const diag = recalibrate(dataset, usesBackfill ? { fixed: ['p3'] } : {});
  const resolved = dataset; // for the response counts below

  // Trim per-regime diagnostics for storage (keep weights, PFs, ablation).
  const regimes = {};
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const g = diag.regimes[R];
    regimes[R] = { fitted: g.fitted, reason: g.reason, n: g.n, weights: g.weights, full: g.full, validation: g.validation, ablation: g.ablation };
  }

  const model = await readModel();
  const prev = model.versions[model.versions.length - 1] || null;
  const now = new Date();
  let saved = false, version = null;

  const srcLabel = source === 'backfill' ? 'backfill-seed' : source === 'all' ? 'live+backfill seed' : 'live-ledger';
  if (diag.fittedAny) {
    const n = model.versions.length + 1;
    version = {
      id: `${BASE_VERSION}.${n}`,
      label: `Model ${BASE_VERSION} · recalibrated ${now.toISOString().slice(0, 10)}${usesBackfill ? ' (seed)' : ''}`,
      effectiveDate: now.toISOString().slice(0, 10),
      createdAt: now.toISOString(),
      quarter: quarterOf(now),
      source: srcLabel,
      fixed: usesBackfill ? ['p3'] : [],
      weights: diag.weights,
      regimes,
      fittedAny: true,
      ablationFlags: ablationFlagsFor(diag, prev),
    };
    model.versions.push(version);
    model.activeId = version.id;
  }
  model.lastRun = {
    at: now.toISOString(),
    source: srcLabel,
    samples: dataset.length,
    resolved: resolvedCount,
    fittedAny: diag.fittedAny,
    perRegime: Object.fromEntries(['RISK_ON', 'NEUTRAL', 'RISK_OFF'].map(R => [R, { fitted: regimes[R].fitted, reason: regimes[R].reason, n: regimes[R].n }])),
  };
  let err = null;
  try { await writeModel(model); saved = true; } catch (e) { err = String(e && e.message || e); }

  return res.status(err ? 502 : 200).json({
    ok: !err, saved, error: err,
    source: srcLabel,
    refit: diag.fittedAny,
    activeId: model.activeId,
    version,
    diagnostics: { fittedAny: diag.fittedAny, minSignals: diag.minSignals, regimes },
    totalSamples: dataset.length,
    totalResolved: resolvedCount,
    at: now.toISOString(),
  });
}

// ── op=research : factor-efficacy analysis (which factors predict outcomes) ──
async function runResearchOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const step = Math.min(63, Math.max(5, parseInt(req.query.step, 10) || 10));
  const months = Math.min(18, Math.max(3, parseInt(req.query.months, 10) || 12));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  try {
    const out = await runResearch({ scope, step, months, limit, deadlineMs: 50000 });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, scope, step, months, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=exits : exit-strategy study (which exit makes the edge profitable) ──
async function runExitsOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  try {
    // 5y / quarterly so the regime + out-of-sample breakdown spans a real bear market.
    const out = await runExitStudy({ scope, step: 21, months: 54, range: '5y', deadlineMs: 50000 });
    const doc = { scope, ...out, generatedAt: new Date().toISOString() };
    if (hasStore()) { try { await writeExits(doc); } catch { /* best-effort cache */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...doc });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=longshort : market-neutral selection test (is there security-selection edge?) ──
async function runLongShortOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  try {
    const out = await runLongShort({ scope, step: 21, months: 54, range: '5y', fracs: [0.1, 0.2], deadlineMs: 50000 });
    const doc = { ...out, generatedAt: new Date().toISOString() };
    if (hasStore()) { try { await writeLongShort(doc); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...doc });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=pead : post-earnings-drift test (event-driven edge) ──
async function runPeadOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const months = Math.min(60, Math.max(12, parseInt(req.query.months, 10) || 54));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  try {
    if (req.query.mode === 'reaction') {  // 5y validation via announcement-day reaction proxy
      const rx = await runReactionPEAD({ scope, limit: limit || 150, deadlineMs: 55000 });
      if (hasStore() && rx.horizons && rx.horizons['63']) {
        try { const pd = (await readPead()) || {}; pd.validation5y = { events: rx.events, coverage: rx.coverage, signed63: rx.horizons['63'].signedOverall, top63: rx.horizons['63'].topQuintile, byYear63: rx.horizons['63'].byYear, generatedAt: new Date().toISOString() }; await writePead(pd); } catch {}
      }
      return res.json({ ok: !rx.error, ...rx });
    }
    const out = await runPEAD({ scope, months, limit, perSymbol: req.query.persymbol === '1', datesOnly: req.query.datesonly === '1', deadlineMs: 55000 });
    if (hasStore() && out.horizons && !limit) { try { await writePead({ ...out, scope, generatedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: !out.error, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── Trade-alert ranker ops (raw posts come from an external collector) ───────
// 🐦 X-alerts handlers (alertsingest/alerts/alertsgrade) live in lib/alerts-routes.js.


// ── op=backfill : seed the ledger with historical technical-pillar signals ──
async function runBackfillOp(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const step = Math.min(63, Math.max(5, parseInt(req.query.step, 10) || 10));
  const months = Math.min(18, Math.max(3, parseInt(req.query.months, 10) || 12));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  let out, err = null;
  try {
    out = await runBackfill({ scope, step, months, limit, deadlineMs: 50000 });
    await writeBackfill({ signals: out.signals, stats: out.stats, scope, step, months, generatedAt: new Date().toISOString() });
  } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, error: err, scope, step, months, stats: out && out.stats, at: new Date().toISOString() });
}

// ── op=model : active weights + version + narrative (consumed by the client) ─
async function runModel(req, res) {
  const model = await readModel();
  const narrative = await readNarrative();
  const bf = await readBackfill();
  const exits = await readExits();
  const ls = await readLongShort();
  const pead = await readPead();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.json({
    configured: hasStore(),
    baseVersion: BASE_VERSION,
    active: active ? { id: active.id, label: active.label, effectiveDate: active.effectiveDate, source: active.source, ablationFlags: active.ablationFlags || [] } : null,
    weights: active ? active.weights : null,            // null → client uses static Module 1 presets
    regimes: active ? active.regimes : null,            // per-regime fit detail for the panel
    lastRun: model.lastRun || null,
    narrative,
    backfill: bf ? { signals: (bf.signals || []).length, generatedAt: bf.generatedAt, stats: bf.stats } : null,
    exits: exits ? {
      summary: exits.summary, selections: exits.selections, scope: exits.scope, range: exits.range, generatedAt: exits.generatedAt,
      byRegime: exits.byRegime || null,
      quartersProfitable: exits.byQuarter ? exits.byQuarter.filter(q => q.time63 && q.time63.pf >= 1).length : null,
      quartersTotal: exits.byQuarter ? exits.byQuarter.length : null,
    } : null,
    longshort: ls && ls.fractions && ls.fractions['0.1'] ? { decile: ls.fractions['0.1'], range: ls.range, generatedAt: ls.generatedAt } : null,
    pead: pead && pead.horizons ? { resolvedEvents: pead.resolvedEvents, coverage: pead.coverage, h63: pead.horizons['63'], h21: pead.horizons['21'], validation5y: pead.validation5y || null, generatedAt: pead.generatedAt } : null,
    versionsCount: model.versions.length,
  });
}

// ── op=narrative : weekly dominant-market-narrative tag (sentiment layer) ───
const NARRATIVE_TAGS = ['RATE_CUTS_HOPE', 'RATE_HIKE_FEAR', 'AI_CAPEX', 'EARNINGS_SEASON', 'RECESSION_FEAR', 'INFLATION_FOCUS', 'SOFT_LANDING', 'RISK_RALLY', 'GEOPOLITICS', 'CREDIT_STRESS', 'OTHER'];

function mondayOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay(); // 0=Sun
  x.setUTCDate(x.getUTCDate() - ((day + 6) % 7));
  return x.toISOString().slice(0, 10);
}

async function runNarrative(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const weekOf = mondayOf(new Date());
  const existing = await readNarrative();
  if (existing && existing.weekOf === weekOf && req.query.force !== '1') {
    return res.status(200).json({ ok: true, cached: true, narrative: existing });
  }
  const newsKey = process.env.NEWS_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!newsKey || !anthropicKey) return res.status(200).json({ ok: false, error: 'NEWS_API_KEY / ANTHROPIC_API_KEY not configured.' });

  let titles = [];
  try {
    const q = '"Federal Reserve" OR inflation OR "interest rates" OR recession OR "earnings season" OR "AI spending" OR jobs OR CPI OR "stock market" OR rally OR selloff';
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=40&apiKey=${newsKey}`;
    const r = await fetch(url); const d = await r.json();
    titles = (d.articles || []).map(a => a.title).filter(t => t && t !== '[Removed]').slice(0, 40);
  } catch { /* fall through */ }
  if (!titles.length) return res.status(200).json({ ok: false, error: 'no headlines available' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: anthropicKey });
  const TOOL = {
    name: 'tag_narrative',
    description: 'Identify the single dominant market narrative of the week.',
    input_schema: { type: 'object', properties: {
      tag: { type: 'string', enum: NARRATIVE_TAGS },
      label: { type: 'string', description: '3-5 word human label' },
      summary: { type: 'string', description: 'one-sentence summary' },
    }, required: ['tag', 'label', 'summary'] },
  };
  let input = null;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'tag_narrative' },
      messages: [{ role: 'user', content: `From this week's market headlines, identify the SINGLE dominant market narrative and choose the best tag.\n\nHEADLINES:\n${titles.join('\n')}` }],
    });
    const t = msg.content.find(b => b.type === 'tool_use');
    if (t) input = t.input;
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
  if (!input || !NARRATIVE_TAGS.includes(input.tag)) return res.status(200).json({ ok: false, error: 'no valid tag returned' });

  const narrative = { tag: input.tag, label: input.label, summary: input.summary, weekOf, updatedAt: new Date().toISOString() };
  let err = null;
  try { await writeNarrative(narrative); } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, error: err, narrative });
}

module.exports = async function handler(req, res) {
  if (req.query.op === 'track') return runTrack(req, res);
  if (req.query.op === 'apexlog') return runApexLog(req, res);
  if (req.query.op === 'ghostlog') return runGhostLog(req, res);
  if (req.query.op === 'edgelog') return runEdgeLog(req, res);
  if (req.query.op === 'edgebook') return runEdgeBook(req, res);
  if (req.query.op === 'vreversal') return runVReversal(req, res);
  if (req.query.op === 'vreversaltest') return runVReversalTest(req, res);
  if (req.query.op === 'fadeopt') return runFadeOpt(req, res);
  if (req.query.op === 'fadeseed') return runFadeSeed(req, res);
  if (req.query.op === 'daytrade') return runDaytrade(req, res);
  if (req.query.op === 'daytradetick') return runDaytradeTick(req, res);
  if (req.query.op === 'daytradebook') return runDaytradeBook(req, res);
  if (req.query.op === 'daytradeopt') return runDaytradeOpt(req, res);
  if (req.query.op === 'confluence') return runConfluence(req, res);
  if (req.query.op === 'confluencetick') return runConfluenceTick(req, res);
  if (req.query.op === 'confluencebook') return runConfluenceBook(req, res);
  if (req.query.op === 'confluenceopt') return runConfluenceOpt(req, res);
  if (req.query.op === 'predict') return runPredict(req, res);
  if (req.query.op === 'predicttick') return runPredictTick(req, res);
  if (req.query.op === 'crowd') return runCrowd(req, res);
  if (req.query.op === 'crowdtick') return runCrowdTick(req, res);
  if (req.query.op === 'brief') return runBrief(req, res);
  if (req.query.op === 'brieftick') return runBriefTick(req, res);
  if (req.query.op === 'alertfeed') return runAlertFeed(req, res);
  if (req.query.op === 'tape') return runTape(req, res);
  if (req.query.op === 'fadesignals') return runFadeSignals(req, res);
  if (req.query.op === 'fadetick') return runFadeTick(req, res);
  if (req.query.op === 'fadebook') return runFadeBook(req, res);
  if (req.query.op === 'trendopt') return runTrendOpt(req, res);
  if (req.query.op === 'trend') return runTrend(req, res);
  if (req.query.op === 'trendtick') return runTrendTick(req, res);
  if (req.query.op === 'trendbook') return runTrendBook(req, res);
  if (req.query.op === 'archive') return runArchive(req, res);
  if (req.query.op === 'insideringest') return runInsiderIngest(req, res);
  if (req.query.op === 'insider') return runInsider(req, res);
  if (req.query.op === 'fundbuild') return runFundBuild(req, res);
  if (req.query.op === 'fundamentals') return runFundamentals(req, res);
  if (req.query.op === 'cerntick') return runCernTickOp(req, res);
  if (req.query.op === 'cern') return runCern(req, res);
  if (req.query.op === 'cernfsprobe') return runCernFsProbe(req, res);
  if (req.query.op === 'cernlockprobe') return runCernLockProbe(req, res);
  if (req.query.op === 'drift') return runDrift(req, res);
  if (req.query.op === 'recalibrate') return runRecalibrate(req, res);
  if (req.query.op === 'backfill') return runBackfillOp(req, res);
  if (req.query.op === 'research') return runResearchOp(req, res);
  if (req.query.op === 'exits') return runExitsOp(req, res);
  if (req.query.op === 'longshort') return runLongShortOp(req, res);
  if (req.query.op === 'pead') return runPeadOp(req, res);
  if (req.query.op === 'alertsingest') return runAlertsIngest(req, res);
  if (req.query.op === 'alerts') return runAlerts(req, res);
  if (req.query.op === 'alertsgrade') return runAlertsGrade(req, res);
  if (req.query.op === 'model') return runModel(req, res);
  if (req.query.op === 'narrative') return runNarrative(req, res);
  return runScoreboard(req, res);
};
