'use strict';
// PIT-DATA-V2 COLLECTOR — capability probe + cursor-based, bounded, resumable FMP
// ingestion into the sharded identity store. Shadow system: writes only under the
// `pitdata/` Blob prefix; no live consumer reads it.
//
// Design constraints honored:
//  * CAPABILITY-PROBE FIRST. The subscription tier is never assumed: each endpoint is
//    probed with one bounded call and recorded available/blocked/error. A blocked
//    endpoint is a recorded LIMITATION, never interpreted as empty data.
//  * BOUNDED + RESUMABLE + IDEMPOTENT. Each collect step does a fixed amount of work
//    inside a serverless deadline and advances a cursor; raw responses are stored
//    content-addressed (hash = key), so replays cannot duplicate.
//  * NO KEY LEAKAGE. URLs are built here, never logged; errors pass redactSecrets();
//    raw-snapshot params are sanitized by the schema factory.
//  * PROVENANCE. Everything this collector backfills is 'historical_reconstruction'
//    with knownAt = ingest time. Only facts first observed by a later live run may be
//    'prospective_live'.

const S = require('./schema');
const { redactSecrets } = require('../redact');

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const STATE_PATH = 'pitdata/state.json';
const shardPath = (k) => `pitdata/identity/${k}.json`;
const rawPath = (hash) => `pitdata/raw/${hash.slice(0, 16)}.json`;

const DELISTED_PAGES_PER_STEP = 5;     // bounded pagination per invocation
const STEP_DEADLINE_MS = 40_000;       // stay inside the serverless budget

// Endpoints probed. `sample` keeps each probe to one cheap call.
const PROBE_ENDPOINTS = Object.freeze([
  { id: 'stock-list', path: '/stock-list', params: {} },
  { id: 'actively-trading-list', path: '/actively-trading-list', params: {} },
  { id: 'delisted-companies', path: '/delisted-companies', params: { page: 0, limit: 100 } },
  { id: 'symbol-change', path: '/symbol-change', params: {} },
  { id: 'profile', path: '/profile', params: { symbol: 'AAPL' } },
  { id: 'historical-market-capitalization', path: '/historical-market-capitalization', params: { symbol: 'AAPL', limit: 5 } },
  { id: 'splits', path: '/splits', params: { symbol: 'AAPL' } },
  { id: 'dividends', path: '/dividends', params: { symbol: 'AAPL' } },
]);

