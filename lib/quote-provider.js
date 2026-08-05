'use strict';
// BULK QUOTE PROVIDER — one clean interface for "current price snapshot for MANY tickers in
// FEW requests", so the broad intraday discovery scan never fans out one-request-per-name
// across a ~2,000-name universe.
//
// Providers, in preference order:
//   1. fmp-batch   — FMP /stable/batch-quote (paid key, comma-separated symbols, includes
//                    volume + previousClose + a quote timestamp). Chunked at 200 symbols.
//   2. yahoo-spark — keyless Yahoo /v7/finance/spark (comma-separated symbols). Returns
//                    price + prior close but NO volume; coverage is honest about that.
// A provider that errors or returns an unusable shape is skipped for the call; the result
// always reports which provider answered, how many names it covered, and which capabilities
// (volume) were actually available — degraded coverage is REPORTED, never papered over.
//
// Politeness: bounded chunk concurrency (4) and hard per-request timeouts. A full ~2,000-name
// scan is ~10 FMP requests or ~50 spark requests — far below the app's existing per-cron
// fan-out, and never thousands of simultaneous sockets.

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
      // FMP timestamp is unix seconds of the quote; absent → null (age unknown, fails closed downstream).
      asOf: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : null,
    } : null).filter(Boolean);
  });
  return rows;
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
  try {
    const rows = await yahooSparkQuotes(wanted);
    return { rows, coverage: { requested: wanted.length, returned: rows.length, provider: 'yahoo-spark', volumeAvailable: false } };
  } catch {
    return { rows: [], coverage: { requested: wanted.length, returned: 0, provider: 'none', volumeAvailable: false } };
  }
}

module.exports = { fetchBulkQuotes, fmpBatchQuotes, yahooSparkQuotes, FMP_CHUNK, SPARK_CHUNK };
