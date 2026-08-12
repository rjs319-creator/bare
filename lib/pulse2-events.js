'use strict';
// 📡 MARKET PULSE v2 — EVENT IDENTITY + MEASURED LIFECYCLES.
//
// v1 keyed episodes on the bare primary ticker ('T:NVDA'), so an earnings story and a
// months-later product story merged, and the new story inherited the old first-seen date.
// v2 identity is an EVENT FINGERPRINT:
//     entity | eventFamily | normalized-claim | eventDate-bucket | direction
// Two different catalysts for one ticker are two events; a re-told story matches its
// own fingerprint. Semantic token overlap is only a BOUNDED fallback (same entity AND
// same family), never a cross-family merge.
//
// Lifecycles are MEASURED from repeated observations (observation counts, lineage
// arrivals, disappearance streaks) — LLM "buzz" may be displayed as editorial inference
// but never drives these states. First-seen records are immutable.
//
// Pure + injectable clock. Storage lives in pulse2-store.

const freshness = require('./pulse2-freshness');

const EVENT_FAMILIES = Object.freeze([
  'earnings', 'guidance', 'analyst', 'product', 'regulatory', 'fda-clinical',
  'merger-acquisition', 'financing', 'legal', 'macro', 'rates', 'commodity',
  'geopolitical', 'industry-supply-chain', 'positioning-sentiment', 'other',
]);

const NARRATIVE_LIFECYCLE = Object.freeze([
  'NEW', 'SPREADING', 'VERIFIED', 'SATURATED', 'COOLING', 'RESOLVED', 'INVALIDATED',
]);

// Disappearance thresholds, in CONSECUTIVE COLLECTION CYCLES the event was not observed.
const MISSED_CYCLES_COOLING = 3;
const MISSED_CYCLES_RESOLVED = 6;
// An event unobserved this many cycles is dropped from the active ledger (kept in outcomes).
const MISSED_CYCLES_EXPIRED = 20;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'as', 'at',
  'by', 'with', 'from', 'this', 'that', 'it', 'its', 'be', 'was', 'will', 'has', 'have',
  'after', 'amid', 'over', 'into', 'up', 'down', 'new', 'us', 'stock', 'stocks', 'shares',
  'market', 'markets', 'says', 'said', 'could', 'may', 'more', 'than', 'plan', 'plans',
  'report', 'reports', 'reported', 'news', 'today', 'week',
]);

const sanitizeFamily = f => (EVENT_FAMILIES.includes(String(f || '').toLowerCase()) ? String(f).toLowerCase() : 'other');

/** Significant lowercase tokens for claim normalization. Pure. */
function claimTokens(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w)))];
}

/** Normalized claim slug: first 4 sorted significant tokens. Pure. */
function claimSlug(text) {
  return claimTokens(text).sort().slice(0, 4).join('-') || 'unspecified';
}

/** The entity an event attaches to: primary ticker or a macro theme slug. Pure. */
function entityOf({ tickers = [], headline = '' } = {}) {
  const tks = (tickers || []).map(t => String(t).toUpperCase()).filter(Boolean);
  if (tks.length) return tks.slice().sort()[0];
  return 'MACRO:' + claimSlug(headline);
}

/**
 * Deterministic event fingerprint. Direction is part of the printed identity (it names
 * the ORIGINAL thesis) but continuity matching deliberately excludes it, so a genuine
 * direction flip becomes a MATERIAL TRANSITION on the same event, not a phantom twin.
 * Pure.
 */
function eventFingerprint({ entity, family, claim, eventDate, direction } = {}) {
  const parts = [
    String(entity || 'UNKNOWN'),
    sanitizeFamily(family),
    claimSlug(claim),
    String(eventDate || 'undated').slice(0, 10),
    String(direction || 'UNKNOWN').toUpperCase(),
  ];
  return parts.join('|');
}

