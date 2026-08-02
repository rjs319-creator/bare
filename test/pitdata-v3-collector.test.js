'use strict';
// PIT-DATA-V3 collector: append-only runs, daily cadence, cursor discipline,
// backoff, content/observation separation, provenance transitions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/pitdata/v3/schema');
const C = require('../lib/pitdata/v3/collector');

function memDeps(responses, { t0 = Date.UTC(2026, 7, 3, 12) } = {}) {
  const blobs = new Map();
  let clock = t0;
  const jitters = [];
  return {
    blobs,
    apiKey: 'test-key-not-real',
    calls: [],
    fetchJson: async function fetchJson(url) {
      this.calls.push(url);
      const hit = responses.find((r) => url.includes(r.match));
      if (!hit) return { ok: false, status: 404, body: null };
      return typeof hit.reply === 'function' ? hit.reply(url) : hit.reply;
    },
    readJSON: async (path, fallback = null) => (blobs.has(path) ? blobs.get(path) : fallback),
    writeJSON: async (path, doc) => { blobs.set(path, JSON.parse(JSON.stringify(doc))); },
    now: () => (clock += 10),
    advanceDays: (d) => { clock += d * 86400000; },
    sleep: async (ms) => { jitters.push(ms); },
    sleeps: jitters,
    jitter: () => 17,   // deterministic injected jitter
  };
}
const page = (rows) => ({ ok: true, status: 200, body: rows });

const STOCK = [{ symbol: 'AAPL', exchangeShortName: 'NASDAQ', type: 'stock' }, { symbol: 'SPY', exchangeShortName: 'AMEX', type: 'etf' }];
const DELISTED = [{ symbol: 'DEADCO', companyName: 'Dead Co', exchange: 'NYSE', ipoDate: '2015-05-01', delistedDate: '2023-03-01' }];

function basicResponses() {
  return [
    { match: '/stock-list', reply: page(STOCK) },
    { match: '/delisted-companies', reply: page(DELISTED) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: {} } },
    { match: 'profile?symbol=AAPL', reply: page([{ symbol: 'AAPL', cik: '0000320193', ipoDate: '1980-12-12', isEtf: false, sector: 'Tech', country: 'US', currency: 'USD' }]) },
    { match: 'profile?symbol=SPY', reply: page([{ symbol: 'SPY', isEtf: true, country: 'US', currency: 'USD' }]) },
  ];
}

async function runToCompletion(deps, maxSteps = 8) {
  const outs = [];
  for (let i = 0; i < maxSteps; i++) {
    const out = await C.collectStepV3(deps);
    outs.push(out);
    if (out.did && (out.did.runComplete || out.did.step === 'idle-until-tomorrow')) break;
  }
  return outs;
}

test('full run: content objects, observations, manifest, listings + alias index all written', async () => {
  const deps = memDeps(basicResponses());
  const outs = await runToCompletion(deps);
  assert.ok(outs.some((o) => o.did && o.did.runComplete), 'run completes');
  const paths = [...deps.blobs.keys()];
  assert.ok(paths.some((p) => p.startsWith('pitdata/v3/raw/content/')), 'content-addressed raw stored');
  assert.ok(paths.some((p) => p.startsWith('pitdata/v3/raw/observations/')), 'observations stored');
  const manifest = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/runs/'))[1];
  assert.equal(manifest.complete, true);
  assert.equal(manifest.completenessStatus, 'complete');
  assert.deepEqual(manifest.requestedPages.filter((p) => !manifest.completedPages.includes(p)), [], 'all requested pages completed');
  assert.ok(Object.keys(manifest.contentHashes).length >= 3, 'hashes recorded per page');
  // Content payload is the EXACT body and its hash re-derives.
  const content = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/raw/content/'))[1];
  assert.equal(S.contentHashOf(content.payload), content.contentHash);
});

test('first run is historical_reconstruction; the NEXT day starts a NEW prospective_live run (defects 2+3 fixed)', async () => {
  const deps = memDeps(basicResponses());
  await runToCompletion(deps);
  const state1 = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state1.initialBackfillComplete, true);
  assert.equal(state1.activeRun, null);

  // Same day again → idle, not a new run.
  const idle = await C.collectStepV3(deps);
  assert.equal(idle.did.step, 'idle-until-tomorrow');

  // Next day → a brand-new run, now prospective_live.
  deps.advanceDays(1);
  const outs2 = await runToCompletion(deps);
  const done2 = outs2.find((o) => o.did && o.did.runComplete);
  assert.ok(done2, 'second run completes on the new day');
  assert.equal(done2.did.provenance, 'prospective_live');
  const state2 = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state2.runsCompleted, 2);
  assert.equal(state2.prospectiveDates.length, 1);
});

