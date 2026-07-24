'use strict';
// 🔎 EVIDENCE EXTRACTION (redesign stage B) — documents → structured events.
//
// One BOUNDED LLM call per ticker turns that name's recent news into structured event
// objects. The LLM is used ONLY for what it is good at — classification, extraction of the
// claim, direction, and materiality — and is FORBIDDEN from being the source of truth for
// numbers (it must copy a figure verbatim from a headline or leave it null) and from deciding
// source primacy (that is done mechanically in evidence-schema from the headline URLs).
//
// Cost discipline (mirrors lib/tone-routes.js / lib/readthrough.js): Haiku, maxRetries:0,
// forced tool call, hard timeout, and per-ticker caching keyed on a news fingerprint so an
// unchanged news set is never re-extracted. Callers cap the universe + concurrency per tick.

const crypto = require('crypto');
const { normalizeEvent, EVENT_TYPES } = require('./evidence-schema');

// Haiku is the right tier: this is bounded structured extraction, not open reasoning. Same
// model the News summarizer + earnings-tone already use. maxRetries:0 is mandatory (the SDK
// retries on timeout, blowing the 60s function wall).
const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 40000;
const MAX_HEADLINES = 24;       // per-ticker headlines fed to one call (newest first)
const MAX_EVENTS = 6;           // cap events returned per ticker

const EXTRACT_TOOL = {
  name: 'submit_events',
  description: 'Return the DISTINCT material events described by this stock\'s recent headlines. Merge headlines about the same underlying event into ONE event. Omit noise (routine price recaps, listicles, unrelated tickers).',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        description: 'Distinct material events, most material first. One event per real development, not per headline.',
        items: {
          type: 'object',
          properties: {
            eventType: { type: 'string', enum: EVENT_TYPES, description: 'the kind of development' },
            eventSubtype: { type: 'string', description: 'short specific subtype, e.g. "guidance_raise", "FDA_approval", "CEO_departure"' },
            headline: { type: 'string', description: 'a neutral one-line headline for the event' },
            claim: { type: 'string', description: 'the specific factual claim — WHAT materially changed. One sentence.' },
            direction: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'], description: 'directional read for the stock' },
            affectedHorizon: { type: 'string', enum: ['swing', 'long_term', 'both', 'unclear'], description: 'which investment horizon this bears on (swing ~5-40 days, long_term ~6-36 months)' },
            quantitativeMagnitude: { type: ['number', 'null'], description: 'the headline figure if one is stated (e.g. 0.12 for a $0.12 beat, 8 for +8% guidance). NULL if no number is stated — never invent one.' },
            surpriseMagnitude: { type: ['number', 'null'], description: 'reported-vs-expected surprise if stated, else null' },
            noveltyScore: { type: 'number', description: '0-1: how NEW is this information vs already-known/expected (1 = genuine surprise, 0 = old news restated)' },
            materialityScore: { type: 'number', description: '0-1: how much this could move the investment thesis (1 = thesis-changing, 0 = trivial)' },
            extractionConfidence: { type: 'number', description: '0-1: your confidence the headlines actually support this event' },
            catalystDate: { type: 'string', description: 'YYYY-MM-DD of the event if determinable, else empty' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'short quotes/phrases from the headlines supporting the claim' },
            contradictions: { type: 'array', items: { type: 'string' }, description: 'any headline that CONTRADICTS this event; empty if none' },
            sourceIndexes: { type: 'array', items: { type: 'integer' }, description: 'the 0-based indexes of the numbered headlines that support this event' },
          },
          required: ['eventType', 'claim', 'direction', 'affectedHorizon', 'noveltyScore', 'materialityScore', 'sourceIndexes'],
        },
      },
    },
    required: ['events'],
  },
};

// Stable fingerprint of a news set (urls + titles) — the extraction cache key. Unchanged
// news → identical fingerprint → skip the LLM call entirely on the next tick.
function newsFingerprint(items) {
  const key = (items || []).map(i => `${i.url || ''}|${(i.title || '').slice(0, 80)}`).sort().join('\n');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function buildPrompt(ticker, company, items) {
  const lines = items.map((it, i) => {
    const when = it.datetime ? String(it.datetime).slice(0, 10) : '?';
    const pub = it.publisher ? ` — ${it.publisher}` : '';
    return `[${i}] (${when}${pub}) ${it.title}${it.text ? ` — ${String(it.text).slice(0, 160)}` : ''}`;
  }).join('\n');
  return `You are an equity research analyst extracting STRUCTURED EVENTS from recent headlines for ${company || ticker} (${ticker}).

Recent headlines (newest first), each numbered:
${lines}

Your job: determine WHAT MATERIALLY CHANGED. Convert the headlines into distinct events.

STRICT RULES:
1. MERGE headlines about the SAME underlying event into ONE event (e.g. five write-ups of one earnings beat = one event). Set sourceIndexes to ALL headline indexes that describe it.
2. Only include MATERIAL events — things that could affect the investment thesis. Drop routine price recaps, "3 stocks to watch" listicles, and headlines about OTHER companies.
3. NEVER invent a number. Put a figure in quantitativeMagnitude/surpriseMagnitude ONLY if it is stated in a headline; otherwise null.
4. Judge novelty honestly: restated/old news scores low novelty even if the headline is loud.
5. Flag genuine contradictions between headlines.
6. If there is no material event, return an empty events array. A short honest list beats a padded one.

You MUST call submit_events. Do not answer in plain text.`;
}

/** One bounded Haiku call. Returns raw tool input or null. */
async function callExtract(ticker, company, items, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY || !items.length) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_events' },
    messages: [{ role: 'user', content: buildPrompt(ticker, company, items) }],
  }, { timeout: timeoutMs });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_events');
  return tool ? tool.input : null;
}

/**
 * Extract normalized events for one ticker from its rich news items.
 * @param {string} ticker
 * @param {object} opts { company, news: [{title,text,datetime,url,publisher}], detectedAt }
 * @returns {Promise<{ events: Array, fingerprint: string, model: string, called: boolean }>}
 */
async function extractEvents(ticker, opts = {}) {
  const items = (opts.news || []).filter(i => i && i.title).slice(0, MAX_HEADLINES);
  const fp = newsFingerprint(items);
  if (!items.length) return { events: [], fingerprint: fp, model: MODEL, called: false };

  let raw;
  try { raw = await callExtract(ticker, opts.company, items, opts.timeoutMs); }
  catch { return { events: [], fingerprint: fp, model: MODEL, called: true, error: 'extract_failed' }; }
  if (!raw || !Array.isArray(raw.events)) return { events: [], fingerprint: fp, model: MODEL, called: true };

  const events = raw.events.slice(0, MAX_EVENTS).map(rawEv => {
    // Attach the REAL source records (url/publisher) the model referenced — primacy is then
    // decided mechanically in normalizeEvent, never by the model.
    const idxs = Array.isArray(rawEv.sourceIndexes) ? rawEv.sourceIndexes : [];
    const seen = new Set();
    const sources = idxs
      .map(i => items[i])
      .filter(Boolean)
      .filter(s => !seen.has(s.url || s.title) && seen.add(s.url || s.title))
      .map(s => ({ url: s.url, publisher: s.publisher, documentType: s.documentType || null }));
    return normalizeEvent(rawEv, { ticker, sources, detectedAt: opts.detectedAt || null });
  }).filter(Boolean);

  return { events, fingerprint: fp, model: MODEL, called: true };
}

module.exports = { extractEvents, newsFingerprint, callExtract, MODEL, MAX_HEADLINES, EXTRACT_TOOL };
