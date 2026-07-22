const { fetchWithTimeout } = require('./http');
// Numeric per-ticker options baseline from Yahoo Finance's options endpoint
// (/v7/finance/options/{symbol}). Unlike the chart feed, this endpoint is gated
// behind Yahoo's cookie+crumb handshake, so we acquire that once and reuse it
// across the whole archive run. This is the "options baseline" the daily archive
// persists — the raw daily snapshot is unrecoverable after the fact.
//
// Returns a flat numeric record for the NEAREST expiry, or null if unavailable:
//   { expiry, underlying, callVol, putVol, totalVol, pcVolRatio,
//     callOI, putOI, totalOI, pcOIRatio, atmIV, contracts }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const YH_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

// Process-cached { cookie, crumb }. Yahoo crumbs are stable for hours, so one
// handshake serves the entire daily archive pass.
let _auth = null;
async function yahooAuth(force = false) {
  if (_auth && !force) return _auth;
  try {
    // 1. Hit a Yahoo host to collect the consent/session cookie.
    const r1 = await fetchWithTimeout('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const raw = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    const cookie = raw.map(c => c.split(';')[0]).join('; ');
    if (!cookie) return null;
    // 2. Exchange the cookie for a crumb.
    const r2 = await fetchWithTimeout('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Accept': 'text/plain', 'Cookie': cookie },
    });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes('<') || crumb.length > 64) return null;
    _auth = { cookie, crumb };
    return _auth;
  } catch { return null; }
}

async function fetchOptionsBaseline(ticker, _retry = true) {
  const sym = String(ticker).toUpperCase();
  const auth = await yahooAuth();
  if (!auth) return null;
  const qs = `crumb=${encodeURIComponent(auth.crumb)}`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
        headers: { ...YH_HEADERS, 'Cookie': auth.cookie },
      });
      // A stale crumb returns 401 — refresh once and retry the whole ticker.
      if (r.status === 401 && _retry) { _auth = null; return fetchOptionsBaseline(ticker, false); }
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.optionChain?.result?.[0];
      const chain = result?.options?.[0];
      if (!result || !chain) continue;

      const calls = Array.isArray(chain.calls) ? chain.calls : [];
      const puts = Array.isArray(chain.puts) ? chain.puts : [];
      if (!calls.length && !puts.length) continue;

      const underlying = result.quote?.regularMarketPrice ?? null;
      const callVol = sum(calls, c => c.volume);
      const putVol = sum(puts, p => p.volume);
      const callOI = sum(calls, c => c.openInterest);
      const putOI = sum(puts, p => p.openInterest);

      // ATM implied vol: MEDIAN IV of the ~6 contracts nearest the money, ignoring
      // stale/zero readings. A single illiquid near-strike contract on Yahoo often
      // reports a degenerate ~0 IV; the median over several neighbors (and the
      // >=5% / <=500% filter) rejects those so the ATM IV proxy is robust.
      let atmIV = null;
      if (underlying != null) {
        const near = [...calls, ...puts]
          .filter(c => c.strike != null && c.impliedVolatility != null && isFinite(c.impliedVolatility) && c.impliedVolatility >= 0.05 && c.impliedVolatility <= 5)
          .sort((a, b) => Math.abs(a.strike - underlying) - Math.abs(b.strike - underlying))
          .slice(0, 6)
          .map(c => c.impliedVolatility)
          .sort((a, b) => a - b);
        if (near.length) atmIV = +near[Math.floor(near.length / 2)].toFixed(4);   // median
      }

      const ratio = (a, b) => (b > 0 ? +(a / b).toFixed(3) : null);
      return {
        expiry: chain.expirationDate ? new Date(chain.expirationDate * 1000).toISOString().slice(0, 10) : null,
        underlying: underlying != null ? +underlying.toFixed(2) : null,
        callVol, putVol, totalVol: callVol + putVol,
        pcVolRatio: ratio(putVol, callVol),
        callOI, putOI, totalOI: callOI + putOI,
        pcOIRatio: ratio(putOI, callOI),
        atmIV,
        contracts: calls.length + puts.length,
      };
    } catch { /* try next host */ }
  }
  return null;
}

