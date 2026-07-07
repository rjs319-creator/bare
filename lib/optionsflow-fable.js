// FABLE-5 ANALYSIS LAYER over the mechanical unusual-options-flow scanner
// (lib/optionsflow.js). The base scanner is pure math on delayed chain data: it
// tells you WHAT traded (premium, vol/OI, sweep/block, aggressor, breakeven) and a
// crude call=bullish / put=bearish LEAN — but it can't tell a conviction directional
// bet from a hedge, a premium-selling write, or event/IV positioning, and its
// "what you could do" is one generic template for every bullish name.
//
// This module adds ONE bounded, PARAMETRIC claude-fable-5 call that reads each
// flagged ticker's actual flow (net premium split, top contracts, aggressor, DTE,
// breakeven, earnings + abnormal-vol flags, spot move) and returns, per ticker:
//   • interpretation — what the flow really implies (conviction vs hedge vs
//     write vs event positioning), handling the @bid-fade and index-hedge nuances
//   • bias + conviction (how REAL/tradeable, not how loud)
//   • a concrete trade plan on the STOCK: entry idea/trigger, invalidation level,
//     and vehicle (shares vs defined-risk option) with a risk note
//   • catalyst + caution
// Plus a "desk read" that ranks the day's most tradeable flow.
//
// Design mirrors lib/alerts-fable.js: single parametric call, maxRetries:0 (the SDK
// retries on timeout → 2-3× budget → blows the 60s function wall), tool-forced
// structured output, graceful null on any failure (the tab keeps its mechanical
// read, never breaks). PARAMETRIC ONLY — no web_search: per the novel-screener
// finding, Fable is only wall-safe inside a tick when it isn't searching.

const MODEL = 'claude-fable-5';
// Top-N single-stock tickers per call. HARD-LEARNED bound: Fable-5 generating 15
// FULL trade plans (interpretation + entry + invalidation + vehicle + caution each)
// blew the 50s timeout on prod — latency ∝ output tokens, and a plan is ~3× an
// alerts-fable assessment. 8 (the highest-premium names, which are what matter) is
// the analog of alerts-fable's proven-safe 15 lightweight assessments. Keep it here.
const MAX_ANALYZE = 8;
const CALL_TIMEOUT_MS = 52000;    // under the 60s wall with maxRetries:0
const MAX_TOKENS = 4500;          // ~8 trade plans + the tool call (also caps worst-case gen time)
const DESK_TOP = 3;               // how many names the desk read highlights

const BIASES = ['bullish', 'bearish', 'neutral'];
const VEHICLES = ['shares', 'call_option', 'put_option', 'spread', 'avoid'];
const TIMEFRAMES = ['intraday', 'swing', 'position'];

// Structured-output tool — forces a per-ticker trade plan, not prose.
const OPTIONS_FABLE_TOOL = {
  name: 'submit_flow_analysis',
  description: 'Return a reasoned trade plan for each ticker showing unusual options flow: what the flow really means, a directional bias with honest conviction, and a concrete plan for trading the STOCK (entry, invalidation, vehicle).',
  input_schema: {
    type: 'object',
    properties: {
      analyses: {
        type: 'array',
        description: 'One analysis per ticker provided. Judge from the actual flow details, not just the call/put lean — a put block bought at the bid can be a closing/hedge, an OTM call sweep lifted at the ask is genuine conviction.',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'the US ticker being analyzed (must be one of the provided tickers)' },
            bias: { type: 'string', enum: BIASES, description: 'the true directional read on the STOCK implied by the flow. Refine the mechanical lean: aggressor at bid fades it, index/hedge flow is often neutral for the underlying, put buying can be protective not bearish.' },
            conviction: { type: 'integer', description: '0-100. How REAL and tradeable this flow is: aggressive OTM sweeps lifted at the ask + confirming spot move + abnormal-vs-own-norm volume = high; a lone block hit at the bid, or flow that contradicts the tape, = low. NOT how large the premium is.' },
            interpretation: { type: 'string', description: 'one or two sentences: what the flow most likely IS (conviction directional bet / hedge / premium-selling write / event or IV positioning) and why, from the contract details.' },
            entry: { type: 'string', description: 'concrete how-to-trade-the-STOCK entry idea: a level, trigger, or confirmation to wait for (e.g. "reclaim of $X on volume", "pullback to Y"). Not "buy now".' },
            invalidation: { type: 'string', description: 'the price level or condition that proves the read wrong and where to cut (e.g. "below $X the thesis is dead").' },
            vehicle: { type: 'string', enum: VEHICLES, description: 'the lower-risk way to express it: shares (simplest), call_option/put_option (leveraged, decays), spread (defined risk), or avoid (do not trade this).' },
            timeframe: { type: 'string', enum: TIMEFRAMES, description: 'the horizon the flow fits: intraday, swing (days-weeks), or position (weeks-months) — anchor to the DTE of the flow.' },
            catalyst: { type: 'string', description: 'the likely reason/event behind the positioning in a few words (earnings, product, macro, technical, squeeze, none). Empty if unclear.' },
            caution: { type: 'string', description: 'honest one-line risk flag (earnings/IV-crush, one-sided/thin flow, extended tape, likely-hedge). Empty if clean.' },
          },
          required: ['ticker', 'bias', 'conviction', 'interpretation', 'entry', 'invalidation', 'vehicle'],
        },
      },
      deskRead: { type: 'string', description: `a 1-2 sentence trading-desk summary of the day's standout, most tradeable unusual flow across these tickers (name the top ${DESK_TOP} and how to lean).` },
    },
    required: ['analyses'],
  },
};

