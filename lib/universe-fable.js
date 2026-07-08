// FABLE-5 CURATION of the expanded universe's ambiguous tail.
//
// The mechanical filter (lib/universe-expand.js) + the liquidity floor
// (universescan) already remove ~95% of the junk cheaply. What they CAN'T judge
// from a symbol + volume alone is the ambiguous remainder: blank-check/SPAC shells
// that slipped through, pure holding shells, defunct/bankruptcy-emerging names,
// and sub-scale trusts that trade but aren't real operating companies. This is a
// language judgment — exactly where a bounded Fable pass adds value that a numeric
// threshold can't. One batch per call, tool-forced, graceful null (keeps names).

const MODEL = 'claude-fable-5';
const CALL_TIMEOUT_MS = 40000;
const MAX_TOKENS = 1500;

const CURATION_TOOL = {
  name: 'submit_curation',
  description: 'From a list of listed US tickers (symbol + security name), return the ones that are NOT ordinary operating companies worth scanning for trade setups.',
  input_schema: {
    type: 'object',
    properties: {
      skip: {
        type: 'array',
        description: 'Tickers to SKIP — blank-check/SPAC shells, pure holding shells with no operations, defunct/bankruptcy or liquidation names, pre-revenue trusts, or clearly non-operating vehicles. Do NOT skip a normal operating company just because it is small or foreign (ADRs are fine).',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            reason: { type: 'string', enum: ['spac', 'shell', 'defunct', 'trust', 'other'], description: 'why it is not worth scanning' },
          },
          required: ['ticker', 'reason'],
        },
      },
    },
    required: ['skip'],
  },
};

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function buildPrompt(items) {
  const lines = items.map(x => `${x.symbol} — ${clip(x.name, 80)}`).join('\n');
  return `You are curating a US stock universe for a swing-trading scanner. Below are listed tickers (symbol — security name). Most are ordinary operating companies — KEEP those. Flag ONLY the ones that are not worth scanning: blank-check/SPAC shells ("... Acquisition ..."), pure holding shells, defunct/bankruptcy/liquidation names, or non-operating trusts/vehicles. A small or foreign operating company (including ADRs) is fine — keep it. When unsure, KEEP (leave it out of skip).

TICKERS:
${lines}

Call submit_curation with the skip list only.`;
}

function parseCuration(input, validSyms) {
  const valid = validSyms ? new Set(validSyms.map(s => String(s).toUpperCase())) : null;
  const raw = (input && Array.isArray(input.skip)) ? input.skip : [];
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    const tk = clip(s && s.ticker, 8).toUpperCase().replace(/[^A-Z.]/g, '');
    if (!tk || seen.has(tk) || (valid && !valid.has(tk))) continue;
    seen.add(tk);
    out.push({ ticker: tk, reason: ['spac', 'shell', 'defunct', 'trust', 'other'].includes(s.reason) ? s.reason : 'other' });
  }
  return out;
}

async function curateBatch(items, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY || !items || !items.length) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      tools: [CURATION_TOOL], tool_choice: { type: 'tool', name: 'submit_curation' },
      messages: [{ role: 'user', content: buildPrompt(items) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_curation');
    if (!tool) return null;
    return parseCuration(tool.input, items.map(x => x.symbol));
  } catch { return null; }
}

module.exports = { curateBatch, parseCuration, buildPrompt };
