// 🎚️ TONE SHIFT — earnings-call language DELTA (Fable-idea #2).
//
// THESIS: the app already scores the tone LEVEL of the latest earnings call (lib/earnings-
// tone.js). The novel, leading signal is the DELTA across consecutive calls — management
// shifting from hedged/cautious to confident/specific (or vice versa) is a language regime
// change the numbers haven't caught up to yet (Loughran-McDonald tone / uncertainty-word
// literature). We compare the LATEST call's tone & emphasis to the PRIOR quarter's and flag
// BRIGHTENING / STABLE / DARKENING.
//
// DATA NOTE: FMP transcript endpoints don't work on the Starter tier (the tone feature uses
// web search for the same reason), so the delta is assessed via web_search on Haiku 4.5 —
// the model reads coverage of both calls and reports the shift + the specific language change.
// HONEST FRAMING: this is a slower SWING-horizon signal (weeks), a LEAD to forward-track.

const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 50000;
const MAX_INVESTIGATE = 5;
const CLASSES = ['BRIGHTENING', 'STABLE', 'DARKENING'];

const TS_TOOL = {
  name: 'submit_toneshift',
  description: 'For each recent reporter, classify the tone/language DELTA of the latest call vs the prior quarter.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            shift: { type: 'string', enum: CLASSES, description: 'BRIGHTENING = notably more confident/upbeat/specific vs last quarter (dropped hedges, guidance-raise language, new positive emphasis); STABLE = no meaningful change; DARKENING = more cautious/hedged/defensive vs last quarter' },
            change: { type: 'string', description: 'the SPECIFIC language/emphasis change vs the prior call (e.g. "dropped the \'challenging macro\' framing and introduced \'accelerating\'")' },
            confidence: { type: 'integer', description: '1-5' },
            thesis: { type: 'string', description: 'one honest sentence' },
            caution: { type: 'string', description: 'honest flag; empty if none' },
          },
          required: ['ticker', 'shift', 'change', 'confidence', 'thesis'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt(cands) {
  const lines = cands.map(c => `- ${c.ticker}${c.callDate ? ` (reported ~${c.callDate})` : ''}`).join('\n');
  return `You are an equity analyst detecting EARNINGS-CALL TONE SHIFTS. These companies recently reported:

${lines}

For EACH, use web search to compare the LATEST earnings call's tone, language and emphasis to the PRIOR quarter's call (management commentary, guidance language, how they framed risks, analyst-call coverage). You care about the DELTA, not the absolute tone. Classify:
- BRIGHTENING: management is notably MORE confident / upbeat / specific than last quarter — dropped hedges ("challenging", "uncertain"), added guidance-raise or "accelerating"/"record" language, new positive emphasis.
- STABLE: no meaningful change in tone.
- DARKENING: notably MORE cautious / hedged / defensive than last quarter.

Be strict and HONEST: cite the SPECIFIC language/emphasis change (not the headline EPS number). If you can't find enough on both calls to judge a delta, say STABLE with low confidence. Give the change, a 1-5 confidence, and one honest sentence. You MUST call submit_toneshift; do not answer in plain text.`;
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
      shift: CLASSES.includes(it.shift) ? it.shift : 'STABLE',
      change: clean(it.change, 400) || 'no clear change',
      confidence: Math.max(1, Math.min(5, parseInt(it.confidence, 10) || 3)),
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

// Rank: BRIGHTENING first (the bullish tell), then by confidence.
function rankItems(items) {
  const bucket = c => (c.shift === 'BRIGHTENING' ? 0 : c.shift === 'STABLE' ? 1 : 2);
  return [...items].sort((a, b) => bucket(a) - bucket(b) || b.confidence - a.confidence);
}

async function investigate(cands) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, TS_TOOL],
    messages: [{ role: 'user', content: buildPrompt(cands) }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_toneshift');
  return tool ? tool.input : null;
}

module.exports = { TS_TOOL, buildPrompt, parseResult, rankItems, investigate, MODEL, MAX_INVESTIGATE, CLASSES };
