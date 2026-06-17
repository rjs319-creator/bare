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

      // ATM implied vol: average the IV of the call & put whose strike is
      // closest to the underlying (the standard "ATM IV" proxy).
      let atmIV = null;
      if (underlying != null) {
        const nearest = list => list.length
          ? list.reduce((a, b) => Math.abs((b.strike ?? 1e9) - underlying) < Math.abs((a.strike ?? 1e9) - underlying) ? b : a)
          : null;
        const ac = nearest(calls), ap = nearest(puts);
        const ivs = [ac?.impliedVolatility, ap?.impliedVolatility].filter(v => v != null && isFinite(v) && v > 0);
        if (ivs.length) atmIV = +(ivs.reduce((s, v) => s + v, 0) / ivs.length).toFixed(4);
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

module.exports = { fetchOptionsBaseline, yahooAuth };
