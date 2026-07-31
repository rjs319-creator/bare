'use strict';
// ⚡ GRIDLOCK — shared schemas, enums and validation (pure, no fetches).
//
// GRIDLOCK is the Physical Constraint & Marginal Beneficiary engine: it tracks
// PHYSICAL/CONTRACTUAL events (a data-center load addition, a plant retirement,
// a turbine order), models the regional constraint they touch, and maps them to
// companies with VERIFIED exposure. First domain: AI-data-center electricity
// demand in PJM. The schemas here are domain-versioned so later bottleneck
// domains (semis, transformers, gas, cooling) reuse the same envelope.
//
// Everything in this file is pure and deterministic — it is the single source
// of truth for event types, lifecycle states, exposure roles, beneficiary
// classes and value-provenance labels, and it validates records fail-closed:
// an event that does not validate is recorded as invalid, never scored.

const SCHEMA_VERSION = 'gridlock-event-v1';
const PARSER_VERSION = 'gridlock-parser-v1';
const MODULE_VERSION = 'gridlock-v1';

// ── Value provenance ─────────────────────────────────────────────────────────
// Every quantitative field in a region state or scenario is labeled with how
// it was obtained. "Hidden proxies inside a score" are a non-negotiable no.
const BASIS = Object.freeze({
  OBSERVED: 'observed',                 // read directly from a primary source
  DERIVED: 'derived',                   // arithmetic on observed values
  ASSUMED: 'assumed',                   // a disclosed modeling assumption
  ESTIMATED_PROXY: 'estimated-proxy',   // stands in for an unavailable measure
  LLM_INTERPRETATION: 'llm-interpretation', // bounded LLM classification output
});
// Labeled value helper: { value, basis, note? }. null value = honestly missing.
function labeled(value, basis, note) {
  // Non-finite numbers (NaN/Infinity) are honestly missing, never propagated.
  const v = typeof value === 'number' ? (Number.isFinite(value) ? value : null) : (value == null ? null : value);
  return note == null ? { value: v, basis } : { value: v, basis, note };
}

// ── Event taxonomy ───────────────────────────────────────────────────────────
const EVENT_TYPES = Object.freeze([
  'DATA_CENTER_LOAD', 'POWER_PURCHASE_AGREEMENT', 'ENERGY_SERVICES_AGREEMENT',
  'GENERATION_BUILD', 'GENERATION_EXPANSION', 'GENERATOR_RETIREMENT',
  'RETIREMENT_DELAY', 'GENERATOR_OUTAGE', 'TRANSMISSION_BUILD',
  'TRANSMISSION_CONSTRAINT', 'INTERCONNECTION_CHANGE', 'CAPACITY_AUCTION',
  'RESOURCE_ADEQUACY_CHANGE', 'REGULATORY_APPROVAL', 'REGULATORY_REJECTION',
  'PROJECT_MORATORIUM', 'TURBINE_ORDER', 'TRANSFORMER_ORDER',
  'ELECTRICAL_EQUIPMENT_ORDER', 'EPC_CONTRACT', 'GAS_SUPPLY_AGREEMENT',
  'PIPELINE_BUILD', 'BATTERY_STORAGE_PROJECT', 'EXTREME_WEATHER',
  'POWER_PRICE_SHOCK', 'EARNINGS_POWER_DISCLOSURE', 'PROJECT_DELAY',
  'PROJECT_CANCELLATION',
]);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

