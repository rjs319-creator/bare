'use strict';
// PIT-DATA-V3 FEATURE FAMILIES (Phase 8) — interfaces + shadow snapshot
// contracts for the data most likely to add REAL predictive value, defined only
// AFTER the foundation (phases 1–7). Nothing here has live influence; every
// family fails closed until its data source is wired and probed, and adoption
// requires stable, cost-net, OUT-OF-SAMPLE incremental value against ALL of the
// required baselines — a good standalone backtest is explicitly insufficient.
//
// Each family declares:
//   requiredInputs      — what must genuinely exist point-in-time
//   vintageRule         — the timestamp that makes the feature PIT-safe
//   requiredBaselines   — the incremental-value comparison set (fixed for all)
//   status(deps)        — 'unavailable' with a reason until wired; never fabricated
//
// Pure module: no network, no clock, no store.

const S = require('./schema');

const FEATURES_V3_VERSION = 'pit-features-v3';

const REQUIRED_BASELINES = Object.freeze([
  'simple-momentum', 'market-relative-momentum', 'sector-relative-momentum',
  'production-rank', 'price-volume-only',
]);

const FEATURE_FAMILIES = Object.freeze([
  {
    id: 'analyst-estimate-revisions',
    description: 'Point-in-time analyst-estimate revisions with ORIGINAL publication/vintage timestamps.',
    requiredInputs: ['estimate vintage feed with per-revision publishedAt'],
    vintageRule: 'a revision is usable from its publishedAt, never from the consensus retro-view',
    knownLimitation: 'FMP Premium caps quarterly estimate pulls; vintage history unverified — probe before claiming availability',
  },
  {
    id: 'sec-filing-features',
    description: 'Filing features keyed to EDGAR acceptance time; CHANGES between filings, not present-day summaries.',
    requiredInputs: ['EDGAR submissions + acceptanceDateTime per filing'],
    vintageRule: 'usable from acceptanceDateTime (not period end, not filing date alone)',
    knownLimitation: 'EDGAR throttle ≤10 req/s; universe-scale needs the external box (see lib/edgar.js pilot)',
  },
  {
    id: 'earnings-surprise-drift',
    description: 'Surprise + post-event drift using estimates available BEFORE the announcement.',
    requiredInputs: ['paired epsActual/epsEstimated with pre-announcement estimate vintage'],
    vintageRule: 'estimate must predate the announcement timestamp; entry no earlier than the first post-announcement session',
    knownLimitation: 'prior SUE-PEAD work: NOT-CONFIRMED on multi-year data (hypothesis-registry pead-sue) — re-test only on the v3 panel',
  },
  {
    id: 'corporate-actions-dilution',
    description: 'Corporate actions, dilution, offerings, buybacks, share-count changes.',
    requiredInputs: ['splits/dividends feeds + share-count deltas from filings'],
    vintageRule: 'actions usable from announcement knownAt; share counts from filing acceptance',
    knownLimitation: 'FMP splits/dividends probed available; offerings/buyback events need 8-K parsing',
  },
  {
    id: 'execution-realism',
    description: 'Realized spread, fills, slippage, no-fill rate, borrow/locate.',
    requiredInputs: ['own-ledger fill records; borrow-rate source'],
    vintageRule: 'only realized (post-trade) records; never modeled values presented as realized',
    knownLimitation: 'no broker integration exists — ledger fills are simulated; borrow is modeled in lib/costs.js',
  },
  {
    id: 'premarket-intraday-bars',
    description: 'Premarket + intraday bars for Day Trade / Gap & Go, halts/LULD where obtainable.',
    requiredInputs: ['intraday bar feed with premarket coverage', 'halt/LULD event source'],
    vintageRule: 'bar usable at its close timestamp; halts usable at halt publication',
    knownLimitation: 'FMP Premium has 5-min intraday; LULD/halt feed unverified — probe first',
  },
  {
    id: 'sector-peer-residual-strength',
    description: 'Point-in-time sector and peer-relative residual strength.',
    requiredInputs: ['PIT sector classification (v3 classificationAt)', 'peer group as known then'],
    vintageRule: 'sector membership as known at decision time (v3 interval track), never today\'s GICS',
    knownLimitation: 'v3 classification coverage starts at first prospective collection — no backfilled history',
  },
  {
    id: 'data-quality-signals',
    description: 'Source disagreement, staleness and missingness AS EXPLICIT FEATURES.',
    requiredInputs: ['≥2 sources per fact (FMP + SEC corroboration)', 'v3 observation timestamps'],
    vintageRule: 'disagreement computed only over facts known by decision time',
    knownLimitation: 'needs the v3 store populated; free by construction once collection runs',
  },
].map((f) => Object.freeze({ ...f, requiredBaselines: REQUIRED_BASELINES, liveInfluence: false })));

// Family status — fail closed: a family with no wired, probed source is
// 'unavailable' with the reason; availability is never inferred.
function familyStatus(familyId, { probe = null, wired = {} } = {}) {
  const fam = FEATURE_FAMILIES.find((f) => f.id === familyId);
  if (!fam) return { status: 'unknown', reason: `no such feature family '${familyId}'` };
  if (!wired[familyId]) {
    return { status: 'unavailable', reason: 'source-not-wired: interface defined, collection not implemented', family: fam.id };
  }
  if (!probe) return { status: 'unavailable', reason: 'capability-probe-missing: availability may not be assumed', family: fam.id };
  return { status: 'available', family: fam.id };
}

// Shadow feature snapshot contract. Refuses to fabricate: rows must carry their
// own vintage timestamps, and rows whose vintage postdates knownAt are DROPPED
// and counted, never silently included.
function buildFeatureSnapshot({ familyId, asOf, knownAt = null, rows = [], provenance }) {
  const fam = FEATURE_FAMILIES.find((f) => f.id === familyId);
  if (!fam) return { ok: false, error: `no such feature family '${familyId}'` };
  if (!asOf) return { ok: false, error: 'asOf required' };
  const kAt = knownAt || asOf;
  const usable = [], leaked = [], unstamped = [];
  for (const r of rows) {
    if (!r || !r.securityId) continue;
    if (!r.vintageTs) { unstamped.push(r); continue; }          // no vintage → not PIT-safe → excluded
    if (S.knownAtCeil(String(r.vintageTs)) > S.knownAtCeil(String(kAt))) { leaked.push(r); continue; }
    usable.push(r);
  }
  const body = {
    schema: 'FeatureSnapshotV3', version: FEATURES_V3_VERSION,
    familyId, asOf, knownAt: kAt,
    provenance: provenance === S.PROVENANCE.PROSPECTIVE_LIVE
      ? S.PROVENANCE.PROSPECTIVE_LIVE : S.PROVENANCE.HISTORICAL_RECONSTRUCTION,
    counts: { usable: usable.length, droppedFutureVintage: leaked.length, droppedUnstamped: unstamped.length },
    rows: usable,
    requiredBaselines: fam.requiredBaselines,
    liveInfluence: false,
    shadow: true,
  };
  return { ok: true, snapshot: Object.freeze({ ...body, snapshotId: S.contentHashOf(body) }) };
}

module.exports = { FEATURES_V3_VERSION, REQUIRED_BASELINES, FEATURE_FAMILIES, familyStatus, buildFeatureSnapshot };
