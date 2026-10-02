// ⌘K PALETTE INDEX — pure shaping for the fuzzy search (Fuse.js, vendored, lazy-loaded by
// command-palette.js). Three item types share one index: app sections, Learn concepts, and the
// tickers currently on screen WITH their company names (so "nvidia" finds NVDA). No DOM access
// except collectTickersFromDom, which is handed a root and only reads attributes/text.

export const FUSE_OPTIONS = Object.freeze({
  keys: [
    { name: 'label', weight: 3 },
    { name: 'ticker', weight: 3 },
    { name: 'company', weight: 2 },
    { name: 'id', weight: 1 },
    { name: 'group', weight: 1 },
  ],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
});
const MIN_WORD_LEN = 2;

const TICKER_SHAPE = /^[A-Z][A-Z0-9.\-]{0,7}$/;
// The company-name element inside a rendered card (scr-company, cx-company, pc-company,
// alert-company, al-co, ps-co, thx-co, td-co, sb-name). Text is "Company · Sector · Exchange".
const COMPANY_SEL = '[class$="-company"], [class$="-co"], .td-co, .sb-name';
const CARD_SEL = '.cx-card, .scr-card, .dt-card, .fade-card, .bt-card, .td-card, .sb-card, .pick-card, .alert-card, article, li, tr';
const SECTION_SEL = 'section.tabbable, section[id]';

const str = (v) => (v == null ? '' : String(v).trim());

function sectionItems(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && str(s.id) && str(s.label))
    .map((s) => ({ type: 'section', id: str(s.id), label: str(s.label), group: str(s.group) }));
}

function learnItems(learn) {
  return (Array.isArray(learn) ? learn : [])
    .filter((l) => l && str(l.key) && str(l.label))
    .map((l) => ({ type: 'learn', key: str(l.key), label: str(l.label), group: str(l.group) }));
}

// Dedupe on symbol; union the sections; union the DISTINCT company strings. Cards that lack a
// company name render a stand-in there (Today: the setup name; Session Board: the sector), so
// keeping every distinct string means the one card that does carry "Moderna" makes it findable.
const COMPANY_JOIN = ' · ';
function tickerItems(tickers) {
  const byTicker = new Map();
  for (const t of Array.isArray(tickers) ? tickers : []) {
    const sym = str(t && t.ticker).toUpperCase();
    if (!TICKER_SHAPE.test(sym)) continue;
    const prev = byTicker.get(sym) || { type: 'ticker', ticker: sym, label: sym, company: '', sections: [] };
    const sections = [...new Set([...prev.sections, ...(Array.isArray(t.sections) ? t.sections.map(str).filter(Boolean) : [])])];
    const companies = [...new Set([...prev.company.split(COMPANY_JOIN), ...str(t.company).split(COMPANY_JOIN)].map(str).filter((c) => c && c !== '?'))];
    byTicker.set(sym, { ...prev, company: companies.join(COMPANY_JOIN), sections });
  }
  return [...byTicker.values()];
}

export function buildIndexItems({ sections, learn, tickers } = {}) {
  return [...sectionItems(sections), ...learnItems(learn), ...tickerItems(tickers)];
}

// Top-N matches from a Fuse instance (best score first). A multi-word query that matches nothing
// whole ("sesion board" against the label "Session") is retried word by word and merged on best
// score, so an extra word never empties the list. Never throws — a broken index means "no fuzzy
// results", and the caller falls back to its substring path.
export function rankMatches(fuse, query, max = 12) {
  const q = str(query);
  if (!fuse || !q || typeof fuse.search !== 'function') return [];
  try {
    const whole = fuse.search(q, { limit: max });
    if (whole.length) return whole.map((r) => r.item);
    const words = q.split(/\s+/).filter((w) => w.length >= MIN_WORD_LEN);
    if (words.length < 2) return [];
    const best = new Map();
    for (const w of words) {
      for (const r of fuse.search(w, { limit: max })) {
        const prev = best.get(r.item);
        if (prev == null || r.score < prev) best.set(r.item, r.score);
      }
    }
    return [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, max).map(([item]) => item);
  } catch { return []; }
}

function companyOf(card) {
  if (!card || typeof card.querySelector !== 'function') return '';
  const el = card.querySelector(COMPANY_SEL);
  return el ? str(el.textContent).split(' · ')[0].trim() : '';
}

// Scrape the cards the app has rendered: every [data-live] / [data-ticker] element, with the
// company text next to it and the section it sits in. Best-effort and read-only.
export function collectTickersFromDom(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const found = [];
  let nodes;
  try { nodes = root.querySelectorAll('[data-live], [data-ticker]'); } catch { return []; }
  for (const el of nodes) {
    const sym = str(el.getAttribute('data-live') || el.getAttribute('data-ticker')).toUpperCase();
    if (!TICKER_SHAPE.test(sym)) continue;
    const card = typeof el.closest === 'function' ? el.closest(CARD_SEL) : null;
    const section = typeof el.closest === 'function' ? el.closest(SECTION_SEL) : null;
    found.push({ ticker: sym, company: companyOf(card), sections: section && section.id ? [section.id] : [] });
  }
  return tickerItems(found).map(({ ticker, company, sections }) => ({ ticker, company, sections }));
}
