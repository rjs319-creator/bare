'use strict';
// "AROUND THE CORNER" — tech-command-events-v1.
//
// The page's differentiating lens: what already happened, what is happening now,
// and what is scheduled next — with every item carrying its source URL, publisher,
// publication timestamp and retrieval timestamp.
//
// RULES ENFORCED HERE:
//   1. Deterministic facts and timestamps come first. Scenarios are built from
//      those facts by rule; an LLM may only NARRATE the record built here.
//   2. Syndicated / repeated stories are deduplicated by normalized headline.
//   3. SCHEDULED catalysts (a dated earnings print, an options expiry) are kept
//      structurally separate from EMERGING narratives (a news story).
//   4. Company-specific events are kept separate from sector-wide ones.
//   5. No scenario is a forecast and no scenario carries a numeric probability —
//      the only confidence expressed is confidence in the underlying DATA.
//
// Pure: no network, no store, no clock beyond the injected `now`.

const EVENTS_VERSION = 'tech-command-events-v1';

const BUCKETS = Object.freeze(['next-session', 'next-48h', 'next-two-weeks', 'next-1-3-months']);
const SCOPES = Object.freeze(['company', 'sector', 'market']);
const KINDS = Object.freeze([
  'earnings', 'guidance', 'product', 'analyst', 'filing', 'insider', 'regulatory',
  'price-response', 'options-expiry', 'peer-earnings', 'macro', 'investor-day', 'conference', 'news',
]);

const DAY_MS = 86400000;

