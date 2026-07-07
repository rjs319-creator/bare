// 🌐 CROSS-ASSET TELLS — leading-indicator fusion (Fable-idea #4).
//
// THESIS: a US stock is often the LAST place a move shows up. The tells lead — an overnight
// move in a foreign market / ADR, a related commodity (oil, gold, copper, uranium, nat gas),
// a related crypto (BTC/ETH → miners/COIN/MSTR), or rates/the dollar. Everything else in the
// app keys off the US equity's OWN tape; this one keys off a move in a DIFFERENT asset that
// the levered US stock hasn't caught up to yet. The AI sweeps today's cross-asset moves and
// names the most-levered US stocks still LAGGING (LEAD) vs already tracking (INLINE) vs a
// loose link (WEAK). Our tape then confirms the named stock is actually still lagging.
//
// MODEL: a broad web_search sweep → Haiku 4.5 (the proven-reliable search model; Sonnet/Fable
// + search overran the 60s wall). maxRetries:0. HONEST FRAMING: cross-asset lead-lag is noisy
// and often already arbitraged — a LEAD to forward-track, not a buy signal.

const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 50000;
const MAX_ITEMS = 8;
const CLASSES = ['LEAD', 'INLINE', 'WEAK'];

const CA_TOOL = {
  name: 'submit_crossasset',
  description: 'Return US stocks with a leading cross-asset tell that they have not yet fully reflected.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'US-listed stocks levered to a cross-asset move, best (clearest LEAD) first.',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'US-listed ticker' },
            lead_asset: { type: 'string', description: 'the asset that moved + roughly how much (e.g. "Brent crude +4% overnight", "gold +2.5% to a record", "TSM ADR +5% pre-market", "BTC +6%")' },
            linkage: { type: 'string', description: 'why this US stock is directly levered to that asset' },
            classification: { type: 'string', enum: CLASSES, description: 'LEAD = the asset moved and this stock has NOT yet caught up (actionable); INLINE = already tracking the move; WEAK = the link is loose/indirect' },
            confidence: { type: 'integer', description: '1-5' },
            thesis: { type: 'string', description: 'one honest sentence' },
            caution: { type: 'string', description: 'honest flag; empty if none' },
          },
          required: ['ticker', 'lead_asset', 'linkage', 'classification', 'confidence', 'thesis'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt() {
  return `You are a cross-asset markets desk analyst. Using web search, sweep the BIGGEST moves right now / overnight in assets OUTSIDE US equities:
- Commodities: crude oil (WTI/Brent), natural gas, gold, silver, copper, uranium, agriculture.
- Overnight foreign markets & key ADRs: Asia/Europe indices, TSMC, ASML, China tech (BABA/PDD/JD), Japan, etc.
- Crypto: BTC, ETH (→ miners, COIN, MSTR).
- Rates / the US dollar (DXY) / Treasury yields.

For each SIGNIFICANT cross-asset move, name the US-listed stocks MOST directly levered to it, and judge whether each has already caught up:
- LEAD: the asset made a clear move and this US stock has NOT yet fully reflected it → the tradeable lag.
- INLINE: the stock has already moved with the asset (caught up).
- WEAK: the linkage is loose or indirect.

Rules: be SPECIFIC about the leading asset and its move (name it + the rough magnitude), and about WHY the stock is levered (a named mechanism, not a theme). Prefer liquid US names. Only include a stock if a real cross-asset move is driving it. Return up to ${MAX_ITEMS}, clearest LEADs first. You MUST call submit_crossasset; do not answer in plain text.`;
}

function parseResult(input) {
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
  const byTicker = new Map();
  for (const it of raw) {
    if (!it || !it.ticker || !it.lead_asset) continue;
    const tk = clean(it.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || byTicker.has(tk)) continue;
    byTicker.set(tk, {
      ticker: tk,
      lead_asset: clean(it.lead_asset, 200),
      linkage: clean(it.linkage, 300),
      classification: CLASSES.includes(it.classification) ? it.classification : 'WEAK',
      confidence: Math.max(1, Math.min(5, parseInt(it.confidence, 10) || 3)),
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

// Rank: LEAD first (the lag is the edge), then by confidence.
function rankItems(items) {
  const bucket = c => (c.classification === 'LEAD' ? 0 : c.classification === 'INLINE' ? 1 : 2);
  return [...items].sort((a, b) => bucket(a) - bucket(b) || b.confidence - a.confidence);
}

async function investigate() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const digest = await require('./feedback-digest').getFeedbackDigest('CrossAsset');  // Layer 4: in-context self-calibration
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, CA_TOOL],
    messages: [{ role: 'user', content: buildPrompt() + digest }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_crossasset');
  return tool ? tool.input : null;
}

module.exports = { CA_TOOL, buildPrompt, parseResult, rankItems, investigate, MODEL, MAX_ITEMS, CLASSES };
