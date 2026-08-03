'use strict';
// HISTORICAL SECURITY MASTER CORE (secmaster-hist-v0.1 — PARTIAL by design)
//
// Fuses the validated free sources into a CIK-spined master for the 2010+ era:
//   * spine — SEC CIK (the free permanent identity);
//   * delisting events — the EDGAR Form-25 enumeration (validated 96.1% vs
//     the 2021+ secmaster; AV dates lost the adjudication 124-0 and are NOT
//     used for dates);
//   * CIK→ticker mapping — layered, provenance-tagged, ambiguity-quarantined:
//       1. secmaster-v3 (verified 2021+ era)      [strongest]
//       2. EDGAR company_tickers.json (current official mapping)
//       3. EDGAR submissions tickers (cached CIKs)
//       4. AV snapshot NAME join (normalized exact-unique match only)
//   * membership — AV monthly snapshots, AS COLLECTED (partial until the
//     daily job completes; coverage measured, never assumed).
//
// This build is explicitly NOT survivorship-authoritative: it feeds the
// coverage measurements that will decide that later. Pure module: no network,
// no clock, no fs.

const crypto = require('crypto');

const SECMASTER_HIST_VERSION = 'secmaster-hist-v0.1';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};
const normCik = (c) => String(Number(c));

// Conservative company-name normalization for the AV name join. Aggressive
// enough to survive "AIRTRAN HOLDINGS INC" vs "AirTran Holdings, Inc.";
// collisions it creates are caught by the unique-match requirement.
const LEGAL_SUFFIXES = /\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|LLC|LP|PLC|SA|NV|AG|HOLDINGS|HOLDING|GROUP|COS)\b/g;
function normalizeCompanyName(name) {
  let s = String(name || '').toUpperCase()
    .replace(/[.,'’&\/\\()-]/g, ' ')
    .replace(/^THE\s+/, '');
  s = s.replace(LEGAL_SUFFIXES, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Layered CIK→ticker map. Every entry carries its source; conflicting symbols
// from different layers are all kept (renames/multi-class are real), the
// primary is the highest-priority layer's symbol.
// Inputs:
//   secmasterRecords — { SYM: { issuer: { cik } , status } }
//   companyTickers   — [{ cik, ticker }]                (EDGAR official, current)
//   submissionsTickers — [{ cik, tickers: [..] }]       (cached EDGAR submissions)
//   avRecords        — [{ symbol, name, assetType }]    (latest active + delisted)
//   form25Events     — [{ cik, companyName }]           (names needing the AV join)
function buildTickerMap({ secmasterRecords = {}, companyTickers = [], submissionsTickers = [], avRecords = [], form25Events = [] } = {}) {
  const byCik = new Map();
  const add = (cik, symbol, source) => {
    if (!cik || !symbol) return;
    const k = normCik(cik);
    if (!byCik.has(k)) byCik.set(k, []);
    const arr = byCik.get(k);
    if (!arr.some((e) => e.symbol === symbol)) arr.push({ symbol, source });
  };
  for (const [sym, rec] of Object.entries(secmasterRecords)) {
    if (rec && rec.issuer && rec.issuer.cik) add(rec.issuer.cik, sym, 'secmaster-v3');
  }
  for (const r of companyTickers) add(r.cik, r.ticker, 'edgar-company-tickers');
  for (const r of submissionsTickers) for (const t of r.tickers || []) add(r.cik, t, 'edgar-submissions');

  // AV name join — exact-unique on normalized names, common stocks preferred.
  const nameToSyms = new Map();
  for (const r of avRecords) {
    const n = normalizeCompanyName(r.name);
    if (!n) continue;
    if (!nameToSyms.has(n)) nameToSyms.set(n, new Map());
    nameToSyms.get(n).set(r.symbol, r.assetType);
  }
  const ambiguities = [];
  for (const e of form25Events) {
    const k = normCik(e.cik);
    if (byCik.has(k)) continue;              // higher-priority mapping exists
    const n = normalizeCompanyName(e.companyName);
    const cands = nameToSyms.get(n);
    if (!cands || !cands.size) continue;
    const stocks = [...cands.entries()].filter(([, t]) => t === 'Stock').map(([s]) => s);
    const pool = stocks.length ? stocks : [...cands.keys()];
    if (pool.length === 1) add(k, pool[0], 'av-name-exact');
    else if (ambiguities.length < 200) ambiguities.push({ cik: k, name: e.companyName, candidates: pool.slice(0, 6) });
  }
  const SOURCE_PRIORITY = ['secmaster-v3', 'edgar-company-tickers', 'edgar-submissions', 'av-name-exact'];
  for (const arr of byCik.values()) {
    arr.sort((a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source));
  }
  return { byCik, ambiguities };
}

// Assemble the master: one record per Form-25-bearing CIK, plus membership
// observations for mapped tickers from whatever AV monthly snapshots exist.
//   form25Events — [{ cik, companyName, formType, filingDate, effectiveDate }]
//   tickerMap    — from buildTickerMap
//   monthlyMembership — { 'YYYY-MM': Set<symbol> } (Stock only), possibly partial
function assembleHistMaster({ form25Events, tickerMap, monthlyMembership = {} }) {
  const byCik = new Map();
  for (const e of form25Events) {
    const k = normCik(e.cik);
    if (!byCik.has(k)) byCik.set(k, { cik: k, names: [], form25: [] });
    const rec = byCik.get(k);
    if (e.companyName && !rec.names.includes(e.companyName)) rec.names.push(e.companyName);
    rec.form25.push({ formType: e.formType, filingDate: e.filingDate, effectiveDate: e.effectiveDate });
  }
  const months = Object.keys(monthlyMembership).sort();
  const records = {};
  const cov = {
    form25Ciks: byCik.size,
    tickerMapped: 0,
    bySource: {},
    unmapped: 0,
    withMembershipObserved: 0,
  };
  for (const [k, rec] of [...byCik.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    rec.form25.sort((a, b) => (a.filingDate < b.filingDate ? -1 : 1));
    const tickers = tickerMap.byCik.get(k) || [];
    const primary = tickers[0] || null;
    let membership = null;
    if (primary && months.length) {
      const present = months.filter((ym) => monthlyMembership[ym].has(primary.symbol));
      if (present.length) {
        membership = { monthsObserved: present.length, firstYm: present[0], lastYm: present[present.length - 1] };
        cov.withMembershipObserved++;
      }
    }
    if (primary) { cov.tickerMapped++; cov.bySource[primary.source] = (cov.bySource[primary.source] || 0) + 1; } else cov.unmapped++;
    records[k] = {
      cik: k,
      names: rec.names,
      tickers,
      primaryTicker: primary ? primary.symbol : null,
      tickerSource: primary ? primary.source : null,
      form25Events: rec.form25,
      delisting: {
        date: rec.form25[rec.form25.length - 1].effectiveDate,   // last Form-25 effective date
        basis: 'edgar-form25-effective (filing+10, Rule 12d2-2(d))',
        reasonCategory: null,                                    // 8-K classification pass pending
      },
      membershipObserved: membership,                            // PARTIAL until AV accrual completes
    };
  }
  cov.tickerMappedFraction = cov.form25Ciks ? +(cov.tickerMapped / cov.form25Ciks).toFixed(4) : null;
  cov.membershipMonthsAvailable = months.length;
  const payload = {
    schema: 'HistoricalSecurityMaster', version: SECMASTER_HIST_VERSION,
    spine: 'sec-cik',
    status: 'PARTIAL — membership accruing, delisting reasons pending, NOT survivorship-authoritative',
    coverage: cov,
    records,
  };
  return { ...payload, contentHash: sha256(canonicalJson(records)) };
}

// Merge the 8-K reason-classification artifact into master records
// (immutable: returns new records). Only fills reasonCategory where the
// classification produced one; everything else stays honestly null.
function mergeReasons(records, reasonsByCik) {
  const out = {};
  let filled = 0;
  const byCategory = {};
  for (const [cik, rec] of Object.entries(records)) {
    const r = reasonsByCik && reasonsByCik[cik];
    if (r && r.reasonCategory) {
      out[cik] = { ...rec, delisting: { ...rec.delisting, reasonCategory: r.reasonCategory, reason: r.reason || null, reasonEvidence: r.evidence || null } };
      filled++;
      byCategory[r.reasonCategory] = (byCategory[r.reasonCategory] || 0) + 1;
    } else out[cik] = rec;
  }
  return { records: out, stats: { filled, byCategory, total: Object.keys(records).length } };
}

module.exports = {
  SECMASTER_HIST_VERSION, normCik, normalizeCompanyName,
  buildTickerMap, assembleHistMaster, mergeReasons,
};