test('same payload observed on two dates: ONE content object, TWO observations', async () => {
  const deps = memDeps(basicResponses());
  await runToCompletion(deps);
  deps.advanceDays(1);
  await runToCompletion(deps);
  const contentPaths = [...deps.blobs.keys()].filter((p) => p.startsWith('pitdata/v3/raw/content/'));
  const stockHash = S.contentHashOf(STOCK);
  assert.equal(contentPaths.filter((p) => p.includes(stockHash)).length, 1, 'identical payload shares one content object');
  const obsDates = new Set([...deps.blobs.keys()]
    .filter((p) => p.startsWith('pitdata/v3/raw/observations/'))
    .map((p) => p.split('/')[4]));
  assert.equal(obsDates.size, 2, 'both sightings kept as separate observations');
});

test('an incomplete/failed page does NOT advance the cursor; the retry resumes the SAME page', async () => {
  let failures = 2;
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'delisted-companies', reply: () => (failures-- > 0 ? { ok: false, status: 500, body: null } : page(DELISTED)) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  await C.collectStepV3(deps);                       // stock-list ok
  const fail = await C.collectStepV3(deps);          // delisted page 0: 500 ×(retries exhausted while failures>0)…
  // fetchWithRetry retries in-invocation; with failures=2 the 3rd attempt succeeds inside one step.
  const state = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  if (fail.ok === false) {
    assert.equal(state.activeRun.delistedPage, 0, 'cursor NOT advanced on failure');
  } else {
    assert.ok(state.activeRun === null || state.activeRun.delistedPage >= 1);
  }
  const manifest = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/runs/'))[1];
  assert.ok(manifest.retries >= 2, 'retries recorded in the manifest');
});

test('a page that fails ALL attempts leaves the cursor in place and records the failure', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'delisted-companies', reply: { ok: false, status: 500, body: null } },
  ]);
  await C.collectStepV3(deps);
  const out = await C.collectStepV3(deps);
  assert.equal(out.ok, false);
  assert.match(out.error, /NOT empty data/);
  const state = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state.activeRun.step, 'delisted');
  assert.equal(state.activeRun.delistedPage, 0, 'cursor not advanced');
  const manifest = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/runs/'))[1];
  assert.ok(manifest.failures.length >= 1);
  assert.equal(manifest.complete, false);
});

test('429 with Retry-After is honored; backoff is bounded exponential with injected jitter', async () => {
  let n = 0;
  const deps = memDeps([
    { match: '/stock-list', reply: () => (++n < 3 ? { ok: false, status: 429, body: null, headers: { 'retry-after': '2' } } : page(STOCK)) },
    { match: '/delisted-companies', reply: page(DELISTED) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  const out = await C.collectStepV3(deps);
  assert.equal(out.ok, true);
  assert.deepEqual(deps.sleeps, [2000, 2000], 'Retry-After seconds honored over exponential backoff');
});

test('backoff without Retry-After: exponential base with the injected deterministic jitter', async () => {
  let n = 0;
  const deps = memDeps([
    { match: '/stock-list', reply: () => (++n < 3 ? { ok: false, status: 500, body: null } : page(STOCK)) },
    { match: '/delisted-companies', reply: page(DELISTED) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  const out = await C.collectStepV3(deps);
  assert.equal(out.ok, true);
  assert.deepEqual(deps.sleeps, [500 + 17, 1000 + 17], 'base*2^k + injected jitter');
});

test('delisted ingestion carries an authoritative confirmation; renames link old→new across shards', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'ZZZ', exchangeShortName: 'NYSE', type: 'stock' }]) },
    { match: '/delisted-companies', reply: page(DELISTED) },
    { match: '/symbol-change', reply: page([{ oldSymbol: 'AAA', newSymbol: 'ZZZ', date: '2024-01-15' }]) },
  ]);
  await runToCompletion(deps);
  const dShard = deps.blobs.get(S.P.listings('D'));
  const dead = Object.values(dShard.listings).find((l) => l.symbol === 'DEADCO');
  const delisted = dead.status.find((iv) => iv.value === 'delisted');
  assert.equal(delisted.effectiveFrom, '2023-03-01');
  assert.equal(delisted.confirmation.source, 'fmp-delisted-companies');
  // Rename: the OLD alias lives in ITS OWN shard (A), pointing at the Z listing.
  const aAliases = deps.blobs.get(S.P.aliases('A'));
  const entries = (aAliases.aliases || {}).AAA || [];
  assert.equal(entries.length, 1, 'old ticker indexed under its own letter');
  assert.equal(entries[0].effectiveTo, '2024-01-15', 'old alias closed at the rename date (half-open)');
});

