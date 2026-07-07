// 📡 MARKET PULSE — a distillation of what the crowd is watching that could move US
// markets, in TWO STAGES:
//
//   1. GATHER (Haiku 4.5 + web_search) — a serverless function can't scrape X/YouTube,
//      so Haiku's server-side web_search tool sweeps trending finance chatter (X/FinTwit,
//      StockTwits, r/wallstreetbets, finance YouTube, major news) and returns a broad,
//      raw candidate list. Haiku is the RELIABLE searcher under the 60s wall (~30-40s).
//   2. REFINE (Fable 5, parametric) — one bounded, no-search reasoning pass over that
//      raw list that MERGES duplicate themes, RE-RANKS by genuine market-moving weight,
//      sharpens the "why it moves," and adds this desk's signature CONTRARIAN / CROWDING
//      read (how positioned the crowd already is, and whether it's likely a fade).
//
// The two stages run in SEPARATE invocations (Haiku-search + Fable-reason in one call
// blows the 60s function wall — proven). The frontend shows the Haiku draft instantly,
// then swaps in the Fable-refined version a few seconds later; the daily warm cron
// pre-builds a refined snapshot so most users hit the cache instantly.
//
// HONEST FRAMING: this is an ATTENTION digest, not buy signals. This project's own
// research found social *sentiment* is weak/contrarian (WSB bullishness underperforms);
// the useful part is *awareness* of catalysts + crowding. Refreshes every ~4 hours.
const { readJSON, writeJSON, hasStore } = require('./store');

const CACHE_KEY = 'pulse/latest.json';
const REFRESH_MS = 4 * 60 * 60 * 1000;          // regenerate at most every 4 hours
const GATHER_MODEL = 'claude-haiku-4-5-20251001';
const REFINE_MODEL = 'claude-fable-5';
const N = 10;              // items surfaced to the user
const GATHER_N = 16;       // raw candidates Haiku pulls (Fable dedupes/culls down to N)
const REFINE_TIMEOUT_MS = 42000;   // Fable parametric pass, under the 60s wall (maxRetries:0)
const REFINE_MAX_TOKENS = 6000;

const SENTIMENTS = ['bullish', 'bearish', 'mixed'];
const VELOCITIES = ['exploding', 'rising', 'steady', 'cooling'];
const CROWDINGS = ['early', 'building', 'crowded', 'capitulation'];

// Structured-output tool for STAGE 1 (Haiku gather): the raw fields the search returns.
const PULSE_TOOL = {
  name: 'submit_pulse',
  description: 'Return the top trending market-moving distillations, ranked by a blend of popularity (how widely discussed right now) and velocity (how fast the news is accelerating).',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Up to ${GATHER_N} items, most popular + fastest-trending first. Include duplicates/overlap if unsure — the refine pass will merge them.`,
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', description: '1..N, 1 = most popular + fastest trending' },
            headline: { type: 'string', description: 'one punchy sentence' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'relevant US tickers (may be empty for a macro theme)' },
            idea: { type: 'string', description: 'what the crowd / media is actually saying (1-2 sentences)' },
            whyMoves: { type: 'string', description: 'why this could move US markets (1 sentence)' },
            sentiment: { type: 'string', enum: SENTIMENTS },
            popularity: { type: 'integer', description: '1-100: how widely discussed right now across platforms' },
            velocity: { type: 'string', enum: VELOCITIES, description: 'how fast the discussion is accelerating' },
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

// Structured-output tool for STAGE 2 (Fable refine): same render fields PLUS the desk's
// contrarian/crowding judgment. Fable MUST merge dupes and cull to the true top ${N}.
const PULSE_REFINE_TOOL = {
  name: 'submit_pulse_refined',
  description: `Return the FINAL top ${N} distillations after merging duplicate/overlapping themes from the draft, re-ranking by genuine market-moving weight, and adding a contrarian/crowding read. Ranked #1 = most important.`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Exactly ${N} de-duplicated items, ranked #1..${N} by genuine importance (popularity × velocity × how tradeable/market-moving it actually is).`,
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', description: `1..${N}` },
            headline: { type: 'string', description: 'one punchy, specific sentence' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'relevant US tickers (may be empty for a macro theme)' },
            idea: { type: 'string', description: 'what the crowd / media is actually saying (1-2 sentences), consolidated across sources' },
            whyMoves: { type: 'string', description: 'the sharpest single reason this could move US markets' },
            sentiment: { type: 'string', enum: SENTIMENTS },
            popularity: { type: 'integer', description: '1-100: how widely discussed right now' },
            velocity: { type: 'string', enum: VELOCITIES },
            crowding: { type: 'string', enum: CROWDINGS, description: 'how POSITIONED the crowd already is: early = few in, thesis fresh; building = gaining steam; crowded = consensus/everyone-long, contrarian risk; capitulation = late blow-off / exhaustion.' },
            contrarian: { type: 'string', description: 'one HONEST desk read: is the crowd likely right, or is this already priced / a probable fade / sell-the-news? Social sentiment is a weak/contrarian signal — say so when it is.' },
            sources: { type: 'string', description: 'where it is trending, consolidated' },
            caution: { type: 'string', description: 'optional honest flag — hype/crowded/extended/thin-float; empty if none' },
          },
          required: ['rank', 'headline', 'tickers', 'idea', 'whyMoves', 'sentiment', 'popularity', 'velocity', 'crowding', 'contrarian', 'sources'],
        },
      },
    },
    required: ['items'],
  },
};

