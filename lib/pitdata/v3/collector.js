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
//   * DEFECT 8 — identity enrichment: a free SEC ticker→CIK map plus a bounded,
//     cursor-resumable FMP profile sweep lift listings off ticker-only 'low'
//     confidence (CIK+IPO ⇒ 'medium') and corroborate instrument type — the
//     ONLY path by which 'stock-unverified' becomes 'common_stock'.
//   * Cursors advance ONLY after a page fully succeeds; failures are recorded in
//     the run manifest and the same page is retried by the next step. The one
//     exception is a per-symbol 4xx during the profile sweep: the SYMBOL is
//     skipped (recorded, no data written — fail closed) so one dead ticker can
//     never wedge the sweep; 429/5xx still stop the sweep with the cursor held.
//   * Bounded exponential backoff with injected jitter; 429/Retry-After honored;
//     retries are idempotent (completedPages is a set, content is hash-keyed).
//   * Vendor PLAN GATES (402) are recorded limitations, never infinite retries;
//     the run completes as 'complete-with-limitations'.
//
// ONE INVOCATION now drives as many run steps as fit its deadline, holding state
// in memory between steps — Vercel Blob is eventually consistent, so re-reading
// state between rapid invocations sees stale copies. CONCURRENCY CONTRACT: one
// serial writer (the warm chain). Hand-triggered calls must be spaced ≥30s.
//
// External API failure is "unavailable" — never an empty result. No fabricated
// data: a blocked endpoint is a recorded capability limitation.
//
// deps: { fetchJson(url, opts?) -> {ok, status, body, headers?}, readJSON,
//         writeJSON, now(), sleep(ms)?, jitter(attempt)?, apiKey? } — clock,
// store, network and jitter are all injected for deterministic tests.

const S = require('./schema');
const I = require('./identity');
const { redactSecrets } = require('../../redact');

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const COLLECTOR_ID = 'fmp-identity';

const DELISTED_PAGES_PER_STEP = 5;
// FMP Premium refuses page>0 on delisted-companies ("page can only be 0 on
// your current subscription"), so the ONE allowed page is requested at the
// maximum limit; a 402 on the big limit falls back to 100 before truncating.
const DELISTED_LIMIT = 1000;
const STEP_DEADLINE_MS = 40_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

// Identity-enrichment sweep bounds. ~250 profile calls stay well inside the
// plan's per-minute budget and the serverless deadline; the cursor lives in
// COLLECTOR STATE (not the run), so coverage accrues across daily runs and a
// completed sweep re-runs each calendar month to catch classification drift.
const PROFILE_CALLS_PER_STEP = 250;
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';

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
  try {
    const r = await deps.fetchJson(SEC_TICKERS_URL, { headers: { 'User-Agent': SEC_UA } });
    out.corroboration.secTickerCikMap = { available: !!r.ok, httpStatus: r.status };
  } catch (e) {
    out.corroboration.secTickerCikMap = { available: false, note: redactSecrets((e && e.message) || e) };
  }
  out.corroboration.openfigi = process.env.OPENFIGI_API_KEY
    ? { keyPresent: true }
    : { keyPresent: false, note: 'no OPENFIGI_API_KEY — share-class FIGIs unavailable; identityConfidence capped below high' };
  return { ...out, ok: true };
}

// Bounded exponential backoff with jitter. Retry-After (seconds) is honored on
// 429/503. deps.jitter is injectable for deterministic tests.
async function fetchWithRetry(deps, url, pageId, manifest, fetchOpts = undefined) {
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
      const r = await deps.fetchJson(url, fetchOpts);
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
    // Identity-enrichment sweep cursor — longitudinal, survives across runs.
    profileCursor: { shard: S.SHARD_KEYS[0], idx: 0 },
    profilesCompletedAt: null,
    profilesEnriched: 0,
  };
}

// One page fully processed: store content (idempotent by hash), append the
// observation, mark the page complete in the manifest.
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

