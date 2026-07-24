'use strict';
// 🧬 BIOTECH CAPITAL STRUCTURE (Phase 3) — deterministic dilution model, not an AI opinion.
//
// Dilution is the #1 biotech-swing failure mode ("they sell your breakout"). This moves it
// from a web-search guess to STRUCTURED, primary-source evidence wherever the free feeds allow:
//   • SEC EDGAR filing dates (S-3 shelf, 424B5 takedown, 8-K) — primary, deterministic.
//   • Company-news headlines classified by keyword (offering priced / announced / ATM / reverse
//     split) — secondary corroboration, NEVER the sole factual claim.
//   • EDGAR Form-4 insider net (already available) — insiders selling into strength.
//   • Finnhub shares-outstanding snapshot — a single count (no time series on free data).
//
// HONEST LIMITS (free data): cash, burn, and runway quarters are NOT available, so the model
// can CONFIRM a financing overhang but cannot assert FUNDED_THROUGH_CATALYST / ADEQUATE_RUNWAY —
// those require balance-sheet data and therefore degrade to UNKNOWN. A shelf on file is
// financing CAPACITY, not an imminent sale, and is scored as such (never auto-PENDING).

const { CAPITAL_STATES: S, VERSIONS } = require('./biotech-config');

// Keyword → offering-flag classifier for a single headline (deterministic, case-insensitive).
function classifyOfferingHeadline(title) {
  const t = String(title || '').toLowerCase();
  const has = (...ws) => ws.every(w => t.includes(w));
  return {
    atm: /\bat[- ]the[- ]market\b/.test(t) || /\batm (program|facility|offering)\b/.test(t),
    pricedOffering: (has('prices') || has('priced') || has('closes') || has('closing of')) && (t.includes('offering') || t.includes('placement')),
    announcedOffering: (has('announces') || has('proposed') || has('commences') || has('launch')) && (t.includes('offering') || t.includes('placement')),
    registeredDirect: t.includes('registered direct'),
    shelf: t.includes('shelf') || /\bs-3\b/.test(t),
    reverseSplit: t.includes('reverse split') || t.includes('reverse stock split'),
  };
}

// Fold a news list into aggregate offering flags + the most-recent offering headline age.
function offeringFlagsFromNews(news, asOf) {
  const flags = { atm: false, pricedOffering: false, announcedOffering: false, registeredDirect: false, shelf: false, reverseSplit: false };
  const sources = [];
  let mostRecentOfferingDate = null;
  for (const n of (news || [])) {
    const f = classifyOfferingHeadline(n.title);
    const hit = Object.values(f).some(Boolean);
    for (const k in flags) flags[k] = flags[k] || f[k];
    if (hit) {
      const d = n.datetime ? new Date(n.datetime).toISOString().slice(0, 10) : null;
      sources.push({ sourceType: 'news', title: String(n.title || '').slice(0, 200), publishedAt: d, primary: false });
      if (f.pricedOffering || f.announcedOffering || f.registeredDirect || f.atm) {
        if (d && (!mostRecentOfferingDate || d > mostRecentOfferingDate)) mostRecentOfferingDate = d;
      }
    }
  }
  return { flags, sources, mostRecentOfferingDate };
}

// Sessions (calendar-day proxy) between two ISO dates.
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}

/**
 * Pure classifier. `ev` = gathered evidence:
 *   { offeringFilings:[{form,filingDate,items}], newsFlags, offeringSources, mostRecentOfferingDate,
 *     insiderNet:{value}, sharesOut, price, asOf, hasNews, hasFilings }
 * Returns { state, dilutionRisk:'High'|'Medium'|'Low'|'None', confidence:1-5, evidence:[str],
 *           sources:[{...}], dataQuality, note, version }.
 */
