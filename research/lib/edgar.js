'use strict';
// SEC EDGAR delisting-evidence enrichment for secmaster-v3.
//
// WHY THIS EXISTS: the FMP /delisted-companies feed is plan-gated to the ~100
// most-recent rows (validated 2026-08-02), so historical delistings cannot be
// confirmed from FMP alone. EDGAR is the PRIMARY authoritative source and is
// free:
//   Form 25 / 25-NSE — notification of removal from listing (SEC Rule 12d2-2;
//                      delisting becomes effective 10 days after filing)
//   Form 15          — deregistration under 12b/12g (supporting evidence)
//   8-K item 1.03    — bankruptcy or receivership       → reason 'bankruptcy'
//   8-K item 2.01    — completion of acquisition/merger → reason 'acquisition'
//                      (only trusted within a window of the Form 25)
// Item 3.01 (delisting-deficiency notices) is deliberately NOT used to infer a
// reason — it also covers cured deficiencies and voluntary transfers.
//
// CAVEAT, HANDLED DOWNSTREAM: a Form 25 is also filed on a voluntary exchange
// TRANSFER (the old exchange delists the security while it keeps trading
// elsewhere). Enrichment therefore only runs for securities that are NOT
// actively trading, and fwd-outcome-v3's conflicting-status and
// truncation-explanation guards reject any Form-25 date that price bars
// contradict. No label is ever produced from a transfer this way.
//
// Fair-access compliance: ≤ ~6 req/s (SEC allows 10), identifying User-Agent,
// one cache file per CIK (resumable; rerun only fetches what is missing).
// No API key exists on this host; nothing secret can leak.

const fs = require('fs');
const path = require('path');

const SEC_SUBMISSIONS = 'https://data.sec.gov/submissions';
const USER_AGENT = 'market-news-app-research/1.0 (rjs319@gmail.com)';
const REQUEST_INTERVAL_MS = 170;
const MAX_RETRIES = 4;
const FORM25_EFFECTIVE_DAYS = 10;          // Rule 12d2-2(d)(1)
const BANKRUPTCY_8K_WINDOW_DAYS = 400;     // 1.03 before/around the Form 25
const COMPLETION_8K_WINDOW_DAYS = 60;      // 2.01 near the Form 25
const DAY = 86400000;

const padCik = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

// ── pure: submissions JSON → delisting evidence ───────────────────────────────
// submissions.filings.recent is a column-oriented table: { form: [...],
// filingDate: [...], items: [...], accessionNumber: [...] } (parallel arrays).
function extractDelistingEvidence(submissions) {
  const recent = submissions && submissions.filings && submissions.filings.recent;
  if (!recent || !Array.isArray(recent.form)) return { form25: null, form15: null, bankruptcy8k: [], completion8k: [], coverage: 'no-filings' };
  const n = recent.form.length;
  let form25 = null, form15 = null;
  const bankruptcy8k = [], completion8k = [];
  for (let i = 0; i < n; i++) {
    const form = String(recent.form[i] || '').toUpperCase();
    const filingDate = recent.filingDate[i] || null;
    if (!filingDate) continue;
    const row = { form, filingDate, accessionNumber: (recent.accessionNumber && recent.accessionNumber[i]) || null };
    if (form === '25' || form === '25-NSE') {
      // keep the LATEST Form 25 (a serial filer may have several)
      if (!form25 || filingDate > form25.filingDate) form25 = row;
    } else if (form === '15' || form.startsWith('15-')) {
      if (!form15 || filingDate > form15.filingDate) form15 = row;
    } else if (form === '8-K' || form === '8-K/A') {
      const items = String((recent.items && recent.items[i]) || '');
      if (items.includes('1.03')) bankruptcy8k.push(row);
      if (items.includes('2.01')) completion8k.push(row);
    }
  }
  const oldest = n ? recent.filingDate[n - 1] : null;
  return { form25, form15, bankruptcy8k, completion8k, coverage: oldest ? `recent-window-back-to-${oldest}` : 'empty' };
}

// pure: evidence → a delisting confirmation block (or null when no Form 25/15)
function deriveDelisting(evidence, retrievedAtIso) {
  const anchor = evidence.form25 || evidence.form15;
  if (!anchor) return null;
  const filingMs = Date.parse(anchor.filingDate);
  if (!Number.isFinite(filingMs)) return null;
  const isForm25 = !!evidence.form25;
  const effectiveMs = isForm25 ? filingMs + FORM25_EFFECTIVE_DAYS * DAY : filingMs;
  const near = (rows, windowDays, { onlyBefore = false } = {}) => rows.some((r) => {
    const ms = Date.parse(r.filingDate);
    if (!Number.isFinite(ms)) return false;
    const delta = filingMs - ms;
    return onlyBefore ? (delta >= -30 * DAY && delta <= windowDays * DAY) : Math.abs(delta) <= windowDays * DAY;
  });
  let reasonCategory = null, reason = null;
  if (near(evidence.bankruptcy8k, BANKRUPTCY_8K_WINDOW_DAYS, { onlyBefore: true })) {
    reasonCategory = 'bankruptcy';
    reason = '8-K item 1.03 (bankruptcy or receivership) filed within window of delisting notice';
  } else if (near(evidence.completion8k, COMPLETION_8K_WINDOW_DAYS)) {
    reasonCategory = 'acquisition';
    reason = '8-K item 2.01 (completion of acquisition) filed within window of delisting notice';
  }
  return {
    date: new Date(effectiveMs).toISOString().slice(0, 10),
    source: isForm25 ? 'sec-edgar-form25' : 'sec-edgar-form15',
    sourcePublishedAt: anchor.filingDate,
    confirmedAt: retrievedAtIso || null,
    reason, reasonCategory,
    provenance: 'regulatory_filing',
    evidence: {
      type: isForm25 ? 'form25' : 'form15',
      accessionNumber: anchor.accessionNumber,
      filingDate: anchor.filingDate,
      effectiveRule: isForm25 ? '12d2-2(d): effective 10 days after filing' : '12b/12g deregistration filing date',
    },
  };
}

