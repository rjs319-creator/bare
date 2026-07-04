'use strict';
// Earnings-call TONE scorer (roadmap Step 3).
//
// For a stock that recently reported, fetch its earnings-call transcript and ask
// Claude (Haiku, for cost) to score management's tone from -10 (negative/evasive)
// to +10 (confident/upbeat) with a one-sentence reason. Cost is controlled two ways:
//   (1) only score stocks that already passed the screener filters, and
//   (2) cache every result permanently per symbol+period so a call is scored once.
//
// This is a STANDALONE sentiment signal — surfaced as a 🎙 chip on pick cards and
// tracked in the Scoreboard on its own (Bullish / Neutral / Bearish tiers). It does
// NOT feed CERN (CERN has no earnings event type; earnings only suppresses CERN).

const MODEL = 'claude-haiku-4-5-20251001';        // cheap, well-scoped task (user chose Haiku)
const MAX_TRANSCRIPT_CHARS = 16000;               // ~4k tokens — prepared remarks + start of Q&A
const BULLISH_AT = 3, BEARISH_AT = -3;            // tone buckets
const RECENT_DAYS = 21;                           // only score calls reported within this window

// Anthropic tool schema — forces a structured, bounded result.
const TONE_TOOL = {
  name: 'submit_tone',
  description: "Score the earnings call management's tone and give a one-sentence reason.",
  input_schema: {
    type: 'object',
    properties: {
      tone: { type: 'integer', description: 'management tone from -10 (negative, evasive, defensive) to +10 (confident, upbeat, transparent)' },
      reason: { type: 'string', description: 'one sentence explaining the score, citing specifics from the call' },
    },
    required: ['tone', 'reason'],
  },
};

// Clamp to the allowed range and round to an integer (defends against a model that
// returns 11, -12, or a float despite the schema).
function clampTone(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(-10, Math.min(10, Math.round(n)));
}

// tone → Scoreboard tier. Bullish/Bearish only at the extremes so the middle band
// isn't over-claimed as a signal.
function bucketOf(tone) {
  if (tone == null) return null;
  if (tone >= BULLISH_AT) return 'Bullish';
  if (tone <= BEARISH_AT) return 'Bearish';
  return 'Neutral';
}

// A stable cache key per earnings call: prefer fiscal period, fall back to date.
function transcriptKey(t) {
  if (!t || !t.symbol) return null;
  if (t.year && t.quarter) return `${t.symbol}-${t.year}Q${t.quarter}`;
  if (t.date) return `${t.symbol}-${String(t.date).slice(0, 10)}`;
  return null;
}

// Was the call reported recently enough to still be actionable? (calendar days)
function recentEnough(dateStr, nowMs = Date.now(), maxDays = RECENT_DAYS) {
  if (!dateStr) return false;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) <= maxDays * 86400000 && t <= nowMs;
}

// Pull the {tone, reason} out of a Claude tool-use response. Returns null if the
// model didn't call the tool or the payload is malformed.
function parseToneFromMessage(msg) {
  const tool = msg && Array.isArray(msg.content) && msg.content.find(b => b.type === 'tool_use');
  if (!tool || !tool.input) return null;
  const tone = clampTone(tool.input.tone);
  const reason = typeof tool.input.reason === 'string' ? tool.input.reason.trim() : '';
  if (tone == null || !reason) return null;
  return { tone, reason };
}

// Fetch the most recent earnings-call transcript from FMP. Returns
// { symbol, year, quarter, date, transcript } or null (graceful on any failure /
// plan-gated endpoint). Kept dependency-light so the caller degrades cleanly.
async function fetchTranscript(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key || !symbol) return null;
  const urls = [
    `https://financialmodelingprep.com/stable/earning-call-transcript?symbol=${encodeURIComponent(symbol)}&limit=1&apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/earning_call_transcript/${encodeURIComponent(symbol)}?apikey=${key}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const row = Array.isArray(j) ? j[0] : j;
      if (!row || !row.content) continue;
      return {
        symbol,
        year: row.year != null ? Number(row.year) : null,
        quarter: row.quarter != null ? Number(row.quarter) : null,
        date: row.date || row.updatedAt || null,
        transcript: String(row.content),
      };
    } catch { /* try next source */ }
  }
  return null;
}

// Score one transcript with Claude. `client` is an @anthropic-ai/sdk instance.
// Returns { tone, reason } or null on any failure (never throws).
async function scoreTone(client, { symbol, transcript }, model = MODEL) {
  if (!client || !transcript) return null;
  const clipped = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 300,
      tools: [TONE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_tone' },
      messages: [{
        role: 'user',
        content: `You are scoring the tone of ${symbol}'s latest earnings call. Read management's prepared remarks and Q&A answers. Score from -10 (negative, evasive, defensive, hedging, downbeat) to +10 (confident, upbeat, transparent, specific). Weigh HOW they answer tough questions, not just the headline numbers. Call transcript:\n\n${clipped}`,
      }],
    });
    return parseToneFromMessage(msg);
  } catch { return null; }
}

// Most-recent PAST earnings date for a symbol, via FMP `stable/earnings` (works on
// the Starter tier — the transcript endpoints don't). Used as the recency gate and
// the cache key. Returns 'YYYY-MM-DD' or null.
async function fetchLastEarningsDate(symbol, nowMs = Date.now()) {
  const key = process.env.FMP_API_KEY;
  if (!key || !symbol) return null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(symbol)}&apikey=${key}&limit=8`);
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    let best = null;
    for (const row of rows) {
      const d = row && row.date;
      if (!d) continue;
      const ms = Date.parse(d);
      if (!Number.isFinite(ms) || ms > nowMs) continue; // ignore scheduled-future dates
      if (best == null || ms > Date.parse(best)) best = String(d).slice(0, 10);
    }
    return best;
  } catch { return null; }
}

// Score tone WITHOUT a transcript: Claude web-searches the stock's latest earnings
// call (coverage, summaries, quoted guidance) and scores management's tone. Mirrors
// the app's Market Pulse pattern — a single bounded web_search call + the submit_tone
// tool, on Haiku. Returns { tone, reason } or null. Never throws.
async function scoreToneViaSearch(client, symbol, model = MODEL) {
  if (!client || !symbol) return null;
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }, TONE_TOOL];
  const messages = [{
    role: 'user',
    content: `Find ${symbol}'s MOST RECENT quarterly earnings call and read the coverage: management's prepared remarks, guidance, and how they answered analyst questions. Score management's TONE from -10 (negative, evasive, defensive, hedging, downbeat) to +10 (confident, upbeat, transparent, specific) — weigh HOW they communicated, not just whether numbers beat. After searching, you MUST call the submit_tone tool with your score and a one-sentence reason. Do not answer in plain text.`,
  }];
  try {
    // Server-side web_search can return stop_reason:"pause_turn" — re-send to resume
    // (don't add a nudge message; the API resumes from the trailing server_tool_use).
    for (let i = 0; i < 3; i++) {
      const msg = await client.messages.create({ model, max_tokens: 700, tools, messages }, { timeout: 45000 });
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      return parseToneFromMessage(msg);
    }
    return null;
  } catch { return null; }
}

module.exports = {
  TONE_TOOL, MODEL, MAX_TRANSCRIPT_CHARS, RECENT_DAYS, BULLISH_AT, BEARISH_AT,
  clampTone, bucketOf, transcriptKey, recentEnough, parseToneFromMessage,
  fetchTranscript, scoreTone, fetchLastEarningsDate, scoreToneViaSearch,
};