function classifyCapitalState(ev = {}) {
  const filings = ev.offeringFilings || [];
  const nf = ev.newsFlags || {};
  const asOf = ev.asOf || null;
  const notes = [];
  const sources = [...(ev.offeringSources || [])];

  // Most-recent primary offering filing (424B5 = a priced takedown; S-3 = shelf capacity).
  const takedown = filings.filter(f => /^424B/.test(f.form)).sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1))[0] || null;
  const shelf = filings.filter(f => /^S-3/.test(f.form)).sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1))[0] || null;
  if (takedown) sources.push({ sourceType: 'sec', originId: takedown.accession, title: `${takedown.form} filed ${takedown.filingDate}`, publishedAt: takedown.filingDate, primary: true });
  if (shelf) sources.push({ sourceType: 'sec', originId: shelf.accession, title: `${shelf.form} shelf filed ${shelf.filingDate}`, publishedAt: shelf.filingDate, primary: true });

  const takedownAge = takedown ? daysBetween(takedown.filingDate, asOf) : null;
  const offeringAge = ev.mostRecentOfferingDate ? daysBetween(ev.mostRecentOfferingDate, asOf) : null;
  const insiderSelling = ev.insiderNet && ev.insiderNet.value != null && ev.insiderNet.value < 0;

  let state = S.UNKNOWN, dilutionRisk = 'Medium', confidence = 2;

  // Priority cascade — most acute overhang first.
  if (nf.reverseSplit) {
    state = S.SEVERE_DILUTION_RISK; dilutionRisk = 'High'; confidence = 4;
    notes.push('reverse-split / distress signal in recent news');
  } else if (nf.announcedOffering || (takedown && takedownAge != null && takedownAge <= 5)) {
    // Announced-but-not-yet-closed, or a 424B5 within the last ~5 sessions → active dilution into strength.
    state = S.PENDING_OFFERING; dilutionRisk = 'High'; confidence = takedown ? 4 : 3;
    notes.push(takedown ? `424B5 takedown ${takedownAge}d ago (offering in progress)` : 'offering announced, not yet priced');
  } else if (nf.atm) {
    state = S.ACTIVE_ATM; dilutionRisk = 'High'; confidence = 3;
    notes.push('active at-the-market program referenced');
  } else if (nf.pricedOffering || (takedown && takedownAge != null && takedownAge <= 20)) {
    // A priced/closed deal in the recent past → overhang CLEARED (candidate for financing-relief).
    state = S.COMPLETED_FINANCING_RELIEF; dilutionRisk = 'Low'; confidence = takedown ? 4 : 3;
    notes.push(takedown ? `priced offering ~${takedownAge}d ago (overhang cleared)` : 'recent priced offering (overhang cleared)');
  } else if (shelf || nf.shelf) {
    // Shelf on file = CAPACITY to raise, not an active sale. Only escalates with corroborating distress.
    if (insiderSelling) { state = S.FINANCING_LIKELY; dilutionRisk = 'Medium'; confidence = 3; notes.push('effective shelf on file + insider selling'); }
    else { state = S.UNKNOWN; dilutionRisk = 'Medium'; confidence = 2; notes.push('effective shelf on file (financing capacity, no active takedown)'); }
  } else {
    // No offering evidence at all. Without cash/runway data we CANNOT assert "funded" — stay UNKNOWN.
    state = S.UNKNOWN; dilutionRisk = ev.hasFilings || ev.hasNews ? 'Low' : 'Medium'; confidence = ev.hasFilings ? 2 : 1;
    notes.push(ev.hasFilings ? 'no offering filings found in the recent window' : 'no capital-structure evidence available');
  }

  if (insiderSelling && state !== S.SEVERE_DILUTION_RISK) notes.push(`net insider selling ($${Math.abs(ev.insiderNet.value).toLocaleString()})`);

  // Data quality: cash/runway is always unavailable on free feeds → at best DEGRADED.
  const dataQuality = (ev.hasFilings || ev.hasNews) ? 'DEGRADED' : 'MISSING';
  notes.push('cash & runway unavailable on free data (funded-through-catalyst cannot be confirmed)');

  return {
    state, dilutionRisk, confidence,
    fundedThroughCatalyst: null,        // requires balance-sheet data we do not have
    runwayQuarters: null, cash: null, sharesOut: ev.sharesOut != null ? ev.sharesOut : null,
    shelfOnFile: !!(shelf || nf.shelf), insiderNet: ev.insiderNet ? ev.insiderNet.value : null,
    evidence: notes, sources, dataQuality, version: VERSIONS.capital,
  };
}

/**
 * Async evidence gather + classify for one ticker. Deterministic sources first; degrades
 * gracefully when a provider is missing. `news` may be passed in to avoid a duplicate fetch.
 */
async function assessCapital(ticker, { asOf = null, price = null, news = null, fromDate = null, budgetMs = 6000 } = {}) {
  const t0 = Date.now();
  const out = { hasFilings: false, hasNews: false, asOf, price };
  const from = fromDate || new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);

  // News (offering headlines) — reuse the shared fundamentals feed if not supplied.
  try {
    let feed = news;
    if (!feed) {
      const { fetchCompanyNews } = require('./fundamentals');
      const today = asOf || new Date().toISOString().slice(0, 10);
      feed = await fetchCompanyNews(ticker, from, today).catch(() => null);
    }
    if (Array.isArray(feed)) {
      out.hasNews = true;
      const nf = offeringFlagsFromNews(feed, asOf);
      out.newsFlags = nf.flags; out.offeringSources = nf.sources; out.mostRecentOfferingDate = nf.mostRecentOfferingDate;
    }
  } catch { /* degrade */ }

  // EDGAR offering filings — deterministic primary source.
  if (Date.now() - t0 < budgetMs) {
    try {
      const { fetchOfferingFilings } = require('./edgar');
      const f = await fetchOfferingFilings(ticker, { fromDate: from, maxFilings: 40 });
      if (f && Array.isArray(f.filings)) { out.offeringFilings = f.filings; out.hasFilings = true; }
    } catch { /* degrade */ }
  }

  // Insider net (already-available EDGAR Form-4 aggregate) — optional, budget-gated.
  if (Date.now() - t0 < budgetMs) {
    try {
      const { fetchInsiderTransactions, aggregateInsider } = require('./edgar');
      const tx = await fetchInsiderTransactions(ticker, { fromDate: from, maxFilings: 20, throttleMs: 60 });
      if (tx && tx.txs && tx.txs.length) out.insiderNet = (aggregateInsider(tx.txs, { asOf }) || {}).net || null;
    } catch { /* degrade */ }
  }

  // Shares-outstanding snapshot (no growth series on free data).
  try {
    const { fetchFundamentals } = require('./fundamentals');
    const fund = await fetchFundamentals(ticker).catch(() => null);
    if (fund && fund.sharesOut != null) out.sharesOut = fund.sharesOut;
  } catch { /* degrade */ }

  return classifyCapitalState(out);
}

module.exports = { classifyCapitalState, classifyOfferingHeadline, offeringFlagsFromNews, assessCapital, daysBetween };
