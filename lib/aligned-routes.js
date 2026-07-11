const { internalHeaders } = require('./auth');
// op=aligned — "Dual Confirmed" scan: names that are a BUY on BOTH horizons
// (trend-continuation), ranked by conviction.
//
// TWO-STAGE, FULL-MARKET:
//   Stage 1 — read the long-term trend for the WHOLE universe (large+small+micro)
//             straight from the daily candle cache the screener warm already built
//             (no re-fetching), keep only the long-term-bullish names, strongest first.
//   Stage 2 — run the intraday short-term signal ONLY on that shortlist (top-N by
//             long-term score) and keep the ones that are also a short-term buy.
// This scans the entire market on the long side while bounding the expensive
// intraday step. Falls back to the warm screener pool if the candle cache is cold.

const { isAligned, rankAligned, selectLongTermBullish } = require('./aligned');

const SCOPES = ['large', 'small', 'micro', 'expanded'];   // 'expanded' = the free full-market universe (Phase 2)
const STAGE2_MAX = 90;         // intraday confirmations to run (top long-term names)
const SCAN_BUDGET_MS = 45000;  // stay under the function wall
const FALLBACK_MAX = 44;
const stStrong = a => a === 'STRONG_BUY' || a === 'BUY';

function hostFrom(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
}

// Build the full-universe daily-candle list from the per-scope candle caches.
async function universeFromCache() {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const seen = new Set();
  const universe = [];
  for (const scope of SCOPES) {
    const doc = await loadCandleCache(scope);
    if (!doc || !doc.data) continue;
    for (const ticker of Object.keys(doc.data)) {
      const tk = ticker.toUpperCase();
      if (seen.has(tk)) continue;
      const entry = cacheGet(doc, ticker);
      if (!entry || !entry.candles || entry.candles.length < 60) continue;
      seen.add(tk);
      universe.push({ ticker: tk, company: entry.meta.shortName || entry.meta.longName || tk, candles: entry.candles });
    }
  }
  return universe;
}

