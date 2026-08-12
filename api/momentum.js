const { fetchWithTimeout } = require('../lib/http');
// INTRADAY MOMENTUM scanner (momentum-v2).
//
// UNIVERSE REDESIGN (predictive-redesign, defect #14): the universe is now PRICE/VOLUME-
// DISCOVERED — Day Trade full-universe CUSUM discovery anomalies first, then the cached
// screener cross-sections — never StockTwits trending. Social attention is retained ONLY
// as an orthogonal annotation joined onto names the tape already surfaced (`social`
// watcher count + `attentionRank`); it can neither originate a candidate nor break a tie.
// If no price/volume universe is available the scanner reports an honestly EMPTY board
// with a degraded note — it never silently falls back to social-only discovery.
//
// HORIZON HONESTY (defect #15): detection is 5-minute technicals — a same-session read.
// The strategy contract is now `intraday` (graded on cost-net excess @1d, momentum-v2);
// the daily swing levels shown are display context, clearly labeled, and the old 1-month
// "position" grading no longer applies to this scanner. Evidence under momentum-v1's
// mismatched contract stays in the ledger under its own version and is NOT inherited.
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
  return `Real-time price action is ${dir} (evidence ${card.confidence}/10 — indicator agreement, not a probability): ${top}.`;
}

const DEEP_SCAN_BUDGET = 14;   // deep 5-minute analyses per run (function time budget)

// Price/volume-discovered candidate universe, deterministic priority order:
//   1. Day Trade discovery anomalies (full-universe CUSUM) — strongest severity first.
//   2. Cached screener cross-sections (large/small/micro) — the scored movers.
// Returns [{ticker, company, priority, origin}] deduped, strongest first.
function buildCandidateUniverse({ discovery, screens }) {
  const seen = new Map();
  const push = (ticker, company, priority, origin) => {
    const t = String(ticker || '').toUpperCase();
    if (!t) return;
    const prev = seen.get(t);
    if (!prev || priority > prev.priority) seen.set(t, { ticker: t, company: company || t, priority, origin });
  };
  for (const a of (discovery && discovery.anomalies) || []) {
    push(a.ticker, a.company, 1000 + (Number.isFinite(a.cusum) ? a.cusum : 0), 'discovery');
  }
  for (const sJson of screens || []) {
    if (!sJson) continue;
    for (const c of sJson.results || []) {
      const mag = Math.abs(Number.isFinite(c.pctChange) ? c.pctChange : 0);
      push(c.ticker, c.company, mag, 'screener');
    }
  }
  return [...seen.values()].sort((a, b) => (b.priority - a.priority) || (a.ticker < b.ticker ? -1 : 1));
}

module.exports = async function handler(req, res) {
  // Price/volume universe (never social). Discovery is best-effort (store-gated).
  let discovery = null;
  try { discovery = await require('../lib/intraday-discovery').loadRecentDiscovery({ now: new Date() }); } catch { discovery = null; }
  const screens = await Promise.all(['large', 'small', 'micro'].map(screenerJSON));
  const universe = buildCandidateUniverse({ discovery, screens });

  // Social attention: an ORTHOGONAL annotation only — joined by ticker, never a candidate
  // source, never a ranking input. Its incremental value is untested → weight zero.
  const trending = await fetchTrendingStockTwits();
  const attention = new Map(trending.map((t, i) => [String(t.symbol || '').toUpperCase(), { rank: i + 1, watchers: t.watchlist_count || 0, title: t.title || null }]));

  if (!universe.length) {
    return res.status(200).json({
      strongBuys: [], strongSells: [], scannedCount: 0, universeCount: 0,
      generatedAt: new Date().toISOString(), degraded: true,
      universeNote: 'Price/volume universe unavailable (no fresh discovery scan and no cached screener cross-section). This scanner never falls back to social trending as a discovery universe — an empty board is the honest answer.',
    });
  }

  // Deep-scan the strongest price/volume candidates with the live technical engine.
  const candidates = universe.slice(0, DEEP_SCAN_BUDGET);
  const results = await Promise.all(candidates.map(async s => {
    try {
      const r = await analyze(s.ticker, { light: true });
      if (!r) return null;
      const att = attention.get(s.ticker) || null;
      return { r, company: s.company, universeOrigin: s.origin, social: att ? att.watchers : 0, attentionRank: att ? att.rank : null };
    } catch { return null; }
  }));

  const toCard = ({ r, company, social, attentionRank, universeOrigin }) => {
    const card = {
      ticker: r.ticker,
      company,
      action: r.live.action,
      confidence: r.live.confidence,
      evidenceStrength: r.live.confidence,   // same value, honest name — heuristic agreement count, NOT a probability
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
      attentionRank: attentionRank ?? null,       // social attention — annotation, weight 0
      universeOrigin: universeOrigin || null,     // 'discovery' | 'screener' (never 'social')
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
    universeCount: universe.length,
    universeSources: { discovery: universe.filter(u => u.origin === 'discovery').length, screener: universe.filter(u => u.origin === 'screener').length },
    excludedExtended,
    contract: { scoringVersion: 'momentum-v2', horizon: 'intraday', note: 'Same-session technical read; daily swing levels are display context. Scores are heuristic ranks, not probabilities.' },
    // REGISTRY STATE ON THE PAYLOAD (alpha-research pass 3). This endpoint published
    // fields literally named `strongBuys`/`strongSells`, which the client rendered as a
    // "⚡ STRONG BUY" action badge AND pushed as a desktop/phone notification with
    // haptics — for a strategy the registry marks `shadow`, and whose own entry records
    // that its momentum-v1 evidence "does not transfer" to the v2 contract. Nothing in
    // that path consulted the registry, so the highest-intent surface in the app issued
    // a buy imperative on the weakest evidence. The client now gates its vocabulary and
    // its notifications on this field.
    maturity: require('../lib/strategy-gate').statusOf('momentum'),
    tradeEligible: require('../lib/strategy-gate').isTradeEligible('momentum'),
    generatedAt: new Date().toISOString(),
  });
};

// Exported for tests: the universe builder is the contract under regression (price/volume
// discovery only — social can never be a candidate source).
module.exports.buildCandidateUniverse = buildCandidateUniverse;
