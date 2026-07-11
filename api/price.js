const { sanitizeTickers } = require('../lib/auth');

// Determine which session the latest print belongs to (no marketState in meta).
function deriveSession(meta, lastTs) {
  const tp = meta.currentTradingPeriod;
  if (tp && lastTs) {
    if (tp.post && lastTs >= tp.post.start) return 'POST';
    if (tp.regular && lastTs >= tp.regular.start && lastTs < tp.regular.end) return 'REGULAR';
    if (tp.pre && lastTs >= tp.pre.start && lastTs < tp.pre.end) return 'PRE';
    if (tp.regular && lastTs >= tp.regular.end) return 'POST';
    return 'CLOSED';
  }
  if (meta.regularMarketTime && lastTs) return lastTs > meta.regularMarketTime + 120 ? 'POST' : 'REGULAR';
  return 'CLOSED';
}

// Live quote with extended-hours (pre/post market) pricing via Yahoo Finance,
// with a Stooq fallback for the regular-session close.
async function fetchYahoo(ticker) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=1d&interval=5m&includePrePost=true`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) continue;

      const ts = result.timestamp || [];
      const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      const livePrice    = closes.length ? closes[closes.length - 1] : meta.regularMarketPrice;
      const regularPrice = meta.regularMarketPrice ?? livePrice;
      // previousClose = yesterday's regular close (correct day-change base);
      // chartPreviousClose is window-relative. Equal on range=1d, but prefer
      // previousClose so this stays correct if the range ever widens.
      const prevClose    = meta.previousClose ?? meta.chartPreviousClose ?? regularPrice;
      const marketState  = deriveSession(meta, ts[ts.length - 1]);
      const isExtended   = (marketState === 'PRE' || marketState === 'POST') &&
                           Math.abs(livePrice - regularPrice) > 0.001;

      const regChangePct = prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : 0;

      return {
        price: (isExtended ? livePrice : regularPrice).toFixed(2),
        regularPrice: regularPrice.toFixed(2),
        change: (regularPrice - prevClose).toFixed(2),
        changePct: regChangePct.toFixed(2),
        previousClose: prevClose.toFixed(2),
        marketState,
        afterHours: isExtended ? {
          price: livePrice.toFixed(2),
          change: (livePrice - regularPrice).toFixed(2),
          changePct: regularPrice ? ((livePrice - regularPrice) / regularPrice * 100).toFixed(2) : '0.00',
          session: (marketState === 'PRE' || marketState === 'PREPRE') ? 'pre' : 'post',
        } : null,
      };
    } catch { /* try next host */ }
  }
  return null;
}

async function fetchStooq(ticker) {
  try {
    const symbol = `${ticker.toUpperCase()}.US`;
    const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcvn&h&e=csv`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
      const r = await fetch(`https://${host}${path}`, {
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
