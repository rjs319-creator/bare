'use strict';
// challenger-events.js — structured event-surprise engine (`event-surprise-v1`). SHADOW ONLY.
//
// Converts the existing news / earnings / SEC / biotech / insider / options / tone-shift /
// read-through / second-wave / catalyst signals into a STRICT structured event record with
// quantitative fields, then a normalized surprise score with EXPLICIT, versioned weights.
// An LLM never assigns a final recommendation: if used, it only fills structured fields, is
// forced to structured output, is sanitized, and the engine degrades to mechanical fields
// when it fails. Missing data is flagged, never fabricated.

const EVENT_SCHEMA_VERSION = 'event-surprise-v1';
const WEIGHTS_VERSION = 'event-weights-v1';

const EVENT_CATEGORIES = [
  'earnings', 'guidance', 'analyst-revision', 'mna', 'fda-biotech', 'insider',
  'sec-filing', 'options-flow', 'news-catalyst', 'tone-shift', 'read-through',
  'second-wave', 'gap', 'none',
];

// Explicit prior weights (priors until validated). Additive terms sum to 1; penalties subtract.
const SURPRISE_WEIGHTS = {
  version: WEIGHTS_VERSION,
  add: { surprise: 0.30, underreaction: 0.25, credibility: 0.20, novelty: 0.15, persistence: 0.10 },
  penalty: { dilution: 0.30, extension: 0.20, contradiction: 0.25 },
};

// Prior event half-lives in trading sessions (how long the edge typically persists).
const HALF_LIFE_SESSIONS = {
  earnings: 21, guidance: 21, 'analyst-revision': 15, mna: 10, 'fda-biotech': 8,
  insider: 30, 'sec-filing': 10, 'options-flow': 5, 'news-catalyst': 5,
  'tone-shift': 12, 'read-through': 8, 'second-wave': 10, gap: 3, none: 5,
};

const SOURCE_CATEGORY = {
  biotech: 'fda-biotech', optionsflow: 'options-flow', toneshift: 'tone-shift',
  readthrough: 'read-through', secondwave: 'second-wave', gapgo: 'gap', gapdown: 'gap',
  daytrade: 'gap', screener: 'news-catalyst', coremo: 'news-catalyst', coil: 'news-catalyst',
  downday: 'news-catalyst', anomaly: 'news-catalyst', crossasset: 'news-catalyst',
};
// Source credibility of the FIELDS a source provides (fact vs feature vs ai-inferred).
const SOURCE_QUALITY = {
  screener: 'fact-medium', biotech: 'fact-medium', optionsflow: 'fact-medium',
  gapgo: 'fact-medium', gapdown: 'fact-medium', daytrade: 'fact-medium', coremo: 'feature',
  coil: 'feature', downday: 'feature', readthrough: 'ai-inferred', anomaly: 'ai-inferred',
  secondwave: 'ai-inferred', crossasset: 'ai-inferred', toneshift: 'ai-inferred',
};
const QUALITY_CRED = { 'fact-high': 0.9, 'fact-medium': 0.7, feature: 0.55, 'ai-inferred': 0.5, unknown: 0.4 };

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function round(v, d) { if (!isNum(v)) return null; const m = Math.pow(10, d); return Math.round(v * m) / m; }

function freshnessOf(inDays, ageBars) {
  if (isNum(inDays)) { if (inDays <= 1) return 'fresh'; if (inDays <= 5) return 'recent'; return 'scheduled'; }
  if (isNum(ageBars)) { if (ageBars <= 1) return 'fresh'; if (ageBars <= 5) return 'recent'; return 'stale'; }
  return null;
}

