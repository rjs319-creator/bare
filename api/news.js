const Anthropic = require('@anthropic-ai/sdk');

const DOMAINS = 'reuters.com,bloomberg.com,apnews.com,cnbc.com,wsj.com,ft.com,barrons.com,marketwatch.com,investors.com,thestreet.com,forbes.com,fortune.com,businessinsider.com,economist.com,seekingalpha.com,morningstar.com,benzinga.com,motleyfool.com,nytimes.com,washingtonpost.com,axios.com,techcrunch.com,kiplinger.com';

const QUERIES = {
  stocks: 'stocks OR earnings OR NASDAQ OR NYSE OR "S&P 500" OR "Dow Jones" OR IPO OR "stock market" OR "stock rally" OR "quarterly results"',
  market: '"Federal Reserve" OR inflation OR "interest rates" OR GDP OR recession OR "treasury yields" OR "oil prices" OR "trade war" OR "economic data" OR "bond market"',
};

// POST /api/news → AI summary of a single article (merged from the old
// /api/summarize endpoint to stay within the Hobby function limit).
async function summarize(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { title, description, content } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Missing title.' });

  const client = new Anthropic({ apiKey });
  const parts = [`Title: ${title}`];
  if (description) parts.push(`Description: ${description}`);
  if (content)     parts.push(`Excerpt: ${content}`);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `${parts.join('\n')}\n\nIn 2 sentences max, summarize this market news and its significance. Be direct and factual.`,
    }],
  });
  return res.json({ summary: message.content[0].text });
}

module.exports = async function handler(req, res) {
  if (req.method === 'POST') return summarize(req, res);

  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'NEWS_API_KEY environment variable not set.' });
  }

  const query = QUERIES[req.query.type];
  if (!query) {
    return res.status(400).json({ error: 'Invalid type. Use ?type=stocks or ?type=market' });
  }

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=10&domains=${DOMAINS}&apiKey=${apiKey}`;

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    // Cache longer to protect the 100 req/day free plan limit
    const ttl = data.status === 'error' ? 60 : 7200; // 2 hours on success, 1 min on error
    res.setHeader('Cache-Control', `s-maxage=${ttl}`);
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch from NewsAPI.' });
  }
};
