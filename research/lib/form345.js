'use strict';
// SEC bulk "Insider Transactions Data Sets" (Form 3/4/5) — pure parsers.
//
// Source: https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets
// One quarterly zip holds tab-separated tables; the three we need are
//   SUBMISSION.tsv      one row per filing (accession → filing date, issuer, 10b5-1 flag)
//   NONDERIV_TRANS.tsv  one row per non-derivative transaction line
//   REPORTINGOWNER.tsv  one row per reporting owner on the filing (a joint filing → several)
// `extractBuys` emits open-market purchases in EXACTLY the shape lib/edgar.js parseForm4
// emits, so research/69-insider-cluster.js clusterEvents consumes them unchanged, plus a
// few fields only the bulk data carries (10b5-1 affirmation, timeliness, owner CIK).
//
// Nothing is dropped silently: every excluded transaction row is counted by reason.

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

// 'DD-MON-YYYY' → 'YYYY-MM-DD'; already-ISO passes through; anything else → null.
function toIso(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

// Tab-separated text → array of objects keyed by the header row. Fields are NOT
// quote-escaped in these files (a literal " inside a name stays a literal "), so a plain
// split on \t is the correct parse. CRLF tolerated; blank trailing lines skipped.
function parseTsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.length || !lines[0]) return [];
  const header = lines[0].split('\t').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split('\t');
    const row = {};
    for (let k = 0; k < header.length; k++) row[header[k]] = cells[k] == null ? '' : cells[k];
    rows.push(row);
  }
  return rows;
}

const BLANK_SYMBOLS = new Set(['', 'N/A', 'NA', 'NONE', 'NULL', 'NOT APPLICABLE', 'NO TICKER']);
function cleanSymbol(s) {
  const v = String(s || '').trim().toUpperCase();
  if (BLANK_SYMBOLS.has(v)) return null;
  // The bulk files occasionally carry exchange suffixes or spaces ("ABC.PK", "ABC WS").
  const bare = v.split(/[\s,;/]/)[0];
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(bare) ? bare : null;
}

function truthy(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'y' || s === 'yes';
}

function relationshipFlags(rel) {
  const r = String(rel || '');
  return {
    isDirector: /Director/i.test(r),
    isOfficer: /Officer/i.test(r),
    isTenPct: /TenPercentOwner/i.test(r),
  };
}

const EXCLUSION_REASONS = Object.freeze([
  'formType', 'code', 'acquiredDisposed', 'sharesOrPrice', 'noSubmission', 'docType', 'noOwner', 'noTicker',
]);

/**
 * Extract open-market insider BUYS.
 * @param {{submissions: object[], trans: object[], owners: object[]}} tables parsed TSV rows
 * @param {{cikToTicker?: Record<string,string>}} [opts] optional CIK→ticker map for blank symbols
 * @returns {{byTicker: Record<string, object[]>, exclusions: Record<string, number>, counts: object}}
 */
function extractBuys({ submissions = [], trans = [], owners = [] } = {}, { cikToTicker = null } = {}) {
  const subs = new Map();
  for (const s of submissions) {
    const acc = String(s.ACCESSION_NUMBER || '').trim();
    if (!acc) continue;
    subs.set(acc, {
      filingDate: toIso(s.FILING_DATE),
      docType: String(s.DOCUMENT_TYPE || '').trim(),
      issuerCik: String(s.ISSUERCIK || '').trim().padStart(10, '0'),
      issuerName: String(s.ISSUERNAME || '').trim(),
      symbol: cleanSymbol(s.ISSUERTRADINGSYMBOL),
      tenB51: truthy(s.AFF10B5ONE),
    });
  }
  const ownersByAcc = new Map();
  for (const o of owners) {
    const acc = String(o.ACCESSION_NUMBER || '').trim();
    if (!acc) continue;
    const list = ownersByAcc.get(acc) || [];
    list.push({
      name: String(o.RPTOWNERNAME || '').trim(),
      cik: String(o.RPTOWNERCIK || '').trim().padStart(10, '0'),
      ...relationshipFlags(o.RPTOWNER_RELATIONSHIP),
    });
    ownersByAcc.set(acc, list);
  }

  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map(r => [r, 0]));
  const byTicker = {};
  let kept = 0, resolvedByCik = 0, amended = 0;
  const exclude = (reason) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };

  for (const t of trans) {
    if (String(t.TRANS_FORM_TYPE || '').trim() !== '4') { exclude('formType'); continue; }
    if (String(t.TRANS_CODE || '').trim() !== 'P') { exclude('code'); continue; }
    if (String(t.TRANS_ACQUIRED_DISP_CD || '').trim() !== 'A') { exclude('acquiredDisposed'); continue; }
    const shares = parseFloat(t.TRANS_SHARES);
    const price = parseFloat(t.TRANS_PRICEPERSHARE);
    if (!(shares > 0) || !(price > 0)) { exclude('sharesOrPrice'); continue; }
    const acc = String(t.ACCESSION_NUMBER || '').trim();
    const sub = subs.get(acc);
    if (!sub) { exclude('noSubmission'); continue; }
    if (sub.docType !== '4' && sub.docType !== '4/A') { exclude('docType'); continue; }
    const ownerList = ownersByAcc.get(acc) || [];
    if (!ownerList.length) { exclude('noOwner'); continue; }
    let ticker = sub.symbol, tickerSource = 'issuerTradingSymbol';
    if (!ticker && cikToTicker && cikToTicker[sub.issuerCik]) { ticker = cikToTicker[sub.issuerCik]; tickerSource = 'cikMap'; resolvedByCik++; }
    if (!ticker) { exclude('noTicker'); continue; }
    const isAmended = sub.docType === '4/A';
    if (isAmended) amended++;
    const date = toIso(t.TRANS_DATE);
    for (const o of ownerList) {
      const tx = {
        date, code: 'P', shares, price, value: Math.round(shares * price), ad: 'A',
        owner: o.name, isDirector: o.isDirector, isOfficer: o.isOfficer, isTenPct: o.isTenPct,
        filingDate: sub.filingDate, accession: acc,
        tenB51: sub.tenB51, timeliness: String(t.TRANS_TIMELINESS || '').trim() || null, ownerCik: o.cik,
        amended: isAmended, tickerSource, issuerCik: sub.issuerCik,
      };
      (byTicker[ticker] = byTicker[ticker] || []).push(tx);
      kept++;
    }
  }
  return {
    byTicker,
    exclusions,
    counts: { transRows: trans.length, submissions: subs.size, buyRows: kept, tickers: Object.keys(byTicker).length, resolvedByCik, amendedRows: amended },
  };
}

// The exact key set lib/edgar.js parseForm4 emits per transaction — the contract
// research/69-insider-cluster.js clusterEvents was written against.
const EDGAR_TX_KEYS = Object.freeze(['date', 'code', 'shares', 'price', 'value', 'ad', 'owner', 'isDirector', 'isOfficer', 'isTenPct']);

module.exports = { toIso, parseTsv, cleanSymbol, truthy, relationshipFlags, extractBuys, EXCLUSION_REASONS, EDGAR_TX_KEYS };
