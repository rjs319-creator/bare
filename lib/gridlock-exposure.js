'use strict';
// ⚡ GRIDLOCK — verified corporate exposure graph (STATIC seed, no LLM).
//
// Mirrors the govdemand-map discipline: mapping a physical asset/region to a
// tradeable ticker is the most error-prone step of the whole engine, so the
// seed graph is DELIBERATELY curated by hand. Every relationship names its
// evidence — a public, durable corporate fact (a 10-K segment, a completed
// acquisition, a signed disclosed PPA) — and carries verifiedOrInferred so the
// UI can show inferred links separately. Nothing here is a recommendation and
// this is NOT a thematic basket: each row is a specific role in a specific
// region with its own materiality note, and the causal engine decides per
// EVENT whether a role is even relevant (most of the time it is not).
//
// LLM output can never add rows here. New relationships come from SEC filings,
// official project announcements, verified IR material, or this reviewable
// config — extended by hand in a PR where the evidence can be checked.

const { EXPOSURE_ROLE_SET } = require('./gridlock-schema');

const GRAPH_VERSION = 'gridlock-exposure-v1';

// rel(ticker, company, role, iso, strength, materiality, evidence, opts)
//   strength: 0–1 how concentrated the company's economics are in this role+region
//   materiality: 'high' | 'medium' | 'low' — how much this exposure could move
//     the COMPANY (not the theme), justified in the note
function rel(ticker, company, exposureRole, isoRegion, estimatedExposureStrength, estimatedMateriality, evidence, opts = {}) {
  return Object.freeze({
    companyId: ticker, ticker, company, exposureRole, isoRegion,
    relationshipType: opts.relationshipType || 'operates-in',
    projectOrAsset: opts.projectOrAsset || null,
    geography: opts.geography || null,
    sector: opts.sector || null,          // GICS sector → Read-Through benchFor() resolves the ETF
    estimatedExposureStrength, estimatedMateriality,
    contractDuration: opts.contractDuration || null,
    evidence, sourceType: opts.sourceType || 'public-filing',
    independentSourceCount: opts.independentSourceCount || 1,
    confidence: opts.confidence != null ? opts.confidence : 0.9,
    validFrom: opts.validFrom || null, validTo: opts.validTo || null,
    lastVerifiedAt: opts.lastVerifiedAt || '2026-07-31',
    parserVersion: GRAPH_VERSION,
    verifiedOrInferred: opts.verifiedOrInferred || 'verified',
  });
}

