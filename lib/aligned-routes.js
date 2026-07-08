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

const SCOPES = ['large', 'small', 'micro'];
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
      const r = await fetch(`https://${host}/api/screener?scope=${scope}`, { headers: { 'x-warm': '1' } });
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

        const price = (r.price && r.price.live) || cand.price;
        let levels = fallbackLevels[cand.ticker] || null;
        if (!levels && cand.candles && price) {
          const L = tradeLevels(cand.candles, price, { bullish: true, targetMode: 'measured' });
          if (L) levels = { entry: +price.toFixed(2), stop: L.stop, target: L.resistance };
        }
        items.push({
          ticker: r.ticker, company: cand.company, price,
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

module.exports = { runAligned, screenerPool, universeFromCache };
