// 🌊 SECOND WAVE — reflexive-attention forecaster (Fable-idea #3).
//
// THESIS (Soros reflexivity): a stock that had a FIRST leg up on a real, legible catalyst
// but that the crowd has NOT yet piled into is a candidate for a reflexive SECOND wave as
// the story spreads to a wider cohort of buyers. This INVERTS Market Pulse (which ranks
// what's ALREADY trending — priced/late); here we forecast the crowd's ARRIVAL. Detection
// is pure tape (a moderate multi-session up move + volume, not yet parabolic, liquid); the
// AI then judges each — PRIMED (fresh legible story with room to spread, crowd still light),
// EARLY (real but needs more confirmation), or FADED (already crowded / story played out).
//
// MODEL: search-bound (needs to gauge how crowded / how fresh the narrative is), so it runs
// on Sonnet 5 + web_search (Fable 5 + search overruns the 60s wall). maxRetries:0.
// HONEST FRAMING: attention is famously reflexive/hard to predict — this is a LEAD, paper-
// tracked on the Scoreboard (do PRIMED names actually get the second leg vs FADED?).

// Sonnet 5 + web_search consistently overran the wall here (Second Wave checks crowd state
// across several platforms per name = heavy searching). Haiku 4.5 is the proven-reliable
// search investigator (Market Pulse runs it at ~40s) and its judgment is adequate for the
// primed/early/faded + crowd-state call with search grounding.
const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 50000;
const MAX_INVESTIGATE = 4;
const CLASSES = ['PRIMED', 'EARLY', 'FADED'];

// Detection: a "first leg" — up a moderate amount over ~10 sessions on elevated volume,
// NOT already parabolic (cap the move so we catch it early), liquid enough to matter.
const MIN_RET10 = 6;                 // >= +6% over ~10 sessions
const MAX_RET10 = 30;                // but < +30% — past that the first wave is likely spent
const MIN_RELVOL = 1.3;
const MIN_DOLLAR_VOL = 5_000_000;

function isFirstLegCandidate(m, ret10) {
  return !!m && ret10 != null
    && ret10 >= MIN_RET10 && ret10 <= MAX_RET10
    && m.relVol >= MIN_RELVOL
    && (m.avgDollarVol || 0) >= MIN_DOLLAR_VOL;
}

const SW_TOOL = {
  name: 'submit_secondwave',
  description: 'Classify each first-leg mover by its potential for a reflexive SECOND wave of buyers.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            classification: { type: 'string', enum: CLASSES, description: 'PRIMED = fresh legible catalyst, story spreading, crowd still light → room for a 2nd wave; EARLY = real but unconfirmed / needs a trigger; FADED = already heavily crowded / story played out / late' },
            catalyst: { type: 'string', description: 'the first-leg catalyst you found' },
            crowd_state: { type: 'string', description: 'how crowded is it already (FinTwit/StockTwits/WSB/news) — light / building / saturated' },
            virality: { type: 'integer', description: '1-5: potential for the narrative to spread to a wider cohort' },
            thesis: { type: 'string', description: 'one honest sentence on the second-wave setup' },
            caution: { type: 'string', description: 'honest flag; empty if none' },
          },
          required: ['ticker', 'classification', 'catalyst', 'crowd_state', 'virality', 'thesis'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt(cands) {
  const lines = cands.map(c => `- ${c.ticker}: up ${c.ret10}% over ~10 sessions, RVOL ${c.relVol}x, today ${c.pctChange > 0 ? '+' : ''}${c.pctChange}%.`).join('\n');
  return `You are a markets desk analyst forecasting REFLEXIVE SECOND WAVES. Each of these stocks has had a FIRST leg up on volume:

${lines}

The idea (Soros reflexivity): a stock with a real, legible catalyst that the CROWD hasn't fully piled into yet can draw a SECOND wave of buyers as the story spreads. You are NOT ranking what's already trending (that's late/priced) — you are forecasting who the crowd is ABOUT to discover.

For EACH, use web search to find (a) the first-leg CATALYST and (b) how CROWDED it already is on FinTwit / X / StockTwits / Reddit / financial media. Then classify:
- PRIMED: a fresh, legible, spreadable catalyst with the crowd still LIGHT → genuine room for a second wave. The interesting bucket.
- EARLY: a real setup but unconfirmed or needing a further trigger.
- FADED: already heavily crowded / saturated coverage / the story has played out → likely late.

Be strict and HONEST: if a name is already all over FinTwit, it's FADED even if the story is good (the second wave already happened). If you can't find a real catalyst, it's not PRIMED. Give the catalyst, the crowd state, a 1-5 virality score, and one honest sentence. You MUST call submit_secondwave; do not answer in plain text.`;
}

function parseResult(input, cands) {
  const allowed = cands ? new Set(cands.map(c => c.ticker)) : null;
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
  const byTicker = new Map();
  for (const it of raw) {
    if (!it || !it.ticker) continue;
    const tk = clean(it.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || (allowed && !allowed.has(tk)) || byTicker.has(tk)) continue;
    byTicker.set(tk, {
      ticker: tk,
      classification: CLASSES.includes(it.classification) ? it.classification : 'EARLY',
      catalyst: clean(it.catalyst, 400) || 'unclear',
      crowd_state: clean(it.crowd_state, 120),
      virality: Math.max(1, Math.min(5, parseInt(it.virality, 10) || 3)),
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

// Rank: PRIMED first, then by virality.
function rankItems(items) {
  const bucket = c => (c.classification === 'PRIMED' ? 0 : c.classification === 'EARLY' ? 1 : 2);
  return [...items].sort((a, b) => bucket(a) - bucket(b) || b.virality - a.virality);
}

async function investigate(cands) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const digest = await require('./feedback-digest').getFeedbackDigest('SecondWave');  // Layer 4: in-context self-calibration
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, SW_TOOL],
    messages: [{ role: 'user', content: buildPrompt(cands) + digest }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_secondwave');
  return tool ? tool.input : null;
}

module.exports = {
  SW_TOOL, isFirstLegCandidate, buildPrompt, parseResult, rankItems, investigate,
  MODEL, MAX_INVESTIGATE, CLASSES, MIN_RET10, MAX_RET10, MIN_RELVOL, MIN_DOLLAR_VOL,
};
