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
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const raw = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    const cookie = raw.map(c => c.split(';')[0]).join('; ');
    if (!cookie) return null;
    // 2. Exchange the cookie for a crumb.
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
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
      const r = await fetch(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
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
      const r = await fetch(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
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
      const r = await fetch(`https://${host}/v7/finance/options/${encodeURIComponent(sym)}?${qs}`, {
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

// Multi-expiry chain for the unusual-flow scanner: the NEAREST expiry (as before)
// PLUS up to `maxExtra` further-out "swing" expiries (first expiration ≥ swingMinDte
// days out), merged into one result's `options[]` so scanChain surfaces both
// short-dated gamma bets and positioning trades. Returns a result shaped exactly
// like fetchChainResult (single `.quote`, multiple `.options` entries), or null.
async function fetchChainMultiExpiry(ticker, { swingMinDte = 14, maxExtra = 1 } = {}) {
  const base = await fetchChainResult(ticker);
  if (!base || !Array.isArray(base.options) || !base.options[0]) return base;
  const dates = Array.isArray(base.expirationDates) ? base.expirationDates : [];
  const nearestTs = base.options[0].expirationDate || null;
  const now = Date.now() / 1000;
  const extras = [];
  for (const ts of dates) {
    if (extras.length >= maxExtra) break;
    if (ts === nearestTs) continue;
    if ((ts - now) / 86_400 >= swingMinDte) extras.push(ts);
  }
  for (const ts of extras) {
    const r = await fetchChainByDate(ticker, ts);
    const chain = r?.options?.[0];
    if (chain) base.options.push(chain);
  }
  return base;
}

module.exports = { fetchOptionsBaseline, fetchChainResult, fetchChainByDate, fetchChainMultiExpiry, yahooAuth };