// Build the strict structured event record mechanically from an enriched signal. `llm` is an
// OPTIONAL sanitized partial (from reviewEventWithLLM) that fills fields the mechanical path
// cannot know; when absent everything unknown is null and flagged.
function normalizeEvent(sig = {}, ctx = {}, llm = null) {
  const source = sig.source || (Array.isArray(sig.sources) && sig.sources[0]) || null;
  const rawEvent = sig.event || null;
  const category = (llm && EVENT_CATEGORIES.includes(llm.category) && llm.category)
    || (rawEvent && rawEvent.type)
    || SOURCE_CATEGORY[source] || 'none';

  const eventTimestamp = (rawEvent && rawEvent.date) || sig.detectedAt || null;
  const firstKnownTimestamp = sig.detectedAt || eventTimestamp || null;
  const inDays = rawEvent && isNum(rawEvent.inDays) ? rawEvent.inDays : null;
  const catalystFreshness = freshnessOf(inDays, sig.ageBars);
  const sourceQuality = SOURCE_QUALITY[source] || 'unknown';

  // Insider alignment: present only when the insider evidence family is lit.
  const fams = (sig.evidence && sig.evidence.families) || sig.evidenceFamilies || [];
  const insiderAlignment = fams.includes('insider') ? 'net-buy' : null;

  // Options confirmation vs contradiction: only known when an options family is present.
  let optionsConfirmation = null;
  if (fams.includes('optionsPositioning') || source === 'optionsflow') {
    optionsConfirmation = 'confirms'; // the options source only surfaces same-direction positioning
  }

  // Already-realized reaction (from remaining-edge origin tracking).
  const re = sig.remainingEdge || null;
  const priceReactionRealizedPct = re && re.rated && isNum(re.realizedMovePct) ? re.realizedMovePct : null;
  const consumedFrac = re && re.rated && isNum(re.consumedPct) ? clamp01(re.consumedPct / 100) : null;

  const peerDiffusion = isNum(sig.sectorStrength) ? sig.sectorStrength : null;
  const extensionR = re && re.rated && isNum(re.extensionR) ? re.extensionR : null;

  // LLM-fillable fields (structured, sanitized). Never a recommendation.
  const novelty = llm && isNum(llm.novelty) ? clamp01(llm.novelty) : null;
  const earningsSurprise = llm && isNum(llm.earningsSurprise) ? llm.earningsSurprise : null;
  const guidance = llm && llm.guidance ? { direction: sanitizeDir(llm.guidance.direction), magnitude: isNum(llm.guidance.magnitude) ? llm.guidance.magnitude : null } : null;
  const analystRevision = llm && llm.analystRevision ? { direction: sanitizeDir(llm.analystRevision.direction), breadth: isNum(llm.analystRevision.breadth) ? clamp01(llm.analystRevision.breadth) : null } : null;
  const dilutionRisk = llm && isNum(llm.dilutionRisk) ? clamp01(llm.dilutionRisk) : null;
  const economicSignificance = llm && isNum(llm.economicSignificance) ? clamp01(llm.economicSignificance) : null;

  // Mechanical contradiction flags (independent of the LLM).
  const contradictionFlags = [];
  const side = sig.side === 'short' ? 'short' : 'long';
  if (isNum(peerDiffusion)) {
    if (side === 'long' && peerDiffusion < -0.3) contradictionFlags.push('long-into-weak-sector');
    if (side === 'short' && peerDiffusion > 0.3) contradictionFlags.push('short-into-strong-sector');
  }
  if (optionsConfirmation === 'contradicts') contradictionFlags.push('options-contradict');
  if (llm && Array.isArray(llm.contradictionFlags)) for (const f of llm.contradictionFlags) if (typeof f === 'string') contradictionFlags.push(f.slice(0, 40));

  const record = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    category,
    eventTimestamp,
    firstKnownTimestamp,
    catalystFreshness,
    sourceQuality,
    novelty,
    economicSignificance,
    earningsSurprise,
    guidance,
    analystRevision,
    dilutionRisk,
    insiderAlignment,
    optionsConfirmation,
    priceReactionRealizedPct,
    consumedFrac,
    volumeReactionRealized: null, // relVol not carried on the enriched signal -> honestly unknown
    peerDiffusion,
    eventHalfLifeSessions: HALF_LIFE_SESSIONS[category] != null ? HALF_LIFE_SESSIONS[category] : HALF_LIFE_SESSIONS.none,
    extensionR,
    contradictionFlags,
    llmUsed: !!llm,
    llmProvenance: llm && llm.provenance ? llm.provenance : null,
  };
  record.missingFlags = missingFieldsOf(record);
  return record;
}

function sanitizeDir(d) { return d === 'up' || d === 'down' || d === 'neutral' ? d : null; }

const REQUIRED_FIELDS = ['eventTimestamp', 'novelty', 'economicSignificance', 'earningsSurprise', 'dilutionRisk', 'volumeReactionRealized'];
function missingFieldsOf(rec) { return REQUIRED_FIELDS.filter((k) => rec[k] == null); }

