'use strict';
// FINRA CONSOLIDATED SHORT INTEREST — point-in-time core for the OMEGA_SI_LEVEL_5D_TOP10
// shadow experiment. Pure logic only (schema, availability, joins, revision versioning);
// networking is injectable so every path is testable without FINRA.
//
// DATASET DISCIPLINE. This module models FINRA Rule 4560 *consolidated short interest*
// (semi-monthly settlement cycles) and nothing else. Daily short-sale VOLUME is a
// different dataset with a different schema and different meaning; rows shaped like it
// are rejected outright (`daily_short_volume_schema`) so it can never be mislabeled as
// short interest, borrow pressure, or positioning.
//
// AVAILABILITY DISCIPLINE. A settlement-date observation is NOT public on its settlement
// date — FINRA disseminates roughly the 7th business day after settlement. The exact
// historical dissemination timestamps are not recoverable from the API, so the PRIMARY
// join uses a conservative settlement + 13 calendar day fallback (>= the likely release),
// stamped `availabilityMethod: 'conservative_13d_fallback'`. A record joins a decision
// only when availableAt <= decision date. Never earlier than the likely public release.

const crypto = require('node:crypto');

const FINRA_SI_VERSION = 'finra-si-v1';
const SI_ENDPOINT = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const REQUIRED_FIELDS = Object.freeze([
  'settlementDate', 'symbolCode', 'currentShortPositionQuantity', 'previousShortPositionQuantity',
  'averageDailyVolumeQuantity', 'daysToCoverQuantity', 'changePercent', 'revisionFlag',
]);
// Fields that identify FINRA's DAILY short-sale volume dataset — presence of any one of
// them is a hard schema rejection (see DATASET DISCIPLINE above).
const DAILY_VOLUME_MARKERS = Object.freeze(['shortParQuantity', 'shortExemptParQuantity', 'totalParQuantity', 'tradeReportDate', 'marketCode']);

const CONSERVATIVE_LAG_DAYS = 13;   // primary availability fallback (calendar days after settlement)
const STALE_LAG_DAYS = 16;          // predeclared robustness variant
const PUBLICATION_BUSINESS_DAYS = 7; // FINRA's nominal dissemination schedule (estimate only)
const DAY_MS = 86_400_000;

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function sourceHash(payload) {
  return crypto.createHash('sha256').update(typeof payload === 'string' ? payload : JSON.stringify(payload)).digest('hex');
}

function normalizeSymbol(raw) {
  const t = String(raw == null ? '' : raw).toUpperCase().trim();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : null;
}

// ── Availability ─────────────────────────────────────────────────────────────
function addCalendarDays(iso, n) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return new Date(ms + n * DAY_MS).toISOString().slice(0, 10);
}

