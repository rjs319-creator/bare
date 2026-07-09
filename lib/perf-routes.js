// op=perf — day / 5-session / 1-month price performance for an ARBITRARY ticker
// list, computed consistently from daily candles (same source the screener uses,
// so a name's day-change here matches its screener changePct). Powers Quick Hit's
// two mover leaderboards across every name the app surfaces — screeners, options
// flow, forecasts and the AI screeners. No new serverless function: routed through
// api/tracker.js like every other op.
const { fetchDailyHistory } = require('./screener');

// Allow plain tickers plus index/ETF symbols (^VIX, BRK.B, etc.); cap the batch so
// a hand-crafted request can't fan out into an unbounded number of candle fetches.
const TICKER_RE = /^\^?[A-Z][A-Z.\-]{0,5}$/;
const MAX_TICKERS = 150;
const CONCURRENCY = 8;

// %-return of the latest close vs the close k sessions earlier (null if not enough
// history or a bad price).
function retK(closes, k) {
  const last = closes.length - 1;
  if (last - k < 0) return null;
  const then = closes[last - k], now = closes[last];
  if (!(then > 0) || !(now > 0)) return null;
  return +(((now / then) - 1) * 100).toFixed(2);
}

// One ticker's {price, day, d5, m1} from its daily candles, or null on failure.
async function computePerf(ticker) {
  const d = await fetchDailyHistory(ticker);
  if (!d || !Array.isArray(d.candles)) return null;
  const closes = d.candles.map(c => c.close).filter(v => v != null);
  if (closes.length < 2) return null;
  return {
    price: +closes[closes.length - 1].toFixed(2),
    day: retK(closes, 1),   // latest session
    d5:  retK(closes, 5),   // past 5 trading sessions
    m1:  retK(closes, 21),  // past month (~21 sessions)
  };
}

async function runPerf(req, res) {
  const tickers = [...new Set(
    String(req.query.tickers || '')
      .split(',').map(t => t.trim().toUpperCase())
      .filter(t => TICKER_RE.test(t))
  )].slice(0, MAX_TICKERS);

  const perf = {};
  if (tickers.length) {
    let i = 0;
    const worker = async () => {
      while (i < tickers.length) {
        const t = tickers[i++];
        try { const p = await computePerf(t); if (p) perf[t] = p; } catch { /* skip — name just won't rank */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({ perf, count: Object.keys(perf).length, generatedAt: new Date().toISOString() });
}

module.exports = { runPerf, computePerf, retK };