/** Identity used for continuity (fingerprint minus direction). Pure. */
function continuityKey({ entity, family, claim, eventDate } = {}) {
  return [String(entity || 'UNKNOWN'), sanitizeFamily(family), claimSlug(claim), String(eventDate || 'undated').slice(0, 10)].join('|');
}

/**
 * BOUNDED fallback matcher: same entity AND same family, with ≥2 shared claim tokens.
 * Never crosses families or entities — an earnings story can never absorb a product
 * story. Pure.
 */
function fuzzyMatch(ev, obs) {
  if (!ev || ev.entity !== entityOf(obs)) return false;
  if (ev.family !== sanitizeFamily(obs.eventFamily)) return false;
  const a = new Set(claimTokens(ev.claim));
  let shared = 0;
  for (const w of claimTokens(obs.claim || obs.headline)) if (a.has(w)) shared++;
  return shared >= 2;
}

/** Find the active event an observation continues, or null. Exact key first, fuzzy fallback. Pure. */
function findEvent(events, obs) {
  const key = continuityKey({
    entity: entityOf(obs), family: obs.eventFamily,
    claim: obs.claim || obs.headline, eventDate: obs.eventDate,
  });
  const exact = (events || []).find(e => e.continuityKey === key && !e.expired);
  if (exact) return exact;
  return (events || []).find(e => !e.expired && fuzzyMatch(e, obs)) || null;
}

// ── Legacy-record migration ─────────────────────────────────────────────────
/**
 * Derive the timestamp-provenance fields on an event record persisted before
 * they existed. IMMUTABLE (returns a copy); fail-closed: a legacy record's
 * model-claimed eventDate becomes `inferred` confidence (never `publisher`),
 * and its publication time stays unknown — so migration can never make an old
 * story look fresh. Pure.
 */
function migrateEventRecord(e) {
  if (!e) return e;
  const m = { ...e };
  if (m.firstSeenAt === undefined) m.firstSeenAt = m.firstSeen || null;
  if (m.lastSeenAt === undefined) m.lastSeenAt = m.lastSeen || m.firstSeen || null;
  if (m.eventOccurredAt === undefined) m.eventOccurredAt = m.eventDate || null;
  if (m.firstPublishedAt === undefined) m.firstPublishedAt = null;
  if (m.lastCorroboratedAt === undefined) {
    m.lastCorroboratedAt = (m.independentLineages || 0) >= 2 ? (m.lastSeen || null) : null;
  }
  if (m.dateConfidence === undefined) m.dateConfidence = m.eventDate ? 'inferred' : 'unknown';
  if (m.lastMaterialUpdateAt === undefined) m.lastMaterialUpdateAt = null;
  if (m.sourceCount === undefined) m.sourceCount = null;
  if (m.syndicatedLastObs === undefined) m.syndicatedLastObs = false;
  return m;
}

// ── Material-update detection ───────────────────────────────────────────────
// A material update is a new SUBSTANTIVE development: a denial/correction, a
// direction flip (handled in the fold), a newer underlying event date (new
// filing / decision / transaction step), or an explicitly flagged update.
// A repost, reworded headline, syndicated copy, or rediscovery is NOT material.
function materialUpdateReason(ev, obs, { prevEvidence } = {}) {
  if (obs.materialUpdate === true) return 'flagged-material';
  if (obs.denied === true && !ev.invalidated) return 'denial-or-correction';
  const newDate = obs.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(obs.eventDate) ? obs.eventDate : null;
  const oldDate = ev.eventOccurredAt ? String(ev.eventOccurredAt).slice(0, 10) : null;
  if (newDate && oldDate && newDate > oldDate) return 'new-development-date';
  return null;   // evidence upgrades are corroboration, not materiality
}

// ── Measured narrative lifecycle ─────────────────────────────────────────────
/**
 * Derive the narrative lifecycle from MEASURED observation history. Pure.
 * @param {object} ev  event record (observations, lineage counts, missedCycles, flags)
 */
