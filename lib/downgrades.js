// Forced-downgrade feed for CERN's FORCED_DOWNGRADE event type.
//
// A sell-side downgrade (especially to sell/underperform) triggers mechanical
// de-risking — mandate-constrained funds trim, quant/momentum models flip, risk
// desks cut — pushing the name below its peers on a burst of supply. That
// dislocation tends to partially revert once the forced selling clears
// (FORCED_DOWNGRADE κ≈0.65, ~45d, direction -1 = long the reversion).
//
// Source: FMP `grades-latest-news` — a market-wide, time-ordered (newest-first),
// paginated feed of analyst grade actions with structured fields {symbol,
// publishedDate, action, previousGrade, newGrade, gradingCompany}. We page back
// `lookbackDays` and keep action==='downgrade'. (FMP's per-symbol `grades`
// ignores limit and returns full history — too heavy at universe scale — and the
// v4 upgrades-downgrades + Finnhub upgrade-downgrade endpoints are legacy-locked
// / premium on our tier; this bulk feed is the one that works.)
//
// HONEST CAVEAT: an analyst downgrade is a softer "forced flow" than an index
// deletion or a fund fire-sale — part sentiment, part mechanical. CERN's gates
// (peer-relative dislocation D, abnormal-volume completion, absorption bar) plus
// counterfactual logging are what separate the downgrades that actually force
// supply from the ones the market shrugs off.
const FMP_KEY = process.env.FMP_API_KEY;
const DAY = 86400000;

async function fetchGradesPage(page, limit) {
  const r = await fetch(`https://financialmodelingprep.com/stable/grades-latest-news?page=${page}&limit=${limit}&apikey=${FMP_KEY}`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows : null;
}

// Recent downgrades within [now-lookbackDays, now], deduped by ticker (most
// recent kept). `allow` (optional Set of tickers) restricts to a tradeable
// universe. Graceful: returns [] on missing key or any failure.
async function fetchRecentDowngrades({ nowMs = Date.now(), lookbackDays = 5, maxPages = 12, limit = 100, allow = null } = {}) {
  if (!FMP_KEY) return [];
  const cutoff = nowMs - lookbackDays * DAY;
  const seen = new Map();
  for (let p = 0; p < maxPages; p++) {
    let rows;
    try { rows = await fetchGradesPage(p, limit); } catch { break; }
    if (!rows || !rows.length) break;
    let sawInWindow = false;
    for (const x of rows) {
      const ms = Date.parse(x.publishedDate || x.date || '');
      if (isNaN(ms) || ms < cutoff) continue;
      sawInWindow = true;
      if (String(x.action).toLowerCase() !== 'downgrade') continue;
      const ticker = String(x.symbol || '').toUpperCase().replace(/\./g, '-');
      if (!/^[A-Z][A-Z\-]{0,5}$/.test(ticker)) continue;
      if (allow && !allow.has(ticker)) continue;
      const prev = seen.get(ticker);
      if (!prev || ms > prev.dateMs)
        seen.set(ticker, { ticker, dateMs: ms, from: x.previousGrade || null, to: x.newGrade || null, firm: x.gradingCompany || null });
    }
    // Feed is newest-first: once an entire page predates the window, stop paging.
    if (!sawInWindow) break;
  }
  return [...seen.values()];
}

module.exports = { fetchRecentDowngrades };
