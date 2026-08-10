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
//                    VOLUME, open, day high/low and a 3-month average volume. This is what
//                    actually serves the scan today.
//   3. yahoo-spark — keyless Yahoo /v7/finance/spark. Price and prior close only, NO volume,
//                    and capped at 20 symbols per request. Last resort, and now only ever used
//                    to fill the GAP the volume-capable provider left.
//
// WHY THE ORDER MATTERS: three of the seven discovery lanes in lib/mover-discovery.js
// (relative volume, volume acceleration, low-float turnover) need a share count. Falling
// through to spark disables them, so `volumeAvailable` is reported on every result and the
// discovery coverage says plainly when recall is reduced.
//
// ── 2026-08-05 PRODUCTION FAILURE, and what changed ────────────────────────────────────────
// Every one of the 125 in-session discovery scans that day reported `insufficient-coverage`:
// provider `yahoo-spark`, coverage 1% of 767 requested symbols, for the whole session. The
// chain had three compounding defects:
//   (a) NO RETRY. A single 429 from a chunk — routine when calling Yahoo from a datacenter IP
//       shared with every other Vercel tenant — dropped those symbols for good.
//   (b) ALL-OR-NOTHING FALLTHROUGH. Partial success was treated as failure: the volume-carrying
//       rows already in hand were DISCARDED and the entire universe was re-requested from the
//       price-only endpoint, which is capped at 20 symbols/request and answered ~8 rows.
//   (c) NO DIAGNOSTICS. Coverage reported "1%, yahoo-spark" but not WHY — a rate limit, a
//       failed crumb handshake and an upstream outage were indistinguishable without a redeploy.
// Now: chunks are smaller and less concurrent, the transport retries retryable failures, the
// symbols no chunk answered get one repair pass, spark only ever fills the REMAINING gap
// (never replaces volume rows), and every result carries per-provider diagnostics.
//
// A provider that errors or returns an unusable shape is skipped for the call; the result
// always reports which provider answered, how many names it covered, and which capabilities
// were actually available — degraded coverage is REPORTED, never papered over.

const { fetchWithTimeout } = require('./http');
const { redactedMessage } = require('./redact');

const FMP_CHUNK = 200;
// Yahoo's spark endpoint enforces a HARD symbol cap and answers 400 above it:
//   {"error":{"code":"Bad Request","description":"Number of symbols needs to be less than or equal to 20"}}
// This was 40, which meant EVERY spark chunk failed and the keyless fallback silently
// returned zero rows for any request larger than 20 symbols. The failure mode was invisible
// because a failed chunk is swallowed by mapChunks and the coverage report only counts what
// came back — a full-universe scan simply reported "0 candidates" and looked like a quiet day.
// Verified against the live endpoint: 20 symbols → 200 OK, 40 symbols → 400 Bad Request.
const SPARK_CHUNK = 20;
// Measured cap is 300 symbols/request in ~165 ms. Chunked at 100 (was 200): a rate-limited
// chunk now costs 100 symbols instead of 200, and the smaller request is itself less likely to
// be shed. 767 names = 8 requests, still nothing next to the app's per-cron fan-out.
const YAHOO_QUOTE_CHUNK = 100;
const CHUNK_CONCURRENCY = 3;        // was 4 — politeness against a shared-IP rate limit
const SPARK_CONCURRENCY = 2;        // the keyless endpoint is the most aggressively limited
const CHUNK_RETRIES = 2;            // retryable statuses only (429/5xx/network), see lib/http
const RETRY_BASE_MS = 400;
const TIMEOUT_MS = 9000;
// A provider answer below this share of the request is not evidence the endpoint answered at
// all (FMP's 402 returns zero rows) — below it, move on to the next provider.
const PRIMARY_MIN_PCT = 0.3;
// Below this share of the request, the volume-capable snapshot is topped up from the keyless
// price-only endpoint. 80% is deliberately the SAME bar lib/daytrade-scan-runner.js calls
// `insufficient-coverage`: if the scan is going to distrust the snapshot, it is worth spending
// gap-fill requests to complete it. Above the bar, the answer stands on its own and no extra
// load is generated.
const GAP_FILL_BELOW_PCT = 0.8;
// Bounded politeness: the gap fill is capped at 20 spark requests (20 symbols each). A gap
// larger than this is reported as truncated rather than fanned out without limit.
const GAP_FILL_MAX_SYMBOLS = 400;
// The volume-dependent lanes need volume on the BULK of the snapshot to be meaningful. Below
// this share the result is reported as price-only — `some(row has volume)` would have called a
// snapshot of 1 volume row + 700 price-only rows "volume available".
const VOLUME_MAJORITY_PCT = 0.5;