function deriveNarrativeLifecycle(ev) {
  if (ev.invalidated) return 'INVALIDATED';
  if (ev.resolved || ev.missedCycles >= MISSED_CYCLES_RESOLVED) return 'RESOLVED';
  if (ev.missedCycles >= MISSED_CYCLES_COOLING) return 'COOLING';
  const obs = ev.observationCount || 0;
  const lineages = ev.independentLineages || 0;
  const lineageGrowth = lineages > (ev.firstSeenLineages || 0);
  if (ev.evidence === 'VERIFIED') return 'VERIFIED';
  if (obs >= 5 && !ev.newLineageLastObs) return 'SATURATED';
  if (obs >= 2 && (lineageGrowth || lineages >= 2)) return 'SPREADING';
  return 'NEW';
}

/**
 * Fold a collection cycle's observations into the event ledger. IMMUTABLE — returns
 * new {events, transitions}; never rewrites firstSeen* fields.
 *
 * An observation: { headline, tickers, claim, eventFamily, eventDate, direction,
 *                   evidence, claims, independentLineages, marketStateRef,
 *                   featuresByTicker, denied }
 *
 * ctx: { date (ET), generation, cycleId, now }
 */
function foldObservations(prevEvents, observations, { date, generation, cycleId, now = () => new Date().toISOString() } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  // Legacy persisted records gain the timestamp-provenance fields on load (fail-closed).
  const events = (prevEvents || []).map(e => migrateEventRecord(e));
  const transitions = [];
  const seenIds = new Set();
  let seq = events.length;

  const pushTransition = t => transitions.push({ at: nowISO, date, cycleId, ...t });

  for (const obs of observations || []) {
    if (!obs || !obs.headline) continue;
    const entity = entityOf(obs);
    const family = sanitizeFamily(obs.eventFamily);
    const direction = String(obs.direction || 'UNKNOWN').toUpperCase();
    let ev = findEvent(events, obs);

    if (!ev) {
      const fp = eventFingerprint({ entity, family, claim: obs.claim || obs.headline, eventDate: obs.eventDate, direction });
      ev = {
        id: 'ev_' + date.replace(/-/g, '') + '_' + (seq++).toString(36) + '_' + fp.length.toString(36),
        fingerprint: fp,
        continuityKey: continuityKey({ entity, family, claim: obs.claim || obs.headline, eventDate: obs.eventDate }),
        entity, family,
        claim: String(obs.claim || obs.headline).slice(0, 300),
        headline: String(obs.headline).slice(0, 240),
        tickers: (obs.tickers || []).slice(0, 8),
        eventDate: obs.eventDate || null,
        category: (obs.tickers || []).length ? 'ticker' : 'macro',
        // ── timestamp provenance (see pulse2-freshness) ──
        eventOccurredAt: obs.eventDate || null,
        firstPublishedAt: obs.publishedAt || null,
        firstSeenAt: nowISO,
        lastSeenAt: nowISO,
        lastCorroboratedAt: (obs.independentLineages || 0) >= 2 ? nowISO : null,
        lastMaterialUpdateAt: null,
        dateConfidence: obs.publishedAt
          ? (obs.dateConfidence || 'metadata')
          : (obs.eventDate ? 'inferred' : 'unknown'),
        sourceCount: obs.sourceCount ?? null,
        syndicatedLastObs: false,
        // ── immutable first-seen snapshot ──
        firstSeen: nowISO,
        firstSeenDate: date,
        firstSeenCycle: cycleId || null,
        firstSeenGeneration: generation || null,
        firstSeenDirection: direction,
        firstSeenEvidence: obs.evidence || 'UNVERIFIED',
        firstSeenClaims: obs.claims || [],
        firstSeenLineages: obs.independentLineages || 0,
        firstSeenMarketStateRef: obs.marketStateRef || null,
        firstSeenFeatures: obs.featuresByTicker || null,
        modelVersion: obs.modelVersion || null,
        // ── mutable tail ──
        currentDirection: direction,
        thesisVersion: 1,
        evidence: obs.evidence || 'UNVERIFIED',
        claims: obs.claims || [],
        independentLineages: obs.independentLineages || 0,
        newLineageLastObs: true,
        observationCount: 1,
        observationDates: [date],
        lastSeen: nowISO,
        lastSeenDate: date,
        missedCycles: 0,
        invalidated: false,
        resolved: false,
        expired: false,
        lifecycleHistory: [],
        transitions: [],
      };
      ev.narrativeLifecycle = deriveNarrativeLifecycle(ev);
      ev.lifecycleHistory = [{ state: ev.narrativeLifecycle, at: nowISO, date }];
      // WHY this event reads as new: a recent publication is NEW_PUBLICATION; an old
      // story first seen by this pipeline is REDISCOVERED — never presented as fresh.
      ev.freshnessReason = freshness.classifyFreshnessReason(ev, nowISO);
      events.push(ev);
      seenIds.add(ev.id);
      pushTransition({
        eventId: ev.id, kind: 'appeared', to: ev.narrativeLifecycle,
        headline: ev.headline, freshnessReason: ev.freshnessReason,
      });
      continue;
    }

    // ── continuation of an existing event ──
    seenIds.add(ev.id);
    const prevLifecycle = ev.narrativeLifecycle;
    const prevEvidence = ev.evidence;
    const prevLineages = ev.independentLineages || 0;

    ev.lastSeen = nowISO;
    ev.lastSeenAt = nowISO;
    ev.lastSeenDate = date;
    ev.missedCycles = 0;
    ev.observationCount = (ev.observationCount || 0) + 1;
    if (!ev.observationDates.includes(date)) ev.observationDates = [...ev.observationDates, date].slice(-60);
    ev.tickers = [...new Set([...(ev.tickers || []), ...(obs.tickers || [])])].slice(0, 8);
    ev.evidence = obs.evidence || ev.evidence;
    ev.claims = (obs.claims && obs.claims.length) ? obs.claims : ev.claims;
    ev.independentLineages = Math.max(prevLineages, obs.independentLineages || 0);
    ev.newLineageLastObs = ev.independentLineages > prevLineages;

    // Publication knowledge only ever moves EARLIER (first publication) or gains
    // confidence — a later syndicated copy can never make the story "newer".
    if (obs.publishedAt && (!ev.firstPublishedAt
        || freshness.toMs(obs.publishedAt) < freshness.toMs(ev.firstPublishedAt))) {
      ev.firstPublishedAt = obs.publishedAt;
    }
    const obsConf = obs.publishedAt ? (obs.dateConfidence || 'metadata') : null;
    if (obsConf && (freshness.CONFIDENCE_RANK[obsConf] || 0) > (freshness.CONFIDENCE_RANK[ev.dateConfidence] || 0)) {
      ev.dateConfidence = obsConf;
    }

    // Corroboration vs syndication: a NEW independent lineage is corroboration;
    // more copies without a new lineage is syndication (diagnostic only).
    const prevSourceCount = ev.sourceCount;
    if (obs.sourceCount != null) ev.sourceCount = Math.max(prevSourceCount || 0, obs.sourceCount);
    if (ev.newLineageLastObs) {
      ev.lastCorroboratedAt = nowISO;
      ev.syndicatedLastObs = false;
      pushTransition({
        eventId: ev.id, kind: 'corroborated',
        from: String(prevLineages), to: String(ev.independentLineages), headline: ev.headline,
      });
    } else {
      ev.syndicatedLastObs = prevSourceCount != null && obs.sourceCount != null && obs.sourceCount > prevSourceCount;
      if (ev.syndicatedLastObs) {
        pushTransition({ eventId: ev.id, kind: 'syndication', headline: ev.headline, reason: 'copies without a new independent lineage' });
      }
    }

    // Material update — the ONLY path by which an old event becomes current again.
    const matReason = materialUpdateReason(ev, obs, { prevEvidence });
    if (matReason) {
      ev.lastMaterialUpdateAt = nowISO;
      if (matReason === 'new-development-date') ev.eventOccurredAt = obs.eventDate;
      pushTransition({ eventId: ev.id, kind: 'material-update', reason: matReason, headline: ev.headline });
    }

    if (obs.denied === true && !ev.invalidated) {
      ev.invalidated = true;
      pushTransition({ eventId: ev.id, kind: 'invalidated', reason: 'denial-or-correction', headline: ev.headline });
    }

    // Direction flip = MATERIAL thesis transition (same event, new thesis version).
    if (direction !== 'UNKNOWN' && direction !== ev.currentDirection && (direction === 'BULLISH' || direction === 'BEARISH')
        && (ev.currentDirection === 'BULLISH' || ev.currentDirection === 'BEARISH')) {
      pushTransition({
        eventId: ev.id, kind: 'direction-flip',
        from: ev.currentDirection, to: direction, headline: ev.headline,
      });
      ev.currentDirection = direction;
      ev.thesisVersion = (ev.thesisVersion || 1) + 1;
      ev.lastMaterialUpdateAt = nowISO;   // a genuine flip is a material development
    } else if (direction !== 'UNKNOWN' && (ev.currentDirection === 'UNKNOWN' || ev.currentDirection === 'MIXED')) {
      ev.currentDirection = direction;
    }

    ev.freshnessReason = freshness.classifyFreshnessReason(ev, nowISO);
    ev.narrativeLifecycle = deriveNarrativeLifecycle(ev);
    if (ev.narrativeLifecycle !== prevLifecycle) {
      ev.lifecycleHistory = [...(ev.lifecycleHistory || []), { state: ev.narrativeLifecycle, at: nowISO, date }].slice(-40);
      pushTransition({ eventId: ev.id, kind: 'lifecycle', from: prevLifecycle, to: ev.narrativeLifecycle, headline: ev.headline });
    }
    if (prevEvidence !== ev.evidence) {
      pushTransition({ eventId: ev.id, kind: 'evidence', from: prevEvidence, to: ev.evidence, headline: ev.headline });
    }
  }

  // ── disappearance handling: events NOT observed this cycle age toward cooling/resolved ──
  for (const ev of events) {
    if (seenIds.has(ev.id) || ev.expired) continue;
    const prevLifecycle = ev.narrativeLifecycle;
    ev.missedCycles = (ev.missedCycles || 0) + 1;
    // Last-observation flags describe THIS cycle only — an unobserved event has
    // neither fresh corroboration nor fresh syndication.
    ev.newLineageLastObs = false;
    ev.syndicatedLastObs = false;
    ev.freshnessReason = freshness.classifyFreshnessReason(ev, nowISO);
    ev.narrativeLifecycle = deriveNarrativeLifecycle(ev);
    if (ev.narrativeLifecycle !== prevLifecycle) {
      ev.lifecycleHistory = [...(ev.lifecycleHistory || []), { state: ev.narrativeLifecycle, at: nowISO, date }].slice(-40);
      pushTransition({ eventId: ev.id, kind: 'lifecycle', from: prevLifecycle, to: ev.narrativeLifecycle, headline: ev.headline });
    }
    if (ev.missedCycles >= MISSED_CYCLES_EXPIRED) {
      ev.expired = true;
      pushTransition({ eventId: ev.id, kind: 'expired', headline: ev.headline });
    }
  }

  return { events: events.slice(-500), transitions };
}

module.exports = {
  EVENT_FAMILIES, NARRATIVE_LIFECYCLE,
  MISSED_CYCLES_COOLING, MISSED_CYCLES_RESOLVED, MISSED_CYCLES_EXPIRED,
  claimTokens, claimSlug, entityOf, sanitizeFamily,
  eventFingerprint, continuityKey, fuzzyMatch, findEvent,
  deriveNarrativeLifecycle, foldObservations,
  migrateEventRecord, materialUpdateReason,
};