function addBusinessDays(iso, n) {
  let ms = Date.parse(`${iso}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    ms += DAY_MS;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

// Best-estimate publication date (7th business day after settlement). ESTIMATE ONLY —
// it ignores market holidays, which is exactly why joins use the conservative fallback.
function publicationDateFor(settlementDate) {
  return isIsoDate(settlementDate) ? addBusinessDays(settlementDate, PUBLICATION_BUSINESS_DAYS) : null;
}

// The availability stamp a record carries. The conservative fallback is never earlier
// than the estimated publication (13 calendar days >= 7 business days + weekends), and
// the max() guard makes that a hard invariant rather than an arithmetic coincidence.
function availabilityFor(settlementDate, { lagDays = CONSERVATIVE_LAG_DAYS } = {}) {
  if (!isIsoDate(settlementDate)) return null;
  const publicationDate = publicationDateFor(settlementDate);
  const conservative = addCalendarDays(settlementDate, lagDays);
  const availableAt = conservative >= publicationDate ? conservative : publicationDate;
  return {
    publicationDate,
    availableAt,
    availabilityMethod: lagDays === CONSERVATIVE_LAG_DAYS ? 'conservative_13d_fallback' : `conservative_${lagDays}d_lag`,
  };
}

// ── Schema validation ────────────────────────────────────────────────────────
// Validates ONE raw FINRA consolidated-short-interest row. Fail-fast, explicit reasons.
function validateSiRow(row) {
  const errors = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, errors: ['not_an_object'] };
  for (const marker of DAILY_VOLUME_MARKERS) {
    if (marker in row) return { ok: false, errors: ['daily_short_volume_schema'] };
  }
  if (!isIsoDate(row.settlementDate)) errors.push('bad_settlementDate');
  if (!normalizeSymbol(row.symbolCode)) errors.push('bad_symbolCode');
  const numeric = (v) => v == null || v === '' ? null : Number(v);
  const cur = numeric(row.currentShortPositionQuantity);
  const dtc = numeric(row.daysToCoverQuantity);
  const adv = numeric(row.averageDailyVolumeQuantity);
  if (!Number.isFinite(cur) || cur < 0) errors.push('bad_currentShortPositionQuantity');
  if (!Number.isFinite(dtc) || dtc < 0) errors.push('bad_daysToCoverQuantity');
  if (adv != null && (!Number.isFinite(adv) || adv < 0)) errors.push('bad_averageDailyVolumeQuantity');
  const prev = numeric(row.previousShortPositionQuantity);
  if (prev != null && (!Number.isFinite(prev) || prev < 0)) errors.push('bad_previousShortPositionQuantity');
  const chg = numeric(row.changePercent);
  if (chg != null && !Number.isFinite(chg)) errors.push('bad_changePercent');
  if (row.revisionFlag != null && row.revisionFlag !== 'R') errors.push('bad_revisionFlag');
  return { ok: errors.length === 0, errors };
}

// Normalize a validated raw row into the stored record shape (diagnostic fields kept as
// diagnostics only — changePercent/prevSi are never model inputs in this experiment).
function toRecord(row, { fetchedAt, source = 'finra:consolidatedShortInterest', revisionRisk = true, snapshotHash = null } = {}) {
  const v = validateSiRow(row);
  if (!v.ok) return null;
  const num = (x) => (x == null || x === '' ? null : Number(x));
  return {
    settlementDate: row.settlementDate,
    symbol: normalizeSymbol(row.symbolCode),
    si: num(row.currentShortPositionQuantity),
    prevSi: num(row.previousShortPositionQuantity),
    adv: num(row.averageDailyVolumeQuantity),
    dtc: num(row.daysToCoverQuantity),
    changePercent: num(row.changePercent),
    revisionFlag: row.revisionFlag === 'R' ? 'R' : null,
    // Retrospectively downloaded history may already embed revisions whose originals are
    // unrecoverable — every such record carries revisionRisk:true. Only prospectively
    // observed first-versions may clear it.
    revisionRisk: !!revisionRisk,
    fetchedAt: fetchedAt || null,
    source,
    sourceHash: snapshotHash,
  };
}

// ── Point-in-time join ───────────────────────────────────────────────────────
// Series must be ascending by settlementDate. Returns the latest record whose
// availability (settlement + lagDays, floored at the estimated publication) is on or
// before the decision date — the ONLY join door into the experiment.
function asOfJoinSi(series, decisionDate, { lagDays = CONSERVATIVE_LAG_DAYS } = {}) {
  if (!Array.isArray(series) || !isIsoDate(decisionDate)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const rec = series[i];
    const avail = availabilityFor(rec.settlementDate, { lagDays });
    if (avail && avail.availableAt <= decisionDate) {
      return { ...rec, publicationDate: avail.publicationDate, availableAt: avail.availableAt, availabilityMethod: avail.availabilityMethod };
    }
  }
  return null;
}

// ── History assembly (append-only revision semantics) ────────────────────────
// snapshots: [{ settlementDate, fetchedAt, sourceHash, source?, revisionRisk?, rows: [raw FINRA rows] }]
// Builds Map(symbol -> ascending records) plus a health report. If two snapshots carry
// the SAME settlement date, the earliest-fetched version is authoritative for joins and
// later ones are recorded as revisions — history is never overwritten.
function buildSiHistory(snapshots, { symbols = null } = {}) {
  const want = symbols ? new Set(symbols) : null;
  const bySymbol = new Map();
  const health = { snapshots: 0, rows: 0, kept: 0, invalid: 0, duplicates: 0, revisions: 0, offUniverse: 0, invalidReasons: {} };
  const ordered = (snapshots || []).filter((s) => s && Array.isArray(s.rows)).sort((a, b) =>
    a.settlementDate === b.settlementDate
      ? String(a.fetchedAt || '').localeCompare(String(b.fetchedAt || ''))
      : String(a.settlementDate).localeCompare(String(b.settlementDate)));
  for (const snap of ordered) {
    if (!snap || !Array.isArray(snap.rows)) continue;
    health.snapshots++;
    const seenInSnap = new Set();
    for (const raw of snap.rows) {
      health.rows++;
      const rec = toRecord(raw, {
        fetchedAt: snap.fetchedAt, snapshotHash: snap.sourceHash || null,
        source: snap.source || 'finra:consolidatedShortInterest',
        revisionRisk: snap.revisionRisk !== false,
      });
      if (!rec) {
        health.invalid++;
        const why = validateSiRow(raw).errors[0] || 'invalid';
        health.invalidReasons[why] = (health.invalidReasons[why] || 0) + 1;
        continue;
      }
      if (rec.settlementDate !== snap.settlementDate) { health.invalid++; health.invalidReasons.settlement_mismatch = (health.invalidReasons.settlement_mismatch || 0) + 1; continue; }
      if (want && !want.has(rec.symbol)) { health.offUniverse++; continue; }
      const dupKey = `${rec.symbol}|${rec.settlementDate}`;
      if (seenInSnap.has(dupKey)) { health.duplicates++; continue; }
      seenInSnap.add(dupKey);
      const series = bySymbol.get(rec.symbol) || [];
      const existing = series.find((r) => r.settlementDate === rec.settlementDate);
      if (existing) {
        // Append-only: the first observed version stays authoritative; the later fetch
        // is preserved as a revision annotation, never a replacement.
        existing.revisions = [...(existing.revisions || []), {
          si: rec.si, dtc: rec.dtc, prevSi: rec.prevSi, adv: rec.adv, changePercent: rec.changePercent,
          revisionFlag: rec.revisionFlag, observedAt: rec.fetchedAt, sourceHash: rec.sourceHash,
        }];
        existing.revisionRisk = true;
        health.revisions++;
        continue;
      }
      bySymbol.set(rec.symbol, [...series, rec].sort((a, b) => a.settlementDate.localeCompare(b.settlementDate)));
      health.kept++;
    }
  }
  return { bySymbol, health };
}

// Coverage of a universe on a set of decision dates through the PIT join door.
function coverageReport(bySymbol, universe, decisionDates, { lagDays = CONSERVATIVE_LAG_DAYS } = {}) {
  const byDate = {};
  let joined = 0, possible = 0;
  for (const D of decisionDates || []) {
    let n = 0;
    for (const sym of universe || []) {
      possible++;
      if (asOfJoinSi(bySymbol.get(sym), D, { lagDays })) { n++; joined++; }
    }
    byDate[D] = { joined: n, universe: (universe || []).length };
  }
  return { byDate, joined, possible, coverage: possible ? +(joined / possible).toFixed(4) : 0 };
}

// ── Networking (injectable) ──────────────────────────────────────────────────
// POST one page. Timeout via AbortController; retries with exponential backoff on 429/5xx
// and network errors; a 4xx other than 429 fails fast (schema/param bug, retry is noise).
async function fetchSiPage({ settlementDate, symbols = null, offset = 0, limit = 5000, fetchImpl = fetch, timeoutMs = 30_000, retries = 4, baseBackoffMs = 1000, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const body = {
    limit, offset,
    fields: REQUIRED_FIELDS,
    compareFilters: [{ compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: settlementDate }],
    ...(symbols && symbols.length ? { domainFilters: [{ fieldName: 'symbolCode', values: symbols }] } : {}),
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(SI_ENDPOINT, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`finra ${r.status}`); }
      else if (!r.ok) { throw new Error(`finra ${r.status} (not retryable)`); }
      else {
        const text = await r.text();
        const rows = text.trim() ? JSON.parse(text) : [];
        if (!Array.isArray(rows)) throw new Error('finra payload not an array');
        return { rows, sourceHash: sourceHash(text) };
      }
    } catch (e) {
      if (String(e.message).includes('not retryable') || String(e.message).includes('payload')) throw e;
      lastErr = e;
    } finally { clearTimeout(timer); }
    if (attempt < retries) await sleepImpl(baseBackoffMs * 2 ** attempt);
  }
  throw lastErr || new Error('finra fetch failed');
}

// Fetch every page of one settlement date (optionally restricted to a symbol batch).
async function fetchSettlementRows({ settlementDate, symbols = null, pageLimit = 5000, maxPages = 40, rateLimitMs = 250, ...net }) {
  const sleepImpl = net.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const all = [];
  const hashes = [];
  for (let page = 0; page < maxPages; page++) {
    const { rows, sourceHash: h } = await fetchSiPage({ settlementDate, symbols, offset: page * pageLimit, limit: pageLimit, ...net });
    all.push(...rows);
    hashes.push(h);
    if (rows.length < pageLimit) break;
    if (rateLimitMs) await sleepImpl(rateLimitMs);
  }
  return { rows: all, sourceHash: sourceHash(hashes.join('|')) };
}

module.exports = {
  FINRA_SI_VERSION, SI_ENDPOINT, REQUIRED_FIELDS, DAILY_VOLUME_MARKERS,
  CONSERVATIVE_LAG_DAYS, STALE_LAG_DAYS, PUBLICATION_BUSINESS_DAYS,
  sourceHash, normalizeSymbol, addCalendarDays, addBusinessDays,
  publicationDateFor, availabilityFor, validateSiRow, toRecord,
  asOfJoinSi, buildSiHistory, coverageReport,
  fetchSiPage, fetchSettlementRows,
};
