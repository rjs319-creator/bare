'use strict';
// ⚡ GRIDLOCK — causal beneficiary engine (pure, deterministic).
//
// For each (event, exposure-relationship) pair, produce a structured causal
// chain and a classification. The rules are a ROLE × CONSTRAINT matrix plus
// hard gates — deliberately NOT an LLM: the whole point is that "AI demand is
// up, buy all utilities" cannot fall out of this code. Most pairs classify as
// TOO_INDIRECT or INSUFFICIENT_EVIDENCE; that is the intended behavior.
//
// Gates applied IN ORDER (first failure wins, recorded as the reason):
//   1. Region match — an event in PJM cannot classify a pure-ERCOT exposure.
//   2. Evidence — inferred relationships can never classify better than
//      SECOND_ORDER, and low confidence → INSUFFICIENT_EVIDENCE.
//   3. Materiality — a 'low'-materiality exposure that is not a named party
//      is TOO_INDIRECT (a company being mentioned ≠ a stock opportunity).
//   4. Certainty — RUMORED events cap at INSUFFICIENT_EVIDENCE; far-future
//      start dates carry a major uncertainty penalty (returned, not hidden).

const { CLASSIFICATIONS, CONSTRAINT_OF_EVENT, LIFECYCLE } = require('./gridlock-schema');

const CAUSAL_VERSION = 'gridlock-causal-v1';

// horizonDays = when the economic effect could plausibly reach the equity.
// 5–10 trading-day relevance requires horizonDays ≤ SWING_RELEVANT_DAYS.
const SWING_RELEVANT_DAYS = 21;

