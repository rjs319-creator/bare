'use strict';
// TECHNOLOGY TAXONOMY — tech-command-taxonomy-v1.
//
// Two-layer classification, because no single source we are entitled to can answer
// the whole question honestly:
//
//   LAYER 1 (primary, VERIFIED provider data). The FMP company-screener `sector` +
//     `industry` fields already carried on every row of the eligible tradable
//     universe (lib/tradable-universe). A documented industry→subsector rule table
//     turns those into the coarse areas the provider can actually support:
//     semiconductors, semiconductor equipment, hardware, communications equipment,
//     software, IT services, internet platforms, digital advertising, fintech,
//     electronic components, solar, other technology.
//
//   LAYER 2 (refinement OVERLAY, current approximation). Memory, servers/networking,
//     data-center infrastructure, cloud, cybersecurity, AI infrastructure and AI
//     applications are NOT derivable from any field this app receives. They are
//     supplied by a small, explicitly-sourced overlay that:
//       • only REFINES a name Layer 1 already put in technology,
//       • never adds a security to the universe and never decides eligibility,
//       • is stamped classificationSource:'tech-command-overlay-v1',
//         pointInTime:false, approximate:true — a CURRENT approximation with no
//         point-in-time history, exactly as the spec requires it be labeled.
//
// A name Layer 1 cannot place gets subsector 'unclassified'. Guessing is not an
// option the code offers.
//
// Pure & dependency-free: no network, no store, no clock.

const TAXONOMY_VERSION = 'tech-command-taxonomy-v1';
const OVERLAY_VERSION = 'tech-command-overlay-v1';

// Canonical subsector ids, display labels, and the benchmark used for
// subsector-relative strength. `null` benchmark ⇒ the group has no tradable proxy
// we can price, and subsector-relative numbers are reported as unavailable rather
// than silently substituted with QQQ.
const SUBSECTORS = Object.freeze({
  semiconductors:            { label: 'Semiconductors',              benchmark: 'SMH' },
  'semiconductor-equipment': { label: 'Semiconductor Equipment',     benchmark: 'SMH' },
  memory:                    { label: 'Memory',                      benchmark: 'SMH' },
  hardware:                  { label: 'Hardware',                    benchmark: 'XLK' },
  'servers-networking':      { label: 'Servers & Networking',        benchmark: 'XLK' },
  'datacenter-infrastructure': { label: 'Data-Center Infrastructure', benchmark: 'XLK' },
  software:                  { label: 'Software',                    benchmark: 'IGV' },
  cloud:                     { label: 'Cloud',                       benchmark: 'SKYY' },
  cybersecurity:             { label: 'Cybersecurity',               benchmark: 'CIBR' },
  'internet-platforms':      { label: 'Internet Platforms',          benchmark: 'QQQ' },
  // The provider's bucket is "Advertising Agencies", which mixes digital-native
  // ad-tech with traditional agencies. The label says so rather than overclaiming.
  'digital-advertising':     { label: 'Advertising (incl. digital)', benchmark: 'QQQ' },
  fintech:                   { label: 'Fintech',                     benchmark: 'QQQ' },
  'communications-equipment': { label: 'Communications Equipment',   benchmark: 'XLK' },
  'ai-infrastructure':       { label: 'AI Infrastructure',           benchmark: 'SMH' },
  'ai-applications':         { label: 'AI Applications',             benchmark: 'IGV' },
  'it-services':             { label: 'IT Services',                 benchmark: 'XLK' },
  'electronic-components':   { label: 'Electronic Components',       benchmark: 'XLK' },
  solar:                     { label: 'Solar / Clean-Tech Hardware', benchmark: 'XLK' },
  'other-technology':        { label: 'Other Technology',            benchmark: 'XLK' },
  unclassified:              { label: 'Unclassified',                benchmark: null },
});
const SUBSECTOR_IDS = Object.freeze(Object.keys(SUBSECTORS));

// Every benchmark ticker the taxonomy can reference (regime + relative-strength fetches).
const BENCHMARK_TICKERS = Object.freeze([...new Set(
  Object.values(SUBSECTORS).map(s => s.benchmark).filter(Boolean),
)]);

// Provider sectors that can contain technology businesses. Communication Services
// holds the internet platforms / digital advertising names; Financial Services
// holds fintech — but ONLY the industries listed below are pulled from them, so a
// bank or a telco never lands in the technology universe.
const TECH_SECTORS = Object.freeze(new Set(['technology', 'information technology']));
const ADJACENT_SECTORS = Object.freeze(new Set(['communication services', 'financial services']));