const RELATIONSHIPS = Object.freeze([
  // ── PJM merchant / nuclear generation (scarcity beneficiaries when constrained)
  rel('TLN', 'Talen Energy', 'MERCHANT_GENERATOR', 'PJM', 0.9, 'high',
    'Susquehanna nuclear plant (PA, PJM); sold adjacent Cumulus data-center campus to AWS with power arrangements (announced 2024-03-04); expanded nuclear PPA with AWS disclosed 2025 (up to ~1.9 GW). Company IR + SEC filings.',
    { sector: 'Utilities', projectOrAsset: 'Susquehanna / AWS campus', geography: 'Pennsylvania', relationshipType: 'contracted-supplier', validFrom: '2024-03-04' }),
  rel('CEG', 'Constellation Energy', 'MERCHANT_GENERATOR', 'PJM', 0.7, 'high',
    'Largest US nuclear fleet incl. PJM units; 20-year PPA with Microsoft to restart Crane Clean Energy Center (835 MW, announced 2024-09-20). Company IR + SEC filings.',
    { sector: 'Utilities', projectOrAsset: 'Crane Clean Energy Center', geography: 'Pennsylvania', relationshipType: 'contracted-supplier', contractDuration: 240, validFrom: '2024-09-20' }),
  rel('VST', 'Vistra', 'INDEPENDENT_POWER_PRODUCER', 'PJM', 0.4, 'medium',
    'PJM nuclear/gas fleet via Energy Harbor acquisition (closed 2024-03-01: Beaver Valley, Davis-Besse, Perry). Vistra 10-K; majority of fleet is ERCOT so PJM strength is partial.',
    { sector: 'Utilities', geography: 'Ohio/Pennsylvania', validFrom: '2024-03-01' }),
  rel('NRG', 'NRG Energy', 'INDEPENDENT_POWER_PRODUCER', 'PJM', 0.3, 'medium',
    'Competitive generation and retail across PJM East + ERCOT (10-K segments). Diversified; PJM is a minority of gross margin.',
    { sector: 'Utilities', geography: 'Mid-Atlantic' }),
  rel('PEG', 'PSEG', 'REGULATED_UTILITY', 'PJM', 0.8, 'medium',
    'NJ regulated T&D plus Salem/Hope Creek nuclear (PJM). Nuclear output eligible for large-load contracting per company disclosures; regulated core limits upside. 10-K.',
    { sector: 'Utilities', projectOrAsset: 'Salem / Hope Creek', geography: 'New Jersey' }),
  // ── PJM regulated wires (rate-base growth, regulatory-lag caveat)
  rel('D', 'Dominion Energy', 'REGULATED_UTILITY', 'PJM', 0.8, 'medium',
    'Virginia utility serving Northern Virginia "Data Center Alley" (PJM DOM zone); contracted data-center load disclosed in Dominion IRP/earnings materials. Regulated: demand growth arrives as capex + regulatory lag, not merchant margin.',
    { sector: 'Utilities', geography: 'Virginia' }),
  rel('EXC', 'Exelon', 'REGULATED_UTILITY', 'PJM', 0.9, 'medium',
    'T&D-only utilities in PJM (ComEd, PECO, BGE, Pepco, ACE, DPL) per 10-K. Pure wires: benefits via rate base, not power prices.',
    { sector: 'Utilities', geography: 'IL/PA/MD/DC/NJ/DE' }),
  rel('AEP', 'American Electric Power', 'REGULATED_UTILITY', 'PJM', 0.5, 'medium',
    'PJM utilities incl. AEP Ohio + Appalachian Power; large disclosed data-center interconnection queue in Ohio (company filings/testimony). Multi-RTO footprint dilutes PJM share.',
    { sector: 'Utilities', geography: 'Ohio/West Virginia/Virginia' }),
  rel('FE', 'FirstEnergy', 'REGULATED_UTILITY', 'PJM', 0.8, 'low',
    'PJM T&D utilities (Ohio Edison, Penelec, JCP&L et al.) per 10-K. Wires-only; slower to monetize load growth.',
    { sector: 'Utilities', geography: 'Ohio/Pennsylvania/New Jersey' }),
  rel('PPL', 'PPL Corporation', 'REGULATED_UTILITY', 'PJM', 0.5, 'low',
    'PPL Electric Utilities (PA, PJM) per 10-K; Kentucky operations are outside PJM.',
    { sector: 'Utilities', geography: 'Pennsylvania' }),
  // ── Fuel chain (gas generation build-out passes through these)
  rel('EQT', 'EQT Corporation', 'NATURAL_GAS_PRODUCER', 'PJM', 0.8, 'medium',
    'Largest US natural-gas producer, Appalachian basin — the marginal fuel source for PJM gas generation (10-K). Benefit requires gas-fired demand growth, not just electricity demand.',
    { sector: 'Energy', geography: 'Appalachia' }),
  rel('WMB', 'Williams Companies', 'MIDSTREAM_OR_PIPELINE', 'PJM', 0.5, 'medium',
    'Transco system serves Mid-Atlantic/PJM demand centers (10-K). Regulated-return pipeline: volume growth helps, but repricing is contract-paced.',
    { sector: 'Energy', projectOrAsset: 'Transco', geography: 'Mid-Atlantic' }),
  // ── Equipment / construction (capacity-cycle beneficiaries)
  rel('GEV', 'GE Vernova', 'TURBINE_MANUFACTURER', 'MULTI', 0.7, 'high',
    'Gas Power (HA-class turbines) + Electrification (grid equipment) segments per 10-K; publicly disclosed turbine reservations for US data-center-driven gas builds.',
    { sector: 'Industrials', geography: 'US' }),
  rel('ETN', 'Eaton', 'ELECTRICAL_EQUIPMENT', 'MULTI', 0.5, 'medium',
    'Electrical Americas segment: switchgear, UPS, data-center electrical distribution (10-K). Diversified industrial: data-center is one of several end markets.',
    { sector: 'Industrials', geography: 'US' }),
  rel('PWR', 'Quanta Services', 'ENGINEERING_PROCUREMENT_CONSTRUCTION', 'MULTI', 0.7, 'medium',
    'Largest US electric T&D specialty contractor (10-K); transmission/substation build-out is its core segment.',
    { sector: 'Industrials', geography: 'US' }),
  rel('VRT', 'Vertiv', 'COOLING_OR_THERMAL_MANAGEMENT', 'MULTI', 0.9, 'high',
    'Data-center power management and thermal/liquid cooling is the core business (10-K).',
    { sector: 'Industrials', geography: 'Global' }),
  // ── Data-center side (named counterparties; usually NOT the trade)
  rel('DLR', 'Digital Realty', 'DATA_CENTER_REIT', 'PJM', 0.5, 'medium',
    'Major Northern Virginia (PJM DOM zone) data-center footprint per 10-K. Power scarcity is a cost/constraint as much as a demand signal — mixed effect by design.',
    { sector: 'Real Estate', geography: 'Northern Virginia' }),
  rel('MSFT', 'Microsoft', 'HYPERSCALER', 'PJM', 0.05, 'low',
    'Counterparty to the Crane Clean Energy Center PPA (2024-09-20). Deliberately low materiality: a single power contract is immaterial to Microsoft economics — expected classification is TOO_INDIRECT.',
    { sector: 'Information Technology', relationshipType: 'offtaker', validFrom: '2024-09-20' }),
  rel('AMZN', 'Amazon', 'HYPERSCALER', 'PJM', 0.05, 'low',
    'AWS acquired the Cumulus campus adjacent to Susquehanna (2024-03-04) with associated power arrangements. Immaterial to Amazon economics — expected classification is TOO_INDIRECT.',
    { sector: 'Consumer Discretionary', relationshipType: 'offtaker', validFrom: '2024-03-04' }),
  // ── Cost side (demonstrates COST_HEADWIND is a first-class outcome)
  rel('CLF', 'Cleveland-Cliffs', 'POWER_INTENSIVE_CONSUMER', 'PJM', 0.6, 'medium',
    'Electricity-intensive steelmaking (EAF + rolling) with major PJM-footprint operations in Ohio/Pennsylvania/Indiana (10-K). Rising power prices are an input-cost headwind.',
    { sector: 'Materials', geography: 'Ohio/Pennsylvania/Indiana' }),
]);

