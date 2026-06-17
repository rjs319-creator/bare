const Anthropic = require('@anthropic-ai/sdk');

// Prioritised by quality of options flow reporting
const OPTIONS_DOMAINS = [
  // Tier 1 — Best options flow reporters
  'benzinga.com',        // Real-time unusual activity alerts — best source
  'barrons.com',         // Options desk, strategy coverage
  'cnbc.com',            // Options Action desk, unusual activity
  'seekingalpha.com',    // Options flow analysis and alerts
  'schaeffersresearch.com', // Dedicated options research firm
  'barchart.com',        // Options volume and flow data articles
  // Tier 2 — Quality financial outlets with options desks
  'marketwatch.com',     // Options coverage
  'wsj.com',             // Wall Street options desk
  'bloomberg.com',       // Options/derivatives desk
  'reuters.com',         // Markets/derivatives coverage
  'thestreet.com',       // Options trading
  'investors.com',       // IBD options strategy
  'investorplace.com',   // Options alerts
  // Tier 3 — Broad financial with some options coverage
  'forbes.com',
  'fortune.com',
  'motleyfool.com',
  'zacks.com',           // Options screening and alerts
  'stocknews.com',       // Options flow coverage
  '247wallst.com',
  'ft.com',              // Financial Times derivatives
  'businessinsider.com',
  'tastylive.com',       // Options-first trading education & flow
].join(',');

const FLOW_TOOL = {
  name: 'submit_options_flow',
  description: 'Submit unusual options flow trade recommendations',
  input_schema: {
    type: 'object',
    properties: {
      trades: {
        type: 'array', minItems: 6, maxItems: 8,
        items: {
          type: 'object',
          properties: {
            rank:             { type: 'integer' },
            ticker:           { type: 'string' },
            company:          { type: 'string' },
            signalType:       { type: 'string' },
            sentiment:        { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
            confidence:       { type: 'number' },
            optionsActivity:  { type: 'string' },
            recommendedTrade: { type: 'string' },
            priceTarget:      { type: 'string' },
            currentPrice:     { type: 'string' },
            stopLoss:         { type: 'string' },
            riskReward:       { type: 'string' },
            timeframe:        { type: 'string' },
            basis:            { type: 'string' },
            keyRisk:          { type: 'string' },
          },
          required: ['rank','ticker','company','signalType','sentiment','confidence',
                     'optionsActivity','recommendedTrade','priceTarget','currentPrice',
                     'stopLoss','riskReward','timeframe','basis','keyRisk'],
        },
      },
    },
    required: ['trades'],
  },
};

async function fetchNews(query, apiKey, size = 15) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=${size}&domains=${OPTIONS_DOMAINS}&apiKey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.articles || []).filter(a => a.title && a.title !== '[Removed]');
}

