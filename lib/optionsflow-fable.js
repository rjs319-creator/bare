// FABLE-5 ANALYSIS LAYER over the mechanical unusual-options-flow scanner
// (lib/optionsflow.js). The base scanner is pure math on delayed chain data: it
// tells you WHAT traded (premium, vol/OI, sweep/block, aggressor, breakeven) and a
// crude call=bullish / put=bearish LEAN — but it can't tell a conviction directional
// bet from a hedge, a premium-selling write, or event/IV positioning, and its
// "what you could do" is one generic template for every bullish name.
//
// This module adds ONE bounded, PARAMETRIC claude-fable-5 call that reads each
// flagged ticker's actual flow (net premium split, top contracts, aggressor, DTE,
// breakeven, earnings + abnormal-vol flags, spot move) and returns a GROUNDED
// EXPLANATION per ticker — it is restricted to interpreting the evidence shown:
//   • interpretation — what the flow really implies (conviction vs hedge vs
//     write vs event positioning), handling the @bid-fade and index-hedge nuances,
//     naming what evidence is MISSING
//   • bias — the directional read the evidence SUPPORTS (neutral when ambiguous)
//   • evidenceClarity (clear/mixed/thin) — evidence quality, NOT a probability
//   • vehicle (educational lower-risk expression) + timeframe + caution
// Plus a "desk read" summarizing the day's standout flow.
//
// GROUNDED-ONLY (step 11): Fable may NOT invent price levels/triggers, invent
// catalysts, output a probability/score, or manufacture a directional read from
// ambiguous activity. Entry/invalidation/targets come from deterministic chart math
// elsewhere — never here. The shadow gate means this can never originate a live trade.
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
const CLARITIES = ['clear', 'mixed', 'thin'];   // how clearly the shown evidence reads — NOT a probability

// Structured-output tool — forces a GROUNDED per-ticker EXPLANATION, not a trade plan.
// Fable's role here is restricted to interpreting the deterministic evidence it is shown:
// it may NOT invent price levels/triggers, invent catalysts, or emit a probability. Entry
// and invalidation levels come only from deterministic chart math elsewhere, never here.
const OPTIONS_FABLE_TOOL = {
  name: 'submit_flow_analysis',
  description: 'For each ticker showing unusual options flow, EXPLAIN what the shown evidence most likely means (conviction bet vs hedge vs write vs event positioning), how clearly it reads, and the lower-risk way to express the read — grounded ONLY in the contract details provided. Do not invent price levels, targets, or catalysts, and do not output a probability.',
  input_schema: {
    type: 'object',
    properties: {
      analyses: {
        type: 'array',
        description: 'One analysis per ticker provided. Judge ONLY from the actual flow details shown, not just the call/put lean — a put block sold at the bid can be a closing/hedge, an OTM call sweep lifted at the ask is genuine conviction. When the evidence is ambiguous, say so and stay neutral; never manufacture a directional read the evidence does not support.',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'the US ticker being analyzed (must be one of the provided tickers)' },
            bias: { type: 'string', enum: BIASES, description: 'the directional read the shown flow SUPPORTS on the STOCK. Refine the mechanical lean: aggressor at bid fades it, index/hedge flow is often neutral, put buying can be protective not bearish. Use neutral whenever the evidence is mixed, hedge-like, or unclear — this is a read of the evidence, not a prediction.' },
            evidenceClarity: { type: 'string', enum: CLARITIES, description: 'how CLEARLY the shown evidence reads (not a probability of profit): clear = aggressive same-direction prints on a reliable quote + confirming context; mixed = conflicting or two-sided; thin = one lone print, unreliable quote, or wide/illiquid. Describes evidence quality only.' },
            interpretation: { type: 'string', description: 'one or two sentences EXPLAINING what the flow most likely IS (conviction directional bet / hedge / premium-selling write / event or IV positioning) and why, strictly from the contract details shown. If a verified catalyst is not among the provided facts, say no verified catalyst was supplied — do not guess one. Note what evidence is MISSING to be more confident.' },
            vehicle: { type: 'string', enum: VEHICLES, description: 'educational note on the lower-risk EXPRESSION of the read (not a specific trade): shares (simplest), call_option/put_option (leveraged, decays), spread (defined risk), or avoid. Do not specify strikes or expiries.' },
            timeframe: { type: 'string', enum: TIMEFRAMES, description: 'the horizon the flow fits, anchored to the DTE of the shown contracts: intraday, swing (days-weeks), or position (weeks-months).' },
            caution: { type: 'string', description: 'honest one-line risk flag grounded in the shown facts (earnings/IV-crush when flagged, one-sided/thin flow, wide spread, likely-hedge). Empty if clean.' },
          },
          required: ['ticker', 'bias', 'evidenceClarity', 'interpretation'],
        },
      },
      deskRead: { type: 'string', description: `a 1-2 sentence desk summary of the day's standout unusual flow across these tickers (name the top ${DESK_TOP} and what the evidence supports). No invented levels or catalysts.` },
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
  return `You are a senior options desk analyst. Below is today's UNUSUAL options flow (delayed Yahoo chain data — real prints, not live tape), one block per stock. A mechanical scanner flagged these and gave a crude call=bullish / put=bearish lean; it CANNOT tell a conviction directional bet from a hedge, a premium-selling write, or event positioning. Your job is to EXPLAIN what the shown evidence means — not to write a trade plan.

FLOW:
${blocks}

STRICT RULES:
• Judge ONLY from the facts shown above. Do NOT invent price levels, entry triggers, targets, or invalidation levels — those come from chart math elsewhere, never from you.
• Do NOT invent a catalyst. Only reference an event if it is in the facts shown (e.g. an EARNINGS flag). If none is shown, say no verified catalyst was supplied.
• Do NOT output a probability or a numeric score of any kind.
• When the evidence is ambiguous, hedge-like, or two-sided, stay NEUTRAL and say so. Never manufacture a directional read the evidence does not support.

For EACH ticker return:
1. bias — the directional read the shown flow SUPPORTS (neutral when ambiguous). A put block sold@bid can be a closing/hedge; an OTM call sweep bought@ask with a confirming up-day is genuine conviction; index/ETF hedging is usually neutral for the underlying.
2. evidenceClarity — clear / mixed / thin: how clearly the shown evidence reads (evidence quality, NOT odds of profit).
3. interpretation — what the flow most likely IS and why, strictly from the contract details; name what evidence is MISSING to be more confident.
4. vehicle (educational: the lower-risk expression, no strikes/expiries) + timeframe (anchor to the shown DTE).
5. caution — an honest risk flag grounded in the shown facts.

Be conservative: "thin" clarity with an "avoid" and a clear caution beats a flattering guess. Then give a desk read naming the top ${DESK_TOP} standout names and what the evidence supports. You MUST call submit_flow_analysis — do not answer in plain text.`;
}