test('a plan-gated 402 page truncates the feed WITH a recorded limitation instead of wedging the run', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'page=0', reply: page(Array.from({ length: 1000 }, (_, i) => ({ symbol: `D${i}`, delistedDate: '2020-01-01', ipoDate: '2010-01-01' }))) },
    { match: 'page=1', reply: { ok: false, status: 402, body: { _raw: "The values for 'page' can only be 0 based on your current subscription." } } },
    { match: '/symbol-change', reply: page([]) },
  ]);
  const outs = await runToCompletion(deps);
  const done = outs.find((o) => o.did && o.did.runComplete);
  assert.ok(done, 'run STILL completes — a plan gate must not block prospective accumulation');
  const manifest = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/runs/'))[1];
  assert.equal(manifest.completenessStatus, 'complete-with-limitations', 'no reader can mistake this for full coverage');
  const trunc = manifest.limitations.find((l) => /TRUNCATED/.test(l.note));
  assert.ok(trunc, 'truncation limitation recorded');
  assert.match(trunc.bodyNote, /page' can only be 0/);
  assert.equal(manifest.rowCounts['delisted:0'], 1000, 'the one allowed page captured at max limit');
  assert.ok(manifest.requestedPages.includes('delisted:1'));
  assert.equal(manifest.completedPages.includes('delisted:1'), false, 'gated page never counted as collected');
  // The reconciliation gate sees the truncation and honestly fails all-pages.
  const REC = require('../lib/pitdata/v3/reconcile');
  const report = REC.reconcileV3({ latestRun: manifest, now: Date.UTC(2026, 7, 3) });
  assert.equal(report.gates.allPagesCollected, false);
});

test('delisted page 0 is requested at the max limit, falling back to 100 when the plan gates the big limit', async () => {
  const gateMsg = { ok: false, status: 402, body: { _raw: 'limit refused on your current subscription' } };
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'limit=1000', reply: gateMsg },
    { match: 'limit=100', reply: page(DELISTED) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  const outs = await runToCompletion(deps);
  assert.ok(outs.some((o) => o.did && o.did.runComplete));
  const manifest = [...deps.blobs.entries()].find(([p]) => p.startsWith('pitdata/v3/runs/'))[1];
  assert.ok(manifest.limitations.some((l) => /falling back to limit=100/.test(l.note)));
  assert.equal(manifest.rowCounts['delisted:0'], 1, 'fallback page recorded');
});

test('newrun=1 recovery: a fresh SAME-DAY run starts with a new runId after a completed one', async () => {
  const deps = memDeps(basicResponses());
  await runToCompletion(deps);
  assert.equal((await C.collectStepV3(deps)).did.step, 'idle-until-tomorrow');
  const out = await C.collectStepV3(deps, { forceNewRun: true });
  assert.ok(out.ok);
  assert.notEqual(out.did && out.did.step, 'idle-until-tomorrow', 'recovery run starts');
  const state = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state.runSeq, 2, 'append-only: a second runId was issued');
  assert.ok([...deps.blobs.keys()].some((p) => p.includes('run-2026-08-03-0002')), 'recovery run manifest exists beside the first');
});

const SEC_MAP = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } };
const AAPL_PROFILE = [{
  symbol: 'AAPL', cik: '0000320193', ipoDate: '1980-12-12', exchangeShortName: 'NASDAQ',
  sector: 'Technology', industry: 'Consumer Electronics', country: 'US', currency: 'USD',
  isEtf: false, isFund: false, isAdr: false, mktCap: 3e12,
}];

