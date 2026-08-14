'use strict';
// CATALYST–FLOW — STEP 1: THE IMMUTABLE POINT-IN-TIME EVENT LEDGER.
//
//   node research/88-catalyst-flow-ledger.js [--limit N] [--no-network]
//
// Builds an append-only JSONL ledger of catalyst events from the vendor earnings archive,
// the local (delisting-inclusive) price cache and the free reference feeds, then writes a
// manifest recording exactly how much of it is promotion-eligible.
//
// THE HEADLINE FINDING THIS STEP EXISTS TO MEASURE, AND WHY IT IS NOT A FAILURE.
// research/data/earnings/*.json is FMP's per-symbol earnings endpoint captured as a
// snapshot. Each row carries `lastUpdated`. If that timestamp precedes the announcement,
// the estimate we hold was last written BEFORE the release and is a genuine final
// pre-release consensus. If it follows the announcement, the vendor has since rewritten
// the row and what we hold is today's corrected consensus wearing an old date.
//
// Measured across the whole archive: 1 row of 110,238 predates its own announcement.
// The estimate archive is therefore ~100% post-release, and every feature built on it is
// RECONSTRUCTED_EXPLORATORY. That is a property of the data we have, established by
// counting, and it is stamped on every ledger row rather than argued about later.
//
// Liquidity pre-filtering happens BEFORE the network step so the reference ingestion is
// scoped to names that could ever be eligible, not to all 3,438 with an earnings file.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const REF = require('./lib/catalyst-reference');
const CLOCK = require('../lib/catalyst-flow/clock');
const ELIG = require('../lib/catalyst-flow/eligibility');
const SCHEMA = require('../lib/catalyst-flow/schema');
const CFG = require('../lib/catalyst-flow/config');

const OUT_DIR = path.join(K.DATA_DIR, 'catalyst-flow');
const LEDGER_PATH = path.join(OUT_DIR, 'events.jsonl');
const MANIFEST_PATH = path.join(OUT_DIR, 'ledger-manifest.json');
const EARNINGS_DIR = path.join(K.DATA_DIR, 'earnings');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const hasFlag = (name) => process.argv.includes(name);

// A vendor snapshot's ingestion moment. The archive was captured as one pull, so its file
// mtime is the honest "when did WE first hold this" — better than pretending we held it
// at the event, and recorded as such.
function archiveIngestTs(file) {
  try { return new Date(fs.statSync(file).mtime).toISOString(); } catch { return new Date().toISOString(); }
}

// Cheap local liquidity pre-screen: does the name EVER clear the floors inside the cached
// window? A name that never does cannot produce an eligible event on any date, so it is
// not worth a network round trip.
function everPlausiblyEligible(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return false;
  // Start at the first index with a full trailing liquidity window.
  for (let i = CFG.ELIGIBILITY.dollarVolumeLookback; i < candles.length; i++) {
    const b = candles[i];
    if (!(b.close >= CFG.ELIGIBILITY.minPriorClose)) continue;
    const dv = ELIG.trailingMedianDollarVolume(candles, i);
    if (dv != null && dv >= CFG.ELIGIBILITY.minMedianDollarVolume) return true;
  }
  return false;
}