// ── pure helpers ────────────────────────────────────────────────────────────────────────────
const chunk = (arr, n) => {
  const c = [];
  for (let i = 0; i < arr.length; i += n) c.push(arr.slice(i, i + n));
  return c;
};

// Symbols the caller asked for that no returned row covers.
function missingFrom(wanted, rows) {
  const have = new Set((rows || []).map(r => String(r.ticker).toUpperCase()));
  return (wanted || []).filter(t => !have.has(String(t).toUpperCase()));
}

// Merge a gap-fill answer under a primary answer. The primary row ALWAYS wins: the fill
// provider carries no volume, and overwriting a volume row with a price-only one would
// silently blind the lanes this whole module exists to keep alive. Returns a new array.
function mergeRows(primary, fill) {
  const have = new Set((primary || []).map(r => String(r.ticker).toUpperCase()));
  return [...(primary || []), ...(fill || []).filter(r => !have.has(String(r.ticker).toUpperCase()))];
}

// Capability report for a snapshot: how much of it actually carries a share count.
function volumeStats(rows) {
  const returned = (rows || []).length;
  const volumeRows = (rows || []).filter(r => r && r.dayVolume != null).length;
  const volumeCoveragePct = returned ? +((volumeRows / returned) * 100).toFixed(1) : 0;
  return { volumeRows, volumeCoveragePct, volumeAvailable: returned > 0 && volumeRows >= returned * VOLUME_MAJORITY_PCT };
}

// Tally per-chunk outcomes into a status histogram — the thing that was missing when the
// board went dark: it distinguishes a rate limit from an outage from an auth failure.
function summarize(outcomes) {
  const statuses = {};
  let failed = 0;
  for (const o of outcomes) {
    const key = o && o.status != null ? String(o.status) : (o && o.error ? 'error' : 'unknown');
    statuses[key] = (statuses[key] || 0) + 1;
    // A chunk FAILED when the request did — a 200 that legitimately covers no symbols (a batch
    // of delisted tickers) is an empty answer, not an error, and must not inflate the count the
    // health verdict reads.
    if (!o || o.status == null || o.status >= 400 || o.error) failed++;
  }
  return { statuses, failedChunks: failed };
}

