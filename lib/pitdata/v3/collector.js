'use strict';
// PIT-DATA-V3 COLLECTOR — versioned, longitudinal, DAILY collector. Shadow-only:
// writes exclusively under pitdata/v3/; no live consumer reads it.
//
// Fixes the verified v2 defects:
//   * DEFECT 2 — v2 reached step 'done' and became a permanent no-op. v3 keys a
//     RUN to a DATE: a run completed yesterday never prevents a new run today.
//   * DEFECT 3 — v2 hard-coded 'historical_reconstruction'. v3 runs carry their
//     own provenance: the first full pass is the reconstruction; every recurring
//     run after `initialBackfillComplete` collects 'prospective_live' facts.
//   * DEFECT 4 — raw content is stored content-addressed over the EXACT payload
//     (schema.makeContentObject); identical payloads share one object, and every
//     sighting appends its own observation record.
//   * Cursors advance ONLY after a page fully succeeds; failures are recorded in
//     the run manifest and the same page is retried by the next step.
//   * Bounded exponential backoff with injected jitter; 429/Retry-After honored;
//     retries are idempotent (completedPages is a set, content is hash-keyed).
//
// External API failure is "unavailable" — never an empty result. No fabricated
// data: a blocked endpoint is a recorded capability limitation.
//
// deps: { fetchJson(url) -> {ok, status, body, headers?}, readJSON, writeJSON,
//         now(), sleep(ms)?, jitter(attempt)?, apiKey? } — clock, store, network
// and jitter are all injected so the whole collector is deterministic in tests.

const S = require('./schema');
const I = require('./identity');
const { redactSecrets } = require('../../redact');

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const COLLECTOR_ID = 'fmp-identity';

const DELISTED_PAGES_PER_STEP = 5;
const STEP_DEADLINE_MS = 40_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

// Capability probe first: the subscription tier is never assumed. SEC is a free
// corroboration source; OpenFIGI is OPTIONAL — a missing key lowers identity
// confidence, it never breaks collection.
const PROBE_ENDPOINTS_V3 = Object.freeze([
  { id: 'stock-list', path: '/stock-list', params: {} },
  { id: 'delisted-companies', path: '/delisted-companies', params: { page: 0, limit: 100 } },
  { id: 'symbol-change', path: '/symbol-change', params: {} },
  { id: 'profile', path: '/profile', params: { symbol: 'AAPL' } },
  { id: 'historical-market-capitalization', path: '/historical-market-capitalization', params: { symbol: 'AAPL', limit: 5 } },
  { id: 'splits', path: '/splits', params: { symbol: 'AAPL' } },
  { id: 'dividends', path: '/dividends', params: { symbol: 'AAPL' } },
  { id: 'shares-float', path: '/shares-float', params: { symbol: 'AAPL' } },
]);

const apiKeyOf = (deps) => (deps.apiKey !== undefined ? deps.apiKey : process.env.FMP_API_KEY);

function urlFor(path, params, apiKey) {
  const u = new URL(FMP_BASE + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  u.searchParams.set('apikey', apiKey);
  return u.toString();
}

async function probeCapabilitiesV3(deps) {
  const apiKey = apiKeyOf(deps);
  const out = { version: S.PITDATA_V3_VERSION, probedAt: new Date(deps.now()).toISOString(), endpoints: {}, corroboration: {} };
  if (!apiKey) return { ...out, ok: false, error: 'FMP_API_KEY missing — collection unavailable (fail closed, not empty)' };
  for (const ep of PROBE_ENDPOINTS_V3) {
    try {
      const r = await deps.fetchJson(urlFor(ep.path, ep.params, apiKey));
      const rows = Array.isArray(r.body) ? r.body.length : (r.body ? 1 : 0);
      out.endpoints[ep.id] = r.ok && rows > 0
        ? { available: true, httpStatus: r.status, sampleRows: rows }
        : { available: false, httpStatus: r.status, note: rows === 0 && r.ok ? 'empty-response' : 'blocked-or-error' };
    } catch (e) {
      out.endpoints[ep.id] = { available: false, note: redactSecrets((e && e.message) || e) };
    }
  }
  // SEC corroboration (free; no key). Probed, never assumed.
  try {
    const r = await deps.fetchJson('https://www.sec.gov/files/company_tickers.json');
    out.corroboration.secTickerCikMap = { available: !!r.ok, httpStatus: r.status };
  } catch (e) {
    out.corroboration.secTickerCikMap = { available: false, note: redactSecrets((e && e.message) || e) };
  }
  // OpenFIGI is optional: absence LOWERS identity confidence, never breaks runs.
  out.corroboration.openfigi = process.env.OPENFIGI_API_KEY
    ? { keyPresent: true }
    : { keyPresent: false, note: 'no OPENFIGI_API_KEY — share-class FIGIs unavailable; identityConfidence capped below high' };
  return { ...out, ok: true };
}

// Bounded exponential backoff with jitter. Retry-After (seconds) is honored on
// 429/503. deps.jitter is injectable for deterministic tests; production default
// is a small random spread.
async function fetchWithRetry(deps, url, pageId, manifest) {
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      manifest.retries++;
      const retryAfterSec = last && last.headers && Number(last.headers['retry-after']);
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const jitter = deps.jitter ? deps.jitter(attempt) : Math.floor(Math.random() * 250);
      const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 15_000) : backoff + jitter;
      if (deps.sleep) await deps.sleep(delay); else await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const r = await deps.fetchJson(url);
      if (r.ok) return r;
      last = r;
      if (r.status !== 429 && r.status < 500) break;   // 4xx (non-429) will not heal on retry
    } catch (e) {
      last = { ok: false, status: 0, body: null, error: redactSecrets((e && e.message) || e) };
    }
  }
  return last || { ok: false, status: 0, body: null };
}