// Raw nearest-expiry chain result (quote + options[0].calls/puts) for the
// per-contract unusual-flow scanner (lib/optionsflow.js). Returns the Yahoo
// optionChain.result[0], or null. Shares the cookie/crumb handshake above.
async function fetchChainResult(ticker, _retry = true) {
  const sym = String(ticker).toUpperCase();
  const auth = await yahooAuth();
  if (!auth) return null;
  const qs = `crumb=${encodeURIComponent(auth.crumb)}`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
        headers: { ...YH_HEADERS, 'Cookie': auth.cookie },
      });
      if (r.status === 401 && _retry) { _auth = null; return fetchChainResult(ticker, false); }
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.optionChain?.result?.[0];
      if (result && result.options && result.options[0]) return result;
    } catch { /* try next host */ }
  }
  return null;
}

// One specific expiry's chain (?date=<unixSeconds>). Best-effort sibling of
// fetchChainResult used to add extra expiries — no 401 retry of its own (the
// base fetch already refreshed the crumb), so a miss just drops that expiry.
async function fetchChainByDate(ticker, dateTs) {
  const sym = String(ticker).toUpperCase();
  const auth = await yahooAuth();
  if (!auth) return null;
  const qs = `date=${encodeURIComponent(dateTs)}&crumb=${encodeURIComponent(auth.crumb)}`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
        headers: { ...YH_HEADERS, 'Cookie': auth.cookie },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.optionChain?.result?.[0];
      if (result && result.options && result.options[0]) return result;
    } catch { /* try next host */ }
  }
  return null;
}

// Swing-relevant expiry TARGETS (in DTE). The nearest expiry (always fetched)
// covers the 0–7 / 8–20 buckets; these targets deliberately populate the PRIMARY
// SWING (21–45) and POSITION (46–75) buckets so a multi-week thesis is not judged
// on nearest-expiry gamma bets. Kept small: each target = one extra fetch/ticker,
// and the scan runs over the whole liquid universe under a serverless wall.
const SWING_EXPIRY_TARGETS = Object.freeze([32, 58]);

// PURE: choose which further-out expiries to fetch, given the available expiration
// timestamps (unix seconds), the nearest already-fetched expiry, and the current
// time (injected — no Date.now() here so it is deterministically testable). For each
// target DTE we pick the CLOSEST available expiry (each used at most once), so the
// extras spread across buckets instead of clustering near one date. Falls back to
// the closest available expiry when the ideal window is missing (short-dated names).
function pickSwingExpiries({ expirationDates = [], nearestTs = null, nowSec = 0, targets = SWING_EXPIRY_TARGETS, maxExtra = null } = {}) {
  const cap = maxExtra == null ? targets.length : maxExtra;
  const candidates = expirationDates
    .filter(ts => ts !== nearestTs && (ts - nowSec) / 86_400 > 0)
    .map(ts => ({ ts, dte: (ts - nowSec) / 86_400 }));
  const chosen = [];
  const used = new Set();
  for (const target of targets) {
    if (chosen.length >= cap) break;
    let best = null, bestDist = Infinity;
    for (const c of candidates) {
      if (used.has(c.ts)) continue;
      const d = Math.abs(c.dte - target);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best) { chosen.push(best.ts); used.add(best.ts); }
  }
  return chosen;
}

// Multi-expiry chain for the unusual-flow scanner: the NEAREST expiry (as before)
// PLUS the swing/position expiries chosen by pickSwingExpiries, merged into one
// result's `options[]` so scanChain surfaces short-dated bets AND multi-week
// positioning across the DTE buckets. Returns a result shaped exactly like
// fetchChainResult (single `.quote`, multiple `.options` entries), or null.
async function fetchChainMultiExpiry(ticker, { targets = SWING_EXPIRY_TARGETS, maxExtra = null } = {}) {
  const base = await fetchChainResult(ticker);
  if (!base || !Array.isArray(base.options) || !base.options[0]) return base;
  const extras = pickSwingExpiries({
    expirationDates: Array.isArray(base.expirationDates) ? base.expirationDates : [],
    nearestTs: base.options[0].expirationDate || null,
    nowSec: Date.now() / 1000,
    targets, maxExtra,
  });
  for (const ts of extras) {
    const r = await fetchChainByDate(ticker, ts);
    const chain = r?.options?.[0];
    if (chain) base.options.push(chain);
  }
  return base;
}

module.exports = { fetchOptionsBaseline, fetchChainResult, fetchChainByDate, fetchChainMultiExpiry, pickSwingExpiries, SWING_EXPIRY_TARGETS, yahooAuth };
