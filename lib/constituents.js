// Point-in-time S&P 500 membership helper — pulls the authoritative "changes"
// table from Wikipedia so the backfill can include names that WERE in the index
// during the window but have since been removed (survivorship-bias correction).
// Best-effort: any failure returns [] and the backfill falls back to current
// constituents only.
// 2026-08-11: Wikipedia moved the "Selected changes" wikitable off the companies list
// into a dedicated article. Fetching the old page returns a page with NO changes table,
// and because this module is best-effort the survivorship correction silently became a
// no-op (zero removals) — discovered 2026-08-15 by research/94-index-events.js. The
// parsers are unchanged; only the source page moved.
const WIKI = 'https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500';

// Returns [{ ticker, removedDate: 'YYYY-MM-DD' }] for names removed within the
// last `years` (default 3). Yahoo tickers use '-' for class shares.
// Pure parse of the S&P "changes" wikitable HTML → [{ ticker, removedDate }] within `years`.
// Exported for testing. CRITICAL: the row regex must tolerate attributes — Wikipedia emits
// `<tr class="...">`, and a strict `/<tr>/` matched ZERO rows, silently emptying the entire
// delisting source (so every survivorship correction added nothing). See the regression test.
function parseRemovedConstituents(html, { years = 3, now = Date.now() } = {}) {
  const tables = [...(html || '').matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/g)].map(m => m[0]);
  const changes = tables.find(t => /Removed/.test(t) && /Date/.test(t) && /Reason/i.test(t));
  if (!changes) return [];
  const cutoff = new Date(now - years * 365 * 864e5);
  const out = [];
  for (const rowMatch of changes.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
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
}

async function fetchRemovedConstituents(years = 3) {
  try {
    const r = await fetch(WIKI, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    return parseRemovedConstituents(await r.text(), { years });
  } catch { return []; }
}

// PURE parse of a Wikipedia S&P-family "changes" wikitable → recent
// { adds:[{ticker,date}], removes:[{ticker,date}] } within `daysBack` days.
// The 500/400/600 pages all share the 6-column layout
// (Date | +Ticker | +Name | −Ticker | −Name | Reason). Exported for testing.
function parseIndexChanges(html, { daysBack = 70, now = Date.now() } = {}) {
  const tables = [...(html || '').matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/g)].map(m => m[0]);
  const changes = tables.find(t => /Removed/.test(t) && /Date/.test(t) && /Reason/i.test(t));
  if (!changes) return { adds: [], removes: [] };
  const cutoff = new Date(now - daysBack * 864e5);
  const adds = [], removes = [];
  const clean = t => (t || '').replace(/\./g, '-');
  const ok = t => /^[A-Z][A-Z\-]{0,5}$/.test(t);
  for (const rowMatch of changes.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
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
    return parseIndexChanges(await r.text(), { daysBack });
  } catch { return { adds: [], removes: [] }; }
}

// S&P MidCap 400 + SmallCap 600 changes — the same mechanical forced flow with
// SEVERAL TIMES the event frequency of the 500 and a LARGER flow-vs-ADV impact
// (small/mid names, smaller tracking AUM but far thinner books). Rows carry an
// `index` tag so the CERN ledger can grade the tiers separately.
const SMID_SOURCES = [
  { index: 'sp400', url: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies' },
  { index: 'sp600', url: 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies' },
];

async function fetchRecentSmidIndexChanges(daysBack = 70) {
  const adds = [], removes = [];
  for (const src of SMID_SOURCES) {
    try {
      const r = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;                          // best-effort per index — one page down must not drop the other
      const chg = parseIndexChanges(await r.text(), { daysBack });
      adds.push(...chg.adds.map(x => ({ ...x, index: src.index })));
      removes.push(...chg.removes.map(x => ({ ...x, index: src.index })));
    } catch { /* best-effort */ }
  }
  return { adds, removes };
}

module.exports = { fetchRemovedConstituents, fetchRecentIndexChanges, fetchRecentSmidIndexChanges, parseRemovedConstituents, parseIndexChanges, SMID_SOURCES };
