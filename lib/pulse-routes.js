// 📡 MARKET PULSE — a distillation of what the crowd is watching that could move US
// markets. A serverless function can't scrape X/YouTube directly, so we let Claude's
// server-side web_search tool sweep trending finance chatter (X/FinTwit, StockTwits,
// r/wallstreetbets, finance YouTube, major news) and distill the TOP 10 ideas, ranked
// by POPULARITY (how widely discussed) + VELOCITY (how fast the news is trending).
//
// HONEST FRAMING: this is an ATTENTION digest, not buy signals. This project's own
// research found social *sentiment* is weak/contrarian (WSB bullishness underperforms);
// the useful part is *awareness* of catalysts + crowding. Refreshes every ~4 hours.
const { readJSON, writeJSON, hasStore } = require('./store');

const CACHE_KEY = 'pulse/latest.json';
const REFRESH_MS = 4 * 60 * 60 * 1000;          // regenerate at most every 4 hours
const MODEL = 'claude-haiku-4-5-20251001';
const N = 10;

// Structured-output tool: Claude must return exactly the fields the UI renders.
const PULSE_TOOL = {
  name: 'submit_pulse',
  description: 'Return the top 10 trending market-moving distillations, ranked #1..10 by a blend of popularity (how widely discussed right now) and velocity (how fast the news is accelerating).',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Exactly 10 items, ranked #1 = most popular + fastest-trending.',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', description: '1..10, 1 = most popular + fastest trending' },
            headline: { type: 'string', description: 'one punchy sentence' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'relevant US tickers (may be empty for a macro theme)' },
            idea: { type: 'string', description: 'what the crowd / media is actually saying (1-2 sentences)' },
            whyMoves: { type: 'string', description: 'why this could move US markets (1 sentence)' },
            sentiment: { type: 'string', enum: ['bullish', 'bearish', 'mixed'] },
            popularity: { type: 'integer', description: '1-100: how widely discussed right now across platforms' },
            velocity: { type: 'string', enum: ['exploding', 'rising', 'steady', 'cooling'], description: 'how fast the discussion is accelerating' },
            sources: { type: 'string', description: 'a short summary of WHERE this is trending (e.g., "Heavy on FinTwit/X + StockTwits top-10; CNBC & Yahoo Finance video coverage")' },
            caution: { type: 'string', description: 'optional honest flag — hype/crowded/contrarian/extended; empty if none' },
          },
          required: ['rank', 'headline', 'tickers', 'idea', 'whyMoves', 'sentiment', 'popularity', 'velocity', 'sources'],
        },
      },
    },
    required: ['items'],
  },
};

const PROMPT = `You are a markets desk analyst. Using web search, run an EXHAUSTIVE sweep of what finance social media and media are trending on RIGHT NOW that could move US markets. Cover, at minimum:
- X / FinTwit most-mentioned tickers and threads
- StockTwits trending & most-active symbols
- Reddit r/wallstreetbets most-mentioned / fastest-rising
- Trending finance YouTube videos (CNBC, Bloomberg, Yahoo Finance, popular finfluencers)
- Breaking market news, earnings, FDA/biotech catalysts, unusual options / short-squeeze chatter, and macro events on the calendar this week

Then distill the TOP ${N} most important ideas — specific stocks OR themes — and rank them #1..${N} by a blend of:
  (a) POPULARITY: how widely discussed across those platforms right now, and
  (b) VELOCITY: how fast the discussion / news is accelerating (exploding > rising > steady > cooling).

For each, give the tickers, what the crowd is actually saying, why it could move US markets, sentiment, a 1-100 popularity score, a velocity bucket, and a short summary of WHERE it's trending. Be specific and HONEST: when something is hype, crowded, extended, or a likely 'sell the news', say so in the caution field. Submit via the submit_pulse tool.`;

