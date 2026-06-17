// Point-in-time S&P 500 membership helper — pulls the authoritative "changes"
// table from Wikipedia so the backfill can include names that WERE in the index
// during the window but have since been removed (survivorship-bias correction).
// Best-effort: any failure returns [] and the backfill falls back to current
// constituents only.
const WIKI = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

// Returns [{ ticker, removedDate: 'YYYY-MM-DD' }] for names removed within the
// last `years` (default 3). Yahoo tickers use '-' for class shares.
async function fetchRemovedConstituents(years = 3) {
  try {
    const r = await fetch(WIKI, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const html = await r.text();
    const tables = [...html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/g)].map(m => m[0]);
    const changes = tables.find(t => /Removed/.test(t) && /Date/.test(t) && /Reason/i.test(t));
    if (!changes) return [];
    const cutoff = new Date(Date.now() - years * 365 * 864e5);
    const out = [];
    for (const rowMatch of changes.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
      if (cells.length < 5) continue;                 // Date | +Ticker | +Name | −Ticker | −Name | Reason
      const d = new Date(cells[0]);
      if (isNaN(d) || d < cutoff) continue;
      const ticker = (cells[3] || '').replace(/\./g, '-'); // BRK.B → BRK-B for Yahoo
      if (/^[A-Z][A-Z\-]{0,5}$/.test(ticker)) out.push({ ticker, removedDate: d.toISOString().slice(0, 10) });
    }
    // Dedupe (keep earliest removal per ticker).
    const seen = new Map();
    for (const x of out.sort((a, b) => (a.removedDate < b.removedDate ? -1 : 1))) if (!seen.has(x.ticker)) seen.set(x.ticker, x);
    return [...seen.values()];
  } catch { return []; }
}

// Recent S&P 500 index changes (both sides) for the CERN forced-flow engine.
// A deletion forces passive index funds to SELL (→ INDEX_DELETE, buy the
// reversion); an addition forces them to BUY, which tends to give back (→
// INDEX_ADD_FADE). Returns { adds:[{ticker,date}], removes:[{ticker,date}] }
// within the last `daysBack` days (default 70 ≈ a bit beyond the 40-45d horizons).
async function fetchRecentIndexChanges(daysBack = 70) {
  try {
    const r = await fetch(WIKI, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { adds: [], removes: [] };
    const html = await r.text();
    const tables = [...html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/g)].map(m => m[0]);
    const changes = tables.find(t => /Removed/.test(t) && /Date/.test(t) && /Reason/i.test(t));
    if (!changes) return { adds: [], removes: [] };
    const cutoff = new Date(Date.now() - daysBack * 864e5);
    const adds = [], removes = [];
    const clean = t => (t || '').replace(/\./g, '-');
    const ok = t => /^[A-Z][A-Z\-]{0,5}$/.test(t);
    for (const rowMatch of changes.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
      if (cells.length < 5) continue;                 // Date | +Ticker | +Name | −Ticker | −Name | Reason
      const d = new Date(cells[0]);
      if (isNaN(d) || d < cutoff) continue;
      const date = d.toISOString().slice(0, 10);
      const added = clean(cells[1]), removed = clean(cells[3]);
      if (ok(added)) adds.push({ ticker: added, date });
      if (ok(removed)) removes.push({ ticker: removed, date });
    }
    return { adds, removes };
  } catch { return { adds: [], removes: [] }; }
}

module.exports = { fetchRemovedConstituents, fetchRecentIndexChanges };
