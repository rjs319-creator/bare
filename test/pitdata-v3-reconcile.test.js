'use strict';
// PIT-DATA-V3 reconciliation gates + the separate human promotion artifact +
// the three-tier health readiness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/pitdata/v3/schema');
const I = require('../lib/pitdata/v3/identity');
const REC = require('../lib/pitdata/v3/reconcile');
const H = require('../lib/pitdata/v3/health');
const C = require('../lib/pitdata/v3/collector');

const OBS = '2026-08-01T12:00:00.000Z';
const NOW = Date.UTC(2026, 7, 2, 12);

// A store that clears (or deliberately fails) the v3 gate battery.
function bigWorld({ lowConfFrac = 0.1, prospectiveDates = 6, n = 6000 } = {}) {
  const listingShards = {}, aliasShards = {};
  const aliasShardFor = (k) => (aliasShards[k] ||= { aliases: {} });
  const listingShardFor = (sym) => (listingShards[S.shardKeyFor(sym)] ||= { listings: {} });
  const nLow = Math.floor(n * lowConfFrac);
  for (let i = 0; i < n; i++) {
    const sym = `T${i}`;
    const highConf = i >= nLow;
    const { listing } = I.upsertListingV3(listingShardFor(sym), aliasShardFor, {
      symbol: sym,
      ipoDate: highConf ? '2015-01-01' : null,
      cik: highConf ? String(100000 + i) : null,
      exchange: 'NASDAQ',
      status: i < 1200 ? 'delisted' : 'active',
      statusFrom: i < 1200 ? '2020-01-01' : null,
      confirmation: i < 1200 ? { source: 'fmp-delisted-companies', delistedDate: '2020-01-01' } : null,
      instrumentType: 'common_stock', sector: 'Tech', industry: 'SW', country: 'US', currency: 'USD',
      observedAt: OBS, provenance: 'prospective_live', source: 't',
    });
    listing.marketDataCoverage = true;
    listing.actionsCollected = true;
    if (i < 100) {
      I.applyRename(listing, aliasShardFor, { oldSymbol: `O${i}`, newSymbol: sym, renameDate: '2019-01-01', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
    }
  }
  const latestRun = {
    ...S.makeRunManifest({ runId: 'run-x', date: '2026-08-01', collector: 'fmp-identity', provenance: 'prospective_live', startedAt: OBS }),
    requestedPages: ['stock-list', 'delisted:0'], completedPages: ['stock-list', 'delisted:0'],
    contentHashes: { 'stock-list': 'h1', 'delisted:0': 'h2' },
    complete: true, completenessStatus: 'complete', endedAt: OBS,
  };
  const state = { prospectiveDates: Array.from({ length: prospectiveDates }, (_, i) => `2026-07-2${i}`) };
  const rawSample = Array.from({ length: 5 }, (_, i) => {
    const payload = [{ i }];
    return { contentHash: S.contentHashOf(payload), payload };
  });
  const v1Master = { records: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`T${i}`, {}])) };
  return {
    listingShards, aliasShards, latestRun, state, rawSample, v1Master,
    universeSamples: [{ date: '2023-01-01', counts: {} }, { date: '2024-01-01', counts: {} }, { date: '2025-01-01', counts: {} }],
    externalControls: { activeUsListings: 5500 },
    labelStats: { unresolvedFrac: 0.3 },
    tickerReuseTestsPass: true,
    now: NOW,
  };
}

test('a complete, well-covered store passes every gate — and STILL cannot switch a consumer', () => {
  const report = REC.reconcileV3(bigWorld());
  assert.deepEqual(report.failedGates, []);
  assert.equal(report.engineeringComplete, true);
  assert.equal(report.survivorshipSafe, false, 'structurally false');
  assert.equal(report.consumerSwitchAllowed, false, 'structurally false');
});

test('excessive low-confidence identity FAILS reconciliation (defect 9 fixed)', () => {
  const report = REC.reconcileV3(bigWorld({ lowConfFrac: 0.9 }));
  assert.equal(report.engineeringComplete, false);
  assert.ok(report.failedGates.includes('lowConfidenceIdentity'));
});

test('insufficient longitudinal prospective history FAILS reconciliation', () => {
  const report = REC.reconcileV3(bigWorld({ prospectiveDates: 1 }));
  assert.ok(report.failedGates.includes('minProspectiveDates'));
});

test('a corrupted raw payload FAILS the raw-integrity gate', () => {
  const w = bigWorld();
  w.rawSample[0] = { contentHash: w.rawSample[0].contentHash, payload: [{ tampered: true }] };
  const report = REC.reconcileV3(w);
  assert.ok(report.failedGates.includes('rawHashesReproducible'));
});

test('an incomplete run (missing page) FAILS the all-pages gate', () => {
  const w = bigWorld();
  w.latestRun.completedPages = ['stock-list'];   // delisted:0 requested but never completed
  const report = REC.reconcileV3(w);
  assert.ok(report.failedGates.includes('allPagesCollected'));
});