function freshState() {
  return {
    version: S.PITDATA_V3_VERSION, collector: COLLECTOR_ID,
    initialBackfillComplete: false,
    activeRun: null,               // { runId, date, step, delistedPage, provenance }
    lastCompletedRunDate: null,
    runSeq: 0, runsCompleted: 0,
    prospectiveDates: [],          // distinct dates with a completed prospective_live run
  };
}

// One page fully processed: store content (idempotent by hash), append the
// observation, mark the page complete in the manifest. Content and observation
// are SEPARATE on purpose — the same payload on two dates keeps both sightings.
async function recordPage(deps, { manifest, pageId, endpoint, params, body, httpStatus, provenance }) {
  const nowIso = new Date(deps.now()).toISOString();
  const content = S.makeContentObject(body);
  const contentPath = S.P.content(content.contentHash);
  const existing = await deps.readJSON(contentPath, null);
  if (!existing) await deps.writeJSON(contentPath, content, 0);
  const seq = (manifest.observationCount = (manifest.observationCount || 0) + 1);
  const obs = S.makeObservation({
    endpoint, params, runId: manifest.runId, sequence: seq, date: manifest.date,
    observedAt: nowIso, ingestedAt: nowIso, httpStatus,
    contentHash: content.contentHash, provenance,
  });
  await deps.writeJSON(S.P.observation(manifest.date, manifest.runId, seq), obs, 0);
  if (!manifest.completedPages.includes(pageId)) manifest.completedPages.push(pageId);
  manifest.rowCounts[pageId] = Array.isArray(body) ? body.length : 1;
  manifest.contentHashes[pageId] = content.contentHash;
  return content.contentHash;
}

const instrumentTypeFromVendor = (t) => {
  const v = String(t || '').toLowerCase();
  if (v === 'etf') return 'etf';
  if (v === 'trust' || v === 'fund') return 'fund';
  if (v === 'stock') return 'stock-unverified';   // NOT confirmed common stock until profile corroborates
  return null;                                    // unknown stays unknown — fails closed downstream
};