// ── Parse / clamp ─────────────────────────────────────────────────────────
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
      evidenceClarity: CLARITIES.includes(a.evidenceClarity) ? a.evidenceClarity : 'thin',
      interpretation: clip(a.interpretation, 400),
      vehicle: VEHICLES.includes(a.vehicle) ? a.vehicle : 'shares',
      timeframe: TIMEFRAMES.includes(a.timeframe) ? a.timeframe : 'swing',
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
        agrees: a.bias === r.net,
      },
    };
  });
}

// ── A/B: does the Fable desk bias beat the mechanical call/put lean? ─────────
// Falsifiable check the app's culture demands: op=optionsassess stamps `aiBias` on
// each ledger entry; once entries resolve (forward return on the underlying) we
// score the Fable bias AND the mechanical lean on the SAME entries and only trust
// Fable if it beats the bot on enough resolved calls. Mirrors alerts-fable's
// fableEdgeReport. Dormant (TRACKING) until FABLE_MIN_RESOLVED entries mature.
const FABLE_MIN_RESOLVED = 20;    // min resolved entries carrying an AI bias before a verdict
const FABLE_MARGIN = 0.05;        // Fable hit-rate must beat mechanical by >= 5 points…
const WILSON_Z = 1.645;           // …and its 90% Wilson lower bound must clear the mechanical point

function wilsonLower(k, n, z = WILSON_Z) {
  if (!n) return 0;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / d;
  return Math.max(0, c - h);
}

// Did a direction call hit, given the RAW underlying return? bullish wants up.
const dirHitRaw = (dir, raw) => dir === 'bullish' ? raw > 0 : dir === 'bearish' ? raw < 0 : null;

/**
 * Paired A/B over resolved ledger entries. Each entry: { aiBias, sentiment, ret }
 * where `ret` is the mechanical-lean-signed forward return (from resolveAt, so
 * ret>0 = the call/put lean was right). We recover the raw underlying move to score
 * the Fable bias independently, then compare hit-rates on the same entries. Pure.
 */
function flowFableEdge(entries) {
  const pairs = [];
  for (const e of (entries || [])) {
    if (!e || e.aiBias === 'neutral' || !BIASES.includes(e.aiBias)) continue;   // neutral = no scoreable call
    if (e.ret == null || e.ret === 0) continue;                                 // flat = undecidable for both
    const raw = e.sentiment === 'bearish' ? -e.ret : e.ret;                     // undo the mechanical sign
    const aiHit = dirHitRaw(e.aiBias, raw);
    if (aiHit == null) continue;
    pairs.push({ aiHit, mechHit: e.ret > 0, override: e.aiBias !== e.sentiment });
  }
  const n = pairs.length;
  if (n < FABLE_MIN_RESOLVED) {
    return { n, minResolved: FABLE_MIN_RESOLVED, promoted: false, verdict: `TRACKING (${n}/${FABLE_MIN_RESOLVED} resolved AI-tagged calls)` };
  }
  let fableHits = 0, mechHits = 0, overrides = 0, overrideHits = 0;
  for (const p of pairs) {
    if (p.aiHit) fableHits++;
    if (p.mechHit) mechHits++;
    if (p.override) { overrides++; if (p.aiHit) overrideHits++; }   // did overriding the raw lean help?
  }
  const fableRate = fableHits / n, mechRate = mechHits / n, fableLB = wilsonLower(fableHits, n);
  const promoted = fableRate - mechRate >= FABLE_MARGIN && fableLB > mechRate;
  return {
    n, minResolved: FABLE_MIN_RESOLVED,
    fableHitRatePct: +(100 * fableRate).toFixed(1),
    mechHitRatePct: +(100 * mechRate).toFixed(1),
    fableHitRateLB90: +(100 * fableLB).toFixed(1),
    overrides, overrideHitRatePct: overrides ? +(100 * overrideHits / overrides).toFixed(1) : null,
    promoted,
    verdict: promoted
      ? `Fable desk bias BEATS the raw call/put lean (${(100 * fableRate).toFixed(1)}% vs ${(100 * mechRate).toFixed(1)}%, n=${n})`
      : `Tracking: Fable ${(100 * fableRate).toFixed(1)}% vs raw lean ${(100 * mechRate).toFixed(1)}% — no proven margin yet (n=${n})`,
  };
}

module.exports = {
  MODEL, MAX_ANALYZE, DESK_TOP, FABLE_MIN_RESOLVED,
  OPTIONS_FABLE_TOOL, buildAnalysisPrompt, tickerBlock, contractLine,
  parseAnalyses, analyzeFlow, mergeAnalyses,
  wilsonLower, flowFableEdge,
};
