const { sanitizeTickers } = require('../lib/auth');
const { fetchWithTimeout } = require('../lib/http');
const MS = require('../lib/market-session');

// Session comes from the CLOCK (shared calendar service) — was previously a
// duplicated copy of lib/signal.js deriveSession that let the last candle's
// timestamp self-certify the session, and could disagree with /api/chart.
function deriveSession() {
  return MS.legacyMarketState(MS.sessionInfoAt(new Date()).marketSession);
}

// Epoch seconds → ISO, or null. A missing/garbage provider timestamp stays NULL — it is
// never replaced with the fetch time (that would make a days-old print look current).
function isoFromEpochSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Pure: shape one Yahoo chart `result` into the quote the UI consumes. Carries three
// SEPARATE facts: observedAt (when the market printed the shown price — provider time),
// fetchedAt (when we asked) and marketState (the exchange session by the clock).
function shapeYahooQuote(result, marketState, fetchedAt = null) {
  const meta = result && result.meta;
  if (!meta) return null;
  const ts = result.timestamp || [];
  const rawCloses = result.indicators?.quote?.[0]?.close || [];
  let lastIdx = -1;
  for (let i = rawCloses.length - 1; i >= 0; i--) { if (rawCloses[i] != null) { lastIdx = i; break; } }
  const livePrice    = lastIdx >= 0 ? rawCloses[lastIdx] : meta.regularMarketPrice;
  const regularPrice = meta.regularMarketPrice ?? livePrice;
  if (!Number.isFinite(livePrice) || !Number.isFinite(regularPrice)) return null;
  // previousClose = yesterday's regular close (correct day-change base);
  // chartPreviousClose is window-relative. Equal on range=1d, but prefer
  // previousClose so this stays correct if the range ever widens.
  const prevClose    = meta.previousClose ?? meta.chartPreviousClose ?? regularPrice;
  const isExtended   = (marketState === 'PRE' || marketState === 'POST') &&
                       Math.abs(livePrice - regularPrice) > 0.001;
  const regChangePct = prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : 0;
  const lastBarAt = lastIdx >= 0 ? isoFromEpochSec(ts[lastIdx]) : null;
  const regularAt = isoFromEpochSec(meta.regularMarketTime);

  return {
    price: (isExtended ? livePrice : regularPrice).toFixed(2),
    regularPrice: regularPrice.toFixed(2),
    change: (regularPrice - prevClose).toFixed(2),
    changePct: regChangePct.toFixed(2),
    previousClose: prevClose.toFixed(2),
    marketState,
    // When the SHOWN price was observed: the extended-hours bar when that is what is shown,
    // otherwise the regular-session print. null when the provider gave no usable time.
    observedAt: isExtended ? lastBarAt : (regularAt || lastBarAt),
    fetchedAt: fetchedAt || null,
    source: 'yahoo',
    afterHours: isExtended ? {
      price: livePrice.toFixed(2),
      change: (livePrice - regularPrice).toFixed(2),
      changePct: regularPrice ? ((livePrice - regularPrice) / regularPrice * 100).toFixed(2) : '0.00',
      session: (marketState === 'PRE' || marketState === 'PREPRE') ? 'pre' : 'post',
    } : null,
  };
}

// Live quote with extended-hours (pre/post market) pricing via Yahoo Finance,
// with a Stooq fallback for the regular-session close.
async function fetchYahoo(ticker) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=1d&interval=5m&includePrePost=true`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const quote = shapeYahooQuote(j?.chart?.result?.[0], deriveSession(), new Date().toISOString());
      if (!quote) continue;
      return quote;
    } catch { /* try next host */ }
  }
  return null;
}

async function fetchStooq(ticker) {
  try {
    const symbol = `${ticker.toUpperCase()}.US`;
    const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcvn&h&e=csv`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(',');
    const open  = parseFloat(parts[3]);
    const close = parseFloat(parts[6]);
    if (!close || isNaN(close)) return null;
    const changePct = open ? ((close - open) / open * 100) : 0;
    return {
      price: close.toFixed(2), regularPrice: close.toFixed(2),
      change: (close - open).toFixed(2), changePct: changePct.toFixed(2),
      previousClose: open.toFixed(2), marketState: 'CLOSED', afterHours: null,
      // Stooq's row carries a date + an exchange-local time with no zone we can trust, so
      // the instant stays unknown (null); the session DATE is passed through when well-formed.
      observedAt: null,
      observedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parts[1] || '').trim()) ? String(parts[1]).trim() : null,
      fetchedAt: new Date().toISOString(),
      source: 'stooq',
    };
  } catch { return null; }
}

async function fetchQuote(ticker) {
  return (await fetchYahoo(ticker)) || (await fetchStooq(ticker));
}

// Last ~4 daily closes (the 3-session trend) for a sparkline. A second, lightweight
// Yahoo call (daily bars) only made when the caller asks for it (?spark=1) — the live
// quote above uses 5-minute bars, so it can't supply multi-day history on its own.
async function fetchSpark(ticker) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=5d&interval=1d`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const closes = ((await r.json())?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter(v => v != null)
        .map(v => +v.toFixed(2));
      if (closes.length >= 2) return closes.slice(-4); // ~3 prior sessions + today
      return null;
    } catch { /* try next host */ }
  }
  return null;
}

module.exports = async function handler(req, res) {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'Missing tickers' });

  // Validate before building provider URLs — reject path-injection / malformed symbols.
  const tickerList = sanitizeTickers(tickers, 12);
  if (!tickerList.length) return res.status(400).json({ error: 'No valid tickers' });

  try {
    const quotes = await Promise.all(tickerList.map(t => fetchQuote(t.trim())));
    const results = {};
    tickerList.forEach((t, i) => {
      if (quotes[i]) results[t.trim().toUpperCase()] = quotes[i];
    });
    // Optional 3-session daily trend (?spark=1) — attach a compact close series per name.
    if (req.query.spark) {
      const sparks = await Promise.all(tickerList.map(t => fetchSpark(t.trim())));
      tickerList.forEach((t, i) => {
        const key = t.trim().toUpperCase();
        if (results[key] && sparks[i]) results[key].spark = sparks[i];
      });
    }
    res.setHeader('Cache-Control', 's-maxage=30'); // 30s — keep prices near-live
    return res.json(results);
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch prices.' });
  }
};
module.exports.shapeYahooQuote = shapeYahooQuote;
module.exports.isoFromEpochSec = isoFromEpochSec;
