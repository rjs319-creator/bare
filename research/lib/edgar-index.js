'use strict';
// EDGAR FULL-INDEX PARSER (edgar-form25-enum-v1)
//
// The SEC publishes quarterly full indexes of EVERY filing:
//   https://www.sec.gov/Archives/edgar/full-index/<year>/QTR<q>/form.idx
// Enumerating all Form 25 / 25-NSE rows 2010→present yields the authoritative
// delisting-event record for the whole era — the same record that adjudicated
// the AV reconciliation tail 124-0 for the secmaster. This module is the PURE
// parsing/planning core; research/62-edgar-form25-enum.js owns I/O.
//
// form.idx layout: preamble, a header line (Form Type / Company Name / CIK /
// Date Filed / File Name), a dashed separator, then fixed-width rows. Column
// boundaries are DERIVED from the header line's label offsets — never guessed
// from whitespace (company names contain arbitrary spacing).
//
// Pure module: no network, no clock, no fs.

const crypto = require('crypto');

const EDGAR_FORM25_VERSION = 'edgar-form25-enum-v1';
const FORM25_TYPES = Object.freeze(['25', '25-NSE']);
const FORM25_AMENDMENTS = Object.freeze(['25/A', '25-NSE/A']);
const FORM25_EFFECTIVE_DAYS = 10;   // SEC Rule 12d2-2(d)

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

// Quarter grid: ['2010-Q1', …, current quarter].
function quartersBetween(fromYear, toYear, toQuarter) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let q = 1; q <= 4; q++) {
      if (y === toYear && q > toQuarter) break;
      out.push(`${y}-Q${q}`);
    }
  }
  return out;
}
const quarterUrl = (qk) => {
  const [y, q] = qk.split('-Q');
  return `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/form.idx`;
};

// Parse a form.idx payload. The header confirms the file's identity, but the
// DATA rows do not share the header's column offsets (the live files pad the
// form-type column wider than the header label), so rows are parsed by their
// unambiguous RIGHT-side structure instead:
//   <form type> <company name…> <CIK digits> <YYYY-MM-DD> <edgar/… path>
// The lazy company-name group tolerates arbitrary internal spacing.
const IDX_ROW_RE = /^(\S+)\s+(.*?)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(edgar\/\S+)\s*$/;
function parseFormIdx(text) {
  const lines = String(text || '').split('\n');
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/^Form Type\s+Company Name\s+CIK\s+Date Filed\s+File Name/.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { error: 'form.idx header not found', rows: [] };
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const m = IDX_ROW_RE.exec(lines[i]);
    if (!m) continue;
    rows.push({ formType: m[1], companyName: m[2].trim(), cik: m[3], dateFiled: m[4], fileName: m[5] });
  }
  return { error: null, rows };
}

// Extract Form 25 events from parsed rows. Amendments tracked separately —
// an /A revises an earlier notice and must not double-count a delisting.
function extractForm25(rows) {
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const events = [], amendments = [];
  for (const r of rows || []) {
    if (!isDate(r.dateFiled) || !/^\d+$/.test(r.cik)) continue;
    const rec = {
      formType: r.formType, cik: r.cik, companyName: r.companyName,
      filingDate: r.dateFiled,
      effectiveDate: new Date(Date.parse(r.dateFiled) + FORM25_EFFECTIVE_DAYS * 86400000).toISOString().slice(0, 10),
      fileName: r.fileName,
    };
    if (FORM25_TYPES.includes(r.formType)) events.push(rec);
    else if (FORM25_AMENDMENTS.includes(r.formType)) amendments.push(rec);
  }
  return { events, amendments };
}

// Content-addressed quarterly partition.
function form25Partition({ quarter, events, amendments, retrievedAt }) {
  const payload = {
    schema: 'EdgarForm25Partition', version: EDGAR_FORM25_VERSION,
    quarter, eventCount: events.length, amendmentCount: amendments.length,
    retrievedAt, events, amendments,
  };
  return { ...payload, contentHash: sha256(canonicalJson({ events, amendments })) };
}
const partitionValid = (doc) => !!(doc && doc.contentHash
  && doc.contentHash === sha256(canonicalJson({ events: doc.events || [], amendments: doc.amendments || [] })));

// Validation: what fraction of the secmaster's confirmed delistings (with a
// CIK) have an enumerated Form 25 within ±tolDays of the known date? One CIK
// may file several Form 25s (multi-class); any within tolerance counts.
function coverageVsKnownDelistings(events, knownDelistings, { tolDays = 45 } = {}) {
  const byCik = new Map();
  for (const e of events) {
    const cik = String(Number(e.cik));
    if (!byCik.has(cik)) byCik.set(cik, []);
    byCik.get(cik).push(e);
  }
  let withCik = 0, covered = 0;
  const misses = [];
  for (const k of knownDelistings || []) {
    if (!k.cik) continue;
    withCik++;
    const evs = byCik.get(String(Number(k.cik))) || [];
    const hit = evs.some((e) => Math.abs(Date.parse(e.effectiveDate) - Date.parse(k.date)) / 86400000 <= tolDays);
    if (hit) covered++;
    else if (misses.length < 40) misses.push({ symbol: k.symbol, cik: k.cik, known: k.date, form25Count: evs.length });
  }
  return {
    knownWithCik: withCik, covered,
    coverageFraction: withCik ? +(covered / withCik).toFixed(4) : null,
    tolDays, misses,
  };
}

module.exports = {
  EDGAR_FORM25_VERSION, FORM25_TYPES, FORM25_AMENDMENTS, FORM25_EFFECTIVE_DAYS,
  quartersBetween, quarterUrl, parseFormIdx, extractForm25,
  form25Partition, partitionValid, coverageVsKnownDelistings,
};
