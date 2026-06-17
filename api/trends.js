const Anthropic = require('@anthropic-ai/sdk');

const DOMAINS = 'reuters.com,bloomberg.com,apnews.com,cnbc.com,wsj.com,ft.com,barrons.com,marketwatch.com,investors.com,thestreet.com,forbes.com,fortune.com,businessinsider.com,economist.com,seekingalpha.com,morningstar.com,benzinga.com,motleyfool.com,nytimes.com,washingtonpost.com,axios.com,techcrunch.com,kiplinger.com,prnewswire.com,globenewswire.com';

const TRENDS_TOOL = {
  name: 'submit_analysis',
  description: 'Submit market trends and predictions analysis',
  input_schema: {
    type: 'object',
    properties: {
      trends: {
        type: 'array', minItems: 8, maxItems: 10,
        items: {
          type: 'object',
          properties: {
            rank:                 { type: 'integer' },
            theme:                { type: 'string' },
            description:          { type: 'string' },
            strength:             { type: 'number' },
            frameworks:           { type: 'array', items: { type: 'string' } },
            relatedSectors:       { type: 'array', items: { type: 'string' } },
            evidenceCount:        { type: 'integer' },
            investmentImplication:{ type: 'string' },
            momentum:             { type: 'string', enum: ['Accelerating', 'Stable', 'Fading'] },
          },
          required: ['rank','theme','description','strength','frameworks','relatedSectors','evidenceCount','investmentImplication','momentum'],
        },
      },
      predictions: {
        type: 'array', minItems: 8, maxItems: 10,
        items: {
          type: 'object',
          properties: {
            rank:            { type: 'integer' },
            prediction:      { type: 'string' },
            confidence:      { type: 'number' },
            timeframe:       { type: 'string' },
            basis:           { type: 'string' },
            supportingTrends:{ type: 'array', items: { type: 'string' } },
            keyRisk:         { type: 'string' },
          },
          required: ['rank','prediction','confidence','timeframe','basis','supportingTrends','keyRisk'],
        },
      },
    },
    required: ['trends', 'predictions'],
  },
};

function twoWeeksAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 14);
  return d.toISOString().split('T')[0];
}

async function fetchNews(query, apiKey) {
  const from = twoWeeksAgo();
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=15&from=${from}&domains=${DOMAINS}&apiKey=${apiKey}`;
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

  const [macro, equities, sectors] = await Promise.all([
    fetchNews('"Federal Reserve" OR inflation OR "interest rates" OR GDP OR recession OR "treasury yields" OR CPI OR PCE', newsApiKey),
    fetchNews('earnings OR "stock market" OR NASDAQ OR "S&P 500" OR IPO OR "analyst upgrade" OR "analyst downgrade" OR "earnings beat"', newsApiKey),
    fetchNews('"artificial intelligence" OR semiconductor OR "energy transition" OR "oil prices" OR banking OR biotech OR "trade policy"', newsApiKey),
  ]);

  const seen = new Set();
  const allArticles = [];
  for (const a of [...macro, ...equities, ...sectors]) {
    const key = a.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) { seen.add(key); allArticles.push(a); }
  }

  const from = twoWeeksAgo();
  const uniqueSources = [...new Set(allArticles.map(a => a.source?.name).filter(Boolean))];
  const articles = allArticles.slice(0, 35);

  const newsSummary = articles
    .map(a => `[${(a.publishedAt || '').slice(0, 10)}][${a.source?.name || '?'}] ${a.title}`)
    .join('\n');

  const client = new Anthropic({ apiKey: anthropicKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    tools: [TRENDS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_analysis' },
    messages: [{
      role: 'user',
      content: `You are an elite macro strategist applying Dalio (debt cycles), Druckenmiller (momentum), Howard Marks (cycles), and Goldman Sachs GIR frameworks.

Analyse ${articles.length} headlines from ${uniqueSources.length} sources (${from} to today). Identify recurring themes across multiple sources — cross-source frequency = signal strength.

You MUST return EXACTLY 10 trends and EXACTLY 10 predictions. Fill all slots even if some have lower confidence.

TREND rules: rank by strength desc (10=strongest). theme: 4-6 words. description: 2 sentences max. strength: 1-10 float. evidenceCount: how many articles support it. momentum: Accelerating/Stable/Fading.

PREDICTION rules: rank by confidence desc. prediction: specific falsifiable statement. confidence: 1-10 float. timeframe: e.g. "4-6 weeks". basis: 2 sentences max. keyRisk: 1 sentence.

Headlines (${from} to today):
${newsSummary}`,
    }],
  });

  const toolUse = message.content.find(b => b.type === 'tool_use');
  if (!toolUse?.input) {
    return res.status(500).json({ error: 'No analysis returned from AI.' });
  }

  res.setHeader('Cache-Control', 's-maxage=14400');
  return res.json({
    trends:         toolUse.input.trends || [],
    predictions:    toolUse.input.predictions || [],
    coverageWindow: `${from} to today`,
    sourceCount:    uniqueSources.length,
    articleCount:   articles.length,
    generatedAt:    new Date().toISOString(),
  });
};
