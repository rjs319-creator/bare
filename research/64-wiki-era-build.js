'use strict';
// ── WIKI-era historical panel build (panel-v3.2-wiki, 2014-01..2017-12) ──────
// Two phases:
//   node research/64-wiki-era-build.js --adapt   # CSV → standard source artifacts
//   node research/64-wiki-era-build.js           # panel + ledger + manifest + reports
// Everything lands in research/data/wiki-era/ with the STANDARD artifact names,
// so the unchanged audit runs against it:
//   RESEARCH_DATA_DIR=research/data/wiki-era npm run audit:research
//
// Governed by research/PREREGISTRATION-MOMENTUM-WIKI-2026-08.md — the grid, the
// band rule and the identity rules here are the preregistered ones; this script
// computes NO ICs and NO verdicts (that is research/66-wiki-confirmatory.js,
// one shot, after the audit passes).
const fs = require('fs');
const path = require('path');

const pit = require('./lib/pit');
const OV3 = require('./lib/outcome-v3');
const CA = require('./lib/corpactions');
const MF = require('./lib/manifest');
const CAL = require('./lib/calendar');
const COHORT = require('./lib/cohort');
const SV = require('../lib/research/survivorship');
const WIKI = require('./lib/wiki-source');
const P15 = require('./15-panel-features-v3');

const DATA = path.join(__dirname, 'data');
const WIKI_DIR = process.env.WIKI_MIRROR_DIR || path.join(DATA, 'wiki');
const OUT_DIR = process.env.WIKI_ERA_DATA_DIR || path.join(DATA, 'wiki-era');
const CSV_PATH = path.join(WIKI_DIR, 'WIKI_PRICES.csv');
const SECMASTER_HIST_PATH = path.join(DATA, 'secmaster-hist.json');
const CODES_PATH = path.join(WIKI_DIR, 'wiki-codes.csv');           // optional names
const GRID_FROM = '2014-01', GRID_TO = '2017-12';                    // preregistered era
const HORIZONS = [21, 63, 126];
const PANEL_VERSION = 'panel-v3.2-wiki';
const MIN_OUTCOME_COVERAGE = COHORT.DEFAULT_MIN_OUTCOME_COVERAGE;
const BUILD_COMMAND = 'node research/64-wiki-era-build.js';
const PRICE_DATA_VERSION = 'wiki-mirror-v1+corpactions-tr';

// Preregistered band: ADV20 floor only. WIKI carries no shares outstanding, so
// the frozen cap band is REPLACED (declared in the preregistration) — never
// silently approximated from a proxy.
const bandCheck = ({ adv }) => adv >= pit.ADV_FLOOR;

function adapt() {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`missing ${CSV_PATH} — download the Kaggle WIKI mirror first`);
  if (!fs.existsSync(SECMASTER_HIST_PATH)) throw new Error(`missing ${SECMASTER_HIST_PATH} — the Form-25 real-death join requires secmaster-hist`);
  const retrievedAt = fs.statSync(CSV_PATH).mtime.toISOString();
  // Sector labels (current-vendor, non-PIT, advisory-only — disclosed): joined
  // from the present-day symbols payload where a ticker matches.
  const sectorBySymbol = {};
  try {
    const syms = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols || {};
    for (const [s, m] of Object.entries(syms)) if (m && m.sector) sectorBySymbol[s] = m.sector;
  } catch { /* sectors stay Unknown */ }
  return WIKI.adaptWikiCsv({ csvPath: CSV_PATH, secmasterHistPath: SECMASTER_HIST_PATH, codesPath: CODES_PATH, outDir: OUT_DIR, retrievedAt, sectorBySymbol })
    .then((report) => {
      console.log(`adapted: ${report.qc.symbols} symbols read, deathsAttached=${report.qc.deathsAttached}, activeAtFreeze=${report.qc.activeAtFreeze}, unknownEnders=${report.qc.unknownEnders}`);
      console.log(`excluded: zombies=${report.qc.zombiesExcluded.length}, adjMismatch=${report.qc.adjMismatchExcluded.length}`);
    });
}

