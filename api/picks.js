const Anthropic = require('@anthropic-ai/sdk');
const { fetchDailyHistory, screenTicker } = require('../lib/screener');
const { fetchFundamentals } = require('../lib/fundamentals');
const { tradeLevels } = require('../lib/levels');

// Rough sector median P/E benchmarks for the "reasonable valuation vs sector"
// gate (a sector-P/E data API isn't available on the current plan).
const SECTOR_PE = {
  'Technology': 32, 'Information Technology': 32, 'Communication Services': 22,
  'Consumer Discretionary': 25, 'Consumer Cyclical': 25, 'Consumer Staples': 22, 'Consumer Defensive': 22,
  'Health Care': 24, 'Healthcare': 24, 'Financials': 16, 'Financial Services': 16,
  'Industrials': 22, 'Energy': 13, 'Materials': 17, 'Basic Materials': 17,
  'Utilities': 19, 'Real Estate': 32,
};
const sectorPE = sec => SECTOR_PE[sec] || 22;

// Map an LLM/pick sector label to FMP's canonical sector name.
const FMP_SECTOR_ALIAS = {
  'technology': 'Technology', 'information technology': 'Technology',
  'financials': 'Financial Services', 'financial services': 'Financial Services', 'financial': 'Financial Services',
  'health care': 'Healthcare', 'healthcare': 'Healthcare',
  'consumer discretionary': 'Consumer Cyclical', 'consumer cyclical': 'Consumer Cyclical',
  'consumer staples': 'Consumer Defensive', 'consumer defensive': 'Consumer Defensive',
  'materials': 'Basic Materials', 'basic materials': 'Basic Materials',
  'communication services': 'Communication Services', 'communications': 'Communication Services', 'communication': 'Communication Services',
  'energy': 'Energy', 'industrials': 'Industrials', 'real estate': 'Real Estate', 'utilities': 'Utilities',
};
const fmpSector = sec => FMP_SECTOR_ALIAS[String(sec || '').toLowerCase()] || sec;

// Live sector P/E medians from FMP's stable API (NASDAQ + NYSE averaged).
// Returns { sectorName: pe } or null if unavailable (caller falls back to table).
async function fetchSectorPEs() {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const day = new Date(Date.now() - 86400e3).toISOString().slice(0, 10); // FMP returns nearest available
  const acc = {};
  try {
    for (const ex of ['NASDAQ', 'NYSE']) {
      const r = await fetch(`https://financialmodelingprep.com/stable/sector-pe-snapshot?date=${day}&exchange=${ex}&apikey=${key}`);
      if (!r.ok) continue;
      const rows = await r.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row.sector || !(row.pe > 0)) continue;
        (acc[row.sector] = acc[row.sector] || []).push(row.pe);
      }
    }
  } catch { return null; }
  const out = {};
  for (const [s, arr] of Object.entries(acc)) out[s] = +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
  return Object.keys(out).length ? out : null;
}

// Meme-spike guard: a parabolic recent move disqualifies a name from the
// long-term track regardless of fundamentals.
const memeSpike = ret => !!ret && ((ret.m1 != null && ret.m1 > 50) || (ret.d5 != null && ret.d5 > 25));

// Enrich each pick with a technical breakout read, real fundamentals, trade
// levels, and recent returns (for the meme guard). Pooled to limit load.
async function enrichPicks(picks, spyByDate) {
  let i = 0;
  const worker = async () => {
    while (i < picks.length) {
      const p = picks[i++];
      try {
        const d = await fetchDailyHistory(p.ticker);
        if (d) {
          const closes = d.candles.map(c => c.close);
          const last = closes.length - 1, px = closes[last];
          p.price = +px.toFixed(2);
          const r = k => (last - k >= 0 && closes[last - k] > 0) ? +(((px / closes[last - k]) - 1) * 100).toFixed(1) : null;
          p._ret = { d5: r(5), m1: r(21) };
          const tech = screenTicker(d.candles, { ...d.meta, symbol: p.ticker }, spyByDate ? { spyByDate } : {});
          if (tech) {
            p._tech = { status: tech.status, qualifies: tech.qualifies, techScore: tech.techScore, filters: tech.filters, metrics: tech.metrics };
            p.levels = tech.levels; // breakout-aware stop/target/R:R
          } else {
            p.levels = tradeLevels(d.candles, px, { bullish: true, targetMode: 'measured' });
          }
        }
        p._fund = await fetchFundamentals(p.ticker);
      } catch { /* skip — pick simply won't qualify for a track */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, picks.length) }, worker));
}