// ROLE × constraint-category rules. cls = base classification BEFORE gates.
// direction: expected equity direction for the exposed company (+1/-1/0).
const RULES = Object.freeze({
  demand: {  // e.g. DATA_CENTER_LOAD — regional demand increases
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'incremental regional demand tightens the supply stack; uncontracted merchant output captures higher realized power prices' },
    INDEPENDENT_POWER_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'regional demand growth raises energy + capacity value of the in-region fleet' },
    REGULATED_UTILITY: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 90, mech: 'load growth raises rate base over years, but capital requirements and regulatory lag arrive first; near-term equity effect ambiguous' },
    NATURAL_GAS_PRODUCER: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'higher electric demand raises gas burn ONLY via gas-fired generation; effect conditional on the marginal unit being gas' },
    MIDSTREAM_OR_PIPELINE: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'sustained gas-fired demand growth supports pipeline volumes/expansions; contract-paced, slow to reprice' },
    TURBINE_MANUFACTURER: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'demand growth pulls forward generation build-out and turbine orders; multi-quarter backlog effect' },
    TRANSFORMER_MANUFACTURER: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'interconnection and grid build-out tighten transformer lead times' },
    ELECTRICAL_EQUIPMENT: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'data-center electrical distribution demand (switchgear/UPS)' },
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'construction backlog grows with grid + campus build-out' },
    COOLING_OR_THERMAL_MANAGEMENT: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'data-center thermal management is a direct content-per-MW beneficiary' },
    BACKUP_POWER: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'each campus carries backup-generation content' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 21, mech: 'tightening regional supply raises input power costs for energy-intensive operations' },
    DATA_CENTER_REIT: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 21, mech: 'demand validates the asset class but power scarcity raises build costs and slows delivery' },
    DATA_CENTER_OPERATOR: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 21, mech: 'same demand tailwind vs power-procurement headwind' },
    HYPERSCALER: { cls: 'TOO_INDIRECT', direction: 0, horizonDays: 21, mech: 'a single power arrangement is immaterial to hyperscaler economics' },
    LAND_OR_SITE_OWNER: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'powered land near the constraint appreciates' },
    FUEL_SUPPLIER: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'fuel demand follows generation mix' },
  },
  'contracted-supply': {  // PPA / ESA — a specific generator locks long-dated revenue
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'long-dated contracted premium over merchant curves de-risks cash flows and marks up the whole fleet\'s optionality', namedOnly: true },
    INDEPENDENT_POWER_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'contracted premium re-rates comparable uncontracted capacity', namedOnly: true },
    REGULATED_UTILITY: { cls: 'TOO_INDIRECT', direction: 0, horizonDays: 90, mech: 'regulated returns are largely insulated from bilateral merchant contracting' },
    NATURAL_GAS_PRODUCER: { cls: 'TOO_INDIRECT', direction: 0, horizonDays: 63, mech: 'a nuclear/renewable PPA does not move gas demand' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 63, mech: 'capacity committed to a hyperscaler is capacity unavailable to other large loads' },
    HYPERSCALER: { cls: 'TOO_INDIRECT', direction: 0, horizonDays: 21, mech: 'immaterial to buyer economics' },
  },
  supply: {  // GENERATION_BUILD / EXPANSION / RETIREMENT / OUTAGE / BATTERY
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'supply removal (retirement/outage) tightens the stack and raises realized prices for the surviving fleet', onSupplyDown: true },
    INDEPENDENT_POWER_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'scarcity accrues to surviving in-region capacity', onSupplyDown: true },
    TURBINE_MANUFACTURER: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'new build requires turbines; named supplier books backlog', onSupplyUp: true },
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'construction contract flow', onSupplyUp: true },
    ELECTRICAL_EQUIPMENT: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'balance-of-plant electrical content', onSupplyUp: true },
    NATURAL_GAS_PRODUCER: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'gas-fired additions raise future basin demand', onSupplyUp: true },
    MIDSTREAM_OR_PIPELINE: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'new gas-fired plants need firm transport', onSupplyUp: true },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 21, mech: 'supply removal raises power input costs', onSupplyDown: true },
    REGULATED_UTILITY: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 90, mech: 'reliability obligations and replacement capex dominate' },
  },
  equipment: {  // TURBINE_ORDER / TRANSFORMER_ORDER / ELECTRICAL_EQUIPMENT_ORDER
    TURBINE_MANUFACTURER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'disclosed order adds backlog at the named manufacturer', namedOnly: true, sameRoleSecondOrder: true },
    TRANSFORMER_MANUFACTURER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'disclosed order adds backlog at the named manufacturer', namedOnly: true, sameRoleSecondOrder: true },
    ELECTRICAL_EQUIPMENT: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'disclosed order adds backlog at the named supplier', namedOnly: true, sameRoleSecondOrder: true },
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'equipment orders precede construction awards' },
  },
  'construction-capacity': {  // EPC_CONTRACT
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'named EPC award adds backlog', namedOnly: true, sameRoleSecondOrder: true },
  },
  transmission: {  // TRANSMISSION_BUILD / TRANSMISSION_CONSTRAINT
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'transmission build-out is core T&D construction demand' },
    TRANSMISSION_DEVELOPER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'named developer earns regulated/contracted transmission returns', namedOnly: true, sameRoleSecondOrder: true },
    ELECTRICAL_EQUIPMENT: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'lines need transformers/switchgear' },
    TRANSFORMER_MANUFACTURER: { cls: 'EQUIPMENT_OR_CAPACITY_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'transmission projects consume transformer capacity' },
    MERCHANT_GENERATOR: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 63, mech: 'congestion relief can DILUTE locational scarcity premia for constrained-zone generators' },
  },
  'market-structure': {  // CAPACITY_AUCTION / RESOURCE_ADEQUACY_CHANGE
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'higher capacity clearing prices flow directly to in-region capacity owners' },
    INDEPENDENT_POWER_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'capacity revenue re-rate for the in-region fleet' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 21, mech: 'capacity costs pass through to large-load bills' },
    REGULATED_UTILITY: { cls: 'TOO_INDIRECT', direction: 0, horizonDays: 90, mech: 'wires utilities pass capacity costs through' },
  },
  price: {  // POWER_PRICE_SHOCK
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 5, mech: 'spot price spike accrues to uncontracted generation immediately' },
    INDEPENDENT_POWER_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 5, mech: 'spot exposure captures the spike' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 10, mech: 'unhedged power input costs jump' },
    NATURAL_GAS_PRODUCER: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'power price spikes usually co-move with gas burn' },
  },
  'weather-demand': {  // EXTREME_WEATHER
    MERCHANT_GENERATOR: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 5, mech: 'weather-driven demand spike raises realized prices; transient' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 5, mech: 'transient cost spike' },
  },
  regulatory: {  // REGULATORY_APPROVAL / REJECTION / MORATORIUM
    MERCHANT_GENERATOR: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 63, mech: 'depends on whether the ruling adds or removes competing supply/load' },
    REGULATED_UTILITY: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 63, mech: 'approvals de-risk capex recovery; rejections strand it' },
    DATA_CENTER_REIT: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 63, mech: 'moratoria constrain new supply of competing capacity but also growth' },
  },
  fuel: {  // GAS_SUPPLY_AGREEMENT / PIPELINE_BUILD
    NATURAL_GAS_PRODUCER: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'firm supply agreements monetize basin gas', namedOnly: true, sameRoleSecondOrder: true },
    MIDSTREAM_OR_PIPELINE: { cls: 'DIRECT_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'named pipeline earns contracted transport revenue', namedOnly: true, sameRoleSecondOrder: true },
  },
  timeline: {  // PROJECT_DELAY / PROJECT_CANCELLATION — effects INVERT for suppliers
    TURBINE_MANUFACTURER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 21, mech: 'cancelled/delayed project removes expected backlog for the named supplier', namedOnly: true },
    ENGINEERING_PROCUREMENT_CONSTRUCTION: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 21, mech: 'award slips or disappears', namedOnly: true },
    MERCHANT_GENERATOR: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 21, mech: 'a cancelled SUPPLY project preserves scarcity for the incumbent fleet' },
    POWER_INTENSIVE_CONSUMER: { cls: 'COST_HEADWIND', direction: -1, horizonDays: 63, mech: 'supply relief delayed = costs stay high longer' },
  },
  disclosure: {  // EARNINGS_POWER_DISCLOSURE — informational
    MERCHANT_GENERATOR: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 10, mech: 'disclosed demand contracts corroborate the regional-scarcity thesis' },
  },
  'queue-friction': {  // INTERCONNECTION_CHANGE
    MERCHANT_GENERATOR: { cls: 'SECOND_ORDER_BENEFICIARY', direction: +1, horizonDays: 63, mech: 'slower queues protect incumbent scarcity' },
    TRANSMISSION_DEVELOPER: { cls: 'MIXED_EFFECT', direction: 0, horizonDays: 63, mech: 'reform can accelerate or reshuffle projects' },
  },
});

