// FADER-REGIME INTRADAY CAPTURE — pure/fetch core.
//
// WHY: the opening-range-gate hypothesis (research/41) only had runner-heavy 2024–25
// intraday data (research/data/intra5, ~85% up-days), where chasing the open wins and
// the OR gate nets lower expectancy. The gate's edge was LARGEST on faders (MAE 0.55R
// vs 1.34R), so a regime-conditional gate (apply only in neutral/risk-off) may pay —
// but that branch is untestable until we accrue fader/risk-off intraday sessions.
//
// This module captures 5-minute REGULAR-HOURS session bars for a completed session so
// the app's daily cron can accumulate that dataset forward, regime-tagged. The date/
// session logic is a pure function (extractSessionBars) so it is unit-testable; only
// fetchFiveMin touches the network.

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

// ET calendar date ('YYYY-MM-DD') of a UNIX-seconds timestamp — DST-correct via Intl.
// en-CA formats as ISO (YYYY-MM-DD); America/New_York handles EST/EDT automatically.
function etDate(tsSec) {
  return new Date(tsSec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Pure: extract ONE ET session's regular-hours 5-min bars from a Yahoo chart result.
// Returns [{ t (ISO), o, h, l, c, v }]. Skips bars missing OHLC (Yahoo emits nulls at
// gaps). `range=5d&interval=5m` (no includePrePost) is already regular-hours only.
function extractSessionBars(result, sessionDate) {
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (etDate(ts[i]) !== sessionDate) continue;
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: new Date(ts[i] * 1000).toISOString(), o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4), v });
  }
  return bars;
}

// Per-request timeout for the Stage-2 bar/quote fetch. This is THE provider call the whole
// actionable gate depends on: a bare fetch with no signal let one hung Yahoo socket pin a
// Stage-2 worker until the function wall (the deadline check between fetches cannot rescue
// an in-flight hang). Bounded well under the worker deadline so a slow host fails over.
const FIVE_MIN_FETCH_TIMEOUT_MS = 8000;

// Capability report for the intraday-bar provider layer (mirrors lib/quote-provider's
// coverage contract). Yahoo chart is the only configured source: 5-minute RTH bars +
// chart-meta quote; no premarket bars, no bid/ask, no 1-minute entitlement verified.
const BAR_PROVIDER_CAPABILITY = Object.freeze({
  provider: 'yahoo-chart',
  barIntervalMin: 5,
  premarketBars: false,
  bidAsk: false,
  subFiveMin: false,
});

// Fetch a ticker's recent 5-min chart (regular hours, 5-day window). Returns the raw
// Yahoo chart result[0] (timestamp + quote arrays) or null. Two hosts for resilience,
// each attempt hard-bounded by fetchWithTimeout (no retries here — the host loop IS the
// retry, and Stage-2 has its own overall deadline).
async function fetchFiveMin(ticker) {
  const { fetchWithTimeout } = require('./http');
  const path = `/v8/finance/chart/${String(ticker).toUpperCase()}?range=5d&interval=5m`;
  for (const host of HOSTS) {
    try {
      const r = await fetchWithTimeout(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeoutMs: FIVE_MIN_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      if (result?.timestamp) return result;
    } catch { /* timeout or network error — try next host */ }
  }
  return null;
}

module.exports = { etDate, extractSessionBars, fetchFiveMin, BAR_PROVIDER_CAPABILITY, FIVE_MIN_FETCH_TIMEOUT_MS };