// Split the enriched picks into a short-term (technical) and long-term
// (fundamentals-led) track. A pick can land in both, one, or neither.
function classifyPicks(picks, sectorPEMap) {
  const benchOf = sec => (sectorPEMap && sectorPEMap[fmpSector(sec)]) || sectorPE(sec);
  const shortTerm = [], longTerm = [], watch = [];
  for (const p of picks) {
    const t = p._tech, f = p._fund;

    // Two quality gates, computed up front so EVERY pick carries a badge and none
    // is hidden — picks clearing neither gate still surface on the watch track.
    const passTech = !!(t && t.status);
    const bench = f ? benchOf(p.sector) : null;
    const passFund = !!(f && f.revGrowth != null && f.revGrowth > 0
      && f.opMarginTTM != null && f.opMarginTTM > 0 && f.marginExpanding === true
      && f.pe != null && f.pe > 0 && f.pe <= bench * 1.3);
    const meme = memeSpike(p._ret);

    const base = {
      rank: p.rank, ticker: p.ticker, company: p.company, sector: p.sector,
      overallRating: p.overallRating, ratingLabel: p.ratingLabel, sourceCoverage: p.sourceCoverage,
      optionsSignal: p.optionsSignal, factors: p.factors, thesis: p.thesis, keyRisk: p.keyRisk,
      price: p.price, levels: p.levels,
      quality: { tech: passTech ? t.status : null, fund: passFund, meme },
    };

    // Short-term: passed the technical breakout + volume gate.
    if (passTech) {
      shortTerm.push({
        ...base, track: 'short', techStatus: t.status,
        tech: { status: t.status, volSurge: t.metrics && t.metrics.volSurge, rsVsSpy63: t.metrics && t.metrics.rsVsSpy63, baseWeeks: t.metrics && t.metrics.consoWeeks, filters: t.filters },
        _score: Math.round((t.techScore || 0) + (p.overallRating || 0)),
      });
    }

    // Long-term: cleared the strict fundamental gate and not a meme spike.
    if (passFund && !meme) {
      const valDiscount = Math.max(0, Math.min(15, (bench - f.pe) / bench * 30));
      const score = Math.round(
        25
        + Math.min(40, f.revGrowth) * 0.5
        + 15 // operating margin expanding (gated true above)
        + Math.min(40, f.opMarginTTM) * 0.3
        + valDiscount
        + (p.factors && p.factors.fundamentals || 5) * 1.5
        + (p.factors && p.factors.technicalMomentum || 5) * 0.3 // technicals weighted LOW
      );
      longTerm.push({
        ...base, track: 'long',
        fundamentals: { revGrowth: f.revGrowth, opMarginTTM: f.opMarginTTM, marginExpanding: f.marginExpanding, pe: f.pe, sectorPE: bench, netMargin: f.netMargin, epsGrowth: f.epsGrowth, earningsInDays: f.earningsInDays },
        recentRun: p._ret, _score: score,
      });
    }

    // Watch: an AI news idea that hasn't cleared a technical OR fundamental gate
    // yet — surfaced (not dropped) so all picks are visible, badged as unconfirmed.
    if (!passTech && !(passFund && !meme)) {
      watch.push({ ...base, track: 'watch', recentRun: p._ret, _score: p.overallRating || 0 });
    }
  }
  shortTerm.sort((a, b) => b._score - a._score);
  longTerm.sort((a, b) => b._score - a._score);
  watch.sort((a, b) => b._score - a._score);
  return { shortTerm, longTerm, watch };
}