// ── chunked fetch ───────────────────────────────────────────────────────────────────────────
// Runs `fn` over chunks with bounded concurrency and returns one outcome per chunk
// ({ rows, status, error }). A throwing chunk becomes an outcome, never a rejected promise —
// one bad chunk must not take the snapshot down.
async function mapChunks(chunks, fn, concurrency = CHUNK_CONCURRENCY) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < chunks.length) {
      const idx = i++;
      try { out[idx] = await fn(chunks[idx]); }
      catch (e) { out[idx] = { rows: [], status: null, error: redactedMessage(e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out.map(o => o || { rows: [], status: null, error: 'no outcome' });
}

const rowsOf = outcomes => outcomes.flatMap(o => (o && o.rows) || []);

// One repair pass over the symbols no chunk answered. Bounded to a single pass: the transport
// already retried each request, so a second sweep is about chunk-level losses, not flakiness.
// SKIPPED when the provider returned nothing at all — re-requesting the universe from a source
// that just answered zero is load against something that is down, and the fallback is the
// correct move there.
async function repairMissing(wanted, rows, run) {
  const missing = missingFrom(wanted, rows);
  if (!rows.length || !missing.length) return { rows, repair: null };
  const outcomes = await run(missing);
  const recovered = rowsOf(outcomes);
  return {
    rows: mergeRows(rows, recovered),
    repair: { requested: missing.length, recovered: recovered.length, ...summarize(outcomes) },
  };
}

// ── providers ───────────────────────────────────────────────────────────────────────────────
// FMP /stable/batch-quote → normalized rows. Shape-checked at runtime (a plan or endpoint
// change degrades to the fallback provider rather than fabricating data).
async function fmpBatchQuotes(tickers, apiKey, { fetchImpl = fetchWithTimeout } = {}) {
  const outcomes = await mapChunks(chunk(tickers, FMP_CHUNK), async syms => {
    const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${syms.join(',')}&apikey=${apiKey}`;
    const r = await fetchImpl(url, { timeoutMs: TIMEOUT_MS, retries: CHUNK_RETRIES, retryBaseMs: RETRY_BASE_MS });
    if (!r.ok) return { rows: [], status: r.status };
    const j = await r.json();
    if (!Array.isArray(j)) return { rows: [], status: r.status, error: 'unexpected shape' };
    return {
      status: r.status,
      rows: j.map(q => (q && q.symbol && q.price != null) ? {
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
      } : null).filter(Boolean),
    };
  });
  return { rows: rowsOf(outcomes), diag: summarize(outcomes) };
}

// Yahoo /v7/finance/quote (cookie+crumb, batched) → normalized rows WITH VOLUME.
//
// This is the provider that keeps the volume-dependent discovery lanes alive. FMP's
// /stable/batch-quote answers 402 "Restricted Endpoint" on the current subscription, and the
// keyless spark endpoint carries no volume at all — without this, relative volume, volume
// acceleration and low-float turnover (three of the seven discovery lanes) simply cannot run.
//
// The endpoint is behind Yahoo's cookie+crumb handshake, which lib/options-baseline.js already
// implements and caches per process; reusing it avoids a second implementation of a flow that
// has broken before. A failed handshake is reported as `auth: 'unavailable'` — it used to be
// indistinguishable from a market where nothing was trading.
//
// Returns { rows, diag } — the diagnostics are what make an in-session degradation legible
// without a redeploy.
async function yahooQuotes(tickers, { fetchImpl = fetchWithTimeout, authImpl = null } = {}) {
  const getAuth = authImpl || require('./options-baseline').yahooAuth;
  let auth = await getAuth();
  if (!auth) return { rows: [], diag: { auth: 'unavailable', statuses: {}, failedChunks: null, repair: null } };

  const fetchChunk = async (syms, allowCrumbRefresh = true) => {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms.join(',')}`
      + `&crumb=${encodeURIComponent(auth.crumb)}`;
    const r = await fetchImpl(url, {
      timeoutMs: TIMEOUT_MS,
      retries: CHUNK_RETRIES,
      retryBaseMs: RETRY_BASE_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Cookie': auth.cookie },
    });
    // A stale crumb answers 401 — refresh once and retry this chunk.
    if (r.status === 401 && allowCrumbRefresh) {
      auth = await getAuth(true);
      if (!auth) return { rows: [], status: 401, error: 'crumb refresh failed' };
      return fetchChunk(syms, false);
    }
    if (!r.ok) return { rows: [], status: r.status };
    const j = await r.json();
    const result = j && j.quoteResponse && Array.isArray(j.quoteResponse.result) ? j.quoteResponse.result : null;
    if (!result) return { rows: [], status: r.status, error: 'unexpected shape' };
    return {
      status: r.status,
      rows: result.map(q => (q && q.symbol && q.regularMarketPrice != null) ? {
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
      } : null).filter(Boolean),
    };
  };

  const run = syms => mapChunks(chunk(syms, YAHOO_QUOTE_CHUNK), s => fetchChunk(s), CHUNK_CONCURRENCY);
  const outcomes = await run(tickers);
  const { rows, repair } = await repairMissing(tickers, rowsOf(outcomes), run);
  return { rows, diag: { auth: 'ok', ...summarize(outcomes), repair } };
}

// Yahoo spark (keyless, batched) → normalized rows. No volume — reported via capabilities.
// Used ONLY to fill the gap the volume-capable provider left, so its 20-symbol cap is spent on
// the symbols that are actually still missing.
async function yahooSparkQuotes(tickers, { fetchImpl = fetchWithTimeout } = {}) {
  const outcomes = await mapChunks(chunk(tickers, SPARK_CHUNK), async syms => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${syms.join(',')}&range=1d&interval=5m`;
    const r = await fetchImpl(url, {
      timeoutMs: TIMEOUT_MS, retries: CHUNK_RETRIES, retryBaseMs: RETRY_BASE_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!r.ok) return { rows: [], status: r.status };
    const j = await r.json();
    const results = j && j.spark && Array.isArray(j.spark.result) ? j.spark.result : null;
    if (!results) return { rows: [], status: r.status, error: 'unexpected shape' };
    return {
      status: r.status,
      rows: results.map(entry => {
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
      }).filter(Boolean),
    };
  }, SPARK_CONCURRENCY);
  return { rows: rowsOf(outcomes), diag: summarize(outcomes) };
}

// ── coverage report ─────────────────────────────────────────────────────────────────────────
const DEGRADED_NOTE = 'The quote snapshot is missing VOLUME for most names (the volume-capable provider was unavailable or rate-limited), so the relative-volume, volume-acceleration and low-float-turnover lanes cannot run. Recall is materially reduced.';
const THIN_NOTE = 'The quote provider covered only part of the requested universe — names it did not answer for were not scanned at all.';

function coverageOf({ requested, rows, provider, diagnostics }) {
  const returned = rows.length;
  const vol = volumeStats(rows);
  const thin = requested > 0 && returned < requested * PRIMARY_MIN_PCT;
  const degraded = !vol.volumeAvailable || thin;
  return {
    requested, returned, provider,
    coveragePct: requested ? +((returned / requested) * 100).toFixed(1) : 0,
    volumeAvailable: vol.volumeAvailable,
    volumeRows: vol.volumeRows,
    volumeCoveragePct: vol.volumeCoveragePct,
    degraded,
    note: !vol.volumeAvailable ? DEGRADED_NOTE : thin ? THIN_NOTE : null,
    diagnostics,
  };
}

// Fetch a bulk snapshot for `tickers`. Returns { rows, coverage } where coverage is the
// honest capability/completeness report the discovery scan surfaces to the user.
//
// `deps` exists for tests (and only tests): each provider can be replaced with a fake so the
// fallback/merge policy is verifiable without a network.
async function fetchBulkQuotes(tickers, deps = {}) {
  const {
    fmpImpl = fmpBatchQuotes,
    quoteImpl = yahooQuotes,
    sparkImpl = yahooSparkQuotes,
    fmpKey = process.env.FMP_API_KEY,
  } = deps;
  const wanted = [...new Set((tickers || []).map(t => String(t).toUpperCase()))];
  if (!wanted.length) {
    return { rows: [], coverage: { requested: 0, returned: 0, provider: null, coveragePct: 0, volumeAvailable: false, volumeRows: 0, volumeCoveragePct: 0, degraded: false, note: null, diagnostics: {} } };
  }
  const diagnostics = {};

  // FIRST CHOICE — the contractual paid source (currently 402 on this plan, so it is skipped).
  if (fmpKey) {
    try {
      const { rows, diag } = await fmpImpl(wanted, fmpKey);
      diagnostics.fmp = diag;
      // Sanity: a healthy batch answer covers a meaningful share of the request.
      if (rows.length >= Math.min(20, wanted.length * PRIMARY_MIN_PCT)) {
        return { rows, coverage: coverageOf({ requested: wanted.length, rows, provider: 'fmp-batch', diagnostics }) };
      }
    } catch (e) { diagnostics.fmp = { error: redactedMessage(e) }; }
  }

  // SECOND CHOICE — crumb-authenticated Yahoo quote. Carries VOLUME, so it keeps the
  // volume-dependent discovery lanes alive when the paid batch endpoint is unavailable.
  let primary = [];
  try {
    const { rows, diag } = await quoteImpl(wanted);
    primary = rows;
    diagnostics.yahooQuote = diag;
  } catch (e) { diagnostics.yahooQuote = { error: redactedMessage(e) }; }
  if (primary.length >= wanted.length * GAP_FILL_BELOW_PCT) {
    return { rows: primary, coverage: coverageOf({ requested: wanted.length, rows: primary, provider: 'yahoo-quote', diagnostics }) };
  }

  // LAST RESORT — keyless spark, price only. It fills the GAP and never replaces a volume row:
  // discarding a partial volume-capable answer to re-request the whole universe from a
  // 20-symbol-capped endpoint is precisely what blanked the board on 2026-08-05.
  const gapAll = missingFrom(wanted, primary);
  const gap = gapAll.slice(0, GAP_FILL_MAX_SYMBOLS);
  let fill = [];
  try {
    const { rows, diag } = await sparkImpl(gap);
    fill = rows;
    diagnostics.spark = { ...diag, requested: gap.length, truncated: gapAll.length - gap.length };
  } catch (e) { diagnostics.spark = { error: redactedMessage(e) }; }

  const rows = mergeRows(primary, fill);
  const provider = primary.length
    ? (fill.length ? 'yahoo-quote+spark' : 'yahoo-quote')
    : (fill.length ? 'yahoo-spark' : 'none');
  return { rows, coverage: coverageOf({ requested: wanted.length, rows, provider, diagnostics }) };
}

module.exports = {
  fetchBulkQuotes, fmpBatchQuotes, yahooQuotes, yahooSparkQuotes,
  missingFrom, mergeRows, volumeStats, coverageOf,
  FMP_CHUNK, SPARK_CHUNK, YAHOO_QUOTE_CHUNK,
  CHUNK_CONCURRENCY, SPARK_CONCURRENCY, CHUNK_RETRIES, PRIMARY_MIN_PCT, VOLUME_MAJORITY_PCT,
  GAP_FILL_BELOW_PCT, GAP_FILL_MAX_SYMBOLS,
};