// ── fetch layer: rate-limited, cached per CIK, resumable ──────────────────────
function makeEdgarFetcher(cacheDir, { refresh = false } = {}) {
  let lastCall = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function submissionsFor(cik) {
    const id = padCik(cik);
    const f = path.join(cacheDir, 'edgar', `CIK${id}.json`);
    if (!refresh && fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* refetch corrupt file */ }
    }
    const wait = lastCall + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${SEC_SUBMISSIONS}/CIK${id}.json`, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw new Error(`edgar CIK${id}: network failure after ${attempt} retries — ${e.message}`);
        await sleep(700 * 2 ** attempt); continue;
      }
      if (res.status === 404) {
        const doc = { retrievedAt: new Date().toISOString(), cik: id, notFound: true };
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(doc));
        return doc;
      }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) throw new Error(`edgar CIK${id} http ${res.status} after ${attempt} retries`);
        await sleep(1500 * 2 ** attempt); continue;
      }
      if (!res.ok) throw new Error(`edgar CIK${id} http ${res.status}`);
      const body = await res.json();
      const doc = { retrievedAt: new Date().toISOString(), cik: id, submissions: body };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(doc));
      return doc;
    }
  }
  return { submissionsFor };
}

// ── enrichment pass over composed records (immutable: returns new objects) ────
// Scope: symbols in `universeSyms` that are NOT actively trading and either
// (a) have unknown status (vendor gap) — a Form 25 upgrades them to a
//     confirmed delisting, or
// (b) are delisted with an unverified reason — 8-K items classify it.
async function enrichRecords(records, universeSyms, cacheDir, { refresh = false, log = () => {} } = {}) {
  const fetcher = makeEdgarFetcher(cacheDir, { refresh });
  const out = { ...records };
  const stats = { looked: 0, noCik: 0, notFound: 0, upgradedToDelisted: 0, reasonClassified: 0, unchanged: 0 };
  for (const sym of [...universeSyms].sort()) {
    const rec = out[sym];
    if (!rec) continue;
    const needsStatus = rec.status === 'unknown' && !rec.conflict;
    const needsReason = rec.status === 'delisted' && rec.delisting && !rec.delisting.reasonCategory;
    if (!needsStatus && !needsReason) continue;
    const cik = rec.issuer && rec.issuer.cik;
    if (!cik) { stats.noCik++; continue; }
    stats.looked++;
    const doc = await fetcher.submissionsFor(cik);
    if (doc.notFound) { stats.notFound++; continue; }
    const evidence = extractDelistingEvidence(doc.submissions);
    const derived = deriveDelisting(evidence, doc.retrievedAt);
    if (needsStatus && derived) {
      out[sym] = {
        ...rec,
        status: 'delisted',
        delisting: derived,
        identityConfidence: rec.identityConfidence === 'low' ? 'medium-low' : rec.identityConfidence,
        verificationState: derived.reasonCategory ? `edgar-${derived.evidence.type}-reason-${derived.reasonCategory}` : `edgar-${derived.evidence.type}-unverified-reason`,
      };
      stats.upgradedToDelisted++;
      if (derived.reasonCategory) stats.reasonClassified++;
    } else if (needsReason && derived && derived.reasonCategory) {
      out[sym] = {
        ...rec,
        delisting: { ...rec.delisting, reason: derived.reason, reasonCategory: derived.reasonCategory,
          evidence: { ...(rec.delisting.evidence || {}), edgar: derived.evidence } },
        verificationState: `edgar-reason-${derived.reasonCategory}`,
      };
      stats.reasonClassified++;
    } else {
      stats.unchanged++;
    }
    if (stats.looked % 100 === 0) log(`  edgar: ${stats.looked} CIKs examined…`);
  }
  return { records: out, stats };
}

module.exports = {
  USER_AGENT, FORM25_EFFECTIVE_DAYS, BANKRUPTCY_8K_WINDOW_DAYS, COMPLETION_8K_WINDOW_DAYS,
  padCik, extractDelistingEvidence, deriveDelisting, makeEdgarFetcher, enrichRecords,
};