// Which physical constraint each event type primarily moves (supply/demand/…).
const CONSTRAINT_OF_EVENT = Object.freeze({
  DATA_CENTER_LOAD: 'demand', POWER_PURCHASE_AGREEMENT: 'contracted-supply',
  ENERGY_SERVICES_AGREEMENT: 'contracted-supply',
  GENERATION_BUILD: 'supply', GENERATION_EXPANSION: 'supply',
  GENERATOR_RETIREMENT: 'supply', RETIREMENT_DELAY: 'supply',
  GENERATOR_OUTAGE: 'supply', TRANSMISSION_BUILD: 'transmission',
  TRANSMISSION_CONSTRAINT: 'transmission', INTERCONNECTION_CHANGE: 'queue-friction',
  CAPACITY_AUCTION: 'market-structure', RESOURCE_ADEQUACY_CHANGE: 'market-structure',
  REGULATORY_APPROVAL: 'regulatory', REGULATORY_REJECTION: 'regulatory',
  PROJECT_MORATORIUM: 'regulatory', TURBINE_ORDER: 'equipment',
  TRANSFORMER_ORDER: 'equipment', ELECTRICAL_EQUIPMENT_ORDER: 'equipment',
  EPC_CONTRACT: 'construction-capacity', GAS_SUPPLY_AGREEMENT: 'fuel',
  PIPELINE_BUILD: 'fuel', BATTERY_STORAGE_PROJECT: 'supply',
  EXTREME_WEATHER: 'weather-demand', POWER_PRICE_SHOCK: 'price',
  EARNINGS_POWER_DISCLOSURE: 'disclosure', PROJECT_DELAY: 'timeline',
  PROJECT_CANCELLATION: 'timeline',
});

// ── Lifecycle (extends the Market Pulse attention-lifecycle vocabulary) ──────
const LIFECYCLE = Object.freeze({
  NEW: 'NEW', EMERGING: 'EMERGING', BUILDING: 'BUILDING', CROWDED: 'CROWDED',
  FADING: 'FADING', INVALIDATED: 'INVALIDATED', COMPLETED: 'COMPLETED',
  DELAYED: 'DELAYED', CANCELLED: 'CANCELLED',
});
const LIFECYCLE_STATES = Object.freeze(Object.values(LIFECYCLE));

// ── Certainty ladder for a physical project ─────────────────────────────────
const CERTAINTY = Object.freeze([
  'RUMORED',            // press only, no party confirmation
  'ANNOUNCED',          // company/official announcement, no binding commitment
  'CONTRACTED',         // signed PPA/ESA/EPC/order disclosed
  'PERMITTED',          // regulatory approval in hand
  'FINANCED',           // financing closed / FID taken
  'UNDER_CONSTRUCTION',
  'OPERATING',
  'CANCELLED',
]);
const CERTAINTY_SET = new Set(CERTAINTY);

// ── Source provenance record ─────────────────────────────────────────────────
const SOURCE_FAMILIES = Object.freeze([
  'iso-market-data',      // PJM / ERCOT / CAISO / EIA published data
  'sec-filing',           // EDGAR filings and exhibits
  'company-ir',           // investor-relations release
  'regulator',            // FERC / state PUC / NERC documents
  'weather-service',      // NWS
  'trusted-news',         // the app's existing news feeds
  'curated-config',       // hand-reviewed seed configuration (this repo)
]);
const SOURCE_QUALITY = Object.freeze({ PRIMARY: 'primary', SECONDARY: 'secondary' });

function validateSourceRecord(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return { ok: false, errors: ['source record must be an object'] };
  if (!s.sourceId) errors.push('sourceId required');
  if (!SOURCE_FAMILIES.includes(s.sourceFamily)) errors.push(`sourceFamily invalid: ${s.sourceFamily}`);
  if (!s.publisher) errors.push('publisher required');
  if (!s.sourceUrl && !s.stableRef) errors.push('sourceUrl or stableRef required');
  if (!isIsoDateTime(s.retrievedAt) && !isIsoDate(s.retrievedAt)) errors.push('retrievedAt must be ISO date/datetime');
  if (s.primaryOrSecondary !== SOURCE_QUALITY.PRIMARY && s.primaryOrSecondary !== SOURCE_QUALITY.SECONDARY) {
    errors.push('primaryOrSecondary must be primary|secondary');
  }
  return { ok: errors.length === 0, errors };
}

