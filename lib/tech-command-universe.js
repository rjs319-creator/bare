'use strict';
// TECHNOLOGY UNIVERSE SERVICE — tech-command-universe-v1.
//
// The canonical, provenance-stamped set of technology securities the Command
// Center may rank. It REUSES the app's eligible tradable universe
// (lib/tradable-universe → NASDAQ Trader symbol directory + FMP company-screener
// metadata) rather than building a second universe, so delisted / non-standard /
// preferred / warrant / SPAC lines are already excluded upstream and every ticker
// carries the exchange's own identity.
//
// Degraded operation: when the tradable universe cannot be loaded (no store, no
// FMP key, provider outage) the service falls back to the SMALL curated set the
// app already maintains (lib/universe SECTOR_OF, Technology + Communication
// Services entries) and LABELS the result `degraded: true, basis:
// 'curated-fallback'`. A curated fallback is never presented as full coverage.
//
// This module classifies and reports. It never scores, ranks, or recommends.

const TAX = require('./tech-command-taxonomy');

const UNIVERSE_VERSION = 'tech-command-universe-v1';
const MAX_AGE_HOURS = 30;    // a pre-open build is the point-in-time set for the session
// Below this many classified names the universe is a data outage, not a market fact.
const MIN_VIABLE_COUNT = 40;

/**
 * Pure: rows (already shaped like tradable-universe securities) → classified
 * technology records + coverage. No network.
 * @param {Array<object>} rows
 * @param {{asOf?: string, applyOverlay?: boolean}} [opts]
 */
function buildFromRows(rows, { asOf = null, applyOverlay = true } = {}) {
  const seen = new Set();
  const records = [];
  let inactive = 0, duplicates = 0, nonTech = 0, unenriched = 0;
  for (const row of rows || []) {
    const sym = String((row && row.symbol) || '').trim().toUpperCase();
    if (!sym) continue;
    if (seen.has(sym)) { duplicates++; continue; }
    seen.add(sym);
    // A security the provider says no longer trades is EXCLUDED and counted — a
    // delisted or renamed line must never sit silently on a leaderboard.
    if (row.isActivelyTrading === false) { inactive++; continue; }
    // An eligible security the metadata provider never matched has NO sector at
    // all. It is dropped as non-technology, but it is a COVERAGE gap, not a
    // finding about the company — so it is counted separately from a name the
    // provider positively classified into another sector.
    const unknownSector = !row.sector && !row.industry;
    const rec = TAX.classifySecurity(row, { asOf, applyOverlay });
    if (!rec) { if (unknownSector) unenriched++; else nonTech++; continue; }
    records.push(rec);
  }
  records.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0) || a.ticker.localeCompare(b.ticker));
  return {
    records,
    exclusions: {
      inactiveOrDelisted: inactive, duplicateSymbols: duplicates, nonTechnology: nonTech,
      // Eligible securities the metadata provider never matched. Any technology name
      // hiding in here is INVISIBLE to this page — a coverage limit, stated as one.
      noProviderMetadata: unenriched,
    },
    coverage: TAX.coverageOf(records),
  };
}

// The degraded fallback: the app's existing curated sector map. Small by design,
// always labeled, and it carries no marketCap/industry detail (so most names land
// in 'other-technology' or 'unclassified' — which is the honest outcome).
function coverageZero() {
  return { total: 0, classified: 0, unclassified: 0, overlayRefined: 0, classifiedPct: null, bySubsector: {} };
}

function curatedFallbackRows() {
  const { SECTOR_OF } = require('./universe');
  const rows = [];
  for (const [ticker, sector] of Object.entries(SECTOR_OF || {})) {
    const s = String(sector || '').toLowerCase();
    if (s !== 'technology' && s !== 'communication services') continue;
    rows.push({
      symbol: ticker,
      company: null,
      // The curated map asserts the SECTOR and nothing finer. That is enough to say
      // "technology, area unspecified" (→ other-technology, benchmarked against the
      // broad technology ETF) but never enough to name a subsector — so the industry
      // string says exactly that instead of leaving a silent gap. Communication-
      // Services names carry no allowed industry here and are dropped, correctly.
      sector: sector,
      industry: 'Technology (curated sector list — no industry detail available)',
      exchange: null,
      marketCap: null,
      price: null,
      isActivelyTrading: true,
      metadataSource: 'curated-fallback (lib/universe SECTOR_OF)',
    });
  }
  return rows;
}

/**
 * Load the technology universe. Returns a frozen document with full provenance.
 * Never throws: a total provider failure degrades to the curated fallback with
 * `degraded: true` and an explicit warning.
 *
 * @param {{now?: Date, applyOverlay?: boolean, forceRebuild?: boolean}} [opts]
 */