const GATHER_PROMPT = `You are a markets desk analyst. Using web search, run an EXHAUSTIVE sweep of what finance social media and media are trending on RIGHT NOW that could move US markets. Cover, at minimum:
- X / FinTwit most-mentioned tickers and threads
- StockTwits trending & most-active symbols
- Reddit r/wallstreetbets most-mentioned / fastest-rising
- Trending finance YouTube videos (CNBC, Bloomberg, Yahoo Finance, popular finfluencers)
- Breaking market news, earnings, FDA/biotech catalysts, unusual options / short-squeeze chatter, and macro events on the calendar this week

Return up to ${GATHER_N} candidate ideas — specific stocks OR themes. Cast a WIDE net: it's fine to include overlapping or borderline items, because a second pass will merge duplicates and cull to the final list. For each, give tickers, what the crowd is actually saying, why it could move US markets, sentiment, a 1-100 popularity score, a velocity bucket (exploding > rising > steady > cooling), and a short summary of WHERE it's trending. Be specific and HONEST about hype/crowding. Submit via the submit_pulse tool — do not answer in plain text.`;

// ── Shared sanitization ─────────────────────────────────────────────────────
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const cleanTickers = arr => (Array.isArray(arr) ? arr : [])
  .map(t => String(t).toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8))
  .filter(Boolean)
  .slice(0, 6);

/** Sanitize one raw/refined item into the render shape. Pure. `refined` adds the desk read. */
function sanitizeItem(it, refined) {
  const base = {
    headline: clip(it.headline, 240),
    tickers: cleanTickers(it.tickers),
    idea: clip(it.idea, 600),
    whyMoves: clip(it.whyMoves || '', 400),
    sentiment: oneOf(it.sentiment, SENTIMENTS, 'mixed'),
    popularity: Math.max(1, Math.min(100, parseInt(it.popularity, 10) || 50)),
    velocity: oneOf(it.velocity, VELOCITIES, 'steady'),
    sources: clip(it.sources || '', 300),
    caution: it.caution ? clip(it.caution, 300) : null,
  };
  if (!refined) return base;
  return { ...base, crowding: oneOf(it.crowding, CROWDINGS, 'building'), contrarian: clip(it.contrarian || '', 400) };
}

// Rank by popularity + velocity weight (exploding=3, rising=2, steady=1, cooling=0).
const VEL_W = { exploding: 3, rising: 2, steady: 1, cooling: 0 };
function rankByBuzz(items, cap) {
  items.forEach(it => { it._score = it.popularity + VEL_W[it.velocity] * 8; });
  items.sort((a, b) => b._score - a._score);
  items.forEach((it, i) => { it.rank = i + 1; delete it._score; });
  return items.slice(0, cap);
}