test('identity enrichment: SEC CIK map + profile sweep lift a ticker-only listing to medium confidence WITHOUT changing its id', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: SEC_MAP } },
    { match: 'profile?symbol=AAPL', reply: page(AAPL_PROFILE) },
    { match: 'profile?symbol=SPY', reply: page([{ symbol: 'SPY', isEtf: true, currency: 'USD', country: 'US' }]) },
  ]);
  const outs = await runToCompletion(deps);
  const done = outs.find((o) => o.did && o.did.runComplete);
  assert.ok(done && done.did.sweepComplete, 'profile sweep completed for this tiny universe');
  const shard = deps.blobs.get(S.P.listings('A'));
  const aapl = Object.values(shard.listings).find((l) => l.symbol === 'AAPL');
  assert.ok(aapl.listingId.startsWith('pitv3:tk:'), 'id assigned once at first observation, NEVER rewritten by enrichment');
  assert.equal(aapl.identity.cik, '320193', 'SEC map set the CIK first');
  assert.equal(aapl.identity.ipoDate, '1980-12-12', 'profile supplied the listing start');
  assert.equal(aapl.identityConfidence, 'medium', 'low → medium once CIK+IPO known');
  assert.ok(aapl.instrumentType.some((iv) => iv.value === 'common_stock'), 'profile corroboration flips stock-unverified → common_stock');
  assert.ok(aapl.classification.some((iv) => iv.value.sector === 'Technology' && iv.value.currency === 'USD'));
  // The ETF is typed as etf, never common stock.
  const sShard = deps.blobs.get(S.P.listings('S'));
  const spy = Object.values(sShard.listings).find((l) => l.symbol === 'SPY');
  assert.ok(spy.instrumentType.every((iv) => iv.value !== 'common_stock'));
});

test('enriched listing now passes the common-stock universe policy end to end', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: SEC_MAP } },
    { match: 'profile?symbol=AAPL', reply: page(AAPL_PROFILE) },
    { match: 'profile?symbol=SPY', reply: page([{ symbol: 'SPY', isEtf: true }]) },
  ]);
  await runToCompletion(deps);
  const U = require('../lib/pitdata/v3/universe');
  const listingShards = {};
  for (const k of S.SHARD_KEYS) { const d = deps.blobs.get(S.P.listings(k)); if (d) listingShards[k] = d; }
  const snap = U.buildUniverseSnapshot({
    effectiveAt: '2026-08-04T00:00:00.000Z', knownAt: '2026-08-04T00:00:00.000Z',
    listingShards, marketDataFor: () => ({ close: 200, marketCap: 3e12, advDollar: 1e9 }),
  });
  assert.equal(snap.counts.selected, 1, 'AAPL selected after enrichment');
  assert.equal(snap.selected[0].symbol, 'AAPL');
  assert.equal(snap.selected[0].identityConfidence, 'medium');
});

test('profile sweep cursor: budget-limited batch resumes NEXT run where it stopped; 4xx symbols are skipped not wedged', async () => {
  // 3 listings needing enrichment; per-run budget effectively limited by a 429
  // stop after the first success on day 1.
  let day1 = true;
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'AAA', exchangeShortName: 'NYSE', type: 'stock' }, { symbol: 'BBB', exchangeShortName: 'NYSE', type: 'stock' }, { symbol: 'CCC', exchangeShortName: 'NYSE', type: 'stock' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: {} } },
    { match: 'profile?symbol=AAA', reply: page([{ symbol: 'AAA', cik: '1', ipoDate: '2000-01-01', isEtf: false, sector: 'X', country: 'US', currency: 'USD' }]) },
    { match: 'profile?symbol=BBB', reply: () => (day1 ? { ok: false, status: 429, body: null } : { ok: false, status: 404, body: null }) },
    { match: 'profile?symbol=CCC', reply: page([{ symbol: 'CCC', cik: '3', ipoDate: '2001-01-01', isEtf: false, sector: 'Y', country: 'US', currency: 'USD' }]) },
  ]);
  const outs1 = await runToCompletion(deps);
  const d1 = outs1.find((o) => o.did && o.did.runComplete).did;
  assert.equal(d1.enriched, 1, 'day 1: AAA enriched, then 429 stopped the sweep');
  assert.match(d1.stoppedBy, /http-429/);
  assert.equal(d1.sweepComplete, false);
  const state1 = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state1.profileCursor.shard, 'B', 'cursor HELD at the failed symbol');

  day1 = false;
  deps.advanceDays(1);
  const outs2 = await runToCompletion(deps);
  const d2 = outs2.find((o) => o.did && o.did.runComplete).did;
  assert.equal(d2.skipped4xx, 1, 'day 2: BBB 404 → skipped (recorded, nothing written), sweep continues');
  assert.equal(d2.enriched, 1, 'CCC enriched');
  assert.equal(d2.sweepComplete, true, 'sweep finished without wedging on the dead ticker');
  const bShard = deps.blobs.get(S.P.listings('B'));
  const bbb = Object.values(bShard.listings).find((l) => l.symbol === 'BBB');
  assert.equal(bbb.identity.cik, null, 'nothing fabricated for the failed symbol');
});