// LAYER 1 rules, most specific first. Each entry is [subsector, industry regex].
// Sourced from the provider's own `industry` vocabulary — no company names here.
//
// AUDITED against the live provider vocabulary (2026-08-06, 1,267 Technology rows).
// What the provider ACTUALLY emits inside Technology: Software - Application /
// - Infrastructure / - Services, Information Technology Services, Hardware Equipment
// & Parts, Semiconductors, Communication Equipment, Computer Hardware, Consumer
// Electronics, Electronic Gaming & Multimedia, Technology Distributors, Solar,
// Media & Entertainment. Rules that match nothing today are KEPT (a vocabulary
// change would use them) but their subsector is reachable only via the overlay —
// see OVERLAY_ONLY_SUBSECTORS below.
const INDUSTRY_RULES = Object.freeze([
  ['semiconductor-equipment',  /semiconductor\s*(equipment|materials|&\s*materials|equipment\s*&\s*materials)/i],
  ['semiconductors',           /semiconductor/i],
  ['communications-equipment', /communication\s*equipment|networking\s*equipment/i],
  // \bit\b is load-bearing: without it, "Credit Services" contains the substring
  // "it services", so every Financial-Services credit name matched IT services and
  // was then dropped by the adjacent-sector allow-list — silently deleting fintech
  // from the universe. Caught by the live-vocabulary audit, not by a unit test.
  ['it-services',              /information\s*technology\s*services|\bit\s*services\b|technology\s*(distributors|consulting)/i],
  ['software',                 /software/i],
  // "Electronic Components" only. NOT "Electronic Gaming & Multimedia" — a games
  // publisher is not a component maker, and matching it here was a real mis-bucket
  // of 35 names caught by the vocabulary audit.
  ['electronic-components',    /electronic\s*components|electronic\s*manufacturing|electronics\s*&\s*computer\s*distribution/i],
  ['hardware',                 /computer\s*hardware|consumer\s*electronics|hardware,?\s*equipment\s*&\s*parts|scientific\s*&\s*technical\s*instruments/i],
  ['solar',                    /solar/i],
  ['digital-advertising',      /advertising/i],
  ['internet-platforms',       /internet\s*(content|retail)|interactive\s*media|entertainment\s*-\s*internet/i],
  ['fintech',                  /credit\s*services|financial\s*(data|conglomerates)|capital\s*markets\s*technology/i],
]);

// Subsectors NO provider field can reach — they exist only through the overlay, and
// a name absent from the overlay will never be placed in one. Surfaced so the page
// can say why a group looks small rather than implying the group is small.
const OVERLAY_ONLY_SUBSECTORS = Object.freeze([
  'semiconductor-equipment', 'memory', 'servers-networking', 'datacenter-infrastructure',
  'cloud', 'cybersecurity', 'ai-infrastructure', 'ai-applications',
]);

// Industries pulled in from ADJACENT sectors only (a bank is not fintech here).
const ADJACENT_ALLOWED = Object.freeze(new Set(['internet-platforms', 'digital-advertising', 'fintech']));