// ── Prompt ────────────────────────────────────────────────────────────────
const usd = n => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : '$' + Math.round(n || 0);
const KIND = { sweep: 'sweep', block: 'block', large: 'large' };

// One compact contract descriptor for the prompt.
function contractLine(c) {
  const aggr = c.aggressor === 'ask' ? ' bought@ask' : c.aggressor === 'bid' ? ' sold@bid' : '';
  const be = (c.breakeven != null && c.moveToBePct != null) ? `, needs ${c.moveToBePct > 0 ? '+' : ''}${c.moveToBePct}% to $${c.breakeven} by ${c.expiry || '?'}` : '';
  const vo = c.volOi != null ? `, ${c.volOi}× OI` : '';
  return `${c.type} $${c.strike} (${c.dte}d, ${c.moneyness}) ${usd(c.premium)} ${KIND[c.kind] || c.kind}${aggr}${vo}${be}`;
}

// One ticker's flow block. `r` = a rollupByTicker row with `contracts` attached.
function tickerBlock(r) {
  const spot = r.underlying != null ? `spot $${r.underlying}${r.undChgPct != null ? ` (${r.undChgPct > 0 ? '+' : ''}${r.undChgPct}% today)` : ''}` : 'spot n/a';
  const split = `${r.bullishPct}% of ${usd(r.totalPremium)} premium in calls`;
  const flags = [];
  if (r.earningsBeforeExpiry && r.earningsInDays != null) flags.push(`EARNINGS in ${r.earningsInDays}d (before expiry — IV-crush risk)`);
  if (r.abnormalVsNormal) flags.push(`option volume abnormal vs its OWN norm${r.baselineNote ? ` (${r.baselineNote})` : ''}`);
  const top = (r.contracts || []).slice()
    .sort((a, b) => (b.premium || 0) - (a.premium || 0))
    .slice(0, 4).map(c => '    · ' + contractLine(c)).join('\n');
  return `- $${r.ticker}: mechanical lean=${r.net} (grade ${r.grade}), ${split}, ${spot}${flags.length ? `\n    flags: ${flags.join('; ')}` : ''}\n  top contracts:\n${top}`;
}

