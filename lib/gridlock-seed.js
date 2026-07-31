'use strict';
// ⚡ GRIDLOCK — curated seed events (STATIC, hand-reviewed, cited).
//
// Purpose: bootstrap the PJM vertical slice with a small set of REAL, widely
// documented physical events so the pipeline (dedup → exposure → causal →
// score → prospective tracking) is demonstrable end-to-end before live news
// ingestion accrues. Rules:
//   • Only events with public, durable, checkable citations (company IR, ISO
//     publications). sourceFamily 'curated-config' marks them reviewable-by-PR.
//   • Dates are the documented announcement dates; where only month-level
//     precision is certain, datePrecision says so — a date is never invented.
//   • These are OLD catalysts by construction: catalyst-freshness scoring will
//     (correctly) never mark them actionable. They exist to seed the region
//     pipeline model and the exposure demonstrations, not to generate picks.

const S = require('./gridlock-schema');

const SEED_VERSION = 'gridlock-seed-v1';
const RETRIEVED = '2026-07-31';

function src(id, publisher, ref, publishedAt) {
  return {
    sourceId: `seed:${id}`, sourceFamily: 'curated-config', publisher,
    sourceUrl: null, stableRef: ref, publishedAt, effectiveAt: publishedAt,
    retrievedAt: RETRIEVED, primaryOrSecondary: S.SOURCE_QUALITY.PRIMARY,
    sourceQuality: 'curated-verified', freshnessStatus: 'historical',
    parserVersion: SEED_VERSION, rawContentHash: null, extractionConfidence: 1,
  };
}

function seedEvent(partial) {
  const ev = {
    schemaVersion: S.SCHEMA_VERSION,
    lifecycle: S.LIFECYCLE.BUILDING,
    geography: null, state: null, county: null, latitude: null, longitude: null,
    powerZone: null, companies: [], counterparties: [], affectedTickers: [],
    demandDeltaMW: null, generationDeltaMW: null, storageDeltaMW: null,
    transmissionDeltaMW: null, fuelDemandDelta: null, capexAmount: null,
    contractValue: null, contractDuration: null, durationMonths: null,
    effectiveStartDate: null, expectedCompletionDate: null, expectedImpactWindow: null,
    independentSourceCount: 1, extractionConfidence: 1, evidenceQuality: 'curated-verified',
    fieldConflicts: [], parserVersion: SEED_VERSION,
    createdAt: RETRIEVED, updatedAt: RETRIEVED, datePrecision: 'day',
    ...partial,
  };
  ev.canonicalEventId = S.canonicalEventId(ev);
  ev.unresolvedFields = S.NUMERIC_FIELDS.filter(f => ev[f] == null);
  return Object.freeze(ev);
}

const SEED_EVENTS = Object.freeze([
  seedEvent({
    id: 'gridlock:seed:crane-ppa',
    eventType: 'POWER_PURCHASE_AGREEMENT',
    title: 'Constellation–Microsoft 20-year PPA to restart Crane Clean Energy Center (835 MW)',
    description: 'Constellation announced a 20-year power purchase agreement with Microsoft supporting the restart of Three Mile Island Unit 1 (renamed Crane Clean Energy Center), ~835 MW of carbon-free baseload returning to PJM.',
    announcedAt: '2024-09-20',
    certainty: 'CONTRACTED',
    isoRegion: 'PJM', state: 'PENNSYLVANIA', geography: 'Pennsylvania',
    projectName: 'Crane Clean Energy Center',
    companies: ['Constellation Energy', 'Microsoft'],
    counterparties: ['Microsoft'],
    affectedTickers: ['CEG', 'MSFT'],
    generationDeltaMW: 835, contractDuration: 240, durationMonths: 240,
    sourceEvidence: [src('crane-ppa', 'Constellation Energy IR', 'Constellation press release 2024-09-20: launch of Crane Clean Energy Center / Microsoft PPA', '2024-09-20')],
  }),
  seedEvent({
    id: 'gridlock:seed:talen-aws',
    eventType: 'DATA_CENTER_LOAD',
    title: 'AWS acquires Talen\'s Cumulus data-center campus adjacent to Susquehanna nuclear plant',
    description: 'Talen Energy announced the sale of its Cumulus data-center campus (adjacent to the Susquehanna nuclear plant, PA) to Amazon Web Services with associated power arrangements; interconnection filings contemplate campus load ramping toward ~960 MW.',
    announcedAt: '2024-03-04',
    certainty: 'CONTRACTED',
    isoRegion: 'PJM', state: 'PENNSYLVANIA', geography: 'Pennsylvania',
    projectName: 'Susquehanna Cumulus campus',
    companies: ['Talen Energy', 'Amazon Web Services'],
    counterparties: ['Amazon Web Services'],
    affectedTickers: ['TLN', 'AMZN'],
    demandDeltaMW: 960,
    sourceEvidence: [src('talen-aws', 'Talen Energy IR', 'Talen press release 2024-03-04: Cumulus data-center campus sale to AWS; ISA filings at FERC (campus capacity up to ~960 MW)', '2024-03-04')],
  }),
  seedEvent({
    id: 'gridlock:seed:pjm-bra-2526',
    eventType: 'CAPACITY_AUCTION',
    title: 'PJM 2025/26 Base Residual Auction clears at record $269.92/MW-day (RTO)',
    description: 'PJM published 2025/26 capacity auction results with the RTO-wide clearing price at $269.92/MW-day, roughly 9–10× the prior auction — a direct market signal of tightening resource adequacy.',
    announcedAt: '2024-07-30',
    certainty: 'OPERATING',
    lifecycle: S.LIFECYCLE.COMPLETED,
    isoRegion: 'PJM',
    projectName: 'PJM BRA 2025/26',
    companies: ['PJM Interconnection'],
    sourceEvidence: [src('pjm-bra-2526', 'PJM Interconnection', 'PJM 2025/2026 Base Residual Auction results publication, 2024-07-30', '2024-07-30')],
  }),
  seedEvent({
    id: 'gridlock:seed:homer-city',
    eventType: 'GENERATION_BUILD',
    title: 'Homer City redevelopment: up to ~4.5 GW gas-fired campus powering AI data centers (PA)',
    description: 'Homer City Redevelopment announced plans to redevelop the retired Homer City coal site (PA) into a gas-fired generation campus (up to ~4.5 GW, GE Vernova turbines) serving co-located AI data centers. Early-stage: permitting/financing/turbine-delivery timelines are the dominant uncertainties.',
    announcedAt: '2025-04-02', datePrecision: 'day',
    certainty: 'ANNOUNCED',
    lifecycle: S.LIFECYCLE.EMERGING,
    isoRegion: 'PJM', state: 'PENNSYLVANIA', geography: 'Pennsylvania',
    projectName: 'Homer City Energy Campus',
    companies: ['Homer City Redevelopment', 'GE Vernova'],
    affectedTickers: ['GEV', 'EQT'],
    generationDeltaMW: 4500,
    sourceEvidence: [src('homer-city', 'Homer City Redevelopment / press', 'Homer City Redevelopment announcement (April 2025): ~4.5 GW gas campus, GE Vernova turbine supply', '2025-04-02')],
  }),
]);

// Validate at load time in tests (never silently ship an invalid seed).
function validateSeeds() {
  const errors = [];
  for (const ev of SEED_EVENTS) {
    const r = S.validateEvent(ev);
    if (!r.ok) errors.push(`${ev.id}: ${r.errors.join('; ')}`);
  }
  return { ok: errors.length === 0, errors, count: SEED_EVENTS.length };
}

module.exports = { SEED_VERSION, SEED_EVENTS, validateSeeds };