// ── PhysicalConstraintEvent validation ───────────────────────────────────────
// Numeric deltas are null-or-finite; null means "honestly unknown" and lands in
// unresolvedFields. Fail-closed: invalid events never reach scoring.
const NUMERIC_FIELDS = Object.freeze([
  'durationMonths', 'latitude', 'longitude', 'demandDeltaMW', 'generationDeltaMW',
  'storageDeltaMW', 'transmissionDeltaMW', 'fuelDemandDelta', 'capexAmount',
  'contractValue', 'contractDuration', 'independentSourceCount', 'extractionConfidence',
]);

function isIsoDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function isIsoDateTime(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v); }

function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') return { ok: false, errors: ['event must be an object'] };
  if (!ev.id) errors.push('id required');
  if (!ev.canonicalEventId) errors.push('canonicalEventId required');
  if (!EVENT_TYPE_SET.has(ev.eventType)) errors.push(`eventType invalid: ${ev.eventType}`);
  if (!ev.title) errors.push('title required');
  if (ev.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!isIsoDate(ev.announcedAt) && !isIsoDateTime(ev.announcedAt)) errors.push('announcedAt must be ISO date');
  if (ev.effectiveStartDate != null && !isIsoDate(ev.effectiveStartDate)) errors.push('effectiveStartDate must be ISO date or null');
  if (ev.expectedCompletionDate != null && !isIsoDate(ev.expectedCompletionDate)) errors.push('expectedCompletionDate must be ISO date or null');
  if (!LIFECYCLE_STATES.includes(ev.lifecycle)) errors.push(`lifecycle invalid: ${ev.lifecycle}`);
  if (!CERTAINTY_SET.has(ev.certainty)) errors.push(`certainty invalid: ${ev.certainty}`);
  if (!ev.isoRegion) errors.push('isoRegion required');
  for (const f of NUMERIC_FIELDS) {
    if (ev[f] != null && !(typeof ev[f] === 'number' && Number.isFinite(ev[f]))) {
      errors.push(`${f} must be finite number or null`);
    }
  }
  if (ev.extractionConfidence != null && (ev.extractionConfidence < 0 || ev.extractionConfidence > 1)) {
    errors.push('extractionConfidence must be within [0,1]');
  }
  if (!Array.isArray(ev.sourceEvidence) || ev.sourceEvidence.length === 0) {
    errors.push('sourceEvidence must be a non-empty array');
  } else {
    ev.sourceEvidence.forEach((s, i) => {
      const r = validateSourceRecord(s);
      if (!r.ok) errors.push(`sourceEvidence[${i}]: ${r.errors.join('; ')}`);
    });
  }
  if (!Array.isArray(ev.affectedTickers)) errors.push('affectedTickers must be an array');
  if (!Array.isArray(ev.unresolvedFields)) errors.push('unresolvedFields must be an array');
  if (!ev.parserVersion) errors.push('parserVersion required');
  return { ok: errors.length === 0, errors };
}