// 30 of the most reliable financial news sources globally
const DOMAINS = [
  // Tier 1 — Wire services & financial press (highest reliability)
  'reuters.com', 'bloomberg.com', 'apnews.com', 'wsj.com', 'ft.com',
  // Tier 1 — Broadcast & specialist financial
  'cnbc.com', 'barrons.com', 'marketwatch.com', 'investors.com', 'thestreet.com',
  // Tier 2 — Business press
  'forbes.com', 'fortune.com', 'businessinsider.com', 'economist.com', 'axios.com',
  // Tier 2 — Investment research & analysis
  'seekingalpha.com', 'morningstar.com', 'benzinga.com', 'motleyfool.com', 'investorplace.com',
  // Tier 2 — General quality news with strong markets desk
  'nytimes.com', 'washingtonpost.com', 'kiplinger.com',
  // Tier 3 — Sector specialists
  'techcrunch.com', 'wired.com',
  // Tier 3 — Press release wires (carry actual earnings releases)
  'prnewswire.com', 'globenewswire.com', 'businesswire.com',
  // Tier 3 — Additional financial outlets
  '247wallst.com', 'valuewalk.com',
].join(',');

const PICK_TOOL = {
  name: 'submit_picks',
  description: 'Submit the ranked stock picks analysis',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        // minItems was 10, which made abstention STRUCTURALLY IMPOSSIBLE: the schema
        // rejected an honest short list, so the model had to pad to satisfy the tool
        // call even when the prompt asked it not to. A quota enforced in the schema
        // outranks any instruction in the prompt. maxItems stays — a cap is a bar, a
        // floor is a quota.
        minItems: 0,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            rank:           { type: 'integer' },
            ticker:         { type: 'string' },
            company:        { type: 'string' },
            sector:         { type: 'string' },
            overallRating:  { type: 'number' },
            ratingLabel:    { type: 'string' },
            sourceCoverage: { type: 'integer' },
            optionsSignal:  { type: 'string' },
            factors: {
              type: 'object',
              properties: {
                newsSentiment:      { type: 'integer' },
                fundamentals:       { type: 'integer' },
                sectorTailwind:     { type: 'integer' },
                macroAlignment:     { type: 'integer' },
                technicalMomentum:  { type: 'integer' },
                riskReward:         { type: 'integer' },
                relativeStrength:   { type: 'integer' },
                catalystClarity:    { type: 'integer' },
                valuation:          { type: 'integer' },
                institutionalSignal:{ type: 'integer' },
              },
              required: ['newsSentiment','fundamentals','sectorTailwind','macroAlignment',
                         'technicalMomentum','riskReward','relativeStrength','catalystClarity',
                         'valuation','institutionalSignal'],
            },
            thesis:  { type: 'string' },
            keyRisk: { type: 'string' },
          },
          required: ['rank','ticker','company','sector','overallRating','ratingLabel',
                     'sourceCoverage','optionsSignal','factors','thesis','keyRisk'],
        },
      },
    },
    required: ['picks'],
  },
};

// CDN cache policy (audit 2026-08-14). Only a HEALTHY run WITH picks may pin the CDN
// for 4 hours. Empty states are never long-cached ("never CDN-cache empty state"):
// a genuine quiet-day abstention gets 30 minutes, and a degraded run (any news feed
// failed) gets 5 minutes so the next healthy fetch can replace it quickly.
const CACHE_HEALTHY_PICKS_S = 14400;
const CACHE_HEALTHY_ABSTAIN_S = 1800;
const CACHE_DEGRADED_S = 300;

