'use strict';
// CBOE DELAYED OPTION CHAINS (with vendor greeks) — zero-dependency HTTP adapter.
//
//   GET https://cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json
//   → 307 → cdn-api.cboe.com (fetch follows it). Indexes are prefixed: SPX → _SPX, VIX → _VIX.
//   Payload: { timestamp, symbol, data: { current_price, …underlying quote, options: [ {
//     option: OCC symbol, bid, ask, iv, delta, gamma, vega, theta, rho, open_interest, volume,
//     last_trade_price, last_trade_time, … } ] } }  — EVERY expiry in one body.
//
// Measured 2026-10-02 from this network: XLU 0.5 MB / 0.27s, AAPL 1.6 MB / 0.14s,
// SPY 5.8 MB / 0.25s, _SPX 13 MB / 0.33s (CDN, no auth). Unknown symbol → 403 AccessDenied.
// Delayed 15 minutes. CBOE terms are tier C: our own analytics are fine; raw chains must
// never be republished (nothing here is reachable from the public /feed).
//
// The normalized result has the SAME shape the Yahoo adapter (lib/options-baseline.js)
// returns — `{ quote, expirationDates, options: [{ expirationDate, calls, puts }] }` with
// Yahoo field names on every contract — plus `source:'cboe-delayed'`, `greeksSource:'vendor'`
// and per-contract delta/gamma/vega/theta/rho. Every field is validated at this boundary:
// a non-numeric vendor value becomes null (or 0 for volume/OI), a malformed option symbol
// drops the row and is COUNTED in `diagnostics.rejected`, never silently.
//
// Memoized through lib/http-memo (one body per symbol per TTL: ~10 min while a session is
// open, 6 h when closed — a closed chain cannot change). A dedicated memo instance because
// SPY/SPX bodies exceed the shared instance's 2 MB item cap.

const { createHttpMemo } = require('./http-memo');
const { sessionInfoAt } = require('./market-session');

const CBOE_SOURCE = 'cboe-delayed';
const CBOE_BASE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';
const DELAYED_BY_MIN = 15;
const MEMO_TAG = 'cboe-chain';
const TTL_OPEN_MS = 10 * 60 * 1000;
const TTL_CLOSED_MS = 6 * 60 * 60 * 1000;
// Measured worst case 0.33s for 13 MB; 15s leaves a 40× margin for a cold edge without
// letting one hung vendor call eat a scan budget.
const FETCH_TIMEOUT_MS = 15_000;
const MEMO_MAX_ITEM_BYTES = 16 * 1024 * 1024;
const MEMO_MAX_BYTES = 64 * 1024 * 1024;
const MEMO_MAX_ENTRIES = 48;
const HEADERS = Object.freeze({ Accept: 'application/json', 'User-Agent': 'market-news-app/1.0 (options analytics)' });
const INDEX_SYMBOLS = Object.freeze({ SPX: '_SPX', VIX: '_VIX', NDX: '_NDX', RUT: '_RUT', DJX: '_DJX', XSP: '_XSP', OEX: '_OEX' });
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
// OCC: root (≤6 letters) + YYMMDD + C|P + strike × 1000 as 8 digits.
const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const STRIKE_SCALE = 1000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);
const countOrZero = (v) => (isNum(v) && v >= 0 ? Math.round(v) : 0);

const MEMO = createHttpMemo({ maxItemBytes: MEMO_MAX_ITEM_BYTES, maxBytes: MEMO_MAX_BYTES, maxEntries: MEMO_MAX_ENTRIES });

/** App ticker → CBOE symbol ('SPX'/'^SPX' → '_SPX'); null when the ticker is not well-formed. */
function cboeSymbolFor(ticker) {
  const t = String(ticker || '').toUpperCase().trim().replace(/^[\^_]/, '');
  if (!TICKER_RE.test(t)) return null;
  return INDEX_SYMBOLS[t] || t;
}

function cboeUrlFor(ticker) {
  const sym = cboeSymbolFor(ticker);
  return sym ? `${CBOE_BASE_URL}${encodeURIComponent(sym)}.json` : null;
}

/** OCC option symbol → { root, expiry, expirationSec, type, strike } or null when malformed. */
function parseOccSymbol(sym) {
  const m = OCC_RE.exec(String(sym || ''));
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strikeRaw] = m;
  const year = 2000 + Number(yy), month = Number(mm), day = Number(dd);
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  const strike = Number(strikeRaw) / STRIKE_SCALE;
  if (!(strike > 0)) return null;
  return { root, expiry: d.toISOString().slice(0, 10), expirationSec: ms / 1000, type: cp === 'C' ? 'call' : 'put', strike };
}

// CBOE timestamps are ET wall-clock without a zone ("2026-10-01T15:59:59"). Resolve them
// through the America/New_York zone so DST is right; returns unix seconds or null.
function etWallToEpochSec(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(guess)).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const asEt = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((guess + (guess - asEt)) / 1000);
}