// One bounded, resumable collection step for TODAY's run. Cursor advances only
// on success; a completed run today idles until tomorrow.
async function collectStepV3(deps) {
  const apiKey = apiKeyOf(deps);
  if (!apiKey) return { ok: false, error: 'FMP_API_KEY missing — collection unavailable (fail closed)' };
  const t0 = deps.now();
  const today = new Date(t0).toISOString().slice(0, 10);
  const nowIso = () => new Date(deps.now()).toISOString();

  const state = (await deps.readJSON(S.P.state(COLLECTOR_ID), null)) || freshState();

  // Close out a stale incomplete run from a previous date honestly (recorded as
  // failed, never silently resumed under today's date) and start fresh.
  if (state.activeRun && state.activeRun.date !== today) {
    const stale = await deps.readJSON(S.P.run(state.activeRun.date, state.activeRun.runId), null);
    if (stale && !stale.complete) {
      stale.completenessStatus = 'failed';
      stale.endedAt = nowIso();
      stale.failures.push({ page: state.activeRun.step, note: 'run abandoned: date rolled over before completion', at: stale.endedAt });
      await deps.writeJSON(S.P.run(stale.date, stale.runId), stale, 0);
    }
    state.activeRun = null;
  }
  if (!state.activeRun && state.lastCompletedRunDate === today) {
    return { ok: true, did: { step: 'idle-until-tomorrow', date: today }, state };
  }
  if (!state.activeRun) {
    state.runSeq++;
    state.activeRun = {
      runId: `run-${today}-${String(state.runSeq).padStart(4, '0')}`,
      date: today, step: 'stock-list', delistedPage: 0,
      provenance: state.initialBackfillComplete ? S.PROVENANCE.PROSPECTIVE_LIVE : S.PROVENANCE.HISTORICAL_RECONSTRUCTION,
    };
    const manifest = S.makeRunManifest({
      runId: state.activeRun.runId, date: today, collector: COLLECTOR_ID,
      provenance: state.activeRun.provenance, startedAt: nowIso(),
    });
    await deps.writeJSON(S.P.run(today, state.activeRun.runId), manifest, 0);
    await deps.writeJSON(S.P.state(COLLECTOR_ID), state, 0);
  }

  const run = state.activeRun;
  const prov = run.provenance;
  const manifest = await deps.readJSON(S.P.run(run.date, run.runId), null)
    || S.makeRunManifest({ runId: run.runId, date: run.date, collector: COLLECTOR_ID, provenance: prov, startedAt: nowIso() });

  // Touched shards, persisted once per step (single serial writer via warm chain).
  const listingShards = new Map(), aliasShards = new Map();
  const listingShardFor = async (symbol) => {
    const k = S.shardKeyFor(symbol);
    if (!listingShards.has(k)) listingShards.set(k, (await deps.readJSON(S.P.listings(k), null)) || { version: S.PITDATA_V3_VERSION, shard: k, listings: {} });
    return listingShards.get(k);
  };
  const aliasCache = {};
  const aliasShardFor = (key) => {
    if (!aliasShards.has(key)) {
      aliasShards.set(key, aliasCache[key] || { version: S.PITDATA_V3_VERSION, shard: key, aliases: {} });
    }
    return aliasShards.get(key);
  };
  // Preload alias shards lazily via async wrapper (upserts call this synchronously,
  // so the shard must be loaded before processing rows that need it).
  const preloadAliasShard = async (key) => {
    if (!aliasShards.has(key) && !aliasCache[key]) {
      aliasCache[key] = (await deps.readJSON(S.P.aliases(key), null)) || { version: S.PITDATA_V3_VERSION, shard: key, aliases: {} };
    }
    return aliasShardFor(key);
  };

  let did = null;
  const failStep = async (pageId, r) => {
    manifest.failures.push({ page: pageId, httpStatus: r ? r.status : null, note: redactSecrets((r && r.error) || 'unavailable'), at: nowIso() });
    await deps.writeJSON(S.P.run(run.date, run.runId), manifest, 0);
    await deps.writeJSON(S.P.state(COLLECTOR_ID), state, 0);   // cursor NOT advanced
    return {
      ok: false, error: `${pageId} unavailable (http ${r ? r.status : '0'}) — capability failure, NOT empty data; cursor not advanced`,
      state, runId: run.runId,
    };
  };

  try {
    if (run.step === 'stock-list') {
      const pageId = 'stock-list';
      if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
      const r = await fetchWithRetry(deps, urlFor('/stock-list', {}, apiKey), pageId, manifest);
      if (!r.ok || !Array.isArray(r.body)) return await failStep(pageId, r);
      await recordPage(deps, { manifest, pageId, endpoint: '/stock-list', params: {}, body: r.body, httpStatus: r.status, provenance: prov });
      const observedAt = nowIso();
      let n = 0;
      for (const row of r.body) {
        if (!row || !row.symbol) continue;
        await preloadAliasShard(I.aliasShardKey(row.symbol));
        const shard = await listingShardFor(row.symbol);
        I.upsertListingV3(shard, aliasShardFor, {
          symbol: row.symbol, exchange: row.exchangeShortName || row.exchange || null,
          status: 'active', instrumentType: instrumentTypeFromVendor(row.type),
          observedAt, provenance: prov, source: 'fmp-stock-list',
        });
        n++;
      }
      run.step = 'delisted';
      did = { step: 'stock-list', rows: n };
    } else if (run.step === 'delisted') {
      let pages = 0, rows = 0;
      while (pages < DELISTED_PAGES_PER_STEP && deps.now() - t0 < STEP_DEADLINE_MS) {
        const pageId = `delisted:${run.delistedPage}`;
        const params = { page: run.delistedPage, limit: 100 };
        if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
        const r = await fetchWithRetry(deps, urlFor('/delisted-companies', params, apiKey), pageId, manifest);
        if (!r.ok || !Array.isArray(r.body)) return await failStep(pageId, r);
        await recordPage(deps, { manifest, pageId, endpoint: '/delisted-companies', params, body: r.body, httpStatus: r.status, provenance: prov });
        const observedAt = nowIso();
        for (const row of r.body) {
          if (!row || !row.symbol) continue;
          await preloadAliasShard(I.aliasShardKey(row.symbol));
          const shard = await listingShardFor(row.symbol);
          I.upsertListingV3(shard, aliasShardFor, {
            symbol: row.symbol, ipoDate: row.ipoDate || null, exchange: row.exchange || null,
            status: 'delisted', statusFrom: row.delistedDate || null,
            confirmation: {
              source: 'fmp-delisted-companies', delistedDate: row.delistedDate || null,
              companyName: row.companyName || null, recordedAt: observedAt,
            },
            observedAt, provenance: prov, source: 'fmp-delisted-companies',
          });
          rows++;
        }
        pages++;
        run.delistedPage++;              // cursor advances ONLY after the page recorded
        if (r.body.length < 100) { run.step = 'symbol-change'; break; }
      }
      did = { step: 'delisted', pages, rows, nextPage: run.delistedPage };
    } else if (run.step === 'symbol-change') {
      const pageId = 'symbol-change';
      if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
      const r = await fetchWithRetry(deps, urlFor('/symbol-change', {}, apiKey), pageId, manifest);
      if (!r.ok || !Array.isArray(r.body)) return await failStep(pageId, r);
      await recordPage(deps, { manifest, pageId, endpoint: '/symbol-change', params: {}, body: r.body, httpStatus: r.status, provenance: prov });
      const observedAt = nowIso();
      let n = 0;
      for (const row of r.body) {
        if (!row || !row.oldSymbol || !row.newSymbol) continue;
        await preloadAliasShard(I.aliasShardKey(row.oldSymbol));
        await preloadAliasShard(I.aliasShardKey(row.newSymbol));
        // Find the listing from EITHER end of the rename via the alias index.
        const byNew = I.entriesForAlias(Object.fromEntries(aliasShards), row.newSymbol);
        const byOld = I.entriesForAlias(Object.fromEntries(aliasShards), row.oldSymbol);
        const listingId = (byNew[0] && byNew[0].listingId) || (byOld[0] && byOld[0].listingId) || null;
        let listing = null;
        if (listingId) {
          for (const [, shard] of listingShards) { if (shard.listings && shard.listings[listingId]) { listing = shard.listings[listingId]; break; } }
          if (!listing) {
            for (const k of [S.shardKeyFor(row.newSymbol), S.shardKeyFor(row.oldSymbol)]) {
              const shard = await listingShardFor(k === S.shardKeyFor(row.newSymbol) ? row.newSymbol : row.oldSymbol);
              if (shard.listings && shard.listings[listingId]) { listing = shard.listings[listingId]; break; }
            }
          }
        }
        if (!listing) {
          const shard = await listingShardFor(row.newSymbol);
          const up = I.upsertListingV3(shard, aliasShardFor, {
            symbol: row.newSymbol, status: null, observedAt, provenance: prov, source: 'fmp-symbol-change',
          });
          listing = up.listing;
        }
        I.applyRename(listing, aliasShardFor, {
          oldSymbol: row.oldSymbol, newSymbol: row.newSymbol, renameDate: row.date || null,
          observedAt, provenance: prov, source: 'fmp-symbol-change',
        });
        n++;
      }
      // Run complete.
      run.step = 'complete';
      manifest.complete = true;
      manifest.completenessStatus = 'complete';
      manifest.endedAt = nowIso();
      state.lastCompletedRunDate = run.date;
      state.runsCompleted++;
      if (prov === S.PROVENANCE.PROSPECTIVE_LIVE && !state.prospectiveDates.includes(run.date)) {
        state.prospectiveDates.push(run.date);
      }
      if (!state.initialBackfillComplete) state.initialBackfillComplete = true;
      state.activeRun = null;
      did = { step: 'symbol-change', rows: n, runComplete: true, provenance: prov };
    }
  } catch (e) {
    manifest.failures.push({ page: run.step, note: redactSecrets((e && e.message) || e), at: nowIso() });
    await deps.writeJSON(S.P.run(run.date, run.runId), manifest, 0);
    await deps.writeJSON(S.P.state(COLLECTOR_ID), state, 0);
    return { ok: false, error: redactSecrets((e && e.message) || e), state };
  }

  for (const [k, shard] of listingShards) await deps.writeJSON(S.P.listings(k), shard, 0);
  for (const [k, shard] of aliasShards) await deps.writeJSON(S.P.aliases(k), shard, 0);
  manifest.updatedAt = nowIso();
  await deps.writeJSON(S.P.run(run.date, run.runId), manifest, 0);
  state.updatedAt = nowIso();
  await deps.writeJSON(S.P.state(COLLECTOR_ID), state, 0);
  return { ok: true, did, state, runId: manifest.runId, shardsWritten: listingShards.size + aliasShards.size };
}

module.exports = {
  COLLECTOR_ID, PROBE_ENDPOINTS_V3, MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS,
  probeCapabilitiesV3, collectStepV3, fetchWithRetry, recordPage, instrumentTypeFromVendor, freshState,
};
