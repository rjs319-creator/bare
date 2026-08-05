'use strict';
// BULK QUOTE PROVIDER — one clean interface for "current price snapshot for MANY tickers in
// FEW requests", so the broad intraday discovery scan never fans out one-request-per-name
// across a ~2,000-name universe.
//
// Providers, in preference order:
//   1. fmp-batch   — FMP /stable/batch-quote (paid key). Volume + previousClose + timestamp.
//                    NOTE: this endpoint answers 402 "Restricted Endpoint" on the current
//                    subscription, so in practice it is skipped — kept first because it is the
//                    contractual source and will be used again if the plan changes.
//   2. yahoo-quote — Yahoo /v7/finance/quote behind the cookie+crumb handshake. Carries
//                    VOLUME, open, day high/low and a 3-month average volume. Measured at 300
//                    symbols/request in ~165 ms; chunked at 200. This is what actually serves
//                    the scan today.
//   3. yahoo-spark — keyless Yahoo /v7/finance/spark. Price and prior close only, NO volume,
//                    and capped at 20 symbols per request. Last resort.
//
// WHY THE ORDER MATTERS: three of the seven discovery lanes in lib/mover-discovery.js
// (relative volume, volume acceleration, low-float turnover) need a share count. Falling
// through to spark silently disables them, so `volumeAvailable` is reported on every result
// and the discovery coverage says plainly when recall is reduced.
//
// A provider that errors or returns an unusable shape is skipped for the call; the result
// always reports which provider answered, how many names it covered, and which capabilities
// were actually available — degraded coverage is REPORTED, never papered over.
//
// Politeness: bounded chunk concurrency (4) and hard per-request timeouts. A full ~4,700-name
// scan is ~24 yahoo-quote requests (~1 s) — far below the app's existing per-cron fan-out, and
// never thousands of simultaneous sockets.

const { fetchWithTimeout } = require('./http');

const FMP_CHUNK = 200;
// Yahoo's spark endpoint enforces a HARD symbol cap and answers 400 above it:
//   {"error":{"code":"Bad Request","description":"Number of symbols needs to be less than or equal to 20"}}
// This was 40, which meant EVERY spark chunk failed and the keyless fallback silently
// returned zero rows for any request larger than 20 symbols. The failure mode was invisible
// because a failed chunk is swallowed by mapChunks and the coverage report only counts what
// came back — a full-universe scan simply reported "0 candidates" and looked like a quiet day.
// Verified against the live endpoint: 20 symbols → 200 OK, 40 symbols → 400 Bad Request.
const SPARK_CHUNK = 20;
const CHUNK_CONCURRENCY = 4;
const TIMEOUT_MS = 9000;

async function mapChunks(chunks, fn) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < chunks.length) {
      const idx = i++;
      try { out[idx] = await fn(chunks[idx]); } catch { out[idx] = null; }
    }
  };
  await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, worker));
  return out.filter(Boolean).flat();
}

const chunk = (arr, n) => {
  const c = [];
  for (let i = 0; i < arr.length; i += n) c.push(arr.slice(i, i + n));
  return c;
};

