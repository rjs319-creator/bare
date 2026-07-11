const { fetchWithTimeout } = require('../lib/http');
// Momentum scanner — pulls the trending universe, runs the real-time technical
// signal on each, and splits the names into Strong Buy vs Strong Sell.
//
// Momentum alerts are meant to catch stocks *starting* to move, not ones that
// have already run. So we pull daily bars for each survivor and (a) drop names
// that are too extended — > 8% above the 20-day SMA or up > 25% over the past 5
// sessions — and (b) report how far price sits from its breakout pivot.
const { analyze, fetchYahooDaily, fetchStooqDaily } = require('../lib/signal');
const { tradeLevels } = require('../lib/levels');

const SMA20_MAX_EXT_PCT = 8;   // exclude names trading > 8% above the 20-day SMA
const RET5_MAX_PCT      = 25;  // exclude names up > 25% over the past 5 sessions

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
// Read the (CDN-cached) screener for a scope — used only to borrow the WHY NOW
// verdict the screener already composed (single source of truth). Best-effort.
async function screenerJSON(scope) {
  try {
    const r = await fetchWithTimeout('https://' + HOST + '/api/screener?scope=' + scope, { headers: { 'x-warm': '1' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Daily extension + breakout stats. `buy` flips the breakout pivot between the
// prior 20-day high (resistance being cleared) and the prior 20-day low.
async function dailyStats(ticker, livePrice, buy) {
  const data = await fetchYahooDaily(ticker) || await fetchStooqDaily(ticker);
  if (!data || data.candles.length < 21) return null;
  const c      = data.candles;
  const closes = c.map(x => x.close);
  const px     = livePrice || closes[closes.length - 1];

  const last20 = closes.slice(-20);
  const sma20  = last20.reduce((a, b) => a + b, 0) / last20.length;
  const pctFromSMA20 = ((px - sma20) / sma20) * 100;

  const ref5 = closes[closes.length - 6]; // close 5 sessions ago
  const ret5Pct = ref5 ? ((px - ref5) / ref5) * 100 : null;

  // Breakout pivot = the prior 20-day extreme *before* today's bar (the level a
  // genuine breakout has to clear). Distance is signed in the trade direction.
  const prior = c.slice(-21, -1); // 20 bars ending at the previous session
  const breakoutPoint = buy
    ? Math.max(...prior.map(x => x.high))
    : Math.min(...prior.map(x => x.low));
  const distFromBreakoutPct = breakoutPoint ? ((px - breakoutPoint) / breakoutPoint) * 100 : null;

  // Swing-structure stop / risk / measured target / reward:risk (direction-aware).
  // Momentum names are moving, so a measured move is a fairer target than the
  // nearest swing level (which understates reward on an active move).
  const levels = tradeLevels(c, px, { bullish: buy, targetMode: 'measured' });

  return {
    sma20:               +sma20.toFixed(2),
    pctFromSMA20:        +pctFromSMA20.toFixed(1),
    ret5Pct:             ret5Pct != null ? +ret5Pct.toFixed(1) : null,
    breakoutPoint:       +breakoutPoint.toFixed(2),
    distFromBreakoutPct: distFromBreakoutPct != null ? +distFromBreakoutPct.toFixed(1) : null,
    levels,
  };
}

// Already-run names: too far above the 20-day SMA, or up too much in 5 sessions.
// (On the short side these conditions never trigger, so it only trims buys.)
function isOverExtended(s) {
  if (!s) return false;
  return s.pctFromSMA20 > SMA20_MAX_EXT_PCT ||
         (s.ret5Pct != null && s.ret5Pct > RET5_MAX_PCT);
}

async function fetchTrendingStockTwits() {
  try {
    const res = await fetchWithTimeout(
      'https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    return data.symbols || [];
  } catch { return []; }
}

// Build a short plain-English thesis from the technical confluence.
function thesisFrom(card) {
  const dir = card.action === 'STRONG_BUY' ? 'bullish' : 'bearish';
  const top = (card.reasons || []).slice(0, 3).join('; ');
  return `Real-time price action is ${dir} (conf ${card.confidence}/10): ${top}.`;
}

module.exports = async function handler(req, res) {
  const trending = await fetchTrendingStockTwits();
  if (!trending.length) {
    return res.status(200).json({ strongBuys: [], strongSells: [], scannedCount: 0, generatedAt: new Date().toISOString(), note: 'Trending data unavailable.' });
  }

  // Scan the top trending names with the live technical engine (parallel).
  const candidates = trending.slice(0, 14);
  const results = await Promise.all(candidates.map(async s => {
    try {
      const r = await analyze(s.symbol, { light: true });
      if (!r) return null;
      return { r, company: s.title || s.symbol, social: s.watchlist_count || 0 };
    } catch { return null; }
  }));

  const toCard = ({ r, company, social }) => {
    const card = {
      ticker: r.ticker,
      company,
      action: r.live.action,
      confidence: r.live.confidence,
      reasons: r.live.reasons,
      levels: r.live.levels,
      rsi: r.live.rsi,
      vwap: r.live.vwap,
      macdBull: r.live.macdBull,
      price: r.price.live,
      regChangePct: r.price.regChangePct,
      afterHours: r.price.afterHours,
      marketState: r.marketState,
      social,
    };
    card.thesis = thesisFrom(card);
    return card;
  };

  const valid = results.filter(Boolean);

  // Build one side: attach daily breakout/extension stats, drop over-extended
  // names, and keep the confidence ordering.
  let excludedExtended = 0;
  async function buildSide(action) {
    const buy = action === 'STRONG_BUY';
    const items = valid.filter(x => x.r.live.action === action)
                       .sort((a, b) => b.r.live.confidence - a.r.live.confidence);
    const cards = await Promise.all(items.map(async x => {
      const stats = await dailyStats(x.r.ticker, x.r.price.live, buy);
      if (isOverExtended(stats)) { excludedExtended++; return null; }
      const card = toCard(x);
      if (stats) {
        card.sma20               = stats.sma20;
        card.pctFromSMA20        = stats.pctFromSMA20;
        card.ret5Pct             = stats.ret5Pct;
        card.breakoutPoint       = stats.breakoutPoint;
        card.distFromBreakoutPct = stats.distFromBreakoutPct;
        // Swing-structure stop / risk / next level / R:R (daily-based, replaces
        // the intraday ATR levels). Hide setups with reward:risk below 2:1.
        if (stats.levels) {
          const L = stats.levels;
          card.levels = {
            entry: card.price, stop: L.stop, target: L.resistance, resistance: L.resistance,
            risk: L.risk, rr: L.rr, targetType: L.targetType, stopBasis: L.stopBasis, blueSky: L.blueSky,
          };
        }
      }
      // The 2:1 reward-to-risk gate (with graceful fallback) is applied in the
      // frontend so a thin tape still surfaces the best-available setups.
      return card;
    }));
    return cards.filter(Boolean);
  }

  const [strongBuys, strongSells] = await Promise.all([
    buildSide('STRONG_BUY'),
    buildSide('STRONG_SELL'),
  ]);

  // Attach the WHY NOW verdict badge to BUY-side names that also appear in the
  // screener cross-section. The screener already composed c.whynow (single source
  // of truth), so we just borrow it — no recomputation. It's a long-setup read, so
  // buy side only; a momentum name not in any screen simply gets no badge.
  try {
    const screens = await Promise.all(['large', 'small', 'micro'].map(screenerJSON));
    const wn = {};
    for (const s of screens) {
      if (!s) continue;
      for (const c of (s.results || [])) if (c.ticker && c.whynow && !wn[c.ticker]) wn[c.ticker] = c.whynow;
      for (const c of (s.ghostTop || [])) if (c.ticker && c.whynow && !wn[c.ticker]) wn[c.ticker] = c.whynow;
    }
    for (const card of strongBuys) { const v = wn[card.ticker]; if (v) card.whynow = v; }
  } catch { /* best-effort — no badges on failure */ }

  res.setHeader('Cache-Control', 's-maxage=180'); // 3 min — signals are time-sensitive
  return res.json({
    strongBuys,
    strongSells,
    scannedCount: valid.length,
    excludedExtended,
    generatedAt: new Date().toISOString(),
  });
};