// Does this event REMOVE supply (retirement, outage, cancellation of build)?
function isSupplyDown(event) {
  return ['GENERATOR_RETIREMENT', 'GENERATOR_OUTAGE'].includes(event.eventType) ||
    (event.eventType === 'PROJECT_CANCELLATION' && (event.generationDeltaMW || 0) > 0);
}
function isSupplyUp(event) {
  return ['GENERATION_BUILD', 'GENERATION_EXPANSION', 'RETIREMENT_DELAY', 'BATTERY_STORAGE_PROJECT'].includes(event.eventType);
}
function isNamedParty(event, relationship) {
  if ((event.affectedTickers || []).includes(relationship.ticker)) return true;
  const names = [...(event.companies || []), ...(event.counterparties || [])].map(c => String(c).toUpperCase());
  const comp = String(relationship.company || '').toUpperCase();
  return names.some(n => comp && (n.includes(comp) || comp.includes(n)));
}

function daysUntil(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const d = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 864e5);
  return Number.isFinite(d) ? d : null;
}

// ── Main classification ─────────────────────────────────────────────────────
function classifyExposure({ event, relationship, constraintScore = null, asOf }) {
  const out = (classification, extra = {}) => ({
    version: CAUSAL_VERSION,
    ticker: relationship.ticker, company: relationship.company,
    exposureRole: relationship.exposureRole, verifiedOrInferred: relationship.verifiedOrInferred,
    eventId: event.canonicalEventId || event.id, eventType: event.eventType,
    isoRegion: event.isoRegion,
    classification, direction: extra.direction != null ? extra.direction : 0,
    horizonDays: extra.horizonDays || null,
    swingRelevant: extra.horizonDays != null ? extra.horizonDays <= SWING_RELEVANT_DAYS : false,
    named: extra.named || false,
    causalChain: extra.causalChain || null,
    uncertaintyPenalties: extra.uncertaintyPenalties || [],
    reason: extra.reason || null,
  });

  // Gate 1 — region.
  if (relationship.isoRegion !== 'MULTI' && relationship.isoRegion !== event.isoRegion) {
    return out('TOO_INDIRECT', { reason: `exposure region ${relationship.isoRegion} ≠ event region ${event.isoRegion}` });
  }
  // Gate 2 — evidence.
  if ((relationship.confidence || 0) < 0.5) {
    return out('INSUFFICIENT_EVIDENCE', { reason: 'relationship confidence < 0.5' });
  }
  const named = isNamedParty(event, relationship);
  const constraint = CONSTRAINT_OF_EVENT[event.eventType] || null;
  const rules = constraint ? RULES[constraint] : null;
  const rule = rules ? rules[relationship.exposureRole] : null;
  if (!rule) return out('TOO_INDIRECT', { named, reason: `no causal mechanism connects role ${relationship.exposureRole} to constraint '${constraint}'` });

  // Directionality conditions (supply-up vs supply-down rules).
  if (rule.onSupplyDown && !isSupplyDown(event)) return out('TOO_INDIRECT', { named, reason: 'mechanism requires supply removal; event adds supply' });
  if (rule.onSupplyUp && !isSupplyUp(event)) return out('TOO_INDIRECT', { named, reason: 'mechanism requires supply addition; event removes supply' });

  // namedOnly rules: unnamed same-role companies demote to SECOND_ORDER (capacity
  // cycle read-through) when the rule allows, else TOO_INDIRECT.
  let cls = rule.cls, mech = rule.mech;
  if (rule.namedOnly && !named) {
    if (rule.sameRoleSecondOrder) { cls = 'SECOND_ORDER_BENEFICIARY'; mech = `${mech} — this company is NOT the named party; read-through is the same-role capacity cycle only`; }
    else return out('TOO_INDIRECT', { named, reason: 'mechanism applies only to the named counterparty' });
  }

  // Gate 3 — materiality (mentioned ≠ material).
  if (relationship.estimatedMateriality === 'low' && !named) {
    return out('TOO_INDIRECT', { named, reason: 'exposure immaterial to company economics' });
  }
  if (relationship.estimatedMateriality === 'low' && named) {
    cls = 'TOO_INDIRECT'; // e.g. hyperscaler counterparties: named, still immaterial
    return out(cls, { named, reason: 'named party but exposure immaterial to company economics' });
  }

  // Gate 4 — certainty / timeline uncertainty penalties (returned explicitly).
  const uncertaintyPenalties = [];
  if (event.certainty === 'RUMORED') return out('INSUFFICIENT_EVIDENCE', { named, reason: 'event is rumored — no party confirmation' });
  if (event.certainty === 'ANNOUNCED') uncertaintyPenalties.push({ kind: 'no-binding-commitment', note: 'announced but not contracted/permitted/financed', points: 20 });
  const startInDays = daysUntil(asOf || event.announcedAt, event.effectiveStartDate);
  if (startInDays != null && startInDays > 365) uncertaintyPenalties.push({ kind: 'far-future-start', note: `project starts in ~${Math.round(startInDays / 30)} months`, points: 15 });
  if ((event.independentSourceCount || 1) < 2) uncertaintyPenalties.push({ kind: 'single-source', note: 'one independent publisher', points: 10 });
  if ((event.fieldConflicts || []).length) uncertaintyPenalties.push({ kind: 'contradictory-evidence', note: `${event.fieldConflicts.length} field conflict(s) across sources`, points: 15 });
  if (event.lifecycle === LIFECYCLE.CROWDED) uncertaintyPenalties.push({ kind: 'crowded', note: 'attention already saturated', points: 10 });
  if (relationship.verifiedOrInferred === 'inferred') uncertaintyPenalties.push({ kind: 'inferred-exposure', note: 'relationship not verified from filings/IR', points: 20 });

  const magnitude = event.demandDeltaMW || event.generationDeltaMW || event.transmissionDeltaMW || event.storageDeltaMW || null;
  const causalChain = {
    event: event.title,
    physicalChange: `${constraint} ${rule.direction >= 0 ? 'tightens/grows' : 'loosens'}${magnitude ? ` (~${magnitude} MW)` : ' (magnitude not grounded)'}`,
    affectedConstraint: constraint,
    economicConsequence: mech,
    companyRole: relationship.exposureRole,
    companyExposure: relationship.evidence,
    expectedEquityDirection: rule.direction > 0 ? 'up' : rule.direction < 0 ? 'down' : 'ambiguous',
    expectedHorizonDays: rule.horizonDays,
    confirmingEvidence: [
      'regional constraint-pressure components move in the implied direction',
      named ? 'company confirms the arrangement in filings/IR' : 'company reports segment results consistent with the mechanism',
      'relative strength vs sector inflects positively with volume confirmation',
    ],
    invalidatingEvidence: [
      'project cancelled, delayed past the impact window, or de-scoped',
      'regional constraint eases (new supply, load growth stalls)',
      'company reprices on an unrelated catalyst (thesis fails even if return succeeds)',
      relationship.verifiedOrInferred === 'inferred' ? 'the inferred relationship is contradicted by filings' : 'the disclosed contract is modified or terminated',
    ],
  };

  return out(cls, {
    direction: rule.direction, horizonDays: rule.horizonDays, named,
    causalChain, uncertaintyPenalties,
  });
}

// Classify one event against the whole exposure graph. Returns ALL pairs (the
// TOO_INDIRECT majority included — prospective tracking records rejections).
function classifyEvent({ event, relationships, constraintScore = null, asOf }) {
  return (relationships || []).map(rel =>
    classifyExposure({ event, relationship: rel, constraintScore, asOf }));
}

module.exports = {
  CAUSAL_VERSION, SWING_RELEVANT_DAYS, RULES, CLASSIFICATIONS,
  isSupplyDown, isSupplyUp, isNamedParty, classifyExposure, classifyEvent,
};
