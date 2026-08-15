'use strict';
// STRUCTURED BEAR CASE — one bounded Haiku call that argues AGAINST each Today pick.
//
// Reader-honesty layer from the TradingAgents audit (their bull/bear debate carries no
// measured edge, so nothing here touches ranking — this is presentation): every ranked
// pick ships with the strongest honest case AGAINST it, argued only from the evidence
// fields the board itself served, plus the one observation that would invalidate the
// bear read. Judge-style anti-hedging: a genuine objection or an explicit "the provided
// evidence gives the bear nothing", never "it could go either way".
//
// Weight 0 by construction: the cases live in their own blob + a payload side-map
// (payload.bearCases) — no row is mutated, the board hash is untouched, and the UI
// labels every line model-generated. Cheap generator model per the two-tier policy.

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_CASES = 8;              // top unique tickers per day — bounds tokens + latency
const CALL_TIMEOUT_MS = 45000;
const MAX_TOKENS = 3000;

const BEAR_TOOL = {
  name: 'submit_bear_cases',
  description: 'Return the strongest honest case AGAINST each listed setup, argued strictly from the provided fields.',
  input_schema: {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'one of the provided tickers, exactly' },
            bearCase: { type: 'string', description: '2-3 sentences: the strongest honest argument AGAINST this setup, from the provided evidence only. No hedging ("could go either way" is banned). If the provided evidence genuinely gives the bear nothing, say exactly that in one sentence.' },
            invalidation: { type: 'string', description: 'one line: the concrete observation that would prove this bear case wrong (a level, a follow-through condition, a breadth/regime change).' },
          },
          required: ['ticker', 'bearCase'],
        },
      },
    },
    required: ['cases'],
  },
};

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = (v) => (Number.isFinite(v) ? v : null);

/** Compact one-line evidence rendering of a board signal. Pure. */
function sigLine(sig) {
  const bits = [
    `$${sig.ticker}`,
    `${sig.side === 'short' ? 'SHORT' : 'LONG'} ${sig.setup || sig.source || 'setup'}`,
    `state=${sig.state || 'n/a'}`, `score=${sig.score}`,
  ];
  if (num(sig.entry)) bits.push(`entry ${sig.entry}`);
  if (num(sig.stop)) bits.push(`stop ${sig.stop}`);
  if (num(sig.target)) bits.push(`target ${sig.target}`);
  if (sig.sector) bits.push(sig.sector);
  const fams = sig.evidence && Array.isArray(sig.evidence.families) ? sig.evidence.families.join('/') : null;
  if (fams) bits.push(`evidence: ${fams}`);
  if (sig.catalyst) bits.push(`catalyst: ${clip(sig.catalyst, 80)}`);
  return '- ' + bits.join(' · ');
}

/** Select up to MAX_CASES unique-ticker signals: actionable first, then leads. Pure. */
function selectSignals(payload) {
  const seen = new Set();
  const out = [];
  const lanes = [payload && payload.actionableByHorizon, payload && payload.qualifiedLeadsByHorizon];
  for (const lane of lanes) {
    for (const arr of Object.values(lane || {})) {
      for (const sig of arr || []) {
        if (!sig || !sig.ticker || seen.has(sig.ticker)) continue;
        seen.add(sig.ticker);
        out.push(sig);
        if (out.length >= MAX_CASES) return out;
      }
    }
  }
  return out;
}

function buildPrompt(signals, regimeLabel) {
  return `You are the risk desk arguing AGAINST today's ranked setups (regime read: ${regimeLabel || 'n/a'}). For EACH setup below, give the strongest honest bear case — the argument a skeptical PM would make — using ONLY the fields shown. Rules:
- Argue from the shown evidence (setup type, state, levels, sector, evidence families, catalyst). Do NOT invent prices, events, fundamentals, or news.
- No hedging. "It could go either way" and probability talk are banned. Commit to the strongest objection, or state plainly that the provided evidence gives the bear nothing.
- For each case, name the one concrete observation that would prove the bear WRONG (invalidation).

SETUPS:
${signals.map(sigLine).join('\n')}

You MUST call submit_bear_cases — do not answer in plain text.`;
}

/** Sanitize model output → { TICKER: {bearCase, invalidation} }. Pure. */
function parseBearCases(input, validTickers) {
  const valid = new Set((validTickers || []).map((t) => String(t).toUpperCase()));
  const out = {};
  for (const c of (input && Array.isArray(input.cases)) ? input.cases : []) {
    if (!c || !c.ticker || !c.bearCase) continue;
    const tk = clip(c.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || !valid.has(tk) || out[tk]) continue;
    out[tk] = {
      bearCase: clip(c.bearCase, 500),
      invalidation: c.invalidation ? clip(c.invalidation, 200) : null,
    };
  }
  return out;
}

/**
 * One bounded Haiku call over the selected signals. Returns { cases, model } or null
 * on any failure (no key, timeout, no tool call) — the board never depends on it.
 */
async function generateBearCases(signals, regimeLabel, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const list = (signals || []).filter((s) => s && s.ticker).slice(0, MAX_CASES);
  if (!list.length) return { cases: {}, model: MODEL };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [BEAR_TOOL],
      tool_choice: { type: 'tool', name: 'submit_bear_cases' },
      system: 'You argue the honest bear case against trading setups from provided evidence only. Never invent facts, prices, or events. Never hedge. Always respond by calling submit_bear_cases.',
      messages: [{ role: 'user', content: buildPrompt(list, regimeLabel) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_bear_cases');
    if (!tool) return null;
    return { cases: parseBearCases(tool.input, list.map((s) => s.ticker)), model: MODEL };
  } catch {
    return null;
  }
}

module.exports = { MODEL, MAX_CASES, BEAR_TOOL, sigLine, selectSignals, buildPrompt, parseBearCases, generateBearCases };
