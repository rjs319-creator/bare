// FABLE-5 NARRATIVE LAYER over the mechanical dual-horizon read.
//
// lib/signal.js gives a short-term intraday action; lib/longterm.js gives a
// long-term daily trend; lib/longterm.combineDualRead fuses them into a coarse,
// rule-based verdict + setup class ("pullback in an uptrend", …). That mechanical
// verdict is a lookup table — it can't weigh HOW bearish the short term is against
// HOW strong the long-term trend is, or phrase it like a desk analyst would.
//
// This module adds ONE bounded, PARAMETRIC claude-fable-5 call that reads both
// mechanical reads and returns a refined verdict, setup class, stance, and a
// one-line "what to actually do". Design mirrors lib/optionsflow-fable.js:
// single call, maxRetries:0 (SDK retry-on-timeout blows the function wall),
// tool-forced structured output, graceful null (caller keeps the mechanical
// verdict). PARAMETRIC ONLY — no web_search (search inside a tick is not
// wall-safe, per the novel-screener finding). One ticker per call — this runs on
// the per-stock view path, so it's naturally single-name.

const MODEL = 'claude-fable-5';
const CALL_TIMEOUT_MS = 22000;   // well under the function wall; single-ticker call is fast
const MAX_TOKENS = 600;          // verdict + note + a couple enums — small on purpose

// The same setup vocabulary the mechanical combiner uses, so Fable refines within
// a shared taxonomy (the UI colors/labels key off these).
const SETUP_CLASSES = [
  'trend-continuation', 'pullback-buy', 'early-strength', 'uptrend-pause',
  'range', 'bear-bounce', 'downtrend-pause', 'early-weakness', 'downtrend',
];
// What a disciplined trader would DO with this alignment.
const STANCES = ['aligned', 'confirm', 'watch', 'wait', 'caution', 'reduce', 'avoid'];

const DUALREAD_TOOL = {
  name: 'submit_dual_read',
  description: 'Return a refined dual-horizon read for one stock: a plain-English verdict that weighs the short-term action against the long-term trend, the best-fit setup class, a disciplined stance, and one line on what to actually do.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', description: 'One clear sentence a trader would say out loud, weighing the short vs long horizon (e.g. "Sharp intraday flush but the yearly uptrend is fully intact — classic buyable dip"). Do NOT just repeat the mechanical label; add the nuance of HOW strong each side is.' },
      setupClass: { type: 'string', enum: SETUP_CLASSES, description: 'Best-fit setup. Usually matches the mechanical class, but override if the magnitudes disagree with the coarse label (e.g. a tiny short-term wobble in a powerful uptrend is uptrend-pause, not bear-bounce).' },
      stance: { type: 'string', enum: STANCES, description: 'What to do: aligned (both agree, ride it), confirm (wait for the laggard horizon), watch (dip in an uptrend, wait for a reclaim trigger), wait (no edge), caution (conflicting), reduce (long-term breaking), avoid (both weak / bounce in a downtrend).' },
      note: { type: 'string', description: 'One line of concrete guidance: what would confirm the read or invalidate it (a level, a reclaim, a trend break). Honest — if it is genuinely mixed, say so.' },
    },
    required: ['verdict', 'setupClass', 'stance'],
  },
};

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// Compact one-block prompt describing the mechanical reads across horizons.
function buildPrompt(ctx) {
  const { ticker, price, st, lt, mech, sw } = ctx;
  const stReasons = (st.reasons || []).slice(0, 4).join('; ') || 'none';
  const ltReasons = (lt.reasons || []).slice(0, 5).join('; ') || 'none';
  const f = lt.factors || {};
  const ltFacts = [
    f.pctFrom200 != null ? `${f.pctFrom200 >= 0 ? '+' : ''}${f.pctFrom200}% vs 200DMA` : null,
    f.rs3mPct != null ? `RS 3mo ${f.rs3mPct >= 0 ? '+' : ''}${f.rs3mPct}pts vs SPY` : null,
    f.pctFrom52wHigh != null ? `${f.pctFrom52wHigh}% from 52w high` : null,
  ].filter(Boolean).join(', ');

  // The swing horizon (2–12 weeks) is the one a position trader actually holds, so
  // give it to Fable as a THIRD fixed input. Fable explains — it must NOT change it.
  let swingBlock = '';
  if (sw && sw.action) {
    const swReasons = (sw.reasons || []).slice(0, 3).join('; ') || 'none';
    const swPlan = sw.plan ? ` Plan: trigger $${sw.plan.trigger}, invalidation $${sw.plan.invalidation}, objective $${sw.plan.objective}.` : '';
    swingBlock = `\nSWING (daily engine, 2–12 weeks): ${sw.action} (evidence ${sw.evidenceStrength ?? '?'}/10, uncalibrated). Evidence: ${swReasons}.${swPlan}`;
  }

  return `You are a senior trading-desk analyst. Independent MECHANICAL engines have read $${ticker} (last $${price}) across three horizons; your job is to explain them in one honest read that prioritizes the SWING (multi-week) horizon a position trader holds.

SHORT-TERM (intraday 5-min engine): ${st.action} (evidence ${st.confidence}/10). Evidence: ${stReasons}.${swingBlock}
LONG-TERM (daily, ~1y engine): trend ${lt.trend} (score ${lt.score}). Evidence: ${ltReasons}.${ltFacts ? `\nLong-term context: ${ltFacts}.` : ''}
Mechanical fusion (a coarse lookup, refine it): "${mech.verdict}" [${mech.setupClass}].

Rules you MUST follow:
- Do NOT change any mechanical action; explain and weigh them. Do NOT invent prices, levels or probabilities the engines didn't give.
- When the horizons DISAGREE, say so plainly and tell the reader which horizon matches which holding period.
- Weigh HOW strong each horizon is (a violent intraday flush inside a powerful uptrend ≠ a small wobble inside a fragile one).
Give the verdict, the best-fit setupClass, a disciplined stance, and a one-line note on what confirms or invalidates the read. You MUST call submit_dual_read — no plain text.`;
}

// Parse/clamp the model output into a clean object, or null if unusable. Pure.
function parseDualRead(input) {
  if (!input || typeof input !== 'object' || !input.verdict) return null;
  return {
    verdict: clip(input.verdict, 240),
    setupClass: SETUP_CLASSES.includes(input.setupClass) ? input.setupClass : null,
    stance: STANCES.includes(input.stance) ? input.stance : null,
    note: input.note ? clip(input.note, 300) : null,
  };
}

/**
 * One bounded Fable-5 dual-horizon narrative for a single ticker.
 * @param ctx { ticker, price, st:{action,confidence,reasons}, lt:{trend,score,reasons,factors}, mech:{verdict,setupClass} }
 * Returns { verdict, setupClass, stance, note } or null on any failure.
 */
async function analyzeDualRead(ctx, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!ctx || !ctx.ticker || !ctx.st || !ctx.lt || !ctx.mech) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [DUALREAD_TOOL],
      tool_choice: { type: 'tool', name: 'submit_dual_read' },
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_dual_read');
    if (!tool) return null;
    return parseDualRead(tool.input);
  } catch {
    return null; // graceful — caller keeps the mechanical verdict
  }
}

module.exports = { analyzeDualRead, parseDualRead, buildPrompt, SETUP_CLASSES, STANCES };