function urlFor(path, params, apiKey) {
  const u = new URL(FMP_BASE + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  u.searchParams.set('apikey', apiKey);
  return u.toString();
}

// deps: { fetchJson(url) -> {ok, status, body}, readJSON, writeJSON, now(), apiKey? }
// apiKey is injectable for tests; production callers omit it and get the env var.
const apiKeyOf = (deps) => (deps.apiKey !== undefined ? deps.apiKey : process.env.FMP_API_KEY);

async function probeCapabilities(deps) {
  const apiKey = apiKeyOf(deps);
  if (!apiKey) return { ok: false, error: 'FMP_API_KEY missing', endpoints: {} };
  const endpoints = {};
  for (const ep of PROBE_ENDPOINTS) {
    try {
      const r = await deps.fetchJson(urlFor(ep.path, ep.params, apiKey));
      const rows = Array.isArray(r.body) ? r.body.length : (r.body ? 1 : 0);
      endpoints[ep.id] = r.ok && rows > 0
        ? { available: true, httpStatus: r.status, sampleRows: rows }
        : { available: false, httpStatus: r.status, note: rows === 0 && r.ok ? 'empty-response' : 'blocked-or-error' };
    } catch (e) {
      endpoints[ep.id] = { available: false, note: redactSecrets((e && e.message) || e) };
    }
  }
  return { ok: true, probedAt: new Date(deps.now()).toISOString(), endpoints };
}

// Merge one observed listing fact into a shard (in place on the shard doc the caller
// owns for this step; persisted once per step — no read-modify-write races since the
// collector is the only writer and runs serially via the warm chain).
function upsertListing(shard, { symbol, ipoDate = null, cik = null, exchange = null, status, statusDate = null, confirmation = null, sector = null, industry = null, knownAt, provenance }) {
  const id = S.listingIdFor({ symbol, ipoDate, cik });
  const listings = (shard.listings ||= {});
  const l = (listings[id] ||= S.makeListing({ listingId: id, symbol, exchange, cik, ipoDate }));
  if (exchange && !l.exchange) l.exchange = exchange;
  if (cik && !l.cik) l.cik = cik;
  if (!(l.aliases || []).some((a) => a.value === String(symbol).toUpperCase())) {
    l.aliases.push(S.makeInterval({ value: String(symbol).toUpperCase(), effectiveFrom: ipoDate, effectiveTo: statusDate, knownAt, source: 'fmp', provenance }));
  }
  if (status === 'delisted') {
    // The vendor row confirms BOTH facts: listed over [ipoDate, delistedDate), then
    // delisted from delistedDate on. Recording the active window too means an as-of
    // query inside the listing's life resolves 'active' instead of failing closed.
    if (ipoDate && statusDate) {
      l.status.push(S.makeInterval({ value: 'active', effectiveFrom: ipoDate, effectiveTo: statusDate, knownAt, source: 'fmp', provenance }));
    }
    l.status.push(S.makeInterval({
      value: 'delisted', effectiveFrom: statusDate, knownAt, source: 'fmp', provenance, confirmation,
    }));
  } else if (status === 'active') {
    // A current-list observation proves "active AS OF the observation", nothing
    // earlier: without an ipoDate the interval starts at the observation date, so
    // current API state can never masquerade as historical knowledge (and can never
    // create false ambiguity against an older delisted listing of the same ticker).
    l.status.push(S.makeInterval({
      value: 'active',
      effectiveFrom: ipoDate || String(knownAt || '').slice(0, 10) || null,
      knownAt, source: 'fmp', provenance,
    }));
  }
  if (sector || industry) {
    l.classification.push(S.makeInterval({ value: { sector, industry }, knownAt, source: 'fmp', provenance }));
  }
  return id;
}

async function saveRaw(deps, snapMeta, payload) {
  // Content-addressed: replays land on the same key. Payload stored beside meta so an
  // auditor can re-derive everything; hash collisions are content identity, not loss.
  await deps.writeJSON(rawPath(snapMeta.responseHash), { meta: snapMeta, payload }, 0);
}

// One bounded, resumable collection step. state.step ∈ stock-list → delisted →
// symbol-change → done.
async function collectStep(deps) {
  const apiKey = apiKeyOf(deps);
  if (!apiKey) return { ok: false, error: 'FMP_API_KEY missing' };
  const t0 = deps.now();
  const nowIso = () => new Date(deps.now()).toISOString();
  const state = (await deps.readJSON(STATE_PATH, null)) || { version: S.PITDATA_VERSION, step: 'stock-list', delistedPage: 0, counts: {} };
  const prov = S.PROVENANCE.HISTORICAL_RECONSTRUCTION;   // backfill; live re-observation upgrades later
  const touched = new Map();   // shardKey -> shard doc

  const shardFor = async (symbol) => {
    const k = S.shardKeyFor(symbol);
    if (!touched.has(k)) touched.set(k, (await deps.readJSON(shardPath(k), null)) || { version: S.PITDATA_VERSION, shard: k, listings: {} });
    return touched.get(k);
  };

  let did = null;
  try {
    if (state.step === 'stock-list') {
      const r = await deps.fetchJson(urlFor('/stock-list', {}, apiKey));
      if (!r.ok || !Array.isArray(r.body)) return { ok: false, error: `stock-list unavailable (http ${r.status}) — capability failure, NOT empty data`, state };
      const knownAt = nowIso();
      await saveRaw(deps, S.makeRawSnapshot({ endpoint: '/stock-list', params: {}, payload: { rows: r.body.length }, knownAt, ingestedAt: knownAt, provenance: prov }), null);
      let n = 0;
      for (const row of r.body) {
        if (!row || !row.symbol) continue;
        const shard = await shardFor(row.symbol);
        upsertListing(shard, {
          symbol: row.symbol, exchange: row.exchangeShortName || row.exchange || null,
          status: 'active', knownAt, provenance: prov,
        });
        n++;
      }
      state.counts.stockList = n;
      state.step = 'delisted';
      did = { step: 'stock-list', rows: n };
    } else if (state.step === 'delisted') {
      let pages = 0, rows = 0;
      while (pages < DELISTED_PAGES_PER_STEP && deps.now() - t0 < STEP_DEADLINE_MS) {
        const params = { page: state.delistedPage, limit: 100 };
        const r = await deps.fetchJson(urlFor('/delisted-companies', params, apiKey));
        if (!r.ok) return { ok: false, error: `delisted-companies page ${state.delistedPage} unavailable (http ${r.status}) — capability failure, NOT empty data`, state };
        const body = Array.isArray(r.body) ? r.body : [];
        const knownAt = nowIso();
        await saveRaw(deps, S.makeRawSnapshot({ endpoint: '/delisted-companies', params, payload: body, knownAt, ingestedAt: knownAt, provenance: prov }), body);
        for (const row of body) {
          if (!row || !row.symbol) continue;
          const shard = await shardFor(row.symbol);
          upsertListing(shard, {
            symbol: row.symbol, ipoDate: row.ipoDate || null, exchange: row.exchange || null,
            status: 'delisted', statusDate: row.delistedDate || null,
            confirmation: { source: 'fmp-delisted-companies', delistedDate: row.delistedDate || null, companyName: row.companyName || null },
            knownAt, provenance: prov,
          });
          rows++;
        }
        pages++;
        state.delistedPage++;
        if (body.length < 100) { state.step = 'symbol-change'; break; }   // final page reached
      }
      state.counts.delisted = (state.counts.delisted || 0) + rows;
      did = { step: 'delisted', pages, rows, nextPage: state.delistedPage };
    } else if (state.step === 'symbol-change') {
      const r = await deps.fetchJson(urlFor('/symbol-change', {}, apiKey));
      const knownAt = nowIso();
      if (r.ok && Array.isArray(r.body)) {
        await saveRaw(deps, S.makeRawSnapshot({ endpoint: '/symbol-change', params: {}, payload: r.body, knownAt, ingestedAt: knownAt, provenance: prov }), r.body);
        let n = 0;
        for (const row of r.body) {
          if (!row || !row.oldSymbol || !row.newSymbol) continue;
          // A rename closes the old alias and opens the new one on the SAME listing.
          const shard = await shardFor(row.newSymbol);
          const id = upsertListing(shard, { symbol: row.newSymbol, status: null, knownAt, provenance: prov });
          const l = shard.listings[id];
          l.aliases.push(S.makeInterval({ value: String(row.oldSymbol).toUpperCase(), effectiveTo: row.date || null, knownAt, source: 'fmp-symbol-change', provenance: prov }));
          n++;
        }
        state.counts.symbolChange = n;
        did = { step: 'symbol-change', rows: n };
      } else {
        did = { step: 'symbol-change', skipped: `unavailable (http ${r.status}) — recorded, not treated as empty` };
        state.counts.symbolChangeUnavailable = true;
      }
      state.step = 'done';
    } else {
      did = { step: 'done' };
    }
  } catch (e) {
    return { ok: false, error: redactSecrets((e && e.message) || e), state };
  }

  for (const [k, shard] of touched) await deps.writeJSON(shardPath(k), shard, 0);
  state.updatedAt = nowIso();
  await deps.writeJSON(STATE_PATH, state, 0);
  return { ok: true, did, state, shardsWritten: touched.size };
}

module.exports = {
  PROBE_ENDPOINTS, STATE_PATH, shardPath, rawPath,
  probeCapabilities, collectStep, upsertListing,
};
