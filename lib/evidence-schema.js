'use strict';
// 🧾 EVIDENCE ENGINE — the structured EVENT + SOURCE schema (redesign stage A/B/O).
//
// The old News section stored a headline + an on-demand 2-sentence summary. This engine
// instead converts each document into a STRUCTURED EVENT: what materially changed, by how
// much, versus what was expected, from which kind of source, and how novel/material it is.
// A summary tells you what an article SAYS; an event tells you what CHANGED.
//
// Design rules (mirror lib/prediction-contract.js — the repo's honesty spine):
//   1. Numbers the LLM cannot ground stay NULL, never fabricated. `magnitude`, `priorValue`,
//      `newValue`, `surprise` are null unless a real number was extracted from the text.
//   2. Scores are bounded, deterministic post-processing of the extraction — the LLM
//      proposes; `normalizeEvent` disposes (clamps, whitelists, defaults).
//   3. Source PRIMACY (primary vs secondary) is decided DETERMINISTICALLY from the URL/
//      publisher, NOT by asking the model — it is the whole defense against counting five
//      reprints of one wire story as five independent confirmations.
//
// Pure module: no I/O, no LLM. Safe to unit-test in isolation.

// ── Event taxonomy (the prompt's eventType list) ─────────────────────────────
const EVENT_TYPES = [
  'earnings', 'guidance', 'analyst_revision', 'product', 'regulatory', 'financing',
  'insider_activity', 'institutional_activity', 'litigation', 'macro', 'industry',
  'management', 'merger_acquisition', 'capital_allocation', 'operational',
  'valuation', 'technical_confirmation',
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

// Each event type → the decision.js evidence family it primarily belongs to. This is how an
// event joins the app's existing independent-evidence / redundancy machinery (lib/decision.js
// EVIDENCE_FAMILIES, lib/redundancy.js effectiveEvidence) instead of inventing a parallel one.
const EVENT_FAMILY = {
  earnings: 'fundamentalsRevisions', guidance: 'fundamentalsRevisions',
  analyst_revision: 'fundamentalsRevisions', valuation: 'fundamentalsRevisions',
  product: 'catalystForcedFlow', regulatory: 'catalystForcedFlow',
  litigation: 'catalystForcedFlow', merger_acquisition: 'catalystForcedFlow',
  operational: 'catalystForcedFlow', management: 'catalystForcedFlow',
  financing: 'catalystForcedFlow', capital_allocation: 'catalystForcedFlow',
  insider_activity: 'insider', institutional_activity: 'insider',
  macro: 'sectorRegime', industry: 'sectorRegime',
  technical_confirmation: 'priceTrend',
};

const DIRECTIONS = ['positive', 'negative', 'mixed', 'neutral'];
// Which investment horizon an event primarily bears on. `both` when it is material to each.
const HORIZONS = ['swing', 'long_term', 'both', 'unclear'];

// ── Source provenance ────────────────────────────────────────────────────────
// PRIMARY sources publish the fact itself: the company (IR / press release), the regulator
// (SEC), the exchange, a first-party wire. SECONDARY sources report ON a primary source.
// Independent-evidence counting must treat N secondary reprints of one primary as ~1.
const PRIMARY_HOST_PATTERNS = [
  /(^|\.)sec\.gov$/i, /(^|\.)nasdaq\.com$/i, /(^|\.)nyse\.com$/i,
  /(^|\.)businesswire\.com$/i, /(^|\.)prnewswire\.com$/i, /(^|\.)globenewswire\.com$/i,
  /(^|\.)accesswire\.com$/i, /(^|\.)newsfilecorp\.com$/i, /(^|\.)federalreserve\.gov$/i,
  /(^|\.)bls\.gov$/i, /(^|\.)bea\.gov$/i,
];
// Reputable financial journalism — secondary, but high reliability (weighted by SOURCE_TIER).
const TIER1_HOST_PATTERNS = [
  /(^|\.)reuters\.com$/i, /(^|\.)bloomberg\.com$/i, /(^|\.)wsj\.com$/i, /(^|\.)ft\.com$/i,
  /(^|\.)apnews\.com$/i, /(^|\.)cnbc\.com$/i, /(^|\.)barrons\.com$/i, /(^|\.)economist\.com$/i,
];
const SOURCE_TYPES = ['primary_filing', 'primary_release', 'wire', 'journalism_tier1', 'journalism', 'aggregator', 'unknown'];
// Reliability weight per source type — feeds the consensus `sourceQuality` subscore. Primary
// filings/regulatory are the most trustworthy; anonymous aggregators the least.
const SOURCE_TIER = {
  primary_filing: 1.0, primary_release: 0.9, wire: 0.85,
  journalism_tier1: 0.8, journalism: 0.6, aggregator: 0.4, unknown: 0.35,
};

function hostOf(url) {
  if (!url || typeof url !== 'string') return null;
  try { return new URL(url).hostname.replace(/^www\./i, ''); }
  catch { return null; }
}

// Deterministically classify a source into a type + primary/secondary + reliability weight,
// from its URL host (preferred) and/or publisher name. NEVER asks the LLM — the whole
// anti-double-counting defense depends on this being mechanical and stable.
function classifySource({ url, publisher, documentType } = {}) {
  const host = hostOf(url);
  const pub = (publisher || '').toLowerCase();
  let type = 'unknown';
  if (documentType === 'sec_filing' || (host && PRIMARY_HOST_PATTERNS.some(re => re.test(host) && /sec\.gov|federalreserve|bls\.gov|bea\.gov/i.test(host)))) {
    type = 'primary_filing';
  } else if (host && PRIMARY_HOST_PATTERNS.some(re => re.test(host))) {
    type = /businesswire|prnewswire|globenewswire|accesswire|newsfilecorp/i.test(host) ? 'primary_release' : 'primary_filing';
  } else if (host && TIER1_HOST_PATTERNS.some(re => re.test(host))) {
    type = 'journalism_tier1';
  } else if (/press release|newswire|business wire|globe newswire/.test(pub)) {
    type = 'primary_release';
  } else if (/reuters|bloomberg|wall street journal|financial times|associated press|cnbc/.test(pub)) {
    type = 'journalism_tier1';
  } else if (host) {
    type = 'journalism';
  }
  return {
    host: host || null,
    publisher: publisher || host || null,
    type,
    isPrimary: type === 'primary_filing' || type === 'primary_release',
    reliability: SOURCE_TIER[type],
  };
}

// ── Event normalization ──────────────────────────────────────────────────────
const clampNum = (v, lo, hi, dflt = null) => {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
};
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const numOrNull = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

// Turn a raw LLM extraction (+ its source records) into a validated, render-ready event.
// Bounds every score, whitelists every enum, and applies null-discipline to every number.
// Returns null if the extraction has no usable claim (fail-closed).
function normalizeEvent(raw, { ticker, sources = [], detectedAt = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const claim = clean(raw.claim, 400);
  if (!claim) return null;

  const eventType = EVENT_TYPE_SET.has(raw.eventType) ? raw.eventType : 'operational';
  const direction = DIRECTIONS.includes(raw.direction) ? raw.direction : 'neutral';
  const affectedHorizon = HORIZONS.includes(raw.affectedHorizon) ? raw.affectedHorizon : 'unclear';

  // Source primacy is decided here, mechanically, from the attached source records.
  const srcClass = (sources || []).map(classifySource);
  const primaryCount = srcClass.filter(s => s.isPrimary).length;
  const bestReliability = srcClass.length ? Math.max(...srcClass.map(s => s.reliability)) : SOURCE_TIER.unknown;
  const sourceType = srcClass.length
    ? srcClass.slice().sort((a, b) => b.reliability - a.reliability)[0].type
    : 'unknown';

  return {
    ticker: (ticker || raw.ticker || '').toUpperCase() || null,
    eventType,
    eventSubtype: clean(raw.eventSubtype, 60) || null,
    headline: clean(raw.headline, 240) || null,
    claim,
    // Quantified change — NULL unless a real number was grounded in the text.
    quantitativeMagnitude: numOrNull(raw.quantitativeMagnitude),
    priorValue: numOrNull(raw.priorValue),
    newValue: numOrNull(raw.newValue),
    consensusExpectation: numOrNull(raw.consensusExpectation),
    surpriseMagnitude: numOrNull(raw.surpriseMagnitude),
    direction,
    affectedHorizon,
    catalystDate: clean(raw.catalystDate, 24) || null,
    // Bounded 0..1 scores (the LLM proposes; we clamp).
    noveltyScore: clampNum(raw.noveltyScore, 0, 1, 0.5),
    materialityScore: clampNum(raw.materialityScore, 0, 1, 0.5),
    extractionConfidence: clampNum(raw.extractionConfidence, 0, 1, 0.5),
    // Provenance — decided mechanically, not by the model.
    sourceType,
    sourceQualityScore: +bestReliability.toFixed(2),
    primarySourceCount: primaryCount,
    family: EVENT_FAMILY[eventType] || 'catalystForcedFlow',
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).slice(0, 4).map(e => clean(e, 200)).filter(Boolean),
    assumptions: clean(raw.assumptions, 300) || null,
    risks: clean(raw.risks, 300) || null,
    contradictions: (Array.isArray(raw.contradictions) ? raw.contradictions : []).slice(0, 4).map(c => clean(c, 200)).filter(Boolean),
    detectedAt: detectedAt || null,
  };
}

// Boundary validator (fail loud but soft) — used by routes before persisting/serving.
function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') return { ok: false, errors: ['not an object'] };
  if (!ev.ticker) errors.push('missing ticker');
  if (!ev.claim) errors.push('missing claim');
  if (!EVENT_TYPE_SET.has(ev.eventType)) errors.push(`invalid eventType: ${ev.eventType}`);
  if (!DIRECTIONS.includes(ev.direction)) errors.push(`invalid direction: ${ev.direction}`);
  for (const f of ['noveltyScore', 'materialityScore', 'extractionConfidence', 'sourceQualityScore']) {
    const v = ev[f];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 1.0001)) errors.push(`${f} out of [0,1]: ${v}`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  EVENT_TYPES, EVENT_TYPE_SET, EVENT_FAMILY, DIRECTIONS, HORIZONS,
  SOURCE_TYPES, SOURCE_TIER, PRIMARY_HOST_PATTERNS, TIER1_HOST_PATTERNS,
  hostOf, classifySource, normalizeEvent, validateEvent,
  SCHEMA_VERSION: 'evidence-v1',
};
