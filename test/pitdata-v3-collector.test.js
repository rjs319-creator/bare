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