function buildAnalysisPrompt(rows) {
  const blocks = rows.map(tickerBlock).join('\n');
  return `You are a senior options trading-desk analyst. Below is today's UNUSUAL options flow (delayed Yahoo chain data — real prints, not live tape), one block per stock. A mechanical scanner already flagged these and gave a crude call=bullish / put=bearish lean; it CANNOT tell a conviction directional bet from a hedge, a premium-selling write, or event positioning. Re-read each name's actual flow and produce a real trade plan.

FLOW:
${blocks}

For EACH ticker decide:
1. bias — the true directional read on the STOCK. Refine the mechanical lean: a put block sold@bid can be a closing/hedge (not bearish); an OTM call sweep bought@ask with a confirming up-day is genuine conviction; heavy premium against the day's move may be a fade or a hedge.
2. conviction (0-100) — how REAL and tradeable this flow is (aggressive OTM sweeps + bought@ask + abnormal-vs-own-norm volume + confirming spot = high; lone block sold@bid or flow fighting the tape = low). Premium size alone is NOT conviction.
3. interpretation — what the flow most likely IS and why (from the contract details).
4. A concrete plan to trade the STOCK: entry (a level/trigger/confirmation, not "buy now"), invalidation (where the read is wrong and you cut), vehicle (shares simplest; options leveraged+decay; spread defined-risk; or avoid), timeframe (anchor to the flow's DTE).
5. catalyst + caution (earnings/IV-crush, thin/one-sided flow, extended tape, likely-hedge).

Be conservative and honest: a low conviction with an "avoid" and a clear caution beats a flattering guess. Then give a desk read naming the top ${DESK_TOP} most tradeable names. You MUST call submit_flow_analysis — do not answer in plain text.`;
}

// ── Parse / clamp ─────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** Sanitize the model output into { analyses: { TICKER: analysis }, deskRead }. Pure. */
function parseAnalyses(input, validTickers) {
  const valid = validTickers ? new Set(validTickers.map(t => String(t).toUpperCase())) : null;
  const raw = (input && Array.isArray(input.analyses)) ? input.analyses : [];
  const out = {};
  for (const a of raw) {
    if (!a || !a.ticker) continue;
    const tk = clip(a.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || (valid && !valid.has(tk)) || out[tk]) continue;
    out[tk] = {
      bias: BIASES.includes(a.bias) ? a.bias : 'neutral',
      conviction: clampInt(a.conviction, 0, 100, 0),
      interpretation: clip(a.interpretation, 400),
      entry: clip(a.entry, 240),
      invalidation: clip(a.invalidation, 240),
      vehicle: VEHICLES.includes(a.vehicle) ? a.vehicle : 'shares',
      timeframe: TIMEFRAMES.includes(a.timeframe) ? a.timeframe : 'swing',
      catalyst: clip(a.catalyst, 60),
      caution: a.caution ? clip(a.caution, 240) : null,
    };
  }
  return { analyses: out, deskRead: clip(input && input.deskRead, 600) };
}

// ── Bounded Fable call ────────────────────────────────────────────────────
/**
 * One bounded Fable-5 analysis of the top ranked single-stock flow rollups.
 * Returns the parsed { analyses, deskRead } or null on any failure (no key,
 * timeout, no tool call). `rows` = rollupByTicker rows with `contracts` attached.
 */
async function analyzeFlow(rows, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const list = (rows || []).filter(r => r && r.ticker && !r.isIndex).slice(0, MAX_ANALYZE);
  if (!list.length) return { analyses: {}, deskRead: '' };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [OPTIONS_FABLE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_flow_analysis' },
      messages: [{ role: 'user', content: buildAnalysisPrompt(list) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_flow_analysis');
    if (!tool) return null;
    return parseAnalyses(tool.input, list.map(r => r.ticker));
  } catch {
    return null;   // graceful — caller keeps the mechanical read
  }
}

// ── Merge onto rollups ─────────────────────────────────────────────────────
/**
 * Attach the cached Fable analysis onto each rollup row as `r.ai`. Adds `agrees`
 * (Fable bias matches the mechanical net lean). Non-destructive: new objects. Pure.
 */
function mergeAnalyses(rollups, assessDoc) {
  const map = (assessDoc && assessDoc.analyses) || {};
  return (rollups || []).map(r => {
    const a = map[String(r.ticker).toUpperCase()];
    if (!a) return { ...r, ai: null };
    return {
      ...r,
      ai: {
        ...a,
        catalyst: a.catalyst || null,
        agrees: a.bias === r.net,
      },
    };
  });
}

module.exports = {
  MODEL, MAX_ANALYZE, DESK_TOP,
  OPTIONS_FABLE_TOOL, buildAnalysisPrompt, tickerBlock, contractLine,
  parseAnalyses, analyzeFlow, mergeAnalyses,
};