// Normalized surprise score with explicit component breakdown. `degraded` flags that hard
// fields were missing and proxies/defaults were used, so the score is a weak prior.
function eventSurpriseScore(rec) {
  const w = SURPRISE_WEIGHTS;
  let degraded = false;

  // surprise: prefer a real earnings surprise magnitude; else proxy from realized reaction.
  let surprise;
  if (isNum(rec.earningsSurprise)) surprise = clamp01(Math.abs(rec.earningsSurprise) / 10);
  else if (isNum(rec.economicSignificance)) surprise = rec.economicSignificance;
  else if (isNum(rec.priceReactionRealizedPct)) { surprise = clamp01(Math.abs(rec.priceReactionRealizedPct) / 12); degraded = true; }
  else { surprise = 0.5; degraded = true; }

  // underreaction: how much of the move is still ahead (inverse of consumed fraction).
  const underreaction = rec.consumedFrac != null ? clamp01(1 - rec.consumedFrac) : (degraded = true, 0.5);

  const credibility = QUALITY_CRED[rec.sourceQuality] != null ? QUALITY_CRED[rec.sourceQuality] : QUALITY_CRED.unknown;

  const novelty = rec.novelty != null ? rec.novelty : (degraded = true, 0.5);

  // persistence: longer half-life => more durable edge, normalized to a 30-session ceiling.
  const persistence = clamp01((rec.eventHalfLifeSessions || 5) / 30);

  const dilution = rec.dilutionRisk != null ? rec.dilutionRisk : 0;
  const extension = isNum(rec.extensionR) ? clamp01(Math.max(0, rec.extensionR - 0.5) / 2) : 0;
  const contradiction = clamp01((rec.contradictionFlags ? rec.contradictionFlags.length : 0) / 2);

  const additive = w.add.surprise * surprise + w.add.underreaction * underreaction
    + w.add.credibility * credibility + w.add.novelty * novelty + w.add.persistence * persistence;
  const penalties = w.penalty.dilution * dilution + w.penalty.extension * extension + w.penalty.contradiction * contradiction;
  const score = clamp01(additive - penalties) * 100;

  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    weightsVersion: w.version,
    isPrediction: true,
    category: rec.category,
    score: round(score, 1),
    degraded, // true => built from proxies/defaults, treat as a weak prior
    components: {
      surprise: round(surprise, 3), underreaction: round(underreaction, 3), credibility: round(credibility, 3),
      novelty: round(novelty, 3), persistence: round(persistence, 3),
      dilution: round(dilution, 3), extension: round(extension, 3), contradiction: round(contradiction, 3),
    },
    contradictionFlags: rec.contradictionFlags || [],
    missingFlags: rec.missingFlags || [],
  };
}

// Convenience: mechanical event surprise straight off a signal (no LLM).
function assessEvent(sig, ctx = {}, llm = null) {
  const record = normalizeEvent(sig, ctx, llm);
  const surprise = eventSurpriseScore(record);
  return { record, surprise };
}

// OPTIONAL bounded LLM enrichment. Forced structured output, maxRetries:0, sanitized, and
// returns null on ANY failure so the caller degrades to mechanical fields. The model NEVER
// returns a recommendation — only structured fields. Not exercised by the unit tests (no network).
async function reviewEventWithLLM(sig, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !sig || !sig.ticker) return null;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch { return null; }
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    const tool = {
      name: 'submit_event_fields',
      description: 'Return ONLY structured event fields. Do not give a trade recommendation.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: EVENT_CATEGORIES },
          novelty: { type: 'number' }, economicSignificance: { type: 'number' },
          earningsSurprise: { type: 'number' }, dilutionRisk: { type: 'number' },
          guidance: { type: 'object', properties: { direction: { type: 'string' }, magnitude: { type: 'number' } } },
          analystRevision: { type: 'object', properties: { direction: { type: 'string' }, breadth: { type: 'number' } } },
          contradictionFlags: { type: 'array', items: { type: 'string' } },
        },
        required: ['category'],
      },
    };
    const resp = await client.messages.create({
      model: opts.model || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      tool_choice: { type: 'tool', name: 'submit_event_fields' },
      tools: [tool],
      messages: [{ role: 'user', content: `Structured event fields for ${sig.ticker}. Catalyst: ${String(sig.catalyst || sig.note || 'n/a').slice(0, 500)}. Fields only, no recommendation.` }],
    });
    const block = (resp.content || []).find((c) => c.type === 'tool_use');
    if (!block || !block.input) return null;
    return { ...block.input, provenance: { model: resp.model || null, at: opts.now || null } };
  } catch { return null; }
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  WEIGHTS_VERSION,
  EVENT_CATEGORIES,
  SURPRISE_WEIGHTS,
  HALF_LIFE_SESSIONS,
  SOURCE_CATEGORY,
  SOURCE_QUALITY,
  normalizeEvent,
  eventSurpriseScore,
  assessEvent,
  reviewEventWithLLM,
};
