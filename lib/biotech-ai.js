'use strict';
// 🧬 BIOTECH AI (Phase 9) — the model as a BOUNDED evidence interpreter, never the factual
// source. Deterministic retrieval (company news + EDGAR filings) builds an EVIDENCE BUNDLE with
// stable ids; the model may only interpret and classify what is IN the bundle. It must cite
// bundle ids for every factual conclusion; at parse time we REJECT any citation not in the
// bundle and any ticker not in the candidate set, and we DOWNGRADE an "evidence: Verified"
// grade that is not backed by a cited PRIMARY source. The model returns no probability. Model,
// prompt version, the exact bundle, and the assessment time are all preserved for audit. On
// timeout/failure the caller keeps a usable mechanical candidate with an honest data-quality
// state — the AI is additive interpretation, never a hard dependency.

const { CATALYST_CLASSES } = require('./biotech');
const { VERSIONS } = require('./biotech-config');

const MODEL = 'claude-haiku-4-5-20251001';   // reliable under the 60s serverless wall
const PROMPT_VERSION = VERSIONS.ai;
const CALL_TIMEOUT_MS = 45000;
const PRIMARY_SOURCE_TYPES = new Set(['sec', 'fda', 'ct.gov', 'ir', 'conference']);
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

// Build a stable-id evidence bundle for one ticker from deterministic retrieval. news items
// {title,datetime}; filings {form,filingDate,url}. Returns [{id, sourceType, title, publishedAt, url, primary}].
function buildEvidenceBundle({ news = [], filings = [] } = {}) {
  const bundle = [];
  filings.slice(0, 8).forEach((f, i) => bundle.push({
    id: `f${i + 1}`, sourceType: 'sec', title: `${f.form} filed ${f.filingDate}`,
    publishedAt: f.filingDate || null, url: f.url || null, primary: true,
  }));
  news.slice(0, 10).forEach((n, i) => bundle.push({
    id: `n${i + 1}`, sourceType: 'news', title: clean(n.title, 200),
    publishedAt: n.datetime ? new Date(n.datetime).toISOString().slice(0, 10) : null, url: n.url || null, primary: false,
  }));
  return bundle;
}