// Headline normalization for syndication dedup: lowercase, strip punctuation,
// collapse whitespace, drop a leading source attribution.
function normalizeHeadline(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^[^:]{1,24}:\s*/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable non-cryptographic hash — the cache key for any LLM narration. */
function hashOf(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Build one normalized event record. Missing provenance is recorded as missing —
 * an event with no publication timestamp is explicitly `undated`, never assumed.
 */
function makeEvent(input = {}) {
  const publishedAt = input.publishedAt ? new Date(input.publishedAt).toISOString() : null;
  const scheduledFor = input.scheduledFor ? String(input.scheduledFor).slice(0, 10) : null;
  const kind = KINDS.includes(input.kind) ? input.kind : 'news';
  const scope = SCOPES.includes(input.scope) ? input.scope : 'company';
  return Object.freeze({
    id: input.id || hashOf(`${input.ticker || ''}|${kind}|${input.title || ''}|${publishedAt || scheduledFor || ''}`),
    ticker: input.ticker ? String(input.ticker).toUpperCase() : null,
    kind,
    scope,
    scheduled: !!scheduledFor,
    title: String(input.title || '').slice(0, 300),
    summary: input.summary ? String(input.summary).slice(0, 400) : null,
    url: input.url || null,
    publisher: input.publisher || null,
    publishedAt,
    scheduledFor,
    retrievedAt: input.retrievedAt || null,
    undated: !publishedAt && !scheduledFor,
    // Confidence in the DATA, never in an outcome.
    dataConfidence: input.url && (publishedAt || scheduledFor) ? 'sourced'
      : (publishedAt || scheduledFor) ? 'dated-unsourced' : 'unverified',
    metrics: input.metrics ? Object.freeze({ ...input.metrics }) : null,
    normalizedTitle: normalizeHeadline(input.title),
  });
}

/** Deduplicate syndicated/repeated stories, keeping the earliest sourced copy. */
function dedupeEvents(events) {
  const byKey = new Map();
  const duplicates = [];
  for (const e of events || []) {
    if (!e) continue;
    const key = `${e.ticker || 'MKT'}|${e.kind}|${e.normalizedTitle || e.id}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...e, syndicatedCopies: 0, publishers: e.publisher ? [e.publisher] : [] }); continue; }
    duplicates.push(e.id);
    const earlier = (e.publishedAt && prev.publishedAt && e.publishedAt < prev.publishedAt);
    const merged = {
      ...(earlier ? e : prev),
      syndicatedCopies: (prev.syndicatedCopies || 0) + 1,
      publishers: [...new Set([...(prev.publishers || []), e.publisher].filter(Boolean))],
    };
    byKey.set(key, merged);
  }
  return { events: [...byKey.values()], duplicatesRemoved: duplicates.length };
}

/**
 * Which forward bucket a dated future event falls into.
 *
 * A DATE-ONLY value (an earnings date, an expiry) is bucketed by whole calendar
 * days, not by hours: "tomorrow" is the next session no matter what time of day
 * the board is read. A full timestamp keeps hour resolution.
 */
function bucketFor(dateIso, now) {
  if (!dateIso) return null;
  const nowMs = new Date(now).getTime();
  let days;
  if (String(dateIso).length === 10) {
    const eventDay = Date.parse(`${dateIso}T00:00:00Z`);
    if (!Number.isFinite(eventDay)) return null;
    const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
    days = Math.round((eventDay - today) / DAY_MS);
    if (days < 0) return null;
    if (days <= 1) return 'next-session';
    if (days <= 2) return 'next-48h';
    if (days <= 14) return 'next-two-weeks';
    if (days <= 92) return 'next-1-3-months';
    return null;
  }
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return null;
  days = (t - nowMs) / DAY_MS;
  if (days < 0) return null;
  if (days <= 1) return 'next-session';
  if (days <= 2) return 'next-48h';
  if (days <= 14) return 'next-two-weeks';
  if (days <= 92) return 'next-1-3-months';
  return null;
}

/**
 * Assemble the past / present / upcoming timeline.
 *
 * @param {{events: Array, present?: object, now?: Date, pastWindowDays?: number}} input
 *   present: { byTicker: { TICKER: { pctChange, relVol, rsVsQqq, rsVsSubsector,
 *              attentionState, optionsState, narrativeShift, accumulation } } }
 */
function buildTimeline({ events, present = {}, now = new Date(), pastWindowDays = 30 } = {}) {
  const nowIso = new Date(now).toISOString();
  const { events: deduped, duplicatesRemoved } = dedupeEvents(events);

  const past = [];
  const upcoming = [];
  const undated = [];
  for (const e of deduped) {
    if (e.scheduledFor) {
      const b = bucketFor(e.scheduledFor, now);
      if (b) { upcoming.push({ ...e, bucket: b }); continue; }
      // A scheduled date in the past IS a past event (the print happened).
      if (Date.parse(`${e.scheduledFor}T21:00:00Z`) < new Date(now).getTime()) { past.push(e); continue; }
      undated.push(e);
      continue;
    }
    if (!e.publishedAt) { undated.push(e); continue; }
    const age = (new Date(now).getTime() - Date.parse(e.publishedAt)) / DAY_MS;
    if (age <= pastWindowDays) past.push(e);
  }

  // Strict timestamp ordering: newest-first for the past, soonest-first ahead.
  past.sort((a, b) => String(b.publishedAt || b.scheduledFor || '').localeCompare(String(a.publishedAt || a.scheduledFor || '')));
  upcoming.sort((a, b) => String(a.scheduledFor || '').localeCompare(String(b.scheduledFor || ''))
    || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

  const byBucket = Object.fromEntries(BUCKETS.map(b => [b, upcoming.filter(e => e.bucket === b)]));

  const presentRows = Object.entries((present && present.byTicker) || {}).map(([ticker, p]) => ({
    ticker,
    ...p,
    contradictions: presentContradictions(p),
  }));

  return Object.freeze({
    schema: EVENTS_VERSION,
    generatedAt: nowIso,
    past: Object.freeze(past),
    present: Object.freeze(presentRows),
    upcoming: Object.freeze(upcoming),
    byBucket: Object.freeze(byBucket),
    undated: Object.freeze(undated),
    counts: Object.freeze({
      past: past.length, upcoming: upcoming.length, undated: undated.length,
      scheduled: upcoming.filter(e => e.scheduled).length,
      emerging: past.filter(e => !e.scheduled).length,
      companyScope: deduped.filter(e => e.scope === 'company').length,
      sectorScope: deduped.filter(e => e.scope !== 'company').length,
      duplicatesRemoved,
    }),
    empty: past.length === 0 && upcoming.length === 0,
    emptyReason: past.length === 0 && upcoming.length === 0
      ? 'No dated technology events could be retrieved this cycle — this is a coverage gap, not a quiet calendar.'
      : null,
  });
}

// Where the facts, the price and the crowd disagree. Purely mechanical.
function presentContradictions(p) {
  const out = [];
  if (!p) return out;
  if (p.attentionState === 'SATURATED' && (p.pctChange ?? 0) <= 0) {
    out.push('Attention is saturated while price is not responding — crowding without follow-through.');
  }
  if ((p.rsVsQqq ?? 0) < 0 && (p.pctChange ?? 0) > 0) {
    out.push('The name is up but still losing ground to QQQ — the move is market beta, not leadership.');
  }
  if (p.optionsState === 'CONTRADICTS_SETUP') {
    out.push('Options positioning leans against the price setup.');
  }
  if ((p.relVol ?? 0) > 2 && (p.attentionState === 'INSUFFICIENT_COVERAGE' || p.attentionState == null)) {
    out.push('Volume is elevated with no measurable attention — a move without a visible narrative.');
  }
  return out;
}

// ── Deterministic scenarios ─────────────────────────────────────────────────
// Built from facts by rule. No probabilities, ever. `dataConfidence` describes the
// inputs; it is explicitly NOT confidence in the outcome.
/**
 * @param {{ticker: string, universeRecord?: object, nextEvent?: object,
 *          levels?: {trigger?: number, invalidation?: number, target?: number, price?: number},
 *          expectedMovePct?: number|null, peers?: string[], present?: object}} input
 */
function buildScenarios(input = {}) {
  const { ticker, universeRecord: u = null, nextEvent = null, levels = {}, expectedMovePct = null, peers = [], present = null } = input;
  const window = nextEvent && nextEvent.scheduledFor
    ? `until ${nextEvent.scheduledFor} (${nextEvent.kind})`
    : 'the next 2–4 weeks';
  const move = expectedMovePct != null ? `${expectedMovePct}%` : 'an unquantified amount (no option-implied move available)';

  const confirm = [];
  const invalidate = [];
  if (levels.trigger != null) confirm.push(`a close above ${levels.trigger}`);
  if (levels.invalidation != null) invalidate.push(`a close below ${levels.invalidation}`);
  confirm.push('relative strength vs QQQ turning positive and holding');
  invalidate.push('relative strength vs QQQ making a new low while price holds up');
  if (u && u.benchmark) {
    confirm.push(`outperformance of ${u.benchmark} on the event day`);
    invalidate.push(`underperformance of ${u.benchmark} on the event day`);
  }

  const dataConfidence = [
    nextEvent ? 'a dated forward event is known' : 'no dated forward event is known',
    expectedMovePct != null ? 'an option-implied move is available' : 'no option-implied move is available',
    present ? 'current price/participation is measured' : 'current price/participation is unmeasured',
  ];

  return Object.freeze({
    ticker: String(ticker || '').toUpperCase(),
    window,
    probabilities: null,
    probabilityNote: 'Scenarios are mechanically-constructed possibilities, not forecasts. No probability is attached because none has been calibrated.',
    bull: {
      label: 'Bull',
      condition: nextEvent
        ? `${nextEvent.kind} lands better than the current setup implies and the group confirms`
        : 'the current relative-strength trend continues and the group confirms',
      priceContext: levels.target != null ? `toward ${levels.target}` : `roughly ${move} higher`,
      confirmedBy: confirm,
    },
    base: {
      label: 'Base',
      condition: 'the event resolves in line and the name keeps tracking its subsector',
      priceContext: 'range-bound around the current level with subsector beta',
      confirmedBy: ['neither the trigger nor the invalidation is taken'],
    },
    bear: {
      label: 'Bear',
      condition: nextEvent
        ? `${nextEvent.kind} disappoints, or the group sells off and this name leads lower`
        : 'relative strength rolls over and the group sells off',
      priceContext: levels.invalidation != null ? `toward ${levels.invalidation}` : `roughly ${move} lower`,
      confirmedBy: invalidate,
    },
    invalidationConditions: invalidate,
    affectedRelated: peers.slice(0, 8),
    dataConfidence,
    // The exact string an LLM narration must be keyed on so a cached narration can
    // never be reused after the underlying facts change.
    factHash: hashOf(JSON.stringify({ ticker, nextEvent: nextEvent && nextEvent.id, levels, expectedMovePct, peers })),
  });
}

module.exports = {
  EVENTS_VERSION, BUCKETS, SCOPES, KINDS,
  normalizeHeadline, hashOf, makeEvent, dedupeEvents, bucketFor,
  buildTimeline, buildScenarios, presentContradictions,
};