// ── LAYER 2: the refinement overlay ─────────────────────────────────────────
// Each entry: ticker → { subsector, basis }. `basis` states WHY, in the company's
// own reported terms, so a reader can check it. This is a CURRENT snapshot: there
// is no point-in-time history behind it and it is labeled as an approximation
// everywhere it is used. It never adds a ticker to the universe — a name absent
// from Layer 1's technology set is ignored here.
//
// Deliberately small. It exists to make the AI/data-center/memory/cloud/security
// groupings expressible at all, NOT to be a curated "famous tech stocks" list; the
// universe itself is the full provider-classified cross-section.
const OVERLAY = Object.freeze({
  // Semiconductor EQUIPMENT. The provider files every one of these under the single
  // industry "Semiconductors", so the equipment/materials distinction is not
  // derivable from its data at all — it exists here or nowhere.
  AMAT: { subsector: 'semiconductor-equipment',    basis: 'wafer-fabrication equipment is the reported business' },
  LRCX: { subsector: 'semiconductor-equipment',    basis: 'deposition and etch equipment is the reported business' },
  KLAC: { subsector: 'semiconductor-equipment',    basis: 'process control and inspection equipment is the reported business' },
  TER:  { subsector: 'semiconductor-equipment',    basis: 'automated test equipment is the reported business' },
  ONTO: { subsector: 'semiconductor-equipment',    basis: 'process control and metrology is the reported business' },
  ACLS: { subsector: 'semiconductor-equipment',    basis: 'ion-implantation equipment is the reported business' },
  VECO: { subsector: 'semiconductor-equipment',    basis: 'deposition and process equipment is the reported business' },
  UCTT: { subsector: 'semiconductor-equipment',    basis: 'subsystems for semiconductor capital equipment' },
  ICHR: { subsector: 'semiconductor-equipment',    basis: 'fluid-delivery subsystems for semiconductor capital equipment' },
  PLAB: { subsector: 'semiconductor-equipment',    basis: 'photomasks are the reported business' },
  FORM: { subsector: 'semiconductor-equipment',    basis: 'probe cards for wafer test are the reported business' },
  MU:   { subsector: 'memory',                     basis: 'DRAM and NAND are the reported revenue segments' },
  WDC:  { subsector: 'memory',                     basis: 'HDD/flash storage media is the reported business' },
  STX:  { subsector: 'memory',                     basis: 'mass-capacity storage media is the reported business' },
  SMCI: { subsector: 'servers-networking',         basis: 'server and storage systems are the reported segments' },
  DELL: { subsector: 'servers-networking',         basis: 'Infrastructure Solutions Group is a reported segment' },
  HPE:  { subsector: 'servers-networking',         basis: 'server / networking / HPC are reported segments' },
  ANET: { subsector: 'servers-networking',         basis: 'datacenter ethernet switching is the reported business' },
  CSCO: { subsector: 'servers-networking',         basis: 'networking infrastructure is the reported business' },
  JNPR: { subsector: 'servers-networking',         basis: 'networking infrastructure is the reported business' },
  // NOTE — 'datacenter-infrastructure' has no entries on purpose. The companies that
  // would populate it (power and thermal equipment makers) are classified OUTSIDE
  // technology by the provider, and the overlay may only refine a name Layer 1
  // already placed in technology. It may never ADD one. The group therefore renders
  // empty, and the page says why rather than importing names it is not entitled to.
  NVDA: { subsector: 'ai-infrastructure',          basis: 'Data Center is the majority reported revenue segment' },
  AMD:  { subsector: 'ai-infrastructure',          basis: 'Data Center is a reported revenue segment' },
  AVGO: { subsector: 'ai-infrastructure',          basis: 'AI networking / custom accelerators are reported drivers' },
  MRVL: { subsector: 'ai-infrastructure',          basis: 'data-center connectivity is the largest reported end market' },
  TSM:  { subsector: 'ai-infrastructure',          basis: 'advanced-node foundry capacity for AI accelerators' },
  CRWD: { subsector: 'cybersecurity',              basis: 'endpoint / cloud security platform is the reported business' },
  PANW: { subsector: 'cybersecurity',              basis: 'network and cloud security is the reported business' },
  ZS:   { subsector: 'cybersecurity',              basis: 'zero-trust security service edge is the reported business' },
  S:    { subsector: 'cybersecurity',              basis: 'endpoint security platform is the reported business' },
  OKTA: { subsector: 'cybersecurity',              basis: 'identity and access management is the reported business' },
  FTNT: { subsector: 'cybersecurity',              basis: 'network security appliances are the reported business' },
  NET:  { subsector: 'cloud',                      basis: 'connectivity cloud / edge platform is the reported business' },
  DDOG: { subsector: 'cloud',                      basis: 'cloud observability platform is the reported business' },
  SNOW: { subsector: 'cloud',                      basis: 'cloud data platform consumption is the reported revenue' },
  MDB:  { subsector: 'cloud',                      basis: 'cloud database (Atlas) is the majority reported revenue' },
  AI:   { subsector: 'ai-applications',            basis: 'enterprise AI applications are the reported business' },
  PLTR: { subsector: 'ai-applications',            basis: 'AI/decision platforms are the reported business' },
});

const lc = v => String(v == null ? '' : v).trim().toLowerCase();

/**
 * LAYER 1 only. Pure: provider sector/industry → { subsector, basis } or null.
 * @param {{sector?: string, industry?: string}} row
 */
function classifyByIndustry(row) {
  const sector = lc(row && row.sector);
  const industry = lc(row && row.industry);
  if (!sector && !industry) return null;
  const isTech = TECH_SECTORS.has(sector);
  const isAdjacent = ADJACENT_SECTORS.has(sector);
  if (!isTech && !isAdjacent) return null;
  // Sector says technology but the provider gave us no industry: we know it belongs
  // in the universe and we do NOT know which area — that is 'unclassified', not a
  // guess and not a silent bucket.
  if (!industry) return null;
  for (const [subsector, rx] of INDUSTRY_RULES) {
    if (!rx.test(industry)) continue;
    if (isAdjacent && !ADJACENT_ALLOWED.has(subsector)) return null;
    return { subsector, basis: `industry "${row.industry}"` };
  }
  return isTech ? { subsector: 'other-technology', basis: `technology sector, unmapped industry "${row.industry}"` } : null;
}