function parsePulse(msg) {
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_pulse');
  let items = (tool && tool.input && Array.isArray(tool.input.items)) ? tool.input.items : [];
  items = items
    .filter(it => it && it.headline && it.idea)
    .map((it, i) => ({
      rank: it.rank || i + 1,
      headline: String(it.headline).slice(0, 240),
      tickers: Array.isArray(it.tickers) ? it.tickers.map(t => String(t).toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8)).filter(Boolean).slice(0, 6) : [],
      idea: String(it.idea).slice(0, 600),
      whyMoves: String(it.whyMoves || '').slice(0, 400),
      sentiment: ['bullish', 'bearish', 'mixed'].includes(it.sentiment) ? it.sentiment : 'mixed',
      popularity: Math.max(1, Math.min(100, parseInt(it.popularity, 10) || 50)),
      velocity: ['exploding', 'rising', 'steady', 'cooling'].includes(it.velocity) ? it.velocity : 'steady',
      sources: String(it.sources || '').slice(0, 300),
      caution: it.caution ? String(it.caution).slice(0, 300) : null,
    }));
  // Rank by popularity + velocity weight (exploding=3, rising=2, steady=1, cooling=0).
  const vW = { exploding: 3, rising: 2, steady: 1, cooling: 0 };
  items.forEach(it => { it._score = it.popularity + vW[it.velocity] * 8; });
  items.sort((a, b) => b._score - a._score);
  items.forEach((it, i) => { it.rank = i + 1; delete it._score; });
  return items.slice(0, N);
}

function textOf(msg) {
  return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// Two-step for reliability: (1) Claude sweeps the web with the web_search tool and writes
// up findings; (2) a forced structured-output call turns that into the ranked 10. This
// guarantees the tool is called (vs. hoping the model emits it after searching).
async function generatePulse() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Step 1 — exhaustive web sweep.
  const research = await client.messages.create({
    model: MODEL,
    max_tokens: 3500,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{ role: 'user', content: PROMPT }],
  });
  const findings = textOf(research);
  if (!findings) return null;

  // Step 2 — force the structured 10 (no web tool, deterministic tool call).
  const structured = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [PULSE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_pulse' },
    messages: [{ role: 'user', content: `From the research below, produce the TOP ${N} market-moving distillations, ranked #1..${N} by popularity + how fast the news is trending. Keep tickers/specifics; flag hype/crowding honestly.\n\n=== RESEARCH ===\n${findings}` }],
  });
  const items = parsePulse(structured);
  return items.length ? { items, generatedAt: new Date().toISOString(), sourcedFromSearch: (research.usage && research.usage.server_tool_use) ? true : undefined } : null;
}

const DISCLAIMER = 'Attention digest — what the crowd is watching, NOT buy signals. Social sentiment is a weak/contrarian indicator (this app\'s own research); use it for awareness of catalysts and crowding, then verify. Refreshes ~every 4 hours.';

// op=pulse — serve the cached distillation, regenerating at most every 4 hours.
async function runPulse(req, res) {
  const force = req.query.force === '1';
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  const fresh = cached && cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime() < REFRESH_MS);
  if (cached && fresh && !force) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, refreshMins: 240, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
  }
  let result = null;
  try { result = await generatePulse(); } catch (e) { result = null; var genErr = e && e.message; }
  if (!result) {
    // Fall back to the last snapshot even if stale, so the UI is never empty.
    if (cached) {
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.json({ ok: true, cached: true, stale: true, disclaimer: DISCLAIMER, ...cached, ageMins: Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: typeof genErr !== 'undefined' ? genErr : 'pulse unavailable (no API key or no results)', items: [], disclaimer: DISCLAIMER });
  }
  if (hasStore()) await writeJSON(CACHE_KEY, result, 0).catch(() => {});
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, cached: false, refreshMins: 240, disclaimer: DISCLAIMER, ...result, ageMins: 0 });
}

module.exports = { runPulse, parsePulse, PULSE_TOOL };
