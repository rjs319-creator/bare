'use strict';
// DILUTION RISK FROM THE FILINGS INDEX — EDGAR evidence combined with the existing
// headline-based supply-risk score.
//
// lib/supply-risk.js classifies dilution from NEWS HEADLINES and honestly discloses that it
// is "NOT a filings-index parse". This module adds the primary source: the SEC submissions
// index via lib/edgar.js (free, keyless, ~130ms throttled). It reads FORM TYPES AND DATES
// only — no document parsing, so it can never fabricate an offering size.
//
// A shelf on file is CAPACITY, not an imminent sale (same doctrine as lib/biotech-capital);
// it raises the score by a bounded pre-registered increment, it does not condemn the name.
// UNKNOWN stays UNKNOWN: no news AND no filings answer → UNKNOWN, never LOW.
//
// The combined DILUTION_RISK_SCORE (0-100) feeds risk grading only. Per the spec it must NOT
// auto-exclude an otherwise valid intraday momentum setup — consumers treat EXTREME as a risk
// label and a sizing input, not a hard gate (the existing HIGH-supply blocking rule upstream
// is unchanged).

const C = require('./ignition-live-config');
const { readJSON, writeJSON, hasStore } = require('./store');

const FILINGS_CACHE_KEY = 'lowfloat/filings-cache.json';
const DILUTION_FORMS = ['S-1', 'S-1/A', 'S-3', 'S-3/A', '424B*', '8-K'];
const DAY_MS = 86400000;

const finite = v => Number.isFinite(v);

// ── Pure: filing rows → flags. `filings` = [{form, filingDate, items}] from lib/edgar.js.
function filingFlags(filings = [], now = new Date()) {
  const nowMs = new Date(now).getTime();
  const ageDays = f => {
    const ms = Date.parse(f.filingDate);
    return finite(ms) ? (nowMs - ms) / DAY_MS : null;
  };
  const within = (f, days) => { const a = ageDays(f); return a != null && a >= 0 && a <= days; };
  const is424 = f => /^424B/.test(f.form || '');
  const isS3 = f => /^S-3/.test(f.form || '');
  const isS1 = f => /^S-1/.test(f.form || '');
  const unregisteredSale = f => (f.form === '8-K') && /(^|,)3\.02(,|$)/.test(String(f.items || ''));

  return {
    recentTakedown7d: filings.some(f => is424(f) && within(f, 7)),
    recentTakedown90d: filings.some(f => is424(f) && within(f, 90)),
    shelfOnFile400d: filings.some(f => isS3(f) && within(f, 400)),
    s1OnFile180d: filings.some(f => isS1(f) && within(f, 180)),
    unregisteredSales90d: filings.some(f => unregisteredSale(f) && within(f, 90)),
    filingCount: filings.length,
    newestFilingDate: filings.map(f => f.filingDate).filter(Boolean).sort().pop() || null,
  };
}

// ── Pure: combine the headline supply-risk assessment with filing flags into the final
//    0-100 DILUTION_RISK_SCORE and its LOW/MODERATE/HIGH/EXTREME label.
function combineDilutionRisk(supplyRisk = null, flags = null, { filingsChecked = false } = {}) {
  const P = C.DILUTION.FILING_POINTS;
  const headlineScore = supplyRisk && finite(supplyRisk.riskScore) ? supplyRisk.riskScore : null;
  const newsAvailable = !!(supplyRisk && supplyRisk.newsAvailable);

  let filingPoints = 0;
  const filingEvidence = [];
  if (flags) {
    // The 7-day takedown supersedes (not stacks with) the 90-day one — same event.
    if (flags.recentTakedown7d) { filingPoints += P.RECENT_TAKEDOWN_7D; filingEvidence.push('424B takedown within 7 days'); }
    else if (flags.recentTakedown90d) { filingPoints += P.RECENT_TAKEDOWN_90D; filingEvidence.push('424B takedown within 90 days'); }
    if (flags.shelfOnFile400d) { filingPoints += P.SHELF_ON_FILE_400D; filingEvidence.push('S-3 shelf on file (capacity, not a sale)'); }
    if (flags.s1OnFile180d) { filingPoints += P.S1_ON_FILE_180D; filingEvidence.push('S-1 on file within 180 days'); }
    if (flags.unregisteredSales90d) { filingPoints += P.UNREGISTERED_SALES_90D; filingEvidence.push('8-K item 3.02 unregistered sales within 90 days'); }
  }

  if (headlineScore == null && !filingsChecked) {
    return {
      version: C.DILUTION_FILINGS_VERSION, score: null, label: 'UNKNOWN', filingPoints: 0,
      headlineScore: null, filingEvidence: [],
      flags: spectFlags(supplyRisk, flags),
      basis: 'neither news nor the filings index answered — UNKNOWN, never assumed low',
    };
  }

  const score = Math.min(100, Math.round((newsAvailable && headlineScore != null ? headlineScore : 0) + filingPoints));
  // News unavailable + filings clean is still weak evidence — label stays UNKNOWN unless
  // filings themselves put points on the board.
  const label = (!newsAvailable && filingPoints === 0) ? 'UNKNOWN'
    : C.DILUTION.BANDS.find(b => score <= b.max).label;

  return {
    version: C.DILUTION_FILINGS_VERSION,
    score, label, headlineScore, filingPoints, filingEvidence,
    flags: spectFlags(supplyRisk, flags),
    basis: filingsChecked
      ? 'headline classification (lib/supply-risk) + EDGAR filings-index dates (forms only, no document parse)'
      : 'headline classification only — filings index not consulted for this name this cycle',
  };
}

