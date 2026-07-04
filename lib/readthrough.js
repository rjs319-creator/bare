// 🔗 READ-THROUGH — Second-Order Beneficiary Graph.
//
// IDEA (Fable-5 novel-approach #1). When a stock gaps on an unscheduled catalyst, human
// traders instantly ask "who ELSE benefits and hasn't moved yet?" — the supplier, the
// dominant customer, the toll-booth, the direct substitute, the key partner. That lead-lag
// (Cohen-Frazzini economic-links momentum) is a RELATIONAL signal a per-stock factor model
// structurally cannot see. We let Fable 5 reason the beneficiary graph off today's Gap & Go
// movers (which already carry a cause tag), then keep only names that have NOT yet repriced.
//
// PHASE-0 VALIDATED (2026-07-04): on seeded triggers Fable produced specific, correct,
// non-obvious links (CVNA→ROOT the standout), flagged the priced-in one (SMCI→NVDA), and
// DECLINED where no real beneficiary exists (RKLB, vertically integrated) — the honesty the
// whole project runs on. Parametric (no web search) returns in ~48s; Fable 5 is slow, so
// generation is cache-gated (Market Pulse pattern), never a blocking live path.
//
// HONEST FRAMING (baked into the UI): this is a LEAD to forward-track, not a proven edge.
// The read-through may already be priced (the tape filter guards this), and parametric
// knowledge has a training cutoff so brand-new relationships can be missed. Nothing is
// treated as tradeable until the survivorship-corrected forward-log (Phase 2) matures —
// the same discipline that killed reversal / PEAD.

const MODEL = 'claude-fable-5';
// Fable 5 is slow (~48s for 3 triggers incl. extended thinking); more triggers → more
// thinking → the call overruns the 60s function wall. 3 is the empirical fit and keeps the
// product focused on the day's biggest gappers. Raising this needs the two-stage split.
const MAX_TRIGGERS = 3;
const ALREADY_MOVED_PCT = 4;        // a beneficiary that itself moved >= this % today is "already priced"
const CALL_TIMEOUT_MS = 52000;      // leaves ~a few s for tape checks under the 60s wall; maxRetries:0 (see below)
const LINK_TYPES = ['supplier', 'customer', 'tollbooth', 'substitute', 'input_cost', 'partner'];

// Structured-output tool — forces a NAMED mechanism per beneficiary, not a vibe.
// `directness` is the whole game (5 = single-name dependency, 1 = loose theme).
const READTHROUGH_TOOL = {
  name: 'submit_readthrough',
  description: 'Return the second-order beneficiaries of today\'s movers: names with a DIRECT, NAMED economic link to a trigger that have plausibly NOT yet repriced.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Beneficiary read-throughs, best (most direct + least-priced) first. Omit anything you cannot tie to a specific, named economic mechanism.',
        items: {
          type: 'object',
          properties: {
            beneficiary_ticker: { type: 'string', description: 'US-listed ticker of the un-moved beneficiary' },
            beneficiary_name: { type: 'string', description: 'company name' },
            trigger_ticker: { type: 'string', description: 'the mover it reads through from (must be one of the provided triggers)' },
            link_type: { type: 'string', enum: LINK_TYPES, description: 'the economic relationship' },
            mechanism: { type: 'string', description: 'the SPECIFIC named dependency, e.g. "sole-source supplier of X to the trigger" or "trigger is ~40% of its revenue". No vague themes.' },
            directness: { type: 'integer', description: '1-5. 5 = single-name / dominant-customer dependency; 3 = clear but diversified; 1 = loose thematic association (omit these).' },
            already_priced_guess: { type: 'boolean', description: 'your best guess whether it has ALREADY moved in sympathy today (the tape verifies this — guess honestly)' },
            thesis: { type: 'string', description: 'one-sentence read-through thesis' },
            caution: { type: 'string', description: 'honest flag — priced-in / diversified / weak-link / speculative; empty if none' },
          },
          required: ['beneficiary_ticker', 'trigger_ticker', 'link_type', 'mechanism', 'directness', 'already_priced_guess', 'thesis'],
        },
      },
      notes: { type: 'string', description: 'brief meta-note on link quality / any triggers with no credible read-through' },
    },
    required: ['items'],
  },
};

/**
 * Build the trigger list (deduped, strongest-first, capped) from a gap-ledger day.
 * @param {{picks?: Array<{ticker:string,cause?:string,gapPct?:number,sector?:string}>}} gapDay
 * @returns {Array<{ticker:string,cause:string,gapPct:number|null,sector:string|null}>}
 */
function buildTriggers(gapDay) {
  const picks = (gapDay && Array.isArray(gapDay.picks)) ? gapDay.picks : [];
  const seen = new Set();
  return picks
    .filter(p => p && p.ticker)
    .map(p => ({ ticker: String(p.ticker).toUpperCase(), cause: p.cause || 'NONE', gapPct: p.gapPct != null ? +Number(p.gapPct).toFixed(1) : null, sector: p.sector || null }))
    .filter(p => !seen.has(p.ticker) && seen.add(p.ticker))   // dedup AFTER normalizing case
    .sort((a, b) => (b.gapPct || 0) - (a.gapPct || 0))        // biggest gaps first (proxy for salience)
    .slice(0, MAX_TRIGGERS);
}