// ── Lookups (pure) ───────────────────────────────────────────────────────────
function graphFor({ isoRegion, asOf } = {}) {
  const d = asOf || null;
  return RELATIONSHIPS.filter(r => {
    if (isoRegion && r.isoRegion !== isoRegion && r.isoRegion !== 'MULTI') return false;
    if (d && r.validFrom && d < r.validFrom) return false;
    if (d && r.validTo && d > r.validTo) return false;
    return true;
  });
}
function byTicker(ticker) { return RELATIONSHIPS.filter(r => r.ticker === ticker); }
function verifiedOnly(rows) { return (rows || RELATIONSHIPS).filter(r => r.verifiedOrInferred === 'verified'); }

// Sanity check used by tests: every row uses a known role and names evidence.
function validateGraph() {
  const errors = [];
  RELATIONSHIPS.forEach((r, i) => {
    if (!EXPOSURE_ROLE_SET.has(r.exposureRole)) errors.push(`[${i}] ${r.ticker}: unknown role ${r.exposureRole}`);
    if (!r.evidence || r.evidence.length < 20) errors.push(`[${i}] ${r.ticker}: evidence citation required`);
    if (!(r.estimatedExposureStrength >= 0 && r.estimatedExposureStrength <= 1)) errors.push(`[${i}] ${r.ticker}: strength out of [0,1]`);
    if (!['high', 'medium', 'low'].includes(r.estimatedMateriality)) errors.push(`[${i}] ${r.ticker}: bad materiality`);
    if (!['verified', 'inferred'].includes(r.verifiedOrInferred)) errors.push(`[${i}] ${r.ticker}: bad verifiedOrInferred`);
  });
  return { ok: errors.length === 0, errors, size: RELATIONSHIPS.length };
}

module.exports = { GRAPH_VERSION, RELATIONSHIPS, graphFor, byTicker, verifiedOnly, validateGraph };