const BIOTECH_TOOL = {
  name: 'submit_biotech_assessment',
  description: 'Interpret ONLY the evidence bundle shown for each ticker. Cite bundle ids for every factual claim. Do NOT invent catalysts, dates, sources, or a probability. If the bundle is insufficient, classify as STEALTH/NOISE with evidence None.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            classification: { type: 'string', enum: CATALYST_CLASSES },
            evidence: { type: 'string', enum: ['Verified', 'Inferred', 'None'], description: 'Verified ONLY if a cited PRIMARY (sec/fda/ct.gov/ir) bundle id supports a dated catalyst; else Inferred or None' },
            citations: { type: 'array', items: { type: 'string' }, description: 'bundle ids (e.g. f1, n2) that support the classification — MUST come from the supplied bundle' },
            catalyst_timing: { type: 'string', enum: ['Behind', 'Ahead', 'NA'] },
            outcomeDirection: { type: 'string', enum: ['positive', 'negative', 'mixed', 'pending', 'unknown'] },
            scientificQuality: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
            subsector: { type: 'string', description: 'mechanism/subsector tag, or empty' },
            dilution_interpretation: { type: 'string', enum: ['High', 'Medium', 'Low', 'None', 'Unknown'] },
            reason: { type: 'string', description: 'the specific catalyst grounded in the cited evidence, or "insufficient evidence in bundle"' },
            bear_case: { type: 'string' },
            thesis: { type: 'string' },
            caution: { type: 'string' },
            confidence: { type: 'integer', description: '1-5' },
          },
          required: ['ticker', 'classification', 'evidence', 'reason', 'confidence'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt(cands) {
  const blocks = cands.map(c => {
    const bundle = (c.bundle || []).map(e => `    [${e.id}] (${e.primary ? 'PRIMARY ' + e.sourceType : e.sourceType}${e.publishedAt ? ', ' + e.publishedAt : ''}) ${e.title}`).join('\n');
    return `- ${c.ticker}: +${c.ret5 != null ? c.ret5 : '?'}% ~5d, RVOL ${c.relVol || '?'}x, $${(c.last || 0).toFixed ? c.last.toFixed(2) : c.last}. Evidence bundle:\n${bundle || '    (no evidence retrieved — classify STEALTH/NOISE, evidence None)'}`;
  }).join('\n\n');
  return `You are a biotech-desk analyst. For EACH ticker, interpret ONLY the evidence bundle shown — do not use outside knowledge as fact, do not invent catalysts/dates/sources, and do not output any probability.

${blocks}

Rules:
- Cite the bundle ids that support your classification in "citations". You may ONLY cite ids that appear in that ticker's bundle.
- Grade evidence "Verified" ONLY when a cited PRIMARY source (sec/fda/ct.gov/ir) establishes a dated catalyst. Corroborating news alone is "Inferred". Nothing supporting → "None".
- FDA=approval/PDUFA/regulatory; DATA=Ph2 randomized/Ph3 topline; MA=definitive merger; PARTNER=licensing; ANALYST=rating/PT; SYMPATHY=moving with a named leader; FINANCING=offering/shelf/ATM; STEALTH=accumulation with no bundle catalyst; NOISE=random illiquid spike.
- catalyst_timing: Behind = reacting to a catalyst already out; Ahead = running into a dated future binary.
- Be honest: an empty or weak bundle means STEALTH/NOISE with evidence None — NOT a manufactured catalyst.
You MUST call submit_biotech_assessment.`;
}

// Parse + enforce: ticker whitelist, citation whitelist, and evidence-grade grounding.
function parseAssessment(input, cands) {
  const byTicker = new Map();
  const allowed = new Map((cands || []).map(c => [String(c.ticker).toUpperCase(), new Set((c.bundle || []).map(e => e.id))]));
  const primaryIds = new Map((cands || []).map(c => [String(c.ticker).toUpperCase(), new Set((c.bundle || []).filter(e => e.primary).map(e => e.id))]));
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  for (const it of raw) {
    if (!it || !it.ticker) continue;
    const tk = clean(it.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || !allowed.has(tk) || byTicker.has(tk)) continue;
    const bundleIds = allowed.get(tk);
    const citations = Array.isArray(it.citations) ? it.citations.map(c => clean(c, 8)).filter(c => bundleIds.has(c)) : [];
    let evidence = ['Verified', 'Inferred', 'None'].includes(it.evidence) ? it.evidence : 'None';
    // Enforce grounding: "Verified" requires a cited PRIMARY bundle id.
    const hasPrimaryCite = citations.some(c => primaryIds.get(tk).has(c));
    if (evidence === 'Verified' && !hasPrimaryCite) evidence = citations.length ? 'Inferred' : 'None';
    byTicker.set(tk, {
      ticker: tk,
      classification: CATALYST_CLASSES.includes(it.classification) ? it.classification : 'NOISE',
      evidence, citations,
      catalyst_timing: ['Behind', 'Ahead', 'NA'].includes(it.catalyst_timing) ? it.catalyst_timing : 'NA',
      outcomeDirection: ['positive', 'negative', 'mixed', 'pending', 'unknown'].includes(it.outcomeDirection) ? it.outcomeDirection : 'unknown',
      scientificQuality: ['high', 'medium', 'low', 'unknown'].includes(it.scientificQuality) ? it.scientificQuality : 'unknown',
      subsector: it.subsector ? clean(it.subsector, 60) : null,
      dilution_interpretation: ['High', 'Medium', 'Low', 'None', 'Unknown'].includes(it.dilution_interpretation) ? it.dilution_interpretation : 'Unknown',
      reason: clean(it.reason, 500) || 'insufficient evidence in bundle',
      bear_case: it.bear_case ? clean(it.bear_case, 300) : null,
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
      confidence: Math.max(1, Math.min(5, parseInt(it.confidence, 10) || 2)),
      groundedPrimary: hasPrimaryCite,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

// Parametric interpretation of the supplied bundles (no web_search — the model cannot fetch
// new facts, only interpret what was retrieved deterministically).
async function investigate(cands) {
  if (!process.env.ANTHROPIC_API_KEY) return { model: MODEL, promptVersion: PROMPT_VERSION, generatedAt: new Date().toISOString(), raw: null };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 6000,
    tools: [BIOTECH_TOOL], tool_choice: { type: 'tool', name: 'submit_biotech_assessment' },
    messages: [{ role: 'user', content: buildPrompt(cands) }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_biotech_assessment');
  return { model: MODEL, promptVersion: PROMPT_VERSION, generatedAt: new Date().toISOString(), raw: tool ? tool.input : null };
}

module.exports = {
  MODEL, PROMPT_VERSION, BIOTECH_TOOL, buildEvidenceBundle, buildPrompt, parseAssessment, investigate,
};
