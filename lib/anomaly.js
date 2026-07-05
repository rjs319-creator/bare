// 🕵️ ANOMALY-FIRST — "what's being repriced" scanner (Fable-idea #5).
//
// THESIS: a name drifting UP on elevated volume with NO public catalyst is the classic
// informed-accumulation tell. Every other screen keys off a REASON (news/gap/earnings);
// this one keys off its ABSENCE. Detection is pure tape (multi-day up move + elevated
// volume + no big gap + liquid), then the news feed drops anything with a known headline.
// The NOVEL part: an AI INVESTIGATOR web-searches each survivor and decides EXPLAINED
// (a public reason exists → priced, discard), ACCUMULATION (genuinely none → the
// interesting case), or NOISE. It catches catalysts our own news feed misses — the
// Phase-0 win (PESI looked newsless to us; the investigator found the DOE catalyst).
//
// MODEL: the investigation is SEARCH-bound, and Fable 5 + web_search overruns the 60s
// wall (same as Read-Through), so the investigator runs on Sonnet 5 (fast + strong
// web_search, proven in Market Pulse). HONEST FRAMING: a LEAD to forward-track — the
// Scoreboard tests whether ACCUMULATION names actually outperform EXPLAINED/NOISE.

// Haiku 4.5 for reliability: Sonnet + web_search sometimes ran ~50s and risked timing out
// the daily cron tick. Haiku is the proven-reliable search investigator (~20-35s), and its
// catalyst-hunt judgment is adequate with web grounding. maxRetries:0.
const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 50000;
const MAX_INVESTIGATE = 5;          // top no-news movers sent to the investigator
const CLASSES = ['ACCUMULATION', 'EXPLAINED', 'NOISE'];

// Detection thresholds — a "quiet mover": multi-day up move on elevated volume, NOT a gap
// (gaps usually carry news), liquid enough to be real. Pure predicate over dayMetrics.
const MIN_PCT5D = 6;                 // >= +6% over ~5 sessions
const MIN_RELVOL = 1.5;             // volume confirmation
const MAX_GAP = 3;                   // |gap| < 3% → a grind, not a news gap
const MIN_DOLLAR_VOL = 3_000_000;    // tradeable

function isAnomalyCandidate(m) {
  return !!m && m.pct5d != null
    && m.pct5d >= MIN_PCT5D
    && m.relVol >= MIN_RELVOL
    && Math.abs(m.gapPct || 0) < MAX_GAP
    && (m.avgDollarVol || 0) >= MIN_DOLLAR_VOL;
}

const ANOM_TOOL = {
  name: 'submit_anomalies',
  description: 'Classify each unexplained mover after searching the web for any catalyst.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            classification: { type: 'string', enum: CLASSES, description: 'ACCUMULATION = moving on volume with NO public catalyst found (possible info asymmetry); EXPLAINED = a clear public reason exists (already priced); NOISE = illiquid / technical / random' },
            reason_found: { type: 'string', description: 'the catalyst you found via search, or "none found" for ACCUMULATION' },
            confidence: { type: 'integer', description: '1-5 confidence in the classification' },
            thesis: { type: 'string', description: 'one honest sentence' },
            caution: { type: 'string', description: 'honest flag (e.g. ticker-change/data artifact); empty if none' },
          },
          required: ['ticker', 'classification', 'reason_found', 'confidence', 'thesis'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt(cands) {
  const lines = cands.map(c => `- ${c.ticker}: up ${c.pct5d}% over ~5 sessions, RVOL ${c.relVol}x, today ${c.pctChange > 0 ? '+' : ''}${c.pctChange}%, gap ${c.gapPct}%. Our company-news feed found NO news in the last 5 days.`).join('\n');
  return `You are a markets desk analyst hunting UNEXPLAINED ACCUMULATION. Each of these stocks is drifting UP on elevated volume, but our own company-news feed found NO catalyst:

${lines}

For EACH, use web search to hunt for ANY public explanation — an SEC filing (8-K, Form 4 insider buy, 13D/G), a contract/partnership, an analyst upgrade/initiation, a sector or commodity move, a product launch, or obscure/regional news. Then classify:
- EXPLAINED: you found a clear public catalyst → the move is likely already priced (discard).
- ACCUMULATION: genuinely NO public catalyst despite the move + volume → possible informed accumulation / information asymmetry. THIS is the interesting bucket.
- NOISE: illiquid, technical (e.g., index-add mechanical, ticker-change artifact), or random drift.

Be strict and HONEST: if you found a reason, say EXPLAINED even if minor — do NOT manufacture an accumulation story. If you truly find nothing after searching, ACCUMULATION is the honest call. Watch for ticker-change/data artifacts and flag them. Give the reason found (or "none found"), a 1-5 confidence, and one honest sentence. You MUST call submit_anomalies; do not answer in plain text.`;
}

// Sanitize the model's structured output into safe render-ready items, keyed by the
// candidates actually investigated (drop hallucinated tickers).
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
      classification: CLASSES.includes(it.classification) ? it.classification : 'NOISE',
      reason_found: clean(it.reason_found, 500) || 'none found',
      confidence: Math.max(1, Math.min(5, parseInt(it.confidence, 10) || 3)),
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

// Rank for display: ACCUMULATION first (the interesting bucket), then by confidence.
function rankItems(items) {
  const bucket = c => (c.classification === 'ACCUMULATION' ? 0 : c.classification === 'EXPLAINED' ? 1 : 2);
  return [...items].sort((a, b) => bucket(a) - bucket(b) || b.confidence - a.confidence);
}

// One bounded Sonnet-5 + web_search call. maxRetries:0 (a retry on timeout blows the wall).
async function investigate(cands) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, ANOM_TOOL],
    messages: [{ role: 'user', content: buildPrompt(cands) }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_anomalies');
  return tool ? tool.input : null;
}

module.exports = {
  ANOM_TOOL, isAnomalyCandidate, buildPrompt, parseResult, rankItems, investigate,
  MODEL, MAX_INVESTIGATE, CLASSES, MIN_PCT5D, MIN_RELVOL, MAX_GAP, MIN_DOLLAR_VOL,
};