/**
 * Full classification for one security row.
 *
 * Returns null when the security is not technology at all (the caller drops it),
 * otherwise a frozen record carrying BOTH layers' provenance. `subsector` is
 * 'unclassified' when the row reached us with no usable sector/industry — an
 * explicit state, never a guess.
 *
 * @param {{symbol: string, company?: string, sector?: string, industry?: string,
 *          exchange?: string, marketCap?: number, price?: number,
 *          isActivelyTrading?: boolean, metadataSource?: string, universeAsOf?: string}} row
 * @param {{asOf?: string, applyOverlay?: boolean}} [opts]
 */
function classifySecurity(row, { asOf = null, applyOverlay = true } = {}) {
  const symbol = String((row && row.symbol) || '').trim().toUpperCase();
  if (!symbol) return null;
  const sector = lc(row.sector);
  const base = classifyByIndustry(row);
  // A technology-sector row we cannot place by industry is still technology — it is
  // 'unclassified' only when the provider gave us nothing to place it with.
  if (!base) {
    if (!TECH_SECTORS.has(sector)) return null;
    return freezeRecord(symbol, row, {
      subsector: 'unclassified', basis: 'no usable sector/industry metadata',
      source: 'unclassified', overlay: null, asOf,
    });
  }
  const over = applyOverlay ? OVERLAY[symbol] : null;
  return freezeRecord(symbol, row, {
    subsector: over ? over.subsector : base.subsector,
    basis: over ? over.basis : base.basis,
    source: over ? OVERLAY_VERSION : (row.metadataSource || 'provider-metadata'),
    overlay: over ? { from: base.subsector, to: over.subsector, basis: over.basis } : null,
    asOf,
  });
}

function freezeRecord(symbol, row, c) {
  const overlayApplied = !!c.overlay;
  return Object.freeze({
    ticker: symbol,
    company: row.company || row.companyName || null,
    exchange: row.exchange || null,
    providerSector: row.sector || null,
    providerIndustry: row.industry || null,
    marketCap: Number.isFinite(row.marketCap) ? row.marketCap : null,
    price: Number.isFinite(row.price) ? row.price : null,
    isActivelyTrading: row.isActivelyTrading !== false,
    subsector: c.subsector,
    subsectorLabel: (SUBSECTORS[c.subsector] || SUBSECTORS.unclassified).label,
    benchmark: (SUBSECTORS[c.subsector] || SUBSECTORS.unclassified).benchmark,
    classification: Object.freeze({
      taxonomyVersion: TAXONOMY_VERSION,
      source: c.source,
      basis: c.basis,
      asOf: c.asOf || row.universeAsOf || null,
      // No provider we are entitled to supplies HISTORICAL sector membership, so
      // every classification here describes TODAY and is labeled as such.
      pointInTime: false,
      approximate: c.subsector === 'unclassified' ? true : overlayApplied,
      overlayApplied,
      overlay: c.overlay,
    }),
  });
}

/** Group a classified list into { subsectorId: [tickers] } (stable order). */
function groupBySubsector(records) {
  const out = {};
  for (const id of SUBSECTOR_IDS) out[id] = [];
  for (const r of records || []) {
    if (!r || !r.subsector) continue;
    (out[r.subsector] = out[r.subsector] || []).push(r.ticker);
  }
  return out;
}

/** Coverage report over a classified list — how much of it is a real classification. */
function coverageOf(records) {
  const list = records || [];
  const bySubsector = {};
  let overlayed = 0, unclassified = 0;
  for (const r of list) {
    bySubsector[r.subsector] = (bySubsector[r.subsector] || 0) + 1;
    if (r.classification.overlayApplied) overlayed++;
    if (r.subsector === 'unclassified') unclassified++;
  }
  return {
    total: list.length,
    classified: list.length - unclassified,
    unclassified,
    overlayRefined: overlayed,
    classifiedPct: list.length ? +(((list.length - unclassified) / list.length) * 100).toFixed(1) : null,
    bySubsector,
  };
}

module.exports = {
  TAXONOMY_VERSION, OVERLAY_VERSION, SUBSECTORS, SUBSECTOR_IDS, BENCHMARK_TICKERS,
  TECH_SECTORS, ADJACENT_SECTORS, INDUSTRY_RULES, ADJACENT_ALLOWED, OVERLAY,
  OVERLAY_ONLY_SUBSECTORS,
  classifyByIndustry, classifySecurity, groupBySubsector, coverageOf,
};