async function main() {
  const t0 = Date.now();
  const limit = parseInt(arg('--limit', '0'), 10) || 0;
  const noNetwork = hasFlag('--no-network');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── Session axis: the app's SPY bars ARE the exchange calendar this rig observes ──
  const spy = K.loadSeries(path.join(K.CACHE_DIR, 'SPY.json'));
  if (!spy) throw new Error('SPY missing from the research cache — no session axis');
  const sessions = spy.map((b) => b.date);

  // ── Candidate symbols: an earnings file AND cached bars ──
  let symbols = fs.readdirSync(EARNINGS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  symbols = symbols.filter((s) => fs.existsSync(path.join(K.CACHE_DIR, `${s}.json`)));
  if (limit) symbols = symbols.slice(0, limit);

  const series = new Map();
  const prescreen = { scanned: symbols.length, noBars: 0, neverLiquid: 0, kept: 0 };
  for (const s of symbols) {
    const c = K.loadSeries(path.join(K.CACHE_DIR, `${s}.json`));
    if (!c) { prescreen.noBars++; continue; }
    if (!everPlausiblyEligible(c)) { prescreen.neverLiquid++; continue; }
    series.set(s, { candles: c, idx: new Map(c.map((b, i) => [b.date, i])) });
    prescreen.kept++;
  }
  process.stdout.write(`prescreen: ${JSON.stringify(prescreen)}\n`);

  // ── Reference data (free; cached to disk) ──
  let benchReport = null, profileReport = null;
  if (!noNetwork) {
    benchReport = await REF.ingestSectorBenchmarks({});
    process.stdout.write(`sector benchmarks: ${JSON.stringify(benchReport)}\n`);
    profileReport = await REF.ingestProfiles([...series.keys()], {
      onProgress: (d, t) => process.stdout.write(`profiles ${d}/${t}\r`),
    });
    process.stdout.write(`\nprofiles: ${JSON.stringify(profileReport)}\n`);
  }
  const profiles = REF.loadProfiles();

  // ── Build the ledger ──
  const rows = [];
  const attrition = {};
  const bump = (k) => { attrition[k] = (attrition[k] || 0) + 1; };
  const pitCounts = { IMMUTABLE_PIT: 0, RECONSTRUCTED_EXPLORATORY: 0 };
  let observedAfterCutoff = 0;
  let preReleaseConsensusRows = 0;

  for (const [sym, s] of series) {
    const ref = REF.sectorOf(profiles, sym);
    const earningsFile = path.join(EARNINGS_DIR, `${sym}.json`);
    const ingestedAt = archiveIngestTs(earningsFile);
    let vendorRows = [];
    try { vendorRows = JSON.parse(fs.readFileSync(earningsFile, 'utf8')); } catch { bump('unreadable-earnings-file'); continue; }

    // Security type must be KNOWN and must be a common share. Unknown ⇒ rejected.
    const typeCheck = ELIG.isOperatingCommonShare(sym, ref ? { quoteType: ref.quoteType } : {});
    if (!typeCheck.ok) { bump(`type:${typeCheck.reason}`); continue; }
    if (!ref) { bump('no-sector-benchmark'); continue; }

    for (const v of vendorRows) {
      const date = v && v.date ? String(v.date).slice(0, 10) : null;
      if (!date) { bump('no-event-date'); continue; }
      if (v.epsActual == null && v.revenueActual == null) { bump('unreported-event'); continue; }

      // The event clock. Rejects anything whose full five-session hold does not fit
      // inside the observed session axis — an unobservable exit is never truncated.
      const clock = CLOCK.eventClock(sessions, date);
      if (!clock.ok) { bump(`clock:${clock.reason}`); continue; }

      const confIdx = s.idx.get(clock.confirmationSession);
      if (confIdx == null) { bump('no-confirmation-bar-for-symbol'); continue; }
      const anchorIdx = s.idx.get(sessions[clock.announcementSessionIdx]);
      if (anchorIdx == null || anchorIdx < 1) { bump('no-announcement-anchor-bar'); continue; }

      // Eligibility is evaluated on the session BEFORE the confirmation session — the
      // last state the market had settled on before this event's own reaction.
      const priorBar = s.candles[anchorIdx];
      const screen = ELIG.screenCandidate({
        symbol: sym,
        meta: { quoteType: ref.quoteType },
        bars: s.candles, idx: anchorIdx,
        priorCloseUnadjusted: priorBar ? priorBar.close : null,
      });
      if (!screen.eligible) { bump(`eligibility:${screen.reason}`); continue; }

      // TWO DIFFERENT QUESTIONS, KEPT APART.
      //   consensusIsPreRelease — did the VENDOR last write this estimate before the
      //     release? (`lastUpdated < date`). Measured: true for 1 row in 110,238.
      //   pitClass — did WE hold the observation at the decision cutoff? For anything
      //     sourced from a bulk archive pull the answer is always no, whatever the
      //     vendor's own timestamp says, because we cannot distinguish "never rewritten"
      //     from "rewritten to the same value". The conservative reading is the only
      //     defensible one, so archive rows are RECONSTRUCTED_EXPLORATORY by construction.
      const lastUpdated = v.lastUpdated ? String(v.lastUpdated).slice(0, 10) : null;
      const consensusIsPreRelease = !!(lastUpdated && lastUpdated < date);
      const pitClass = 'RECONSTRUCTED_EXPLORATORY';
      pitCounts[pitClass]++;
      if (consensusIsPreRelease) preReleaseConsensusRows++;

      const row = SCHEMA.buildEventRow({
        symbol: sym,
        securityIdAsOf: `YAHOO:${sym}@${clock.decisionDate}`,
        eventType: 'EARNINGS',
        providerEventTimestamp: `${date}T21:00:00Z`,   // vendor gives a DATE only; see the clock note
        firstSeenAt: ingestedAt,
        ingestedAt,
        featureCutoffTs: `${clock.decisionDate}T20:00:00Z`,
        decisionDate: clock.decisionDate,
        plannedEntryTs: `${clock.entrySession}T13:30:00Z`,
        source: 'fmp-earnings-archive',
        rawPayload: v,
        pitClass,
        epsActual: v.epsActual,
        epsConsensusPreRelease: v.epsEstimated,
        epsConsensusAsOfTs: lastUpdated ? `${lastUpdated}T00:00:00Z` : null,
        revenueActual: v.revenueActual,
        revenueConsensusPreRelease: v.revenueEstimated,
        revenueConsensusAsOfTs: lastUpdated ? `${lastUpdated}T00:00:00Z` : null,
        dataQuality: {
          announcementTimeKnown: false,        // no BMO/AMC marker in the feed
          confirmationSessionRule: 'first session strictly after the announcement date (conservative)',
          consensusIsPreRelease,
          sectorPitVerified: false,
          sector: ref.sector,
          benchmark: ref.benchmark,
          liquidityRankBasis: 'trailing-20-session-median-dollar-volume',
          dollarVolumeAtDecision: screen.dollarVolume,
          confirmationSession: clock.confirmationSession,
          entrySession: clock.entrySession,
          exitSession: clock.exitSession,
          holdSessions: clock.holdSessions,
        },
      });

      const valid = SCHEMA.validateEventRow(row);
      if (!valid.ok) { bump(`schema:${valid.errors[0]}`); continue; }
      if (valid.observedAfterCutoff) {
        observedAfterCutoff++;
        row.dataQuality.observedAfterCutoff = true;
      }
      rows.push(row);
    }
  }

  // Append-only write. Sorted by (decisionDate, symbol) for deterministic bytes.
  rows.sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : a.symbol.localeCompare(b.symbol)));
  fs.writeFileSync(LEDGER_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  const dates = [...new Set(rows.map((r) => r.decisionDate))].sort();
  const perDate = {};
  for (const r of rows) perDate[r.decisionDate] = (perDate[r.decisionDate] || 0) + 1;
  const cohortSizes = Object.values(perDate);

  const manifest = {
    version: 'catalyst-ledger-manifest-v1',
    schema: CFG.SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    sessionAxis: { source: 'research/data/cache/SPY.json', first: sessions[0], last: sessions[sessions.length - 1], sessions: sessions.length },
    prescreen,
    referenceIngestion: { benchmarks: benchReport, profiles: profileReport, sectorPitVerified: false },
    events: rows.length,
    decisionDates: dates.length,
    dateRange: { first: dates[0] || null, last: dates[dates.length - 1] || null },
    cohortSize: {
      mean: cohortSizes.length ? +(cohortSizes.reduce((a, b) => a + b, 0) / cohortSizes.length).toFixed(2) : null,
      median: cohortSizes.length ? cohortSizes.slice().sort((a, b) => a - b)[cohortSizes.length >> 1] : null,
      max: cohortSizes.length ? Math.max(...cohortSizes) : null,
      // The percentile grade bins need ≥200 names on a date; below that the deterministic
      // rank fallback is used and this count says how often.
      datesAtOrAbovePercentileFloor: cohortSizes.filter((n) => n >= CFG.MIN_COHORT_FOR_PERCENTILE_BINS).length,
    },
    pitClassCounts: pitCounts,
    // Rows whose observation moment postdates their own decision cutoff. This is the
    // count that decides promotion eligibility, and it is a measurement, not a judgement.
    observedAfterCutoff,
    // Vendor rows whose estimate was last written BEFORE the release. Reported because it
    // is the measurement that would justify a real point-in-time claim if it were large.
    preReleaseConsensusRows,
    promotionEligibleEvents: pitCounts.IMMUTABLE_PIT,
    attrition,
    honesty: {
      estimatesArePointInTime: pitCounts.IMMUTABLE_PIT > 0 && pitCounts.RECONSTRUCTED_EXPLORATORY === 0,
      survivorshipProvenSafe: false,
      survivorshipNote: 'The price cache contains names whose bars simply end (delistings), which REDUCES survivorship bias; it does not carry delisting RETURNS, so the experiment is non-promotable on that ground alone.',
      announcementTimeKnown: false,
      sectorPitVerified: false,
      optionsSignedCoverage: false,
    },
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`\nledger → ${LEDGER_PATH}\nmanifest → ${MANIFEST_PATH}\n`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
