'use strict';
// SECOND DAILY-BAR PROVIDER — a lagging primary must not stall the whole app.
//
// THE INCIDENT THIS EXISTS FOR (2026-08-18). The primary daily source (Yahoo) had no
// 2026-08-17 bar for SPY or ~512 of the 514 large-cap names. Because every
// cross-sectional scan anchors its decision session to the benchmark's own bar axis,
// one provider gap silently redefined "today" for the entire app: `/api/screener`
// published a 2026-08-14 cross-section, `op=health` went red with `spyDate 2026-08-14`,
// and the two names that DID carry Monday's bar were discarded as `future-dated`.
// Nothing in the app was broken — it had simply no second opinion about what day it was.
//
// THE CONTRACT. This is a WHOLE-SERIES fallback, never a splice. Bars from two
// providers are never merged into one array: adjustment conventions differ (Yahoo's
// quote OHLC is split-adjusted with a separate adjClose; Stooq publishes its own
// adjusted series), so stitching a foreign tail onto a primary series would silently
// change the price basis mid-array and corrupt every return computed across the seam.
// A fallback series is returned intact and STAMPED with its own provenance, so a
// consumer can always see which provider a given series came from.
//
// It is also strictly opt-in per call: `fetchDailyHistory` only reaches for it when the
// primary series is behind the exchange calendar (or absent entirely), so the normal
// path makes exactly the requests it always did.

const { fetchWithTimeout } = require('./http');
const { logWarn } = require('./log');

// Stooq daily CSV. Already used as the quote fallback in api/price.js, so the app has
// an existing operational relationship with it. Header: Date,Open,High,Low,Close,Volume
const STOOQ_HOST = 'https://stooq.com';

function parseStooqCsv(text) {
  const lines = String(text || '').trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].toLowerCase().split(',').map(h => h.trim());
  const iDate = head.indexOf('date'), iOpen = head.indexOf('open'), iHigh = head.indexOf('high'),
        iLow = head.indexOf('low'), iClose = head.indexOf('close'), iVol = head.indexOf('volume');
  if (iDate < 0 || iOpen < 0 || iHigh < 0 || iLow < 0 || iClose < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const date = (p[iDate] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const open = +p[iOpen], high = +p[iHigh], low = +p[iLow], close = +p[iClose];
    const volume = iVol >= 0 ? +p[iVol] : 0;
    if (![open, high, low, close].every(Number.isFinite) || close <= 0) continue;
    out.push({
      date, open, high, low, close,
      volume: Number.isFinite(volume) ? volume : 0,
      // Stooq publishes ONE adjusted series and no separate adjusted close. Reporting a
      // fabricated adjClose here would let a total-return consumer think it had a
      // dividend-adjusted leg it does not have — so it stays null, honestly.
      adjClose: null,
    });
  }
  // Stooq returns ascending, but never rely on a provider's ordering.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// CIRCUIT BREAKER. The trigger condition (primary behind the calendar) is market-WIDE,
// so a scan hits this once per ticker — ~515 times. If the fallback is itself down or
// rate-limiting, that turns a stale-data problem into a timeout problem and starts
// blowing the cron's budget: the cure would be worse than the disease. After
// FAILURE_LIMIT consecutive failures the breaker opens for COOLDOWN_MS and every call
// returns null immediately, so the scan degrades to exactly its pre-fallback behaviour.
// Per-process state: serverless instances are short-lived, so it self-heals on recycle.
const FAILURE_LIMIT = 5;
const COOLDOWN_MS = 5 * 60 * 1000;
let _consecutiveFailures = 0;
let _openUntil = 0;

function breakerOpen(now = Date.now()) { return now < _openUntil; }
function noteFailure(now = Date.now()) {
  if (++_consecutiveFailures >= FAILURE_LIMIT) {
    _openUntil = now + COOLDOWN_MS;
    _consecutiveFailures = 0;
    logWarn('daily-fallback.stooq', 'breaker opened — fallback disabled for cooldown', { cooldownMs: COOLDOWN_MS });
  }
}
function noteSuccess() { _consecutiveFailures = 0; }
// Test seam only.
function _resetBreaker() { _consecutiveFailures = 0; _openUntil = 0; }

// Fetch a full daily series for `ticker` from the fallback provider.
// Returns the same shape as lib/screener.js fetchDailyHistory, or null.
// Timeout is deliberately tighter than the primary's: this is a small CSV, and it runs
// only when the primary already spent its own budget.
async function fetchStooqDaily(ticker, { timeoutMs = 5000, now = Date.now() } = {}) {
  if (breakerOpen(now)) return null;
  const sym = `${String(ticker || '').toLowerCase()}.us`;
  const url = `${STOOQ_HOST}/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
  try {
    const r = await fetchWithTimeout(url, { timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { noteFailure(now); return null; }
    const candles = parseStooqCsv(await r.text());
    if (candles.length < 60) { noteFailure(now); return null; }   // same minimum the primary path enforces
    noteSuccess();
    return {
      candles,
      meta: { symbol: String(ticker || '').toUpperCase() },
      corporateActions: null,               // not supplied by this feed — never fabricated
      priceBasis: 'stooq-adjusted',
      adjustment: 'unknown',                // the feed does not declare its convention
      provider: 'stooq',
    };
  } catch (e) {
    noteFailure(now);
    logWarn('daily-fallback.stooq', 'fetch failed', { ticker: sym, error: String((e && e.message) || e) });
    return null;
  }
}

module.exports = { fetchStooqDaily, parseStooqCsv, _resetBreaker, FAILURE_LIMIT };