// The spec's flag vocabulary, sourced from whichever layer actually observed each fact.
function spectFlags(supplyRisk, flags) {
  return {
    active_ATM: !!(supplyRisk && supplyRisk.atmRisk),
    recent_offering: !!((supplyRisk && supplyRisk.activeOfferingRisk) || (flags && (flags.recentTakedown7d || flags.recentTakedown90d))),
    recent_reverse_split: !!(supplyRisk && supplyRisk.reverseSplitRecent),
    warrant_overhang: !!(supplyRisk && supplyRisk.warrantOverhang),
    convertible_debt_risk: !!(supplyRisk && supplyRisk.convertibleRisk),
    shelf_registration: !!((supplyRisk && supplyRisk.shelfRisk) || (flags && flags.shelfOnFile400d)),
    s1_on_file: !!(flags && flags.s1OnFile180d),
  };
}

// ── Cache + bounded fetch. One shared cache doc; per-ticker TTL; per-tick fetch cap so the
//    EDGAR throttle can never eat the tick's budget. Failures record `checked:false` and the
//    combined label degrades honestly.
async function loadFilingsCache() {
  if (!hasStore()) return { byTicker: {} };
  return (await readJSON(FILINGS_CACHE_KEY, null).catch(() => null)) || { byTicker: {} };
}

async function enrichFilings(tickers = [], { now = new Date(), t0 = Date.now(), deadlineMs = 15000, cache = null } = {}) {
  const doc = cache || await loadFilingsCache();
  const byTicker = { ...(doc.byTicker || {}) };
  const ttlMs = C.DILUTION.CACHE_TTL_HOURS * 3600 * 1000;
  const nowMs = new Date(now).getTime();
  let fetched = 0, failed = 0, fromCache = 0;

  for (const t of tickers.slice(0, C.DILUTION.FETCH_CAP_PER_TICK)) {
    const hit = byTicker[t];
    if (hit && finite(Date.parse(hit.fetchedAt)) && nowMs - Date.parse(hit.fetchedAt) < ttlMs) { fromCache++; continue; }
    if (Date.now() - t0 > deadlineMs) break;
    try {
      const { cikFor, fetchRecentFilings } = require('./edgar');
      const cik = await cikFor(t);
      if (!cik) { byTicker[t] = { fetchedAt: new Date(now).toISOString(), filings: [], noCik: true }; fetched++; continue; }
      const fromDate = new Date(nowMs - 400 * DAY_MS).toISOString().slice(0, 10);
      const filings = await fetchRecentFilings(cik, { forms: DILUTION_FORMS, fromDate, maxFilings: 40 });
      byTicker[t] = {
        fetchedAt: new Date(now).toISOString(),
        filings: (filings || []).map(f => ({ form: f.form, filingDate: f.filingDate, items: f.items || null })),
      };
      fetched++;
    } catch { failed++; }
  }

  const next = { version: C.DILUTION_FILINGS_VERSION, byTicker, updatedAt: new Date(now).toISOString() };
  let saved = false;
  if ((fetched > 0) && hasStore()) {
    try { await writeJSON(FILINGS_CACHE_KEY, next, 0); saved = true; } catch { saved = false; }
  }
  return { byTicker, coverage: { requested: tickers.length, capped: Math.max(0, tickers.length - C.DILUTION.FETCH_CAP_PER_TICK), fetched, fromCache, failed, saved } };
}

// Assess one ticker from the (already-loaded) filings map + its supply-risk record.
function assessDilution(ticker, supplyRisk, filingsByTicker = {}, now = new Date()) {
  const entry = filingsByTicker[ticker] || null;
  const checked = !!entry;
  const flags = checked ? filingFlags(entry.filings || [], now) : null;
  return combineDilutionRisk(supplyRisk, flags, { filingsChecked: checked });
}

module.exports = {
  FILINGS_CACHE_KEY, DILUTION_FORMS,
  filingFlags, combineDilutionRisk, loadFilingsCache, enrichFilings, assessDilution,
};