function normalizeContract(raw, parsed, spot) {
  const bid = numOrNull(raw.bid), ask = numOrNull(raw.ask), last = numOrNull(raw.last_trade_price);
  return {
    contractSymbol: raw.option,
    strike: parsed.strike,
    expiration: parsed.expirationSec,
    lastPrice: last,
    bid, ask,
    volume: countOrZero(raw.volume),
    openInterest: countOrZero(raw.open_interest),
    impliedVolatility: numOrNull(raw.iv),
    delta: numOrNull(raw.delta), gamma: numOrNull(raw.gamma), vega: numOrNull(raw.vega), theta: numOrNull(raw.theta), rho: numOrNull(raw.rho),
    lastTradeDate: etWallToEpochSec(raw.last_trade_time),
    inTheMoney: isNum(spot) ? (parsed.type === 'call' ? parsed.strike < spot : parsed.strike > spot) : null,
    greeksSource: 'vendor',
  };
}

function normalizeQuote(data, fetchedAt) {
  const price = numOrNull(data.current_price);
  return {
    symbol: typeof data.symbol === 'string' ? data.symbol.replace(/^_/, '') : null,
    regularMarketPrice: price,
    regularMarketChange: numOrNull(data.price_change),
    regularMarketChangePercent: numOrNull(data.price_change_percent),
    regularMarketVolume: numOrNull(data.volume),
    regularMarketDayHigh: numOrNull(data.high),
    regularMarketDayLow: numOrNull(data.low),
    regularMarketPreviousClose: numOrNull(data.prev_day_close),
    regularMarketTime: etWallToEpochSec(data.last_trade_time) || (fetchedAt ? Math.floor(fetchedAt / 1000) : null),
    bid: numOrNull(data.bid), ask: numOrNull(data.ask),
    iv30: numOrNull(data.iv30),
    exchangeDataDelayedBy: DELAYED_BY_MIN,
    quoteType: data.security_type === 'index' ? 'INDEX' : 'EQUITY',
  };
}

/**
 * Validate + reshape a CBOE payload into the Yahoo-shaped chain result. Pure.
 * @returns {object|null} null when the payload has no usable options array or no price.
 */
function normalizeCboeChain(payload, { fetchedAt = null } = {}) {
  const data = payload && payload.data;
  if (!data || !Array.isArray(data.options)) return null;
  const quote = normalizeQuote(data, fetchedAt);
  if (!isNum(quote.regularMarketPrice) || quote.regularMarketPrice <= 0) return null;
  const spot = quote.regularMarketPrice;
  const byExpiry = new Map();
  let rejected = 0;
  for (const raw of data.options) {
    const parsed = raw && typeof raw.option === 'string' ? parseOccSymbol(raw.option) : null;
    if (!parsed) { rejected++; continue; }
    const bucket = byExpiry.get(parsed.expirationSec) || { expirationDate: parsed.expirationSec, calls: [], puts: [] };
    bucket[parsed.type === 'call' ? 'calls' : 'puts'].push(normalizeContract(raw, parsed, spot));
    byExpiry.set(parsed.expirationSec, bucket);
  }
  const options = [...byExpiry.values()].sort((a, b) => a.expirationDate - b.expirationDate)
    .map((ch) => ({ ...ch, calls: ch.calls.sort((a, b) => a.strike - b.strike), puts: ch.puts.sort((a, b) => a.strike - b.strike) }));
  if (!options.length) return null;
  return {
    underlyingSymbol: quote.symbol,
    quote,
    expirationDates: options.map((ch) => ch.expirationDate),
    options,
    source: CBOE_SOURCE,
    provider: 'cboe',
    greeksSource: 'vendor',
    chainComplete: true,
    providerTimestamp: typeof payload.timestamp === 'string' ? payload.timestamp : null,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    diagnostics: { contracts: data.options.length - rejected, rejected, expiries: options.length },
  };
}

/** Cache TTL: a closed market cannot change the chain, so hold it far longer. */
function chainTtlMs(now = new Date()) {
  return sessionInfoAt(now).marketSession === 'closed' ? TTL_CLOSED_MS : TTL_OPEN_MS;
}

// A body is only worth remembering when it carries a priced chain with contracts.
function shouldCacheBody(body) {
  return !!(body && body.data && Array.isArray(body.data.options) && body.data.options.length && isNum(body.data.current_price));
}

/**
 * Fetch one symbol's FULL delayed chain (every expiry) with vendor greeks.
 * @returns {Promise<object|null>} normalized result, or null on non-ok / unusable body.
 *   Throws only when the fetch itself threw (network/timeout) — like fetchWithTimeout.
 */
async function fetchCboeChain(ticker, { nowMs = Date.now(), fetchImpl, memo = MEMO } = {}) {
  const url = cboeUrlFor(ticker);
  if (!url) return null;
  const r = await memo.memoFetchJSON(url, {
    ttlMs: chainTtlMs(new Date(nowMs)), tag: MEMO_TAG, shouldCache: shouldCacheBody,
    init: { timeoutMs: FETCH_TIMEOUT_MS, headers: HEADERS, redirect: 'follow' },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!r.ok || !r.body) return null;
  return normalizeCboeChain(r.body, { fetchedAt: nowMs });
}

module.exports = {
  CBOE_SOURCE, CBOE_BASE_URL, DELAYED_BY_MIN, TTL_OPEN_MS, TTL_CLOSED_MS, FETCH_TIMEOUT_MS, INDEX_SYMBOLS,
  cboeSymbolFor, cboeUrlFor, parseOccSymbol, etWallToEpochSec, normalizeCboeChain, chainTtlMs, fetchCboeChain,
  _memo: MEMO,
};