// Warrant/unit/right ticker patterns — a profile that is not an ETF/fund/ADR is
// still NOT called common stock when its symbol matches a derivative-security
// suffix (conservative heuristic; unmatched claims stay 'stock-unverified').
const DERIVATIVE_SUFFIX_RE = /[-.](WS|WT|W|U|R|RT)$|[-.]P[A-Z]?$/;

// Instrument type from a full FMP profile — the corroboration step.
function instrumentTypeFromProfile(sym, p) {
  if (p.isEtf === true) return 'etf';
  if (p.isFund === true) return 'fund';
  if (p.isAdr === true) return 'adr';
  if (DERIVATIVE_SUFFIX_RE.test(String(sym || '').toUpperCase())) return 'stock-unverified';
  return 'common_stock';
}

// One bounded, resumable collection invocation for TODAY's run. Executes as many
// run steps as fit the deadline (state held in memory between steps). Cursors
// advance only on success; a completed run today idles until tomorrow.
//
// opts.forceNewRun: privileged same-day operational recovery (fresh runId,
// append-only; never rewrites the previous run).
async function collectStepV3(deps, opts = {}) {
  const apiKey = apiKeyOf(deps);
  if (!apiKey) return { ok: false, error: 'FMP_API_KEY missing — collection unavailable (fail closed)' };
  const t0 = deps.now();
  const today = new Date(t0).toISOString().slice(0, 10);
  const nowIso = () => new Date(deps.now()).toISOString();

  const state = (await deps.readJSON(S.P.state(COLLECTOR_ID), null)) || freshState();
  if (!state.profileCursor) {   // migrate pre-enrichment state docs
    state.profileCursor = { shard: S.SHARD_KEYS[0], idx: 0 };
    state.profilesCompletedAt = null;
    state.profilesEnriched = 0;
  }
  if (opts.forceNewRun && !state.activeRun && state.lastCompletedRunDate === today) {
    state.lastCompletedRunDate = null;   // allow a same-day recovery run (new runId, append-only)
  }
  // Monthly refresh: a finished sweep restarts in a new calendar month so
  // classification drift keeps being re-observed prospectively.
  if (state.profilesCompletedAt && String(state.profilesCompletedAt).slice(0, 7) < today.slice(0, 7)) {
    state.profileCursor = { shard: S.SHARD_KEYS[0], idx: 0 };
    state.profilesCompletedAt = null;
  }

  // Close out a stale incomplete run from a previous date honestly.
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
  if (!state.activeRun && state.lastCompletedRunDate === today && state.profilesCompletedAt) {
    return { ok: true, did: { step: 'idle-until-tomorrow', date: today }, state };
  }
  if (!state.activeRun) {
    // After today's FULL run, further calls run ENRICH-ONLY batches until the
    // profile sweep completes — the sweep is state-scoped, so extra warm-chain
    // steps (or a manual drain) advance coverage without re-pulling the feeds.
    const enrichOnly = state.lastCompletedRunDate === today && !opts.forceNewRun;
    state.runSeq++;
    state.activeRun = {
      runId: `run-${today}-${String(state.runSeq).padStart(4, '0')}`,
      date: today, step: enrichOnly ? 'profiles' : 'stock-list', delistedPage: 0, enrichOnly,
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
  if (!manifest.limitations) manifest.limitations = [];

  // Shard caches held across ALL steps of this invocation (single writer).
  const listingShards = new Map(), aliasShards = new Map();
  const listingShardForKey = async (k) => {
    if (!listingShards.has(k)) listingShards.set(k, (await deps.readJSON(S.P.listings(k), null)) || { version: S.PITDATA_V3_VERSION, shard: k, listings: {} });
    return listingShards.get(k);
  };
  const listingShardFor = (symbol) => listingShardForKey(S.shardKeyFor(symbol));
  const aliasCache = {};
  const aliasShardFor = (key) => {
    if (!aliasShards.has(key)) {
      aliasShards.set(key, aliasCache[key] || { version: S.PITDATA_V3_VERSION, shard: key, aliases: {} });
    }
    return aliasShards.get(key);
  };
  const preloadAliasShard = async (key) => {
    if (!aliasShards.has(key) && !aliasCache[key]) {
      aliasCache[key] = (await deps.readJSON(S.P.aliases(key), null)) || { version: S.PITDATA_V3_VERSION, shard: key, aliases: {} };
    }
    return aliasShardFor(key);
  };
  const findListingAnywhere = (listingId) => {
    for (const [, shard] of listingShards) {
      if (shard.listings && shard.listings[listingId]) return shard.listings[listingId];
    }
    return null;
  };
  const persist = async () => {
    for (const [k, shard] of listingShards) await deps.writeJSON(S.P.listings(k), shard, 0);
    for (const [k, shard] of aliasShards) await deps.writeJSON(S.P.aliases(k), shard, 0);
    manifest.updatedAt = nowIso();
    await deps.writeJSON(S.P.run(run.date, run.runId), manifest, 0);
    state.updatedAt = nowIso();
    await deps.writeJSON(S.P.state(COLLECTOR_ID), state, 0);
  };

  // The vendor's error BODY names the gate (plan limit, bandwidth, endpoint
  // tier) — a redacted snippet makes an opaque 402/403 diagnosable.
  const bodyNoteOf = (r) => {
    if (!r || r.body == null) return null;
    try { return redactSecrets(JSON.stringify(r.body).slice(0, 240)); } catch { return null; }
  };
  const failStep = async (pageId, r) => {
    manifest.failures.push({
      page: pageId, httpStatus: r ? r.status : null,
      note: redactSecrets((r && r.error) || 'unavailable'),
      bodyNote: bodyNoteOf(r), at: nowIso(),
    });
    await persist();   // cursor NOT advanced
    return {
      ok: false, error: `${pageId} unavailable (http ${r ? r.status : '0'}) — capability failure, NOT empty data; cursor not advanced`,
      bodyNote: bodyNoteOf(r),
      state, runId: run.runId,
    };
  };

  const completeRun = () => {
    run.step = 'complete';
    manifest.complete = true;
    manifest.completenessStatus = (manifest.limitations || []).length ? 'complete-with-limitations' : 'complete';
    manifest.endedAt = nowIso();
    state.lastCompletedRunDate = run.date;
    state.runsCompleted++;
    if (prov === S.PROVENANCE.PROSPECTIVE_LIVE && !state.prospectiveDates.includes(run.date)) {
      state.prospectiveDates.push(run.date);
    }
    if (!state.initialBackfillComplete) state.initialBackfillComplete = true;
    state.activeRun = null;
  };

  // ── one step of the run state machine ───────────────────────────────────────
  async function runOneStep() {
    if (run.step === 'stock-list') {
      const pageId = 'stock-list';
      if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
      const r = await fetchWithRetry(deps, urlFor('/stock-list', {}, apiKey), pageId, manifest);
      if (!r.ok || !Array.isArray(r.body)) return failStep(pageId, r);
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
        }, { findListing: findListingAnywhere });
        n++;
      }
      run.step = 'delisted';
      return { step: 'stock-list', rows: n };
    }

    if (run.step === 'delisted') {
      let pages = 0, rows = 0, truncatedByPlanGate = null;
      while (pages < DELISTED_PAGES_PER_STEP && deps.now() - t0 < STEP_DEADLINE_MS) {
        const pageId = `delisted:${run.delistedPage}`;
        let params = { page: run.delistedPage, limit: DELISTED_LIMIT };
        if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
        let r = await fetchWithRetry(deps, urlFor('/delisted-companies', params, apiKey), pageId, manifest);
        if (!r.ok && r.status === 402 && params.limit > 100) {
          manifest.limitations.push({
            page: pageId, httpStatus: 402, bodyNote: bodyNoteOf(r),
            note: `plan-gated: limit=${params.limit} refused — falling back to limit=100`, at: nowIso(),
          });
          params = { page: run.delistedPage, limit: 100 };
          r = await fetchWithRetry(deps, urlFor('/delisted-companies', params, apiKey), pageId, manifest);
        }
        if (!r.ok && r.status === 402) {
          // A plan gate is a capability boundary, not a transient failure:
          // record the truncation and move on. The page stays requested-but-
          // not-completed, so the allPagesCollected gate honestly fails.
          manifest.limitations.push({
            page: pageId, httpStatus: 402, bodyNote: bodyNoteOf(r),
            note: 'plan-gated: vendor refuses this page on the current subscription — feed TRUNCATED at the previous page, not retried',
            at: nowIso(),
          });
          run.step = 'symbol-change';
          truncatedByPlanGate = pageId;
          break;
        }
        if (!r.ok || !Array.isArray(r.body)) return failStep(pageId, r);
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
          }, { findListing: findListingAnywhere });
          rows++;
        }
        pages++;
        run.delistedPage++;              // cursor advances ONLY after the page recorded
        if (r.body.length < params.limit) { run.step = 'symbol-change'; break; }
      }
      return { step: 'delisted', pages, rows, nextPage: run.delistedPage, ...(truncatedByPlanGate ? { truncatedByPlanGate } : {}) };
    }

    if (run.step === 'symbol-change') {
      const pageId = 'symbol-change';
      if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
      const r = await fetchWithRetry(deps, urlFor('/symbol-change', {}, apiKey), pageId, manifest);
      if (!r.ok || !Array.isArray(r.body)) return failStep(pageId, r);
      await recordPage(deps, { manifest, pageId, endpoint: '/symbol-change', params: {}, body: r.body, httpStatus: r.status, provenance: prov });
      const observedAt = nowIso();
      let n = 0;
      for (const row of r.body) {
        if (!row || !row.oldSymbol || !row.newSymbol) continue;
        await preloadAliasShard(I.aliasShardKey(row.oldSymbol));
        await preloadAliasShard(I.aliasShardKey(row.newSymbol));
        const byNew = I.entriesForAlias(Object.fromEntries(aliasShards), row.newSymbol);
        const byOld = I.entriesForAlias(Object.fromEntries(aliasShards), row.oldSymbol);
        const listingId = (byNew[0] && byNew[0].listingId) || (byOld[0] && byOld[0].listingId) || null;
        let listing = listingId ? findListingAnywhere(listingId) : null;
        if (listingId && !listing) {
          for (const sym of [row.newSymbol, row.oldSymbol]) {
            const shard = await listingShardFor(sym);
            if (shard.listings && shard.listings[listingId]) { listing = shard.listings[listingId]; break; }
          }
        }
        if (!listing) {
          const shard = await listingShardFor(row.newSymbol);
          const up = I.upsertListingV3(shard, aliasShardFor, {
            symbol: row.newSymbol, status: null, observedAt, provenance: prov, source: 'fmp-symbol-change',
          }, { findListing: findListingAnywhere });
          listing = up.listing;
        }
        I.applyRename(listing, aliasShardFor, {
          oldSymbol: row.oldSymbol, newSymbol: row.newSymbol, renameDate: row.date || null,
          observedAt, provenance: prov, source: 'fmp-symbol-change',
        });
        n++;
      }
      run.step = 'sec-cik-map';
      return { step: 'symbol-change', rows: n };
    }

    if (run.step === 'sec-cik-map') {
      // FREE corroboration: SEC ticker→CIK for every registrant. Failure is a
      // recorded limitation (SEC is corroboration, not a required feed) — it
      // lowers achievable identity confidence, it never blocks the run.
      const pageId = 'sec-cik-map';
      if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
      const r = await fetchWithRetry(deps, SEC_TICKERS_URL, pageId, manifest, { headers: { 'User-Agent': SEC_UA } });
      let enriched = 0, conflicts = 0;
      if (r.ok && r.body && typeof r.body === 'object') {
        await recordPage(deps, { manifest, pageId, endpoint: 'sec:company_tickers.json', params: {}, body: r.body, httpStatus: r.status, provenance: prov });
        for (const entry of Object.values(r.body)) {
          const sym = String((entry && entry.ticker) || '').toUpperCase();
          const cik = I.normCik(entry && entry.cik_str);
          if (!sym || !cik) continue;
          const idxShard = await preloadAliasShard(I.aliasShardKey(sym));
          const claims = ((idxShard.aliases || {})[sym] || []).filter((e) => !e.effectiveTo);
          const ids = [...new Set(claims.map((e) => e.listingId))];
          if (ids.length !== 1) continue;   // ambiguous/unknown ticker — fail closed, no guess
          await listingShardForKey(S.shardKeyFor(sym));   // ensure home shard loaded
          let listing = findListingAnywhere(ids[0]);
          if (!listing) {
            for (const k of S.SHARD_KEYS) {
              await listingShardForKey(k);
              listing = findListingAnywhere(ids[0]);
              if (listing) break;
            }
          }
          if (!listing) continue;
          if (listing.identity.cik && listing.identity.cik !== cik) {
            if (!listing.identityCandidates.includes(`sec-cik:${cik}`)) listing.identityCandidates.push(`sec-cik:${cik}`);
            conflicts++;
            continue;   // competing identity preserved, never overwritten
          }
          if (!listing.identity.cik) {
            listing.identity.cik = cik;
            listing.identity.vendorIds['sec-company-tickers'] = cik;
            listing.identityConfidence = I.identityConfidenceFor(listing.identity);
            enriched++;
          }
        }
      } else {
        manifest.limitations.push({
          page: pageId, httpStatus: r ? r.status : null, bodyNote: bodyNoteOf(r),
          note: 'sec-cik-map unavailable — corroboration skipped this run (identity confidence capped, collection continues)',
          at: nowIso(),
        });
      }
      run.step = 'profiles';
      return { step: 'sec-cik-map', enriched, conflicts, available: !!(r && r.ok) };
    }

    if (run.step === 'profiles') {
      // Bounded identity-enrichment sweep. The cursor is COLLECTOR STATE: the
      // run completes after one budgeted batch and tomorrow's run resumes
      // where this one stopped. Only listings that still need enrichment are
      // fetched; per-symbol 4xx skips the symbol (recorded, nothing written);
      // 429/5xx stops the sweep with the cursor held.
      let calls = 0, enriched = 0, skipped4xx = 0;
      let stoppedBy = null;
      const cur = state.profileCursor;
      const startShardIdx = S.SHARD_KEYS.indexOf(cur.shard) >= 0 ? S.SHARD_KEYS.indexOf(cur.shard) : 0;
      outer:
      for (let si = startShardIdx; si < S.SHARD_KEYS.length; si++) {
        const shardKey = S.SHARD_KEYS[si];
        const shard = await listingShardForKey(shardKey);
        const ids = Object.keys(shard.listings || {}).sort();
        for (let li = (si === startShardIdx ? cur.idx : 0); li < ids.length; li++) {
          if (calls >= PROFILE_CALLS_PER_STEP || deps.now() - t0 >= STEP_DEADLINE_MS) {
            cur.shard = shardKey; cur.idx = li;
            stoppedBy = calls >= PROFILE_CALLS_PER_STEP ? 'call-budget' : 'deadline';
            break outer;
          }
          const listing = shard.listings[ids[li]];
          const isActive = (listing.status || []).some((iv) => iv.value === 'active' && !iv.effectiveTo);
          const needsIdentity = !listing.identity.cik || !listing.identity.ipoDate;
          const needsType = !(listing.instrumentType || []).some((iv) => iv.value && iv.value !== 'stock-unverified');
          const needsCls = !(listing.classification || []).length;
          if (!isActive || !(needsIdentity || needsType || needsCls)) continue;
          const sym = listing.symbol;
          calls++;
          const r = await fetchWithRetry(deps, urlFor('/profile', { symbol: sym }, apiKey), `profile:${sym}`, manifest);
          if (!r.ok) {
            if (r.status === 429 || r.status >= 500 || r.status === 0) {
              cur.shard = shardKey; cur.idx = li;       // cursor HELD — resume at this symbol
              stoppedBy = `http-${r.status}`;
              manifest.failures.push({ page: `profile:${sym}`, httpStatus: r.status, bodyNote: bodyNoteOf(r), note: 'profile sweep stopped — cursor held', at: nowIso() });
              break outer;
            }
            skipped4xx++;                                // dead ticker — recorded, nothing written, sweep moves on
            if (skipped4xx <= 5) manifest.failures.push({ page: `profile:${sym}`, httpStatus: r.status, note: 'profile 4xx — symbol skipped (fail closed, no data written)', at: nowIso() });
            continue;
          }
          const p = Array.isArray(r.body) ? r.body[0] : r.body;
          if (!p || typeof p !== 'object') { skipped4xx++; continue; }
          (manifest.profileBatch ||= []).push({ symbol: sym, body: p });
          const observedAt = nowIso();
          I.upsertListingV3(shard, aliasShardFor, {
            symbol: sym,
            cik: p.cik != null ? String(p.cik) : null,
            ipoDate: p.ipoDate || null,
            exchange: p.exchangeShortName || p.exchange || null,
            status: 'active',
            instrumentType: instrumentTypeFromProfile(sym, p),
            sector: p.sector || null, industry: p.industry || null,
            country: p.country || null, currency: p.currency || null,
            observedAt, provenance: prov, source: 'fmp-profile',
          }, { findListing: findListingAnywhere });
          // Identity fields merge onto the SAME listing (id assigned once).
          if (I.normCik(p.cik) && !listing.identity.cik) listing.identity.cik = I.normCik(p.cik);
          if (p.ipoDate && !listing.identity.ipoDate) listing.identity.ipoDate = p.ipoDate;
          listing.identityConfidence = I.identityConfidenceFor(listing.identity);
          listing.marketDataCoverage = listing.marketDataCoverage || Number.isFinite(p.mktCap) || Number.isFinite(p.marketCap);
          enriched++;
          state.profilesEnriched++;
        }
        cur.shard = S.SHARD_KEYS[Math.min(si + 1, S.SHARD_KEYS.length - 1)];
        cur.idx = 0;
        if (si === S.SHARD_KEYS.length - 1 && !stoppedBy) {
          state.profilesCompletedAt = nowIso();
          cur.shard = S.SHARD_KEYS[0]; cur.idx = 0;
        }
      }
      // The batch of exact per-call payloads is stored as ONE content object
      // per run step (volume tradeoff, documented): params carry the symbols.
      if ((manifest.profileBatch || []).length) {
        const pageId = `profiles:${run.runId}`;
        if (!manifest.requestedPages.includes(pageId)) manifest.requestedPages.push(pageId);
        await recordPage(deps, {
          manifest, pageId, endpoint: '/profile#batch',
          params: { symbols: manifest.profileBatch.map((x) => x.symbol) },
          body: manifest.profileBatch, httpStatus: 200, provenance: prov,
        });
        delete manifest.profileBatch;
      }
      completeRun();
      return {
        step: 'profiles', calls, enriched, skipped4xx, stoppedBy,
        sweepComplete: !!state.profilesCompletedAt,
        cursor: { ...state.profileCursor },
        runComplete: true, provenance: prov,
      };
    }

    return null;
  }

  // ── drive as many steps as fit the deadline ─────────────────────────────────
  let did = null;
  try {
    while (deps.now() - t0 < STEP_DEADLINE_MS) {
      const out = await runOneStep();
      if (out === null) break;
      if (out && out.ok === false) return out;   // failStep already persisted
      did = out;
      await persist();
      if (!state.activeRun) break;               // run completed
    }
  } catch (e) {
    manifest.failures.push({ page: run.step, note: redactSecrets((e && e.message) || e), at: nowIso() });
    await persist();
    return { ok: false, error: redactSecrets((e && e.message) || e), state };
  }

  return { ok: true, did, state, runId: manifest.runId, shardsWritten: listingShards.size + aliasShards.size };
}

module.exports = {
  COLLECTOR_ID, PROBE_ENDPOINTS_V3, MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS,
  DELISTED_LIMIT, PROFILE_CALLS_PER_STEP, SEC_TICKERS_URL,
  probeCapabilitiesV3, collectStepV3, fetchWithRetry, recordPage,
  instrumentTypeFromVendor, instrumentTypeFromProfile, freshState,
};