// ── Canonicalization + dedup ─────────────────────────────────────────────────
// Five articles about one campus must collapse to ONE event with five evidence
// records. Canonical identity = eventType + region + normalized project name
// (fallback: normalized title). Same key ⇒ same event ⇒ merge evidence.
function normalizeName(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(THE|A|AN|OF|AT|IN|FOR|NEW|PHASE|CAMPUS|PROJECT|FACILITY|CENTER|CENTRE|PLANT|STATION)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalEventId(ev) {
  const name = normalizeName(ev.projectName || ev.title);
  return `gridlock:${ev.eventType}:${String(ev.isoRegion || 'UNKNOWN').toUpperCase()}:${name || 'UNNAMED'}`;
}

// Merge a duplicate report into an existing canonical event (immutable).
// Evidence accumulates; independentSourceCount = distinct publishers; scalar
// fields are only filled where the canonical copy is null (first grounded value
// wins — later articles NEVER silently overwrite an earlier grounded number);
// conflicts are recorded, not resolved by overwrite.
function mergeEvent(existing, incoming) {
  const seen = new Set((existing.sourceEvidence || []).map(s => s.sourceId));
  const addedEvidence = (incoming.sourceEvidence || []).filter(s => !seen.has(s.sourceId));
  const evidence = [...(existing.sourceEvidence || []), ...addedEvidence];
  const publishers = new Set(evidence.map(s => String(s.publisher || '').toLowerCase()).filter(Boolean));

  const conflicts = [...(existing.fieldConflicts || [])];
  const merged = { ...existing };
  for (const f of NUMERIC_FIELDS) {
    if (merged[f] == null && incoming[f] != null) merged[f] = incoming[f];
    else if (merged[f] != null && incoming[f] != null && merged[f] !== incoming[f]) {
      conflicts.push({ field: f, kept: merged[f], reported: incoming[f], sourceId: (incoming.sourceEvidence || [])[0]?.sourceId || null });
    }
  }
  for (const f of ['effectiveStartDate', 'expectedCompletionDate', 'projectName', 'state', 'county', 'powerZone', 'geography']) {
    if (merged[f] == null && incoming[f] != null) merged[f] = incoming[f];
  }
  const unresolved = new Set(merged.unresolvedFields || []);
  for (const f of [...NUMERIC_FIELDS, 'effectiveStartDate', 'expectedCompletionDate']) {
    if (merged[f] == null) unresolved.add(f); else unresolved.delete(f);
  }
  return {
    ...merged,
    sourceEvidence: evidence,
    independentSourceCount: publishers.size,
    fieldConflicts: conflicts,
    unresolvedFields: [...unresolved],
    updatedAt: incoming.updatedAt || incoming.createdAt || merged.updatedAt,
  };
}

// ── Exposure roles ───────────────────────────────────────────────────────────
const EXPOSURE_ROLES = Object.freeze([
  'MERCHANT_GENERATOR', 'REGULATED_UTILITY', 'INDEPENDENT_POWER_PRODUCER',
  'NATURAL_GAS_PRODUCER', 'MIDSTREAM_OR_PIPELINE', 'TURBINE_MANUFACTURER',
  'TRANSFORMER_MANUFACTURER', 'ELECTRICAL_EQUIPMENT',
  'ENGINEERING_PROCUREMENT_CONSTRUCTION', 'TRANSMISSION_DEVELOPER',
  'BATTERY_OR_STORAGE', 'COOLING_OR_THERMAL_MANAGEMENT', 'BACKUP_POWER',
  'DATA_CENTER_OPERATOR', 'DATA_CENTER_REIT', 'HYPERSCALER',
  'POWER_INTENSIVE_CONSUMER', 'LAND_OR_SITE_OWNER', 'FUEL_SUPPLIER',
  'OTHER_VERIFIED_EXPOSURE',
]);
const EXPOSURE_ROLE_SET = new Set(EXPOSURE_ROLES);

// ── Beneficiary classification ───────────────────────────────────────────────
const CLASSIFICATIONS = Object.freeze([
  'DIRECT_BENEFICIARY', 'SECOND_ORDER_BENEFICIARY',
  'EQUIPMENT_OR_CAPACITY_BENEFICIARY', 'RELATIVE_VALUE_BENEFICIARY',
  'COST_HEADWIND', 'MIXED_EFFECT', 'TOO_INDIRECT', 'INSUFFICIENT_EVIDENCE',
]);

// ── Shadow flags (matches govdemand's contract with the rest of the app) ────
const SHADOW_FLAGS = Object.freeze({
  shadow: true, affectsLiveRank: false, deploymentWeight: 0,
  governanceStatus: 'paper', probability: null, portfolioEligible: false,
});

module.exports = {
  SCHEMA_VERSION, PARSER_VERSION, MODULE_VERSION,
  BASIS, labeled,
  EVENT_TYPES, EVENT_TYPE_SET, CONSTRAINT_OF_EVENT,
  LIFECYCLE, LIFECYCLE_STATES, CERTAINTY, CERTAINTY_SET,
  SOURCE_FAMILIES, SOURCE_QUALITY, validateSourceRecord,
  NUMERIC_FIELDS, isIsoDate, isIsoDateTime, validateEvent,
  normalizeName, canonicalEventId, mergeEvent,
  EXPOSURE_ROLES, EXPOSURE_ROLE_SET, CLASSIFICATIONS, SHADOW_FLAGS,
};