async function fetchNews(query, apiKey, size = 20) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=${size}&domains=${DOMAINS}&apiKey=${apiKey}`;
  const res = await fetch(url);
  // A 429/5xx used to be swallowed into [] here — indistinguishable from "no articles",
  // so a provider outage read as a quiet news day and was recorded as an abstention.
  if (!res.ok) throw new Error(`NewsAPI ${res.status}`);
  const data = await res.json();
  return (data.articles || []).filter(a => a.title && a.title !== '[Removed]');
}

// Per-feed guard: null = THIS FEED FAILED (outage/rate-limit/network) — an explicitly
// different value from [] ("the feed answered: nothing"). Also keeps a thrown network
// error from rejecting the handler's Promise.all into a 500.
const fetchNewsSafe = (query, apiKey, size) => fetchNews(query, apiKey, size).catch(() => null);

async function fetchSectors() {
  try {
    const symbols = ['SPY','QQQ','XLK','XLF','XLV','XLE','XLI','XLY'];
    const quotes = await Promise.all(symbols.map(async s => {
      try {
        const url = `https://stooq.com/q/l/?s=${s}.US&f=sd2t2ohlcvn&h&e=csv`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const parts = text.trim().split('\n')[1]?.split(',');
        if (!parts) return null;
        const open = parseFloat(parts[3]), close = parseFloat(parts[6]);
        if (!open || !close) return null;
        return { symbol: s, changePct: ((close - open) / open * 100).toFixed(2) };
      } catch { return null; }
    }));
    const data = quotes.filter(Boolean);
    if (!data.length) return null;
    return data.sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct));
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  const newsApiKey   = process.env.NEWS_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!newsApiKey || !anthropicKey) {
    return res.status(500).json({ error: 'API keys not configured.' });
  }

  // 4 parallel fetches — broader, deeper coverage. Each news feed fails soft to null
  // (never rejects the Promise.all); a null feed marks the whole run DEGRADED.
  const [stocksFeed, macroFeed, earningsFeed, optionsFeed, sectors] = await Promise.all([
    // Broad stock market news
    fetchNewsSafe(
      'stocks OR "stock market" OR NASDAQ OR NYSE OR "S&P 500" OR "Dow Jones" OR "stock rally" OR "stock surge" OR "stock decline" OR buyback OR "share repurchase"',
      newsApiKey, 20
    ),
    // Macro & market-moving events
    fetchNewsSafe(
      '"Federal Reserve" OR inflation OR "interest rates" OR GDP OR recession OR "treasury yields" OR "oil prices" OR "trade war" OR CPI OR PCE OR payrolls OR "dollar index"',
      newsApiKey, 20
    ),
    // Earnings, analyst actions, insider activity — highest signal for specific stocks
    fetchNewsSafe(
      '"earnings beat" OR "earnings miss" OR "raised guidance" OR "lowered guidance" OR "analyst upgrade" OR "analyst downgrade" OR "price target" OR "strong buy" OR "insider buying" OR "quarterly results" OR "revenue beat" OR "EPS beat" OR "profit surge"',
      newsApiKey, 20
    ),
    // Options flow & institutional signals
    fetchNewsSafe(
      '"unusual options" OR "call sweep" OR "put sweep" OR "options activity" OR "options flow" OR "bullish bet" OR "bearish bet" OR "call buying" OR "block trade" OR "dark pool"',
      newsApiKey, 10
    ),
    fetchSectors(),
  ]);

  // Provider health. A degraded run may still produce usable picks from the surviving
  // feeds, but its output must never be recorded as a full-coverage read — and an empty
  // book from a starved model must never be recorded as a genuine abstention.
  const newsFeedsFailed = [stocksFeed, macroFeed, earningsFeed, optionsFeed].filter(f => f === null).length;
  const degraded = newsFeedsFailed > 0;
  const stocksArticles = stocksFeed || [];
  const macroArticles = macroFeed || [];
  const earningsArticles = earningsFeed || [];
  const optionsArticles = optionsFeed || [];

  // Deduplicate across all feeds
  const seen = new Set();
  const allArticles = [];
  for (const a of [...earningsArticles, ...stocksArticles, ...macroArticles]) {
    const key = a.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) { seen.add(key); allArticles.push(a); }
  }

  const uniqueSources = [...new Set(allArticles.map(a => a.source?.name).filter(Boolean))];

  // Label each article by feed type so Claude knows its provenance
  const newsSummary = allArticles.slice(0, 40)
    .map(a => {
      const src = a.source?.name || '?';
      const isEarnings = earningsArticles.some(e => e.title === a.title);
      const tag = isEarnings ? '[EARNINGS/ANALYST]' : '[MARKET]';
      return `${tag}[${src}] ${a.title}`;
    })
    .join('\n');

  const optionsSummary = optionsArticles.length
    ? '\n\nOPTIONS FLOW SIGNALS:\n' +
      optionsArticles.map(a => `[${a.source?.name || '?'}] ${a.title}`).join('\n')
    : '';

  const sectorContext = sectors
    ? '\n\nSECTOR ETF MOMENTUM (today):\n' +
      sectors.map(s => `${s.symbol} ${parseFloat(s.changePct) >= 0 ? '+' : ''}${s.changePct}%`).join(' | ')
    : '';

  const client = new Anthropic({ apiKey: anthropicKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 6000,   // 10 verbose picks (10-factor breakdown + thesis each) — headroom so none get truncated
    tools: [PICK_TOOL],
    tool_choice: { type: 'tool', name: 'submit_picks' },
    messages: [{
      role: 'user',
      content: `You are an elite buy-side analyst. Blend Buffett (moat/FCF), Lynch (GARP), Druckenmiller (macro momentum), Simons (signal frequency/cross-source recurrence), and Goldman Sachs GIR frameworks.

You have ${allArticles.slice(0,40).length} articles from ${uniqueSources.length} sources including Reuters, Bloomberg, WSJ, FT, Barron's, CNBC, Morningstar, Seeking Alpha, Benzinga, PR Newswire, Globe Newswire, and more.
${sectorContext}

SIGNAL PRIORITY (weight heavily):
1. [EARNINGS/ANALYST] tagged articles carry the highest signal — actual earnings beats/misses, analyst upgrades/downgrades, and price target changes are the most reliable predictors
2. Cross-source coverage — a stock mentioned by 3+ independent outlets is a stronger signal than one mentioned by 1
3. Options flow — unusual call sweeps from institutional players often precede moves

Score each pick 1-10 on:
1. newsSentiment      – volume + tone; reward multi-source positive coverage
2. fundamentals       – earnings beats, revenue acceleration, margin expansion, FCF
3. sectorTailwind     – use SECTOR ETF data; reward picks in outperforming sectors
4. macroAlignment     – fits current rate/inflation/USD environment
5. technicalMomentum  – breakout, new highs, volume implied by news intensity
6. riskReward         – asymmetric upside; penalise crowded/priced-for-perfection names
7. relativeStrength   – leading peers and broad market
8. catalystClarity    – specific near-term catalyst (4–8 weeks); reward earnings releases, product launches, regulatory decisions
9. valuation          – cheap relative to growth; penalise high-multiple names with no catalyst
10. institutionalSignal – analyst upgrades, insider buying, dark pool/block trade activity

optionsSignal: summarise any options activity from the OPTIONS FLOW SIGNALS section for this stock. "None detected" if none.

MANDATORY RULES — NON-NEGOTIABLE:
- Return ONLY picks that clear the bar. Returning FEWER than 10 is correct, and returning ZERO is correct and expected on a quiet news day. There is no quota.
- NEVER pad the list. Do not add a name to reach a count, and do not lower your standard for the last slots. A weak pick presented alongside strong ones is worse than an absent pick, because the user cannot tell them apart.
- Only include a stock if a specific, current catalyst in the supplied feed justifies it. No catalyst in the feed means no pick — do not reason from prior knowledge.
- Only pick US-listed stocks with a real ticker symbol
- Max 3 picks in the same sector
- Never pick a stock whose PRIMARY news is negative (earnings miss, downgrade, lawsuit)
- Prefer stocks with [EARNINGS/ANALYST] coverage over those with only general market mentions
- thesis: 2 sentences; MUST cite a specific headline or source from the feed
- keyRisk: 1 sentence — what would invalidate this pick
- overallRating = average of all 10 factors (1 decimal, 1.0–10.0)
- ratingLabel: "Strong Buy" ≥8, "Buy" ≥6, "Moderate Buy" otherwise
- sourceCoverage: count of distinct sources mentioning this stock across all feeds
- Rank 1 = highest overallRating, rank 10 = lowest

${optionsSummary}

NEWS FEED (${allArticles.slice(0,40).length} articles, ${uniqueSources.length} sources):
${newsSummary}`,
    }],
  });

  const toolUse = message.content.find(b => b.type === 'tool_use');
  // A MISSING tool call is a failure (the model never answered). An EMPTY picks array
  // is an answer — the honest one on a quiet day. Conflating the two is what forced the
  // quota in the first place, so they are now distinguished explicitly.
  if (!toolUse?.input?.picks) {
    return res.status(500).json({ error: 'No picks returned from AI.' });
  }

  // Enrich with technicals + real fundamentals, then split into two tracks:
  // short-term (technical breakout + volume) and long-term (fundamentals-led).
  const all = toolUse.input.picks;
  let spyByDate = null;
  try {
    const spy = await fetchDailyHistory('SPY');
    if (spy) { spyByDate = {}; spy.candles.forEach(x => { spyByDate[x.date] = x.close; }); }
  } catch {}
  await enrichPicks(all, spyByDate);
  const sectorPEMap = await fetchSectorPEs(); // live FMP sector P/Es (null → benchmark table)
  const { shortTerm, longTerm, watch } = classifyPicks(all, sectorPEMap);

  // ABSTENTION CONTRACT (alpha-research brief §3). The economically correct output is
  // permitted to be "no position". `abstained` is true only when the model returned a
  // genuinely empty book — not when downstream classification happens to leave a track
  // empty, which is a different (and normal) state — and NOT when the empty book was
  // caused by a failed news feed: a starved model is not an abstaining model, and
  // stamping an outage as abstention would corrupt the abstention track record.
  const abstained = all.length === 0 && !degraded;
  const rejectionReasonCounts = abstained
    ? { noQualifyingCatalyst: 1 }
    : {
        // Rejections we can actually observe at this layer: names the model surfaced
        // that did not clear a technical OR fundamental gate land in `watch` rather
        // than an actionable track. Reported so an empty actionable list is legible as
        // a measured outcome instead of a blank section.
        belowActionableGate: watch.length,
      };

  // Cache by health, then by emptiness — see the constants above fetchNews.
  const cacheSeconds = degraded ? CACHE_DEGRADED_S
    : (all.length > 0 ? CACHE_HEALTHY_PICKS_S : CACHE_HEALTHY_ABSTAIN_S);
  res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}`);
  return res.json({
    shortTerm,
    longTerm,
    watch,
    abstained,
    degraded,
    newsFeedsFailed,
    ...(degraded && all.length === 0
      ? { degradedNote: 'news provider failure — empty book is NOT a genuine abstention' }
      : {}),
    actionableCount: shortTerm.length + longTerm.length,
    screenedCount: all.length,
    rejectionReasonCounts,
    fundamentalsEnabled: !!process.env.FINNHUB_API_KEY,
    sectorPESource: sectorPEMap ? 'fmp-live' : 'benchmark',
    generatedAt: new Date().toISOString(),
    sourceCount: uniqueSources.length,
    articleCount: allArticles.slice(0, 40).length,
    hasSectorData: !!sectors,
  });
};
