// DAILY GAME PLAN — synthesizes the day's market state (news + macro/sentiment +
// the app's own signal leans) into ONE succinct, easy-to-follow investing plan
// with a few forward predictions, tiered for novice → seasoned. The narrative is
// stored per-day and fed back on each intraday re-run so it BUILDS on the story
// as more headlines break, rather than restarting.
//
// Structured output uses the app's proven idiom: a forced tool call (same shape
// as lib/predict.js PREDICT_TOOL) → guaranteed-valid JSON. Low-frequency call
// (cron + on-demand), so it runs on a stronger model than the Haiku default —
// quality of the synthesis is the whole point. Bump MODEL to claude-opus-4-8 for
// maximum quality; caching is intentionally NOT used (volatile, growing prefix).

const MODEL = 'claude-sonnet-4-6';   // quality > cost for a few-times-daily brief
const MAX_DRIVERS = 4;
const MAX_PREDICTIONS = 3;

// Forced-output schema for the brief. Kept flat + bounded so the model fills a
// predictable shape the UI can render without defensive parsing.
const GAMEPLAN_TOOL = {
  name: 'submit_game_plan',
  description: 'Submit the daily market game plan as structured fields.',
  input_schema: {
    type: 'object',
    properties: {
      sentiment: {
        type: 'object',
        properties: {
          tone: { type: 'string', enum: ['risk-off', 'cautious', 'neutral', 'constructive', 'risk-on'] },
          oneLiner: { type: 'string', description: 'One sentence read on the tape + why.' },
        },
        required: ['tone', 'oneLiner'],
      },
      headline: { type: 'string', description: "The day's market story in a single sentence." },
      drivers: {
        type: 'array',
        description: 'The major news stories moving markets today, most important first.',
        items: {
          type: 'object',
          properties: {
            story: { type: 'string', description: 'The news event, concise.' },
            soWhat: { type: 'string', description: 'Why it matters for positioning — the actionable read.' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'Most-affected tickers/sectors (symbols).' },
          },
          required: ['story', 'soWhat'],
        },
      },
      gamePlan: {
        type: 'object',
        properties: {
          lean: { type: 'array', items: { type: 'string' }, description: 'What to lean toward / favor.' },
          avoid: { type: 'array', items: { type: 'string' }, description: 'What to avoid / fade.' },
          watch: { type: 'array', items: { type: 'string' }, description: 'Triggers/levels/events to watch next sessions.' },
        },
        required: ['lean', 'avoid', 'watch'],
      },
      predictions: {
        type: 'array',
        description: 'A few specific, falsifiable calls for the coming trading days.',
        items: {
          type: 'object',
          properties: {
            call: { type: 'string', description: 'The specific prediction.' },
            rationale: { type: 'string', description: 'Why, grounded in the provided data.' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            horizon: { type: 'string', description: 'e.g. "next session", "this week", "1-2 weeks".' },
          },
          required: ['call', 'rationale', 'confidence', 'horizon'],
        },
      },
      novice: { type: 'string', description: 'Plain-English 2-3 sentence summary for a beginner — no jargon.' },
      pro: { type: 'string', description: 'The nuanced layer for a seasoned trader — positioning, risk, second-order reads.' },
      narrativeUpdate: { type: 'string', description: 'How today builds on / changes the running multi-day narrative.' },
    },
    required: ['sentiment', 'headline', 'drivers', 'gamePlan', 'predictions', 'novice', 'pro', 'narrativeUpdate'],
  },
};

const SYSTEM = [
  'You are a sharp, honest market strategist writing a DAILY GAME PLAN for an investing app.',
  'Audience spans a complete novice to a seasoned professional trader — serve both via the dedicated novice/pro fields.',
  'Be succinct, specific, and ACTIONABLE. Every claim must be grounded in the DATA provided — do not invent prices, levels, or events.',
  'No hype, no filler, no generic "consult a financial advisor" boilerplate. Flag uncertainty honestly and prefer "if X then Y" framing.',
  'The app has its OWN validated signals (a macro regime gate and a "fade" short engine on over-extended names); weight the regime read heavily — it is the most proven lever. When the regime is risk-off, the honest default is caution / smaller size, not heroics.',
  'If a PRIOR NARRATIVE is provided, BUILD on it: note what changed, what is confirmed, what is invalidated — do not restart from scratch.',
  'BE TIGHT — this must be SUCCINCT and skimmable. Keep each driver soWhat to ONE sentence, each lean/avoid/watch item to a short phrase, novice to <=3 sentences, pro to <=4 sentences, narrativeUpdate to <=2 sentences. Quality over volume; do not pad.',
  'Return your answer ONLY by calling the submit_game_plan tool, and ALWAYS include every field — the narrativeUpdate field is mandatory, so keep earlier fields concise enough to reach it.',
].join(' ');

// ── pure context assembly (unit-tested; no network) ────────────────────────

// Compact a macro snapshot into a labeled line for the prompt.
function macroLine(macro) {
  if (!macro) return 'Macro/regime: unavailable.';
  const bits = [];
  if (macro.regime) bits.push(`regime=${macro.regime}`);
  if (macro.vix != null) bits.push(`VIX=${(+macro.vix).toFixed(1)}`);
  if (macro.vixPctile != null) bits.push(`VIX %ile(1y)=${Math.round(macro.vixPctile)}`);
  if (macro.macroRisk != null) bits.push(`macroRisk=${Math.round(macro.macroRisk)}/100`);
  if (macro.creditStress != null) bits.push(`creditStress=${(+macro.creditStress).toFixed(2)}`);
  return `Macro/regime: ${bits.join(', ') || 'n/a'}.`;
}

// Compact a headlines array ([{title, source, publishedAt}]) into a numbered list.
function headlinesBlock(headlines, limit = 14) {
  const items = (headlines || []).filter(h => h && h.title).slice(0, limit);
  if (!items.length) return 'Headlines: none available.';
  return 'Headlines (most recent first):\n' + items.map((h, i) => {
    const src = h.source && h.source.name ? ` [${h.source.name}]` : '';
    return `${i + 1}. ${h.title}${src}`;
  }).join('\n');
}

// Compact app signal leans into a line. signals is a free-form object; we render
// the keys that are present so the engine degrades gracefully as inputs vary.
function signalsLine(signals) {
  if (!signals || typeof signals !== 'object') return 'App signals: none.';
  const parts = [];
  if (signals.trendLight) parts.push(`trend climate=${signals.trendLight}`);
  if (signals.fadeRegime) parts.push(`fade engine=${signals.fadeRegime === 'risk-off' ? 'OFF (risk-off)' : 'active'}`);
  if (signals.fadeTopShorts && signals.fadeTopShorts.length) parts.push(`top fade shorts: ${signals.fadeTopShorts.slice(0, 5).join(', ')}`);
  if (signals.topSectors && signals.topSectors.length) parts.push(`leading sectors: ${signals.topSectors.slice(0, 3).join(', ')}`);
  if (signals.botSectors && signals.botSectors.length) parts.push(`lagging sectors: ${signals.botSectors.slice(0, 3).join(', ')}`);
  return parts.length ? `App signals: ${parts.join('; ')}.` : 'App signals: none.';
}

// Build the full user message from the assembled market state.
function buildUserMessage({ date, macro, headlines, signals, priorNarrative }) {
  const lines = [
    `DATE: ${date}`,
    macroLine(macro),
    signalsLine(signals),
    '',
    headlinesBlock(headlines),
  ];
  if (priorNarrative && priorNarrative.trim()) {
    lines.push('', 'PRIOR NARRATIVE (build on this, note what changed):', priorNarrative.trim());
  }
  lines.push('', `Write today's game plan, SUCCINCT: at most ${MAX_DRIVERS} drivers (one-sentence soWhat each), at most 3 items per lean/avoid/watch list, at most ${MAX_PREDICTIONS} predictions. Include ALL fields incl. narrativeUpdate. Call submit_game_plan.`);
  return lines.join('\n');
}

// ── LLM synthesis ───────────────────────────────────────────────────────────

// client: an @anthropic-ai/sdk instance. Returns the parsed tool input (the
// structured game plan) or throws on a malformed response.
async function synthesize(client, state, { model = MODEL, maxTokens = 2600 } = {}) {
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: SYSTEM,
    tools: [GAMEPLAN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_game_plan' },
    messages: [{ role: 'user', content: buildUserMessage(state) }],
  });
  const block = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_game_plan');
  if (!block || !block.input) throw new Error('No game plan returned by the model.');
  return block.input;
}

module.exports = {
  MODEL, MAX_DRIVERS, MAX_PREDICTIONS, GAMEPLAN_TOOL, SYSTEM,
  macroLine, headlinesBlock, signalsLine, buildUserMessage, synthesize,
};
