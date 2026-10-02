'use strict';
// WIKIDATA P414 → English Wikipedia article (wikidata-tickers-v1).
//
// One SPARQL query lists every item with a "stock exchange" (P414) statement on the
// exchanges below, the ticker qualifier (P249) and the item's enwiki sitelink title.
// That is the ticker → article map the pageview study keys on. Pure parse exported.

const { fetchJSON } = require('./http-polite');

const WIKIDATA_TICKERS_VERSION = 'wikidata-tickers-v1';
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
// NYSE, NASDAQ, NYSE American, NYSE Arca, Cboe BZX
const EXCHANGES = Object.freeze(['wd:Q13677', 'wd:Q82059', 'wd:Q846626', 'wd:Q2632892', 'wd:Q5133034']);

const QUERY = `SELECT ?ticker ?title ?item WHERE {
  ?item p:P414 ?s . ?s ps:P414 ?ex ; pq:P249 ?ticker .
  VALUES ?ex { ${EXCHANGES.join(' ')} }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
}`;

const normTicker = (t) => String(t || '').toUpperCase().trim().replace(/\./g, '-');

// Pure: SPARQL JSON bindings → { TICKER: { title, item } } (first title wins per ticker;
// a ticker that maps to several items is flagged ambiguous and dropped — a wrong article
// is worse than a missing one). Exported for tests.
function parseBindings(json) {
  const rows = (json && json.results && Array.isArray(json.results.bindings)) ? json.results.bindings : [];
  const seen = new Map();
  const ambiguous = new Set();
  for (const b of rows) {
    const ticker = normTicker(b.ticker && b.ticker.value);
    const title = b.title && b.title.value;
    const item = b.item && b.item.value;
    if (!/^[A-Z][A-Z0-9-]{0,5}$/.test(ticker) || !title) continue;
    const prior = seen.get(ticker);
    if (prior && prior.item !== item) { ambiguous.add(ticker); continue; }
    if (!prior) seen.set(ticker, { title, item: item || null });
  }
  for (const t of ambiguous) seen.delete(t);
  return { map: Object.fromEntries([...seen.entries()].sort()), ambiguous: [...ambiguous].sort(), rows: rows.length };
}

async function fetchTickerMap({ fetchImpl } = {}) {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(QUERY)}`;
  const r = await fetchJSON(url, { fetchImpl, headers: { Accept: 'application/sparql-results+json' }, timeoutMs: 120000 });
  if (!r.ok) throw new Error(`Wikidata SPARQL failed: HTTP ${r.status}`);
  return { version: WIKIDATA_TICKERS_VERSION, fetchedAt: new Date().toISOString(), exchanges: EXCHANGES, ...parseBindings(r.json) };
}

module.exports = { WIKIDATA_TICKERS_VERSION, EXCHANGES, QUERY, normTicker, parseBindings, fetchTickerMap };