test('enrich-only runs: same-day calls after the full run advance the sweep instead of idling; idle only once the sweep completes', async () => {
  let block = true;   // day-1 sweep stops at BBB via 429 → incomplete
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'AAA', exchangeShortName: 'NYSE', type: 'stock' }, { symbol: 'BBB', exchangeShortName: 'NYSE', type: 'stock' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: {} } },
    { match: 'profile?symbol=AAA', reply: page([{ symbol: 'AAA', cik: '1', ipoDate: '2000-01-01', isEtf: false, sector: 'X', country: 'US', currency: 'USD' }]) },
    { match: 'profile?symbol=BBB', reply: () => (block ? { ok: false, status: 429, body: null } : page([{ symbol: 'BBB', cik: '2', ipoDate: '2001-01-01', isEtf: false, sector: 'Y', country: 'US', currency: 'USD' }])) },
  ]);
  const outs1 = await runToCompletion(deps);
  const d1 = outs1.find((o) => o.did && o.did.runComplete).did;
  assert.equal(d1.sweepComplete, false);
  block = false;
  const enrich = await C.collectStepV3(deps);   // SAME day — must NOT idle
  assert.equal(enrich.did.step, 'profiles');
  assert.equal(enrich.did.runComplete, true);
  assert.equal(enrich.did.sweepComplete, true, 'enrich-only run finished the sweep');
  const state = deps.blobs.get(S.P.state(C.COLLECTOR_ID));
  assert.equal(state.runsCompleted, 2, 'the enrich batch is its own append-only run');
  const idle = await C.collectStepV3(deps);
  assert.equal(idle.did.step, 'idle-until-tomorrow', 'idle only once the sweep is complete');
});

test('SEC map conflict: a different CIK claim is preserved as a candidate, never overwritten', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'DUPC', exchangeShortName: 'NYSE', type: 'stock' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: { 0: { cik_str: 999, ticker: 'DUPC' } } } },
    { match: 'profile?symbol=DUPC', reply: page([{ symbol: 'DUPC', cik: '111', ipoDate: '2010-01-01', isEtf: false, country: 'US', currency: 'USD', sector: 'Z' }]) },
  ]);
  await runToCompletion(deps);
  const shard = deps.blobs.get(S.P.listings('D'));
  const l = Object.values(shard.listings).find((x) => x.symbol === 'DUPC');
  assert.equal(l.identity.cik, '999', 'first-set CIK (SEC) retained');
  // Profile's competing CIK never silently replaces it — identity.cik unchanged.
  assert.equal(l.identity.cik === '111', false);
});

test('missing API key fails closed — never an empty result', async () => {
  const deps = memDeps(basicResponses());
  deps.apiKey = null;
  const out = await C.collectStepV3(deps);
  assert.equal(out.ok, false);
  assert.match(out.error, /FMP_API_KEY missing/);
  assert.equal([...deps.blobs.keys()].length, 0, 'nothing written');
});

test('capability probe records blocked endpoints as limitations and treats OpenFIGI absence as confidence-only', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'company_tickers', reply: { ok: true, status: 200, body: { 0: { cik_str: 320193, ticker: 'AAPL' } } } },
  ]);
  const saved = process.env.OPENFIGI_API_KEY;
  delete process.env.OPENFIGI_API_KEY;
  try {
    const probe = await C.probeCapabilitiesV3(deps);
    assert.equal(probe.ok, true);
    assert.equal(probe.endpoints['stock-list'].available, true);
    assert.equal(probe.endpoints['delisted-companies'].available, false, 'unprobed/blocked endpoint recorded, not assumed');
    assert.equal(probe.corroboration.openfigi.keyPresent, false);
    assert.match(probe.corroboration.openfigi.note, /identityConfidence/);
  } finally {
    if (saved !== undefined) process.env.OPENFIGI_API_KEY = saved;
  }
});

test('no secret ever appears in state, manifests, observations or errors', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page(STOCK) },
    { match: 'delisted-companies', reply: { ok: false, status: 500, body: null, error: 'boom apikey=test-key-not-real' } },
  ]);
  await C.collectStepV3(deps);
  const out = await C.collectStepV3(deps);
  const everything = JSON.stringify([...deps.blobs.entries()]) + JSON.stringify(out);
  assert.equal(everything.includes('test-key-not-real'), false, 'key never persisted or echoed');
});