/** STAGE 1 parse: Haiku's raw gather → sanitized, buzz-ranked list (capped). Pure. */
function parsePulse(msg, cap = N) {
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_pulse');
  const raw = (tool && tool.input && Array.isArray(tool.input.items)) ? tool.input.items : [];
  const items = raw.filter(it => it && it.headline && it.idea).map(it => sanitizeItem(it, false));
  return rankByBuzz(items, cap);
}

/** STAGE 2 parse: Fable's refined list → sanitized, keeps Fable's ordering (its judgment). Pure. */
function parseRefinedPulse(input, cap = N) {
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const items = raw.filter(it => it && it.headline && it.idea).map(it => sanitizeItem(it, true));
  items.forEach((it, i) => { it.rank = i + 1; });   // trust Fable's rank order
  return items.slice(0, cap);
}

// ── STAGE 1: gather (Haiku + web_search) ─────────────────────────────────────
// Single web-search call (must fit the 60s function budget): Haiku sweeps the web and
// emits the raw candidates via submit_pulse in one request. max_uses is bounded so it
// stays under the timeout.
async function gatherPulse() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: GATHER_MODEL,
    max_tokens: 5000,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      PULSE_TOOL,
    ],
    messages: [{ role: 'user', content: GATHER_PROMPT + `\n\nAfter searching, you MUST call the submit_pulse tool with the items — do not answer in plain text.` }],
  }, { timeout: 48000 });    // stay under the 60s function limit → graceful stale fallback
  const items = parsePulse(msg, GATHER_N);
  return items.length ? { items, stage: 'draft', generatedAt: new Date().toISOString() } : null;
}

// ── STAGE 2: refine (Fable 5, parametric, no search) ─────────────────────────
function draftLine(it, i) {
  const tks = (it.tickers || []).map(t => '$' + t).join(' ') || '—';
  return `${i + 1}. [${tks}] ${it.headline}\n   crowd: ${it.idea}\n   why: ${it.whyMoves} | sentiment: ${it.sentiment} | pop ${it.popularity} | velocity ${it.velocity}\n   trending on: ${it.sources}${it.caution ? `\n   flag: ${it.caution}` : ''}`;
}

function buildRefinePrompt(draftItems) {
  const lines = draftItems.map(draftLine).join('\n\n');
  return `You are the senior editor on a markets desk. A junior analyst swept social + finance media and produced this RAW draft of trending ideas. It is noisy: themes overlap and repeat, ranking is crude, and it takes the crowd at face value.

RAW DRAFT (${draftItems.length} items):
${lines}

Produce the FINAL top ${N}:
1. MERGE duplicates and overlapping themes into one item (combine their tickers/sources; take the higher popularity).
2. RE-RANK by genuine market-moving weight = how widely discussed × how fast it's accelerating × how actually tradeable/consequential it is. Drop pure noise and stale items.
3. Sharpen each: one punchy headline, a consolidated "what the crowd is saying", and the single sharpest reason it could move US markets.
4. Add this desk's CONTRARIAN read for each:
   - crowding: how positioned the crowd already is (early / building / crowded / capitulation).
   - contrarian: one HONEST line — is the crowd likely right, or is this already priced, extended, a probable fade or 'sell the news'? Remember social sentiment is a WEAK / CONTRARIAN signal at this desk (retail-crowded longs tend to underperform); when a name is loud and crowded, say so rather than cheerleading.
5. Keep sentiment/popularity/velocity honest.

Return exactly ${N} de-duplicated items via submit_pulse_refined — do not answer in plain text.`;
}

