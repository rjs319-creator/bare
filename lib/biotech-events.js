'use strict';
// 🧬 BIOTECH EVENT LEDGER (Phase 2) — a point-in-time record of verified catalyst evidence,
// so the engine does not ask an LLM to rediscover every catalyst from scratch each run.
//
// DOCTRINE: an LLM may INTERPRET and classify evidence, but it may NOT be the factual SOURCE
// of an event. A factual event needs a source record (SEC filing, FDA notice, ClinicalTrials.gov
// entry, company IR release, conference abstract, earnings record). Multiple news stories
// derived from the SAME press release are ONE factual origin, not corroboration. When no
// primary/secondary source can be matched, the event degrades to UNVERIFIED rather than being
// invented. Expected dates are kept separate from actual results; the first time the app could
// have known the information (firstKnownAt) is preserved so historical imports never masquerade
// as prospective observations.

const { VERSIONS } = require('./biotech-config');

const EVENT_TYPES = ['FDA_DECISION', 'PDUFA', 'TRIAL_READOUT', 'MA', 'PARTNERSHIP', 'FINANCING', 'ANALYST', 'CONFERENCE', 'OTHER'];
const VERIFICATION = { PRIMARY: 'PRIMARY', CORROBORATED: 'CORROBORATED', SECONDARY: 'SECONDARY', UNVERIFIED: 'UNVERIFIED', CONFLICTED: 'CONFLICTED' };
// Source types that can, on a direct ticker/asset/type/date match, establish PRIMARY verification.
const PRIMARY_SOURCE_TYPES = new Set(['sec', 'fda', 'ct.gov', 'ir', 'conference']);

const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

// Normalize a headline to a factual-origin signature: lowercase alnum, first ~48 chars. Two
// wire stories rewriting the same PR collapse to the same signature → counted as one origin.
function originSignature(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Normalize + validate a source record.
function makeSource(s) {
  return {
    sourceType: clean(s.sourceType, 20) || 'news',
    originId: s.originId ? clean(s.originId, 80) : null,
    title: clean(s.title, 240),
    url: s.url ? clean(s.url, 400) : null,
    publishedAt: s.publishedAt ? clean(s.publishedAt, 30) : null,
    retrievedAt: s.retrievedAt ? clean(s.retrievedAt, 30) : null,
    primary: !!s.primary && PRIMARY_SOURCE_TYPES.has(s.sourceType),
  };
}

// Collapse a source list to DISTINCT factual origins. A primary source with an originId is its
// own origin; news items collapse by headline signature. Returns { origins:[key], count }.
function independentOrigins(sources = []) {
  const keys = new Set();
  for (const s of sources) {
    if (s.originId) keys.add(`${s.sourceType}:${s.originId}`);
    else if (s.primary) keys.add(`${s.sourceType}:${originSignature(s.title)}`);
    else keys.add(`news:${originSignature(s.title)}`);
  }
  return { origins: [...keys], count: keys.size };
}

/**
 * Build a normalized, verification-graded event. `input` carries whatever evidence was
 * retrieved/interpreted; verification is derived deterministically from the SOURCES, not
 * from the caller's assertion.
 */
function makeEvent(input = {}) {
  const sources = (input.sources || []).map(makeSource);
  const { origins, count: originCount } = independentOrigins(sources);
  const hasPrimary = sources.some(s => s.primary);
  const hasSecondary = sources.some(s => !s.primary);
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts.map(c => clean(c, 200)) : [];

  // Deterministic verification level.
  let verification = VERIFICATION.UNVERIFIED;
  if (conflicts.length) verification = VERIFICATION.CONFLICTED;
  else if (hasPrimary && originCount >= 2) verification = VERIFICATION.CORROBORATED;
  else if (hasPrimary) verification = VERIFICATION.PRIMARY;
  else if (hasSecondary) verification = VERIFICATION.SECONDARY;

  const eventType = EVENT_TYPES.includes(input.eventType) ? input.eventType : 'OTHER';
  return {
    eventId: input.eventId ? clean(input.eventId, 80) : null,
    ticker: clean(input.ticker, 8).toUpperCase(),
    company: input.company ? clean(input.company, 120) : null,
    asset: input.asset ? clean(input.asset, 80) : null,
    indication: input.indication ? clean(input.indication, 80) : null,
    mechanism: input.mechanism ? clean(input.mechanism, 80) : null,
    developmentPhase: input.developmentPhase ? clean(input.developmentPhase, 24) : null,
    eventType,
    eventStatus: input.eventStatus ? clean(input.eventStatus, 24) : (input.actualDate ? 'occurred' : 'expected'),
    expectedDate: input.expectedDate || null,
    expectedWindowStart: input.expectedWindowStart || null,
    expectedWindowEnd: input.expectedWindowEnd || null,
    actualDate: input.actualDate || null,
    dateCertainty: input.dateCertainty ? clean(input.dateCertainty, 16) : (input.actualDate ? 'confirmed' : input.expectedDate ? 'estimated' : 'unknown'),
    outcomeDirection: ['positive', 'negative', 'mixed', 'pending', null].includes(input.outcomeDirection) ? input.outcomeDirection : null,
    primaryEndpoint: input.primaryEndpoint ? clean(input.primaryEndpoint, 200) : null,
    secondaryEndpoints: Array.isArray(input.secondaryEndpoints) ? input.secondaryEndpoints.map(e => clean(e, 120)) : [],
    scientificQuality: input.scientificQuality ? clean(input.scientificQuality, 16) : null,
    safetySignal: input.safetySignal ? clean(input.safetySignal, 120) : null,
    sourceQuality: hasPrimary ? 'primary' : hasSecondary ? 'secondary' : 'none',
    sources,
    verified: verification === VERIFICATION.PRIMARY || verification === VERIFICATION.CORROBORATED,
    verification,
    independentOriginCount: originCount,
    origins,
    conflicts,
    nextUnresolvedBinaryDate: input.nextUnresolvedBinaryDate || null,
    firstKnownAt: input.firstKnownAt || null,          // preserved: when the app COULD have known
    lastUpdatedAt: input.lastUpdatedAt || null,
    version: VERSIONS.events,
  };
}

// Is the catalyst REACTING to something already out, or running INTO a dated future binary?
function classifyTiming(event, asOf) {
  if (!event) return 'NA';
  const d = asOf || new Date().toISOString().slice(0, 10);
  if (event.actualDate && event.actualDate <= d) return 'Behind';
  const future = event.expectedDate || event.expectedWindowStart || event.nextUnresolvedBinaryDate;
  if (future && future > d) return 'Ahead';
  return 'NA';
}

// Sessions/days until the next unresolved binary event (or the expected date). null when none.
function daysToNextBinary(event, asOf) {
  if (!event) return null;
  const d = asOf || new Date().toISOString().slice(0, 10);
  const target = event.nextUnresolvedBinaryDate || (event.actualDate ? null : event.expectedDate || event.expectedWindowStart);
  if (!target || target <= d) return null;
  return Math.round((new Date(target) - new Date(d)) / 86_400_000);
}

module.exports = {
  EVENT_TYPES, VERIFICATION, PRIMARY_SOURCE_TYPES,
  makeSource, makeEvent, independentOrigins, originSignature, classifyTiming, daysToNextBinary,
};