function build() {
  const masterPath = path.join(OUT_DIR, 'secmaster-v3.json');
  const symbolsPath = path.join(OUT_DIR, 'symbols.json');
  const sessionsPath = path.join(OUT_DIR, 'sessions.json');
  const cacheDir = path.join(OUT_DIR, 'cache');
  const corpDir = path.join(OUT_DIR, 'corpactions');
  for (const p of [masterPath, symbolsPath, sessionsPath, cacheDir, corpDir]) {
    if (!fs.existsSync(p)) throw new Error(`missing ${p} — run: node research/64-wiki-era-build.js --adapt`);
  }
  const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
  const symbolsDoc = JSON.parse(fs.readFileSync(symbolsPath, 'utf8'));
  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  const adapterReport = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'adapter-report.json'), 'utf8'));

  const calendar = CAL.buildSessionCalendar(sessions.dates, { source: sessions.source });
  const grid = pit.monthEnds(GRID_FROM, GRID_TO);

  let supersedes = null;
  const outPath = path.join(OUT_DIR, 'panel-features-v3.json');
  if (fs.existsSync(outPath)) {
    try { supersedes = MF.normalizedPanelHash(JSON.parse(fs.readFileSync(outPath, 'utf8')).panel); } catch { supersedes = null; }
  }

  const b = P15.buildPanel(
    { master, symbols: symbolsDoc.symbols, cacheDir, corpDir },
    { grid, requireShares: false, bandCheck, priceDataVersion: PRICE_DATA_VERSION },
  );
  const months = Object.keys(b.out).sort();
  const datasetHash = MF.normalizedPanelHash(b.out);
  const generatedAt = new Date().toISOString();
  const universeRule = `PIT at decision date: WIKI-mirror observed membership (bars present), ADV20 ≥ ${pit.ADV_FLOOR / 1e6}M (NO cap band — WIKI carries no shares outstanding; preregistered replacement), non-stale price, curated-list US common stock, ticker-reuse collisions excluded (adapter zombie rule)`;

  const ledger = COHORT.computeCohortLedger({
    panelByMonth: b.out, calendar, horizons: HORIZONS,
    labelObservationCutoff: b.cutoffs.labelObservationCutoff,
    minOutcomeCoverage: MIN_OUTCOME_COVERAGE,
  });

  const corpFiles = fs.readdirSync(corpDir).filter((f) => f.endsWith('.json')).sort();
  const corpHash = P15.hashPartitionDir(corpDir, corpFiles);
  const priceFiles = [...new Set(b.cachedSymbols)].sort().map((s) => `${s}.json`);
  const priceHash = P15.hashPartitionDir(cacheDir, priceFiles);
  const git = P15.gitBuildFacts(path.join(__dirname, '..'));

  // MEASURED survivorship — reduced BY CONSTRUCTION and declared so: WIKI is a
  // curated mirror, not an authoritative listing universe. delistedExpected is
  // the Form-25 verified real-death count for the era (all deaths, not just
  // ticker-mapped ones) so the coverage fraction is honest about the misses.
  const survivorship = SV.makeSurvivorshipContract({
    historicalListingSource: 'WIKI mirror observed membership (curated ~3,000 names) + EDGAR Form-25 real-death join',
    historicalListingSourceAuthoritative: false,
    delistedSecuritiesCovered: b.deadNamesIncluded,
    delistedSecuritiesExpected: adapterReport.eraRealDeathsExpected ?? null,
    totalSecurities: b.names,
    instrumentTypeCoverage: { includedNames: b.names, exclusionsBySymbol: Object.fromEntries(Object.entries(b.exclusions).filter(([k]) => k.startsWith('type:'))) },
    missingSymbolReasons: b.exclusions,
    notes: 'survivorship-reduced BY CONSTRUCTION (curated mirror; pre-2014 deaths absent at source; ~1/3 of era real deaths never in WIKI). Preregistered verdict ceiling: pass-provisional(survivorship-reduced); NEVER promotion-eligible.',
  });

  const manifest = MF.buildSnapshotManifest({
    snapshotId: `${PANEL_VERSION}:${datasetHash.slice(0, 16)}`,
    datasetHash,
    generatedAt,
    sourceHashes: {
      securityMasterPayloadHash: MF.definitionHash(master),
      universePayloadHash: MF.definitionHash(symbolsDoc),
      corpactionsMerkleRoot: corpHash.root,
      priceCacheMerkleRoot: priceHash.root,
      marketCalendarHash: calendar.calendarHash,
      cohortEligibilityHash: ledger.ledgerHash,
    },
    build: {
      codeCommit: git.codeCommit,
      worktreeDirty: git.worktreeDirty,
      dirtyDiffHash: git.dirtyDiffHash,
      buildCommand: BUILD_COMMAND,
      generationParams: {
        grid: [GRID_FROM, GRID_TO], volLb: 63, horizons: HORIZONS,
        minOutcomeCoverage: MIN_OUTCOME_COVERAGE, unknownReasonPolicy: 'exclude',
        band: `adv>=${pit.ADV_FLOOR}` , capBand: 'none (preregistered replacement — no shares data)',
        calendarSource: 'wiki-observed-union-sessions',
      },
      priceCacheRetrievalRange: {
        minFetchedAt: priceHash.minStamp, maxFetchedAt: priceHash.maxStamp,
        corpMinRetrievedAt: b.corpRetrievedRange.min, corpMaxRetrievedAt: b.corpRetrievedRange.max,
        partitions: { priceCache: priceHash.fileCount, corpactions: corpHash.fileCount },
      },
      sourceSchemaVersions: {
        'wiki-price-cache': WIKI.WIKI_SOURCE_VERSION,
        corpactions: CA.CORPACTIONS_VERSION,
        secmaster: master.version,
        symbols: symbolsDoc.generatedAt || 'unknown',
        calendar: CAL.CALENDAR_VERSION,
        cohort: COHORT.COHORT_POLICY_VERSION,
        outcome: OV3.OUTCOME_POLICY_VERSION,
      },
    },
    sources: [
      { name: 'wiki-mirror', version: WIKI.WIKI_SOURCE_VERSION, retrievedAt: adapterReport.retrievedAt, earliestObservation: calendar.firstSession, latestObservation: b.cutoffs.labelObservationCutoff },
      { name: 'wiki-secmaster', version: master.version, retrievedAt: master.builtAt, earliestObservation: null, latestObservation: null },
      { name: 'wiki-corpactions', version: CA.CORPACTIONS_VERSION, retrievedAt: adapterReport.retrievedAt, earliestObservation: null, latestObservation: null },
      { name: 'market-calendar', version: CAL.CALENDAR_VERSION, retrievedAt: null, earliestObservation: calendar.firstSession, latestObservation: calendar.lastSession },
    ],
    featureAvailabilityCutoff: b.cutoffs.featureAvailabilityCutoff,
    lastDecisionTimestamp: b.cutoffs.lastDecisionTimestamp,
    labelObservationCutoff: b.cutoffs.labelObservationCutoff,
    lastLabelReadyDecisionDateByHorizon: P15.lastLabelReadyByHorizon(b.out),
    lastFullyObservedCohortDateByHorizon: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.lastFullyObservedCohortDate]),
    ),
    cohortEligibilityByHorizon: COHORT.ledgerManifestSummary(ledger),
    cohortCoveragePolicy: { minOutcomeCoverage: MIN_OUTCOME_COVERAGE, basis: ledger.policy.basis },
    ineligibleCohortCounts: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.ineligibleCounts]),
    ),
    marketCalendarVersion: CAL.CALENDAR_VERSION,
    priceAdjustmentBasis: 'derived split-adjusted bars (raw ÷ suffix split factor, adj_close cross-checked) + total-return index (adjDividend reinvested); dollar volume scale-invariant',
    corporateActionSource: 'wiki-mirror:ex-dividend+split_ratio',
    corporateActionStatus: `verified-split-adjusted:${b.provenanceSummary.verifiedSplitAdjusted} unverifiable(no in-window splits):${b.provenanceSummary.unverifiable} conflicts-excluded:${b.provenanceSummary.conflicts}`,
    sectorClassificationBasis: 'current-vendor-classification joined by ticker — NOT point-in-time, partial; advisory only (preregistration forbids sector-conditioned verdicts)',
    survivorship,
    rowCount: b.kept,
    securityCount: new Set(Object.values(b.out).flat().map((r) => r.lid)).size,
    listingStatusCounts: { activeNames: b.names - b.deadNamesIncluded, deadNamesIncluded: b.deadNamesIncluded },
    labelStateCounts: b.labelStatesByH,
    missingnessByFeature: undefined,
    excludedRowCounts: { ...b.exclusions, 'label:structural-poison': b.extremeSummary.poisonedLabels, 'row:entry-bar-poisoned': b.extremeSummary.poisonedEntriesSkipped },
    knownLimitations: (master.meta && master.meta.coverageLimitations) || [],
    supersedes,
  });

  const verdict = MF.verifySnapshotManifest(manifest, b.out, { horizons: HORIZONS, calendar });
  if (!verdict.valid) {
    fs.writeFileSync(path.join(OUT_DIR, 'panel-v3.INVALID.json'), JSON.stringify({ status: 'invalid', panelVersion: PANEL_VERSION, generatedAt, errors: verdict.errors, stats: verdict.stats }, null, 2));
    console.error('WIKI-ERA PANEL INVALID — not published. Errors:');
    for (const e of verdict.errors) console.error(`  * ${e}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt,
    panelVersion: PANEL_VERSION,
    outcomePolicyVersion: OV3.OUTCOME_POLICY_VERSION,
    unknownReasonPolicy: 'exclude',
    securityMasterVersion: master.version,
    securityMasterSource: master.source || null,
    securityMasterBuiltAt: master.builtAt || null,
    coverageLimitations: (master.meta && master.meta.coverageLimitations) || null,
    dataCutoff: b.cutoffs.labelObservationCutoff,
    universeRule,
    featureTimestamping: 'all features computed from bars at or before each row\'s dt (decision date); return basis = total-return index; no fundamentals exist in this source',
    sectorBasis: 'current-vendor-classification joined by ticker — NOT point-in-time, partial; advisory only',
    labelStates: b.labelStates,
    labelStatesByHorizon: b.labelStatesByH,
    withheldDelistings: b.withheldDelistings,
    months, rows: b.kept, deadNamesIncluded: b.deadNamesIncluded,
    datasetHash,
    manifest,
    panel: b.out,
  }));
  const { recomputedLedger, ...verdictSlim } = verdict;
  fs.writeFileSync(path.join(OUT_DIR, 'panel-v3-manifest.json'), JSON.stringify({ manifest, verification: verdictSlim }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'market-calendar-v1.json'), JSON.stringify(CAL.calendarArtifact(calendar), null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'cohort-eligibility-v3.json'), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'identity-quality-v3.json'), JSON.stringify({ generatedAt, ...b.identity.report }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'extreme-returns-v3.json'), JSON.stringify({ generatedAt, ...b.extremeSummary }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'universe-coverage-v3.json'), JSON.stringify({
    generatedAt, universeRule,
    symbolFunnel: { universeSymbols: Object.keys(symbolsDoc.symbols).length, exclusionsBySymbol: b.exclusions },
    monthlyFunnel: b.monthlyFunnel,
  }, null, 2));
  console.log(`WIKI-era panel built (${PANEL_VERSION}/${OV3.OUTCOME_POLICY_VERSION}): ${b.kept} name-months across ${months.length} months, ${b.names} names, ${b.deadNamesIncluded} confirmed-delisted included.`);
  console.log(`datasetHash ${datasetHash.slice(0, 16)}… supersedes ${supersedes ? supersedes.slice(0, 16) + '…' : '(none)'}`);
  console.log('label states:', JSON.stringify(b.labelStates), 'withheld delistings:', JSON.stringify(b.withheldDelistings));
  console.log('cohorts:', JSON.stringify(Object.fromEntries(Object.entries(ledger.byHorizon).map(([h, v]) => [h, { lastFullyObserved: v.lastFullyObservedCohortDate, eligible: v.eligibleCohorts, ineligible: v.ineligibleCounts }]))));
  console.log('survivorship:', survivorship.status, `(covered ${survivorship.delistedSecuritiesCovered}${survivorship.delistedSecuritiesExpected ? '/' + survivorship.delistedSecuritiesExpected : ''})`);
  console.log('build:', JSON.stringify({ codeCommit: (git.codeCommit || 'NULL').slice(0, 12), dirty: git.worktreeDirty, reproducibility: manifest.build.reproducibility }));
  console.log(`next: RESEARCH_DATA_DIR=${path.relative(process.cwd(), OUT_DIR)} npm run audit:research`);
}

module.exports = { GRID_FROM, GRID_TO, PANEL_VERSION, PRICE_DATA_VERSION, bandCheck, OUT_DIR, adapt, build };
if (require.main === module) {
  if (process.argv.includes('--adapt')) adapt().catch((e) => { console.error(e); process.exitCode = 1; });
  else build();
}
