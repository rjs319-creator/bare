// op=aligned — "Dual Confirmed" scan. Starts from the warm breakout-screener pool
// (names already long-term-strong: above their moving averages, leading SPY), runs
// the full dual-horizon read on each, and keeps only those that are a BUY on BOTH
// horizons (trend-continuation), ranked by conviction. Reuses the warm /api/screener
// cache so this stays cheap — it only adds the intraday confirmation on the shortlist.

const { isAligned, rankAligned } = require('./aligned');

const MAX_SCAN = 44;          // bound the intraday confirmations (screener pool is ~this size)
const SCAN_BUDGET_MS = 45000; // stay under the function wall
const stStrong = a => a === 'STRONG_BUY' || a === 'BUY';

function hostFrom(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
}

// Pull the warm screener candidate pool (large + small scopes) → {ticker, company,
// price, levels}. Uses the CDN-cached response, so it's fast once warmed.
async function screenerPool(host) {
  const scopes = ['large', 'small'];
  const out = new Map();
  await Promise.all(scopes.map(async scope => {
    try {
      const r = await fetch(`https://${host}/api/screener?scope=${scope}`, { headers: { 'x-warm': '1' } });
      if (!r.ok) return;
      const j = await r.json();
      for (const c of (j.results || [])) {
        const tk = (c.ticker || '').toUpperCase();
        if (tk && !out.has(tk)) out.set(tk, { ticker: tk, company: c.company || tk, price: c.price, levels: c.levels || null, scope });
      }
    } catch { /* skip scope */ }
  }));
  return [...out.values()].slice(0, MAX_SCAN);
}

async function runAligned(req, res) {
  const { analyze } = require('./signal');
  const pool = await screenerPool(hostFrom(req));

  const t0 = Date.now();
  const items = []; let i = 0, scanned = 0;
  const worker = async () => {
    while (i < pool.length) {
      const cand = pool[i++];
      if (Date.now() - t0 > SCAN_BUDGET_MS) return;
      try {
        const r = await analyze(cand.ticker);
        if (!r || !r.dual || !r.longTerm) continue;
        scanned++;
        // Both horizons must be a buy: trend-continuation AND an actual bull ST action.
        if (!isAligned(r.dual) || !stStrong(r.live.action)) continue;
        items.push({
          ticker: r.ticker,
          company: cand.company,
          price: r.price.live,
          stAction: r.live.action,
          stConf: r.live.confidence,
          ltTrend: r.longTerm.trend,
          ltScore: r.longTerm.score,
          group: r.longTerm.group || null,
          levels: cand.levels || (r.live.levels ? { entry: +r.live.levels.entry, stop: +r.live.levels.stop, target: +r.live.levels.target } : null),
          stReasons: (r.live.reasons || []).slice(0, 2),
          ltReasons: (r.longTerm.reasons || []).slice(0, 2),
        });
      } catch { /* skip name */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const picks = rankAligned(items);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    picks,
    scanned,
    qualified: picks.length,
    generatedAt: new Date().toISOString(),
    note: 'Names that are a BUY on BOTH horizons — short-term signal bullish AND the ~1y trend bullish (trend-continuation), ranked by conviction. Drawn from the breakout-screener pool.',
  });
}

module.exports = { runAligned, screenerPool };