test('missing external controls / label stats FAIL closed rather than passing silently', () => {
  const w = bigWorld();
  w.externalControls = null;
  w.labelStats = null;
  const report = REC.reconcileV3(w);
  assert.ok(report.failedGates.includes('externalControlTotals'));
  assert.ok(report.failedGates.includes('labelStateRates'));
});

test('promotion proposal: refused without engineering-complete report or named approver; never auto-applies', () => {
  const failing = REC.reconcileV3(bigWorld({ lowConfFrac: 0.9 }));
  assert.equal(REC.makePromotionProposal({ reconReport: failing, approvedBy: 'ravi', now: NOW }).ok, false);
  const passing = REC.reconcileV3(bigWorld());
  assert.equal(REC.makePromotionProposal({ reconReport: passing, approvedBy: '', now: NOW }).ok, false);
  const out = REC.makePromotionProposal({ reconReport: passing, approvedBy: 'ravi shah', now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.proposal.applied, false);
  assert.equal(out.proposal.appliesAutomatically, false);
  assert.equal(out.proposal.reconciliationHash, S.contentHashOf(passing), 'approval bound to the exact reviewed evidence');
});

// ── health readiness tiers ────────────────────────────────────────────────────
function healthDeps(blobs = new Map(), t = NOW) {
  return {
    blobs,
    readJSON: async (path, fallback = null) => (blobs.has(path) ? blobs.get(path) : fallback),
    writeJSON: async (path, doc) => { blobs.set(path, JSON.parse(JSON.stringify(doc))); },
    now: () => t,
  };
}
const ENV_OK = { FMP_API_KEY: 'x', BLOB_READ_WRITE_TOKEN: 'x', CRON_SECRET: 'x' };

test('health cannot be green when mandatory PIT sections are absent', async () => {
  const deps = healthDeps();
  const h = await H.buildV3Health(deps, { env: ENV_OK });
  assert.equal(h.readiness.operationallyHealthy, false);
  assert.equal(h.readiness.researchReady, false);
  assert.equal(h.readiness.promotionReady, false);
  assert.ok(h.missingMandatorySections.length > 0);
  assert.ok(h.problems.length > 0, 'absence of data is a finding, not a blank');
});

test('a missing required key caps readiness even with everything else present', async () => {
  const deps = healthDeps();
  const h = await H.buildV3Health(deps, { env: { BLOB_READ_WRITE_TOKEN: 'x' } });
  assert.equal(h.readiness.operationallyHealthy, false);
  assert.ok(h.sections.keys.requiredMissing.includes('FMP_API_KEY'));
});

test('research-ready requires reconciliation with integrity + identity + longitudinal gates; promotion-ready additionally requires the human artifact', async () => {
  const w = bigWorld();
  const recon = REC.reconcileV3(w);
  const blobs = new Map();
  const state = {
    version: S.PITDATA_V3_VERSION, collector: C.COLLECTOR_ID, initialBackfillComplete: true,
    activeRun: null, lastCompletedRunDate: '2026-08-01', runSeq: 1, runsCompleted: 1,
    prospectiveDates: w.state.prospectiveDates,
  };
  blobs.set(S.P.state(C.COLLECTOR_ID), state);
  blobs.set(S.P.run('2026-08-01', 'run-2026-08-01-0001'), w.latestRun);
  blobs.set('pitdata/v3/probe.json', { probedAt: OBS, endpoints: { 'stock-list': { available: true } }, corroboration: { openfigi: { keyPresent: false } } });
  blobs.set('pitdata/v3/reconciliation/latest.json', recon);
  blobs.set('pitdata/v3/labels/latest-stats.json', { unresolvedFrac: 0.3 });
  for (const s of w.rawSample) blobs.set(S.P.content(s.contentHash), { payload: s.payload });
  // Point the run's hashes at real re-derivable content.
  w.latestRun.contentHashes = Object.fromEntries(w.rawSample.map((s, i) => [`p${i}`, s.contentHash]));
  w.latestRun.completedPages = Object.keys(w.latestRun.contentHashes);
  w.latestRun.requestedPages = Object.keys(w.latestRun.contentHashes);

  const deps = healthDeps(blobs);
  const h1 = await H.buildV3Health(deps, { env: ENV_OK });
  assert.equal(h1.readiness.researchReady, true);
  assert.equal(h1.readiness.promotionReady, false, 'no human artifact yet');

  blobs.set('pitdata/v3/promotion/latest.json', REC.makePromotionProposal({ reconReport: recon, approvedBy: 'ravi shah', now: NOW }).proposal);
  const h2 = await H.buildV3Health(deps, { env: ENV_OK });
  assert.equal(h2.readiness.promotionReady, true);
  assert.equal(h2.survivorshipSafe, false, 'even promotion-ready never claims survivorship safety');
});

test('the daily health artifact is immutable — the first write of the day wins', async () => {
  const deps = healthDeps();
  const h = await H.buildV3Health(deps, { env: ENV_OK });
  const w1 = await H.persistDailyHealth(deps, h);
  assert.equal(w1.written, true);
  const w2 = await H.persistDailyHealth(deps, { ...h, healthy: 'tampered' });
  assert.equal(w2.written, false);
  assert.equal(w2.reason, 'already-recorded');
});