/** One bounded Fable-5 parametric refine over the draft. Returns refined items or null. */
async function refineDraft(draftItems, timeoutMs = REFINE_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const items = (draftItems || []).filter(it => it && it.headline).slice(0, GATHER_N);
  if (!items.length) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: REFINE_MODEL,
      max_tokens: REFINE_MAX_TOKENS,
      tools: [PULSE_REFINE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_pulse_refined' },
      messages: [{ role: 'user', content: buildRefinePrompt(items) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_pulse_refined');
    if (!tool) return null;
    const refined = parseRefinedPulse(tool.input, N);
    return refined.length ? refined : null;
  } catch {
    return null;   // graceful — caller keeps the Haiku draft
  }
}

const DISCLAIMER = 'Attention digest — what the crowd is watching, NOT buy signals. Social sentiment is a weak/contrarian indicator (this app\'s own research); use it for awareness of catalysts and crowding, then verify. Refreshes ~every 4 hours.';

function serve(res, doc, extra, cacheHeader) {
  res.setHeader('Cache-Control', cacheHeader);
  const ageMins = doc.generatedAt ? Math.round((Date.now() - new Date(doc.generatedAt).getTime()) / 60000) : 0;
  return res.json({ ok: true, disclaimer: DISCLAIMER, refreshMins: 240, ...doc, ...extra, ageMins });
}

// ── op=pulse — STAGE 1. Serve the cached distillation, regenerating (gather) at most
// every 4 hours. Returns the Haiku draft immediately; the frontend (or warm cron) then
// calls op=pulserefine to upgrade it to the Fable-refined version.
async function runPulse(req, res) {
  const force = req.query.force === '1';
  const store = hasStore();
  const cached = store ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  const fresh = cached && cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime() < REFRESH_MS);
  if (cached && fresh && !force) {
    const { raw, ...userDoc } = cached;
    return serve(res, userDoc, { cached: true, persisted: store }, 's-maxage=1800, stale-while-revalidate=86400');
  }
  let draft = null, genErr;
  try { draft = await gatherPulse(); } catch (e) { draft = null; genErr = e && e.message; }
  if (!draft) {
    if (cached) return serve(res, cached, { cached: true, stale: true, persisted: store }, 's-maxage=600');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: genErr || 'pulse unavailable (no API key or no results)', items: [], disclaimer: DISCLAIMER });
  }
  // `items` is always the user-facing top-N; the fuller candidate list is kept under
  // `raw` for the refine pass to merge/cull. The frontend then upgrades via op=pulserefine.
  const doc = { stage: 'draft', generatedAt: draft.generatedAt, items: draft.items.slice(0, N), raw: draft.items };
  if (store) await writeJSON(CACHE_KEY, doc, 0).catch(() => {});
  const { raw, ...userDoc } = doc;
  return serve(res, userDoc, { cached: false, persisted: store, candidates: draft.items.length }, 's-maxage=1800, stale-while-revalidate=86400');
}

// ── op=pulserefine — STAGE 2. Read the cached draft, run the bounded Fable-5 pass, and
// overwrite the cache with the refined top-${N}. Idempotent: if already refined for this
// generation, just returns it. Requires a persisted draft (needs a Blob store).
async function runPulseRefine(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, needsDraft: true, error: 'no store — refine needs a persisted draft' });
  }
  const cached = await readJSON(CACHE_KEY, null).catch(() => null);
  const candidates = cached && (Array.isArray(cached.raw) ? cached.raw : cached.items);
  if (!cached || !Array.isArray(candidates) || !candidates.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, needsDraft: true, error: 'no draft to refine — call op=pulse first' });
  }
  const force = req.query.force === '1';
  if (cached.stage === 'refined' && !force) {
    return serve(res, cached, { cached: true, alreadyRefined: true, persisted: true }, 's-maxage=1800, stale-while-revalidate=86400');
  }
  const refined = await refineDraft(candidates);
  if (!refined) {
    // Fable failed — keep serving the draft (its top N), never break the tab.
    const { raw, ...userDoc } = cached;
    return serve(res, userDoc, { refineFailed: true, persisted: true }, 's-maxage=600');
  }
  const doc = { items: refined, stage: 'refined', generatedAt: cached.generatedAt, refinedAt: new Date().toISOString() };
  await writeJSON(CACHE_KEY, doc, 0).catch(() => {});
  return serve(res, doc, { cached: false, refined: true, persisted: true }, 's-maxage=1800, stale-while-revalidate=86400');
}

module.exports = {
  runPulse, runPulseRefine,
  parsePulse, parseRefinedPulse, sanitizeItem,
  PULSE_TOOL, PULSE_REFINE_TOOL,
};