// Fallback pool (warm screener candidates) when the candle cache isn't available.
async function screenerPool(host) {
  const out = new Map();
  await Promise.all(['large', 'small'].map(async scope => {
    try {
      const r = await fetch(`https://${host}/api/screener?scope=${scope}`, { headers: internalHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      for (const c of (j.results || [])) {
        const tk = (c.ticker || '').toUpperCase();
        if (tk && !out.has(tk)) out.set(tk, { ticker: tk, company: c.company || tk, candles: null, levels: c.levels || null });
      }
    } catch { /* skip */ }
  }));
  return [...out.values()].slice(0, FALLBACK_MAX);
}

async function runAligned(req, res) {
  const { analyze } = require('./signal');
  const { fetchDailyHistory } = require('./screener');
  const { readJSON } = require('./store');
  const { tradeLevels } = require('./levels');

  const [spy, weightsDoc, universe] = await Promise.all([
    fetchDailyHistory('SPY', '1y').catch(() => null),
    readJSON('dualread/groupweights.json', null).catch(() => null),
    universeFromCache().catch(() => []),
  ]);
  const spyC = spy && spy.candles;

  // ── Stage 1: full-universe long-term filter (from the cache) ──
  let shortlist = [], longTermBullish = 0;
  let scanned = universe.length, stage = 'full-market';
  if (spyC && universe.length) {
    const ltAll = selectLongTermBullish(universe, spyC, weightsDoc);
    longTermBullish = ltAll.length;
    shortlist = ltAll.slice(0, STAGE2_MAX);   // confirm the strongest long-term names first
  }

  // Fallback: candle cache cold → confirm the warm screener pool the old way.
  let fallbackLevels = {};
  if (!shortlist.length) {
    stage = 'screener-pool';
    const pool = await screenerPool(hostFrom(req));
    scanned = pool.length;
    shortlist = pool.map(p => ({ ticker: p.ticker, company: p.company, candles: null, lt: null, price: null }));
    fallbackLevels = Object.fromEntries(pool.map(p => [p.ticker, p.levels]));
  }

  // ── Stage 2: intraday short-term confirmation on the shortlist only ──
  const t0 = Date.now();
  const items = []; let i = 0, confirmed = 0;
  const worker = async () => {
    while (i < shortlist.length) {
      const cand = shortlist[i++];
      if (Date.now() - t0 > SCAN_BUDGET_MS) return;
      try {
        // Cache path already has the long-term read → only need the intraday signal
        // (light = no daily re-fetch). Fallback path has neither → full analyze.
        const r = await analyze(cand.ticker, cand.lt ? { light: true } : {});
        if (!r || !r.live) continue;
        confirmed++;
        if (!stStrong(r.live.action)) continue;

        const lt = cand.lt || r.longTerm;
        if (!lt) continue;
        const dual = require('./longterm').combineDualRead(r.live.action, lt.trend);
        if (!isAligned(dual)) continue;

        const P = r.price || {};
        const price = P.live || cand.price;
        let levels = fallbackLevels[cand.ticker] || null;
        if (!levels && cand.candles && price) {
          const L = tradeLevels(cand.candles, price, { bullish: true, targetMode: 'measured' });
          if (L) levels = { entry: +price.toFixed(2), stop: L.stop, target: L.resistance };
        }
        items.push({
          ticker: r.ticker, company: cand.company, price,
          // How it's trading today: regular-session price + day change + any extended move.
          regularPrice: P.regular ?? null,
          change: P.regChange ?? null,
          changePct: P.regChangePct ?? null,
          prevClose: P.previousClose ?? null,
          afterHours: P.afterHours || null,
          stAction: r.live.action, stConf: r.live.confidence,
          ltTrend: lt.trend, ltScore: lt.score, group: lt.group || cand.group || null,
          levels,
          stReasons: (r.live.reasons || []).slice(0, 2),
          ltReasons: (lt.reasons || []).slice(0, 2),
        });
      } catch { /* skip name */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const picks = rankAligned(items);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    picks,
    stage,                       // 'full-market' or 'screener-pool' (cache cold)
    scanned,                     // universe size scanned on the long side
    longTermBullish,             // names that passed the long-term filter
    stage2Confirmed: confirmed,  // intraday checks actually run
    qualified: picks.length,
    generatedAt: new Date().toISOString(),
    note: 'Names that are a BUY on BOTH horizons — the short-term signal AND the ~1y trend both bullish (trend-continuation), ranked by conviction. Full-market: the long-term filter runs over the whole universe, then the short-term signal confirms the strongest long-term names.',
  });
}

const ALIGNED_H = 21;   // ~1 month — Dual Confirmed is a swing/position setup

// op=alignedlog — cron: snapshot today's Dual Confirmed picks (entry + conviction)
// to the ledger so the tab is accountable.
async function runAlignedLog(req, res) {
  const { hasStore, writeAlignedDay } = require('./store');
  const { nowET } = require('./stats');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const date = nowET().date;   // ET calendar date 'YYYY-MM-DD'
  let picks = [];
  try {
    const r = await fetch(`https://${hostFrom(req)}/api/tracker?op=aligned`, { headers: internalHeaders() });
    const j = await r.json();
    picks = (j.picks || []).filter(p => p.price != null).map(p => ({
      ticker: p.ticker, entry: p.price, conviction: p.conviction, ltScore: p.ltScore, stConf: p.stConf,
    }));
  } catch (e) { return res.json({ ok: false, error: String(e && e.message || e) }); }
  if (picks.length) await writeAlignedDay(date, picks);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged: picks.length });
}

// op=alignedbook — resolve logged picks to forward excess-vs-SPY, overall + by
// conviction tier. First-appearance per ticker (no double-counting a persistent pick).
async function runAlignedBook(req, res) {
  const { readAllAlignedDays } = require('./store');
  const { fetchDailyHistory } = require('./screener');
  const { wilson } = require('./stats');
  const H = Math.max(1, parseInt(req.query.h, 10) || ALIGNED_H);
  const days = await readAllAlignedDays();

  const seen = new Set();
  const entries = [];
  for (const d of days) for (const p of (d.picks || [])) {
    if (seen.has(p.ticker)) continue; seen.add(p.ticker);
    entries.push({ ...p, date: d.date });
  }

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyC = spy && spy.candles;
  const afterN = (c, date, n) => { const idx = c.findIndex(x => x.date >= date); if (idx < 0 || idx + n >= c.length) return null; return { c0: c[idx].close, c1: c[idx + n].close }; };

  const uniq = [...new Set(entries.map(e => e.ticker))];
  const candle = {};
  let j = 0;
  const worker = async () => { while (j < uniq.length) { const tk = uniq[j++]; try { const d = await fetchDailyHistory(tk, '1y'); candle[tk] = d && d.candles; } catch { candle[tk] = null; } } };
  await Promise.all(Array.from({ length: 6 }, worker));

  const resolved = []; let open = 0;
  for (const e of entries) {
    const c = candle[e.ticker];
    if (!c || !spyC) { open++; continue; }
    const st = afterN(c, e.date, H), m = afterN(spyC, e.date, H);
    if (!st || !m) { open++; continue; }
    const exc = ((st.c1 - st.c0) / st.c0 - (m.c1 - m.c0) / m.c0) * 100;
    resolved.push({ ...e, exc, beat: exc > 0 });
  }

  const summarize = arr => {
    const n = arr.length; if (!n) return null;
    const beats = arr.filter(x => x.beat).length; const ci = wilson(beats, n);
    return { n, avgExc: +(arr.reduce((s, x) => s + x.exc, 0) / n).toFixed(2), beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0) };
  };

  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, horizon: H, resolved: resolved.length, open,
    overall: summarize(resolved),
    byTier: {
      STRONG: summarize(resolved.filter(x => x.conviction >= 80)),   // both horizons near-max
      GOOD: summarize(resolved.filter(x => x.conviction >= 60 && x.conviction < 80)),
    },
    note: `Forward ${H}-session excess-vs-SPY of every logged Dual Confirmed pick (first appearance per ticker), overall and split by conviction tier. STRONG (≥80) should beat GOOD for conviction to be earning its keep. Accrues via the daily cron.`,
  });
}

module.exports = { runAligned, runAlignedLog, runAlignedBook, screenerPool, universeFromCache };
