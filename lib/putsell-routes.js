// op=putsell — Options Moves: cash-secured put-selling setups.
//
// TWO-STAGE, FULL-MARKET (same pattern as Dual Confirmed):
//   Stage 1 — read the price-action put-sell setup for the WHOLE universe
//             (large+small+micro) from the screener's daily candle cache (no
//             re-fetching); keep qualifying setups, strongest first.
//   Stage 2 — for the top shortlist, fetch the option chain (ATM IV + liquidity)
//             and the next earnings date to layer premium/earnings context on.

const { analyzePutSetup, finalizePutSell } = require('./putsell');

const SCOPES = ['large', 'small', 'micro'];
const STAGE2_MAX = 30;         // option-chain fetches to run (top setups)
const SCAN_BUDGET_MS = 45000;

async function universeFromCache() {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const seen = new Set();
  const out = [];
  for (const scope of SCOPES) {
    const doc = await loadCandleCache(scope);
    if (!doc || !doc.data) continue;
    for (const ticker of Object.keys(doc.data)) {
      const tk = ticker.toUpperCase();
      if (seen.has(tk)) continue;
      const entry = cacheGet(doc, ticker);
      if (!entry || !entry.candles || entry.candles.length < 200) continue;
      seen.add(tk);
      out.push({ ticker: tk, company: entry.meta.shortName || entry.meta.longName || tk, candles: entry.candles });
    }
  }
  return out;
}

async function runPutSell(req, res) {
  const universe = await universeFromCache().catch(() => []);

  // ── Stage 1: full-universe price-action put-sell setups ──
  let scanned = universe.length;
  const setups = [];
  for (const u of universe) {
    const s = analyzePutSetup(u.candles);
    if (s) setups.push({ ...s, ticker: u.ticker, company: u.company });
  }
  setups.sort((a, b) => b.score - a.score);
  const shortlist = setups.slice(0, STAGE2_MAX);

  // ── Stage 2: enrich the shortlist with IV richness + earnings + liquidity ──
  const { fetchOptionsBaseline } = require('./options-baseline');
  const { fetchEarningsInfo } = require('./fundamentals');
  const t0 = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < shortlist.length) {
      const s = shortlist[i++];
      if (Date.now() - t0 > SCAN_BUDGET_MS) return;
      const [opt, earn] = await Promise.all([
        fetchOptionsBaseline(s.ticker).catch(() => null),
        fetchEarningsInfo(s.ticker).catch(() => null),
      ]);
      const enriched = finalizePutSell(s, {
        atmIV: opt && opt.atmIV, contracts: opt && opt.contracts,
        earningsInDays: earn && earn.earningsInDays,
      });
      Object.assign(s, enriched);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  // Rank: keep the setup score, but nudge richer-IV names up within a tier.
  const picks = shortlist.sort((a, b) => (b.tier === a.tier ? (b.atmIV || 0) - (a.atmIV || 0) : 0) || b.score - a.score);

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    picks,
    scanned,
    qualified: setups.length,
    generatedAt: new Date().toISOString(),
    note: 'Cash-secured PUT-SELLING setups by price action: quality uptrends that have pulled back to support, with a suggested strike below support and an OTM cushion. Full-market: the price-action screen runs over the whole universe; the top setups are enriched with ATM IV, liquidity, and the next earnings date. Educational — not financial advice; selling puts obligates you to buy the stock at the strike.',
  });
}

module.exports = { runPutSell, universeFromCache };