// FMP /stable/batch-quote → normalized rows. Shape-checked at runtime (a plan or endpoint
// change degrades to the fallback provider rather than fabricating data).
async function fmpBatchQuotes(tickers, apiKey) {
  const rows = await mapChunks(chunk(tickers, FMP_CHUNK), async syms => {
    const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${syms.join(',')}&apikey=${apiKey}`;
    const r = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.map(q => (q && q.symbol && q.price != null) ? {
      ticker: String(q.symbol).toUpperCase(),
      price: +q.price,
      prevClose: q.previousClose != null ? +q.previousClose : null,
      dayVolume: q.volume != null ? +q.volume : null,
      // ADDITIVE session fields (used by the Stage-0 gap and range lanes in
      // lib/mover-discovery.js). Absent on providers that do not supply them → null, never
      // derived, so a consumer can always tell "unknown" from "unchanged".
      open: q.open != null ? +q.open : null,
      dayHigh: q.dayHigh != null ? +q.dayHigh : null,
      dayLow: q.dayLow != null ? +q.dayLow : null,
      avgVolume: q.avgVolume != null ? +q.avgVolume : null,
      // FMP timestamp is unix seconds of the quote; absent → null (age unknown, fails closed downstream).
      asOf: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : null,
    } : null).filter(Boolean);
  });
  return rows;
}

// Yahoo /v7/finance/quote (cookie+crumb, batched) → normalized rows WITH VOLUME.
//
// This is the provider that keeps the volume-dependent discovery lanes alive. FMP's
// /stable/batch-quote answers 402 "Restricted Endpoint" on the current subscription, and the
// keyless spark endpoint carries no volume at all — without this, relative volume, volume
// acceleration and low-float turnover (three of the seven discovery lanes) simply cannot run.
//
// The endpoint is behind Yahoo's cookie+crumb handshake, which lib/options-baseline.js
// already implements and caches per process; reusing it avoids a second implementation of a
// flow that has broken before. Measured cap: 300 symbols per request in ~165 ms with 100%
// volume coverage. Chunked at 200 for headroom.
const YAHOO_QUOTE_CHUNK = 200;

async function yahooQuotes(tickers) {
  const { yahooAuth } = require('./options-baseline');
  let auth = await yahooAuth();
  if (!auth) return [];

  const fetchChunk = async (syms, retry = true) => {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms.join(',')}`
      + `&crumb=${encodeURIComponent(auth.crumb)}`;
    const r = await fetchWithTimeout(url, {
      timeoutMs: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Cookie': auth.cookie },
    });
    // A stale crumb answers 401 — refresh once and retry this chunk.
    if (r.status === 401 && retry) {
      auth = await yahooAuth(true);
      if (!auth) return null;
      return fetchChunk(syms, false);
    }
    if (!r.ok) return null;
    const j = await r.json();
    const rows = j && j.quoteResponse && Array.isArray(j.quoteResponse.result) ? j.quoteResponse.result : null;
    if (!rows) return null;
    return rows.map(q => (q && q.symbol && q.regularMarketPrice != null) ? {
      ticker: String(q.symbol).toUpperCase(),
      price: +q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose != null ? +q.regularMarketPreviousClose : null,
      dayVolume: q.regularMarketVolume != null ? +q.regularMarketVolume : null,
      open: q.regularMarketOpen != null ? +q.regularMarketOpen : null,
      dayHigh: q.regularMarketDayHigh != null ? +q.regularMarketDayHigh : null,
      dayLow: q.regularMarketDayLow != null ? +q.regularMarketDayLow : null,
      avgVolume: q.averageDailyVolume3Month != null ? +q.averageDailyVolume3Month : null,
      // Provider quote time in unix seconds; absent → null so the freshness gate fails closed
      // rather than stamping the row with server time.
      asOf: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
    } : null).filter(Boolean);
  };

  return mapChunks(chunk(tickers, YAHOO_QUOTE_CHUNK), fetchChunk);
}

// Yahoo spark (keyless, batched) → normalized rows. No volume — reported via capabilities.
async function yahooSparkQuotes(tickers) {
  const rows = await mapChunks(chunk(tickers, SPARK_CHUNK), async syms => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${syms.join(',')}&range=1d&interval=5m`;
    const r = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const results = j && j.spark && Array.isArray(j.spark.result) ? j.spark.result : null;
    if (!results) return null;
    return results.map(entry => {
      const resp = entry && entry.response && entry.response[0];
      const meta = resp && resp.meta;
      if (!meta || meta.regularMarketPrice == null) return null;
      return {
        ticker: String(entry.symbol).toUpperCase(),
        price: +meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose != null ? +meta.chartPreviousClose : (meta.previousClose != null ? +meta.previousClose : null),
        dayVolume: null,
        open: null, dayHigh: null, dayLow: null, avgVolume: null,   // spark meta carries none of these
        asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      };
    }).filter(Boolean);
  });
  return rows;
}

// Fetch a bulk snapshot for `tickers`. Returns { rows, coverage } where coverage is the
// honest capability/completeness report the discovery scan surfaces to the user.
async function fetchBulkQuotes(tickers) {
  const wanted = [...new Set((tickers || []).map(t => String(t).toUpperCase()))];
  if (!wanted.length) return { rows: [], coverage: { requested: 0, returned: 0, provider: null, volumeAvailable: false } };

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      const rows = await fmpBatchQuotes(wanted, fmpKey);
      // Sanity: a healthy batch answer covers a meaningful share of the request.
      if (rows.length >= Math.min(20, wanted.length * 0.3)) {
        return { rows, coverage: { requested: wanted.length, returned: rows.length, provider: 'fmp-batch', volumeAvailable: rows.some(r => r.dayVolume != null) } };
      }
    } catch { /* fall through to spark */ }
  }
  // SECOND CHOICE — crumb-authenticated Yahoo quote. Carries VOLUME, so it keeps the
  // volume-dependent discovery lanes alive when the paid batch endpoint is unavailable.
  try {
    const rows = await yahooQuotes(wanted);
    if (rows.length >= Math.min(20, wanted.length * 0.3)) {
      return { rows, coverage: { requested: wanted.length, returned: rows.length, provider: 'yahoo-quote', volumeAvailable: rows.some(r => r.dayVolume != null) } };
    }
  } catch { /* fall through to spark */ }

  // LAST RESORT — keyless spark. Price only: no volume, so three of the seven discovery
  // lanes go dark. Reported honestly via volumeAvailable rather than papered over.
  try {
    const rows = await yahooSparkQuotes(wanted);
    return { rows, coverage: { requested: wanted.length, returned: rows.length, provider: 'yahoo-spark', volumeAvailable: false } };
  } catch {
    return { rows: [], coverage: { requested: wanted.length, returned: 0, provider: 'none', volumeAvailable: false } };
  }
}

module.exports = { fetchBulkQuotes, fmpBatchQuotes, yahooQuotes, yahooSparkQuotes, FMP_CHUNK, SPARK_CHUNK, YAHOO_QUOTE_CHUNK };