function buildPrompt(triggers) {
  const lines = triggers.map(t => `- ${t.ticker} (${t.gapPct != null ? `+${t.gapPct}% gap` : 'gapped'}, cause=${t.cause}${t.sector ? `, sector ${t.sector}` : ''})`).join('\n');
  return `You are a markets desk analyst hunting SECOND-ORDER READ-THROUGHS. These stocks gapped up today on an unscheduled catalyst:

${lines}

For each, human traders immediately ask "who else benefits and HASN'T moved yet?" — the supplier, the dominant customer, the toll-booth, the direct substitute, the key partner. Your job: identify those un-moved beneficiaries.

STRICT RULES — follow exactly:
1. Only return a name if you can state a SPECIFIC, NAMED economic mechanism (e.g. "sole-source optical-transceiver supplier to <trigger>", "<trigger> is its single largest customer at ~35% of revenue").
2. REJECT vague thematic association ("both are AI", "same sector"). If the only link is a theme, omit it.
3. Prefer names that have plausibly NOT yet repriced today (the edge is the lag). Flag your best guess in already_priced_guess.
4. Rate directness honestly (5 = single-name dependency, 1 = loose theme). OMIT directness-1 links entirely.
5. Rely on your knowledge of these companies' supply chains and customer relationships; only assert a link you are confident is real and US-listed/tradeable.
6. Be honest: if a trigger has no credible direct beneficiary, say so in notes and return nothing for it. A short, correct list beats a long, speculative one.

You MUST call submit_readthrough. Do not answer in plain text.`;
}

/** Sanitize + clamp the model's structured output into safe render-ready items. */
function parseGraph(input, validTriggers) {
  const triggerSet = validTriggers ? new Set(validTriggers.map(t => t.ticker)) : null;
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
  const tk = s => clean(s, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
  const items = raw
    .map(it => {
      if (!it || !it.beneficiary_ticker || !it.mechanism) return null;
      const bt = tk(it.beneficiary_ticker);
      const tt = tk(it.trigger_ticker);
      if (!bt || !tt || bt === tt) return null;                          // no self-links
      if (triggerSet && !triggerSet.has(tt)) return null;                // trigger must be one we fed
      const directness = Math.max(1, Math.min(5, parseInt(it.directness, 10) || 1));
      if (directness <= 1) return null;                                  // rule 4: drop loose-theme links
      return {
        beneficiary_ticker: bt,
        beneficiary_name: clean(it.beneficiary_name, 80) || bt,
        trigger_ticker: tt,
        link_type: LINK_TYPES.includes(it.link_type) ? it.link_type : 'partner',
        mechanism: clean(it.mechanism, 600),
        directness,
        already_priced_guess: !!it.already_priced_guess,
        thesis: clean(it.thesis, 400),
        caution: it.caution ? clean(it.caution, 300) : null,
      };
    })
    .filter(Boolean);
  // dedup by beneficiary (keep the highest-directness link if a name reads through from two triggers)
  const byTicker = new Map();
  for (const it of items) {
    const prev = byTicker.get(it.beneficiary_ticker);
    if (!prev || it.directness > prev.directness) byTicker.set(it.beneficiary_ticker, it);
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 800) };
}

/** Given a beneficiary's daily candles, flag whether it has already moved today. Pure. */
function alreadyMovedFlag(dm) {
  if (!dm || dm.pctChange == null) return { movedPct: null, alreadyMoved: null };   // unknown
  const movedPct = +Number(dm.pctChange).toFixed(2);
  return { movedPct, alreadyMoved: Math.abs(movedPct) >= ALREADY_MOVED_PCT };
}

/**
 * Rank: un-moved first (the whole edge is the lag), then unknown, then already-moved;
 * within each, higher directness first. Pure — the route attaches `moved` before calling.
 */
function rankItems(items) {
  const bucket = it => (it.moved && it.moved.alreadyMoved === true ? 2 : it.moved && it.moved.alreadyMoved === null ? 1 : 0);
  return [...items].sort((a, b) => bucket(a) - bucket(b) || b.directness - a.directness);
}

/**
 * One bounded Fable-5 call (parametric — no web search). Returns raw structured input
 * or throws. maxRetries:0 is MANDATORY — the SDK retries on timeout by default, which
 * turns one slow call into 2-3x the budget and blows past the 60s function wall.
 */
async function callFable(triggers) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [READTHROUGH_TOOL],
    messages: [{ role: 'user', content: buildPrompt(triggers) }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_readthrough');
  return tool ? tool.input : null;
}

module.exports = {
  READTHROUGH_TOOL, buildTriggers, buildPrompt, parseGraph, alreadyMovedFlag, rankItems, callFable,
  MODEL, MAX_TRIGGERS, ALREADY_MOVED_PCT, LINK_TYPES,
};