async function loadTechUniverse({ now = new Date(), applyOverlay = true, forceRebuild = false } = {}) {
  const warnings = [];
  let rows = [];
  let basis = 'tradable-universe';
  let sourceDoc = null;
  try {
    const { loadTradableUniverse } = require('./tradable-universe');
    sourceDoc = await loadTradableUniverse({ now, maxAgeHours: MAX_AGE_HOURS, forceRebuild });
    rows = (sourceDoc && sourceDoc.securities) || [];
    if (!rows.length) warnings.push('Tradable universe returned no securities.');
  } catch (e) {
    warnings.push(`Tradable universe unavailable: ${String((e && e.message) || e)}`);
  }

  // Without provider metadata every row would be 'unclassified' — that is a
  // degraded universe, not a classified one, so say so rather than shipping a
  // leaderboard of unclassified names.
  const withIndustry = rows.filter(r => r && r.industry).length;
  const metadataThin = rows.length > 0 && withIndustry / rows.length < 0.2;
  if (metadataThin) warnings.push(`Sector/industry metadata covers only ${withIndustry} of ${rows.length} securities — classification is thin.`);

  const asOf = (sourceDoc && (sourceDoc.universeAsOf || sourceDoc.builtAt)) || new Date(now).toISOString();
  let degraded = false;
  let built = rows.length ? buildFromRows(rows, { asOf, applyOverlay }) : { records: [], exclusions: {}, coverage: coverageZero() };

  // The directory alone carries no sector/industry, so without the metadata
  // provider EVERY row classifies as non-technology and the universe collapses to
  // zero. An empty technology universe is not a finding about the market — it is a
  // data outage, and it must degrade to the labeled curated set rather than render
  // three empty boards as though nothing qualified.
  if (built.records.length < MIN_VIABLE_COUNT) {
    if (rows.length) {
      warnings.push(`Only ${built.records.length} securities classified as technology from ${rows.length} eligible rows — below the ${MIN_VIABLE_COUNT}-name viability floor, almost certainly missing sector/industry metadata.`);
    }
    rows = curatedFallbackRows();
    basis = 'curated-fallback';
    degraded = true;
    built = buildFromRows(rows, { asOf, applyOverlay });
    warnings.push('Using the small CURATED fallback universe — this is NOT full technology coverage, and subsector detail is unavailable for these names.');
  }

  return Object.freeze({
    schema: UNIVERSE_VERSION,
    taxonomyVersion: TAX.TAXONOMY_VERSION,
    overlayVersion: TAX.OVERLAY_VERSION,
    basis,
    degraded,
    metadataThin,
    universeAsOf: asOf,
    builtAt: new Date(now).toISOString(),
    sourceCoverage: (sourceDoc && sourceDoc.coverage) || null,
    sourceFromCache: (sourceDoc && sourceDoc.fromCache) || false,
    securities: Object.freeze(built.records),
    byTicker: Object.freeze(Object.fromEntries(built.records.map(r => [r.ticker, r]))),
    bySubsector: Object.freeze(TAX.groupBySubsector(built.records)),
    coverage: Object.freeze(built.coverage),
    exclusions: Object.freeze(built.exclusions),
    enrichmentGapNote: built.exclusions.noProviderMetadata
      ? `${built.exclusions.noProviderMetadata} eligible securities carried no provider sector/industry and could not be considered. Any technology company among them is missing from this universe — a coverage limit, not a judgement about those companies.`
      : null,
    warnings: Object.freeze(warnings),
    // Classification is a CURRENT snapshot everywhere — no point-in-time history
    // exists for sector membership on the providers this app is entitled to.
    pointInTime: false,
    pointInTimeNote: 'Sector/industry classification describes TODAY. No point-in-time membership history is available, so historical studies over this universe carry look-ahead classification risk.',
  });
}

// ── Views the page asks for ─────────────────────────────────────────────────
const MEGA_CAP_USD = 200e9;
const LIQUID_OPTIONS_MIN_CAP = 10e9;   // a cap floor is the only options-liquidity proxy this data supports

/**
 * Named views over a loaded universe document. Pure.
 * `liquidOptions` is explicitly a PROXY: this app has no options-volume screen
 * across the full universe, so the view is labeled as a cap-based approximation.
 */
function viewsOf(doc) {
  const secs = (doc && doc.securities) || [];
  return {
    broad: secs.map(s => s.ticker),
    megaCap: secs.filter(s => (s.marketCap || 0) >= MEGA_CAP_USD).map(s => s.ticker),
    liquidOptionsProxy: {
      tickers: secs.filter(s => (s.marketCap || 0) >= LIQUID_OPTIONS_MIN_CAP).map(s => s.ticker),
      basis: `market cap ≥ $${LIQUID_OPTIONS_MIN_CAP / 1e9}B — a PROXY for options liquidity, not measured option volume`,
    },
    bySubsector: (doc && doc.bySubsector) || {},
  };
}

/** Is this ticker in the technology universe? Returns the record or null. */
function lookup(doc, ticker) {
  if (!doc || !ticker) return null;
  return doc.byTicker[String(ticker).toUpperCase()] || null;
}

module.exports = {
  UNIVERSE_VERSION, MAX_AGE_HOURS, MIN_VIABLE_COUNT, MEGA_CAP_USD, LIQUID_OPTIONS_MIN_CAP,
  buildFromRows, curatedFallbackRows, loadTechUniverse, viewsOf, lookup,
};