module.exports = async function handler(req, res) {
  const newsApiKey   = process.env.NEWS_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!newsApiKey || !anthropicKey) {
    return res.status(500).json({ error: 'API keys not configured.' });
  }

  // 4 parallel queries targeting different aspects of options flow
  const [sweepsArticles, volumeArticles, strategyArticles, catalystArticles] = await Promise.all([
    // Unusual sweeps, block trades, dark pool — highest conviction signals
    fetchNews(
      '"unusual options" OR "call sweep" OR "put sweep" OR "block trade" OR "dark pool" OR "large call" OR "large put" OR "options alert" OR "unusual activity" OR "unusual call" OR "unusual put"',
      newsApiKey, 20
    ),
    // Volume, open interest, IV spikes — quantitative signals
    fetchNews(
      '"unusual call volume" OR "unusual put volume" OR "implied volatility" OR "open interest" OR "options flow" OR "options activity" OR "smart money" OR "institutional options" OR "IV spike" OR "IV crush"',
      newsApiKey, 15
    ),
    // Specific strategies being deployed — directional intelligence
    fetchNews(
      '"risk reversal" OR "call spread" OR "put spread" OR "bull call" OR "bear put" OR "straddle" OR "strangle" OR "LEAPS" OR "covered call" OR "protective put" OR "collar" OR "options trader" OR "bearish bet" OR "bullish bet"',
      newsApiKey, 15
    ),
    // Catalyst-driven options activity — earnings, upgrades, events
    fetchNews(
      '"earnings beat" OR "analyst upgrade" OR "price target raised" OR "insider buying" OR "product launch" OR "FDA approval" OR "merger" OR "acquisition" OR "buyback"',
      newsApiKey, 10
    ),
  ]);

  // Deduplicate, label by signal quality
  const seen = new Set();
  const allArticles = [];
  const flowSet = new Set([...sweepsArticles, ...volumeArticles].map(a => a.title.slice(0,60).toLowerCase()));

  for (const a of [...sweepsArticles, ...volumeArticles, ...strategyArticles, ...catalystArticles]) {
    const key = a.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allArticles.push({ ...a, _isFlow: flowSet.has(key) });
    }
  }

  const uniqueSources = [...new Set(allArticles.map(a => a.source?.name).filter(Boolean))];
  const articles = allArticles.slice(0, 40);

  const newsSummary = articles
    .map(a => {
      const tag = a._isFlow ? '[OPTIONS SIGNAL]' : '[CATALYST]';
      const desc = a.description ? ' — ' + a.description.slice(0, 100) : '';
      return `${tag}[${a.source?.name || '?'}] ${a.title}${desc}`;
    })
    .join('\n');

  const client = new Anthropic({ apiKey: anthropicKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3500,
    tools: [FLOW_TOOL],
    tool_choice: { type: 'tool', name: 'submit_options_flow' },
    messages: [{
      role: 'user',
      content: `You are an elite options desk analyst at a multi-strategy hedge fund. You read options flow signals the way a market maker reads order flow — identifying institutional intent behind unusual activity.

You have ${articles.length} articles from ${uniqueSources.length} sources including Benzinga (real-time flow alerts), Barron's options desk, CNBC Options Action, Schaeffer's Research, Barchart, Seeking Alpha, and Bloomberg.

SIGNAL HIERARCHY — weight heavily:
1. [OPTIONS SIGNAL] tagged articles from Benzinga/Barchart/Schaeffersresearch = highest conviction (real reported flow)
2. [OPTIONS SIGNAL] from CNBC/Barron's/Bloomberg = strong institutional signal
3. [CATALYST] tagged articles = contextual backdrop that amplifies options signals
4. Cross-source confirmation: same ticker in 2+ [OPTIONS SIGNAL] articles = very high conviction

For each trade recommendation:
- signalType: precise description (e.g. "Unusual Call Sweep — Benzinga Alert", "Large Block Trade — Calls", "IV Spike Pre-Earnings", "Aggressive Put Buying", "Dark Pool Print", "LEAPS Accumulation")
- sentiment: Bullish / Bearish / Neutral
- confidence: 1-10 (base on source quality + cross-confirmation. Benzinga alert alone = 7+; Benzinga + CNBC = 9+)
- optionsActivity: 1-2 sentences of what was specifically reported (volume, strike, expiry if known)
- recommendedTrade: precise trade (e.g. "Buy Jun 2026 $185 calls" or "Buy Aug $140/$130 put spread")
- currentPrice: estimated current stock price based on context (e.g. "$178")
- priceTarget: specific dollar price with timeframe (e.g. "$210 within 6 weeks")
- stopLoss: specific dollar level (e.g. "$162 — close below 20-day MA")
- riskReward: ratio (e.g. "1:2.8")
- timeframe: trade duration (e.g. "4-6 weeks")
- basis: 2 sentences citing specific source and why this signal matters now
- keyRisk: 1 sentence — what invalidates this trade immediately

MANDATORY RULES:
- Return EXACTLY 8 trade recommendations. All 8 slots MUST be filled.
- Only recommend trades on US-listed stocks with valid ticker symbols
- Bullish signal = calls or call spreads; Bearish = puts or put spreads
- All price targets and stop losses must be specific dollar amounts
- Max 2 trades in the same sector
- Rank by confidence desc (rank 1 = highest confidence signal)
- If genuine options flow is limited, use strong catalyst + momentum signals with lower confidence scores (4-6)

NEWS FEED (${articles.length} articles from ${uniqueSources.length} sources):
${newsSummary}`,
    }],
  });

  const toolUse = message.content.find(b => b.type === 'tool_use');
  if (!toolUse?.input?.trades) {
    return res.status(500).json({ error: 'No options flow data returned from AI.' });
  }

  res.setHeader('Cache-Control', 's-maxage=14400');
  return res.json({
    trades:       toolUse.input.trades,
    sourceCount:  uniqueSources.length,
    articleCount: articles.length,
    generatedAt:  new Date().toISOString(),
  });
};
