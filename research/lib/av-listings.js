'use strict';
// ALPHA VANTAGE LISTING_STATUS COLLECTOR CORE (av-listings-v1)
//
// The free path to the missing dataset (see history-expansion.BLOCKED.json):
// point-in-time snapshots of the active/delisted US listing universe, any date
// back to 2010-01-01, on the free tier (~25 requests/day). This module is the
// PURE core — snapshot planning, CSV parsing, response classification,
// partition documents and the validation gates. The I/O driver is
// research/59-av-listings-fetch.js; the gate runner is
// research/60-av-listings-gates.js.
//
// HONESTY CONTRACT: Alpha Vantage enters as *candidate*-authoritative only.
// The gates below decide whether the survivorship contract may ever cite it;
// until they pass, survivorshipStatus stays survivorship-reduced and the
// preregistered Era-A study stays sealed.
//
// Pure module: no network, no clock, no fs.

const crypto = require('crypto');

const AV_LISTINGS_VERSION = 'av-listings-v1';
const EXPECTED_HEADER = Object.freeze(['symbol', 'name', 'exchange', 'assetType', 'ipoDate', 'delistingDate', 'status']);
const FROM_YM = '2010-01';
// Free-tier pacing: ~25 requests/day, 5/minute.
const DEFAULT_RUN_BUDGET = 22;
const THROTTLE_MS = 15000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

// Last calendar day of 'YYYY-MM' (AV accepts any calendar date).
function monthEndDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function* ymRange(fromYm, toYm) {
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    yield `${y}-${String(m).padStart(2, '0')}`;
    m++; if (m > 12) { m = 1; y++; }
  }
}

// The full request plan, most-informative first:
//   1. latest active + latest delisted (2 requests → the complete current
//      universe INCLUDING every delistingDate — the whole delisting-history
//      table in one shot);
//   2. monthly ACTIVE snapshots 2010-01 → toYm (point-in-time membership);
//   3. quarterly DELISTED snapshots (internal-consistency checks).
// doneKeys lets the driver resume; the plan is deterministic.
function snapshotPlan({ toYm, doneKeys = new Set() } = {}) {
  if (!toYm) throw new Error('snapshotPlan requires toYm (the driver supplies the current month)');
  const plan = [];
  plan.push({ key: 'latest-active', state: 'active', date: null });
  plan.push({ key: 'latest-delisted', state: 'delisted', date: null });
  for (const ym of ymRange(FROM_YM, toYm)) {
    plan.push({ key: `active-${ym}`, state: 'active', date: monthEndDate(ym) });
  }
  for (const ym of ymRange(FROM_YM, toYm)) {
    const m = Number(ym.slice(5));
    if (m % 3 === 0) plan.push({ key: `delisted-${ym}`, state: 'delisted', date: monthEndDate(ym) });
  }
  return { plan, pending: plan.filter((p) => !doneKeys.has(p.key)) };
}

// RFC-4180-ish CSV parser (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

// AV failure modes arrive as JSON bodies (rate limit "Note"/"Information",
// "Error Message") instead of CSV. Classify before trusting anything.
function classifyResponse(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };
  if (t[0] === '{') {
    let body = null; try { body = JSON.parse(t); } catch { /* fall through */ }
    const msg = body && (body.Note || body.Information || body['Error Message'] || '');
    if (/rate limit|per day|per minute|premium/i.test(msg)) return { kind: 'rate-limited', message: String(msg).slice(0, 200) };
    return { kind: 'error', message: String(msg || t).slice(0, 200) };
  }
  const rows = parseCsv(t);
  if (!rows.length) return { kind: 'empty' };
  const header = rows[0].map((h) => h.trim());
  if (EXPECTED_HEADER.some((h, i) => header[i] !== h)) {
    return { kind: 'error', message: `unexpected header: ${header.join(',').slice(0, 120)}` };
  }
  const records = rows.slice(1).filter((r) => r.length === EXPECTED_HEADER.length).map((r) => ({
    symbol: r[0], name: r[1], exchange: r[2], assetType: r[3],
    ipoDate: r[4] || null, delistingDate: r[5] && r[5] !== 'null' ? r[5] : null, status: r[6],
  }));
  return { kind: 'csv', records };
}

// Content-addressed, never-overwritten partition document.
function partitionDoc({ key, state, asOfDate, records, retrievedAt }) {
  const payload = {
    schema: 'AvListingSnapshot', version: AV_LISTINGS_VERSION,
    key, state, asOfDate: asOfDate || 'latest', rowCount: records.length,
    retrievedAt, records,
  };
  return { ...payload, contentHash: sha256(canonicalJson(records)) };
}
const partitionValid = (doc) => !!(doc && doc.contentHash && Array.isArray(doc.records) && doc.contentHash === sha256(canonicalJson(doc.records)));

// ── VALIDATION GATES (candidate-authoritative → authoritative) ───────────────
// Each returns { gate, status: 'pass'|'fail'|'insufficient-data', ... }.

const isCommonStock = (r) => r.assetType === 'Stock';

// Gate 1: delisting-date reconciliation against the independently built
// secmaster (FMP+EDGAR, 636 confirmed delistings 2021+).
//
// MEASURED CONVENTION (first run, 578 matches): AV records the LAST TRADING
// DAY; the secmaster records the Form-25 EFFECTIVE date (SEC Rule 12d2-2(d):
// filing + 10 days) — the offset distribution has a median of exactly +10
// days. The convention window (default ±21d: 10-day effectiveness + halts /
// weekend drift) therefore counts as agreement, and the residual tail is
// judged by EDGAR ADJUDICATION (research/61-av-delist-adjudicate.js): a tail
// symbol whose AV date matches the authoritative Form-25 filing date is an AV
// agreement (the SECMASTER carried the wrong date, not AV). Only tail symbols
// where EDGAR sides against AV — or is silent — count against it.
// Pass bar stays ≥95% of matched symbols.
function gateDelistingReconciliation(latestDelistedRecords, knownDelistings, {
  tolDaysConvention = 21, minMatchFrac = 0.95, adjudication = null,
} = {}) {
  if (!latestDelistedRecords || !latestDelistedRecords.length) return { gate: 'delisting-reconciliation', status: 'insufficient-data' };
  const bySym = new Map(latestDelistedRecords.filter((r) => r.delistingDate).map((r) => [r.symbol, r.delistingDate]));
  let matched = 0, withinConvention = 0;
  const offsets = [];
  const tail = [];
  for (const k of knownDelistings || []) {
    const av = bySym.get(k.symbol);
    if (!av) continue;
    matched++;
    const signed = Math.round((Date.parse(k.date) - Date.parse(av)) / 86400000);   // known − AV; +10 ≈ the convention
    offsets.push(signed);
    if (Math.abs(signed) <= tolDaysConvention) withinConvention++;
    else tail.push({ symbol: k.symbol, known: k.date, av, diffDays: signed });
  }
  if (matched < 50) return { gate: 'delisting-reconciliation', status: 'insufficient-data', matched, note: 'need ≥50 matched known delistings' };
  offsets.sort((a, b) => a - b);
  const offsetStats = {
    median: offsets[Math.floor(offsets.length / 2)],
    p10: offsets[Math.floor(offsets.length / 10)],
    p90: offsets[Math.floor((offsets.length * 9) / 10)],
  };
  // Adjudicated tail agreements: EDGAR sided with AV → the disagreement was
  // the secmaster's, not AV's. Unadjudicated or EDGAR-against-AV tail symbols
  // remain disagreements (fail closed).
  const avConsistent = new Set((adjudication && adjudication.avConsistentSymbols) || []);
  const tailResolvedForAv = tail.filter((t) => avConsistent.has(t.symbol)).length;
  const agree = withinConvention + tailResolvedForAv;
  const frac = agree / matched;
  return {
    gate: 'delisting-reconciliation',
    status: frac >= minMatchFrac ? 'pass' : 'fail',
    knownDelistings: (knownDelistings || []).length, matched,
    withinConvention, tolDaysConvention, offsetStats,
    tailCount: tail.length, tailResolvedForAv,
    adjudicated: !!adjudication,
    agreementFraction: +frac.toFixed(4),
    disagreements: tail.filter((t) => !avConsistent.has(t.symbol)).slice(0, 50),
    note: 'convention: AV=last trading day, secmaster=Form-25 effective (filing+10d); tail judged by EDGAR adjudication when available',
  };
}

// EDGAR adjudication of one reconciliation-tail symbol. The authoritative
// anchor is the Form 25: its FILING date ≈ the last trading day (AV's
// convention) and filing+10 = the effective date (the secmaster's convention).
// Form 15 (deregistration) is a weaker anchor: filing date only, wider window.
// No filings → 'no-edgar-evidence' (fails closed: never an AV agreement).
const FORM25_EFFECTIVE_DAYS_LOCAL = 10;
function adjudicateDelistingCase({ symbol, avDate, knownDate, form25FilingDate, form15FilingDate }, { tolDays = 7, form15TolDays = 30 } = {}) {
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  if (form25FilingDate) {
    const effective = new Date(Date.parse(form25FilingDate) + FORM25_EFFECTIVE_DAYS_LOCAL * 86400000).toISOString().slice(0, 10);
    const avOk = avDate && days(avDate, form25FilingDate) <= tolDays;
    const knownOk = knownDate && days(knownDate, effective) <= tolDays;
    const verdict = avOk && knownOk ? 'both-consistent' : avOk ? 'av-consistent' : knownOk ? 'secmaster-consistent' : 'edgar-disagrees-with-both';
    return { symbol, anchor: 'form25', form25FilingDate, effectiveDate: effective, avDate, knownDate, verdict, avConsistent: avOk };
  }
  if (form15FilingDate) {
    const avOk = avDate && days(avDate, form15FilingDate) <= form15TolDays;
    const knownOk = knownDate && days(knownDate, form15FilingDate) <= form15TolDays;
    const verdict = avOk && knownOk ? 'both-consistent' : avOk ? 'av-consistent' : knownOk ? 'secmaster-consistent' : 'edgar-disagrees-with-both';
    return { symbol, anchor: 'form15', form15FilingDate, avDate, knownDate, verdict, avConsistent: avOk };
  }
  return { symbol, anchor: null, avDate, knownDate, verdict: 'no-edgar-evidence', avConsistent: false };
}

// Gate 2: monthly common-stock membership counts stay in a plausible band with
// no unexplained cliffs (>10% month-over-month).
function gateMembershipSanity(countsByYm, { lo = 3000, hi = 7500, cliffFrac = 0.10, minMonths = 24 } = {}) {
  const yms = Object.keys(countsByYm || {}).sort();
  if (yms.length < minMonths) return { gate: 'membership-sanity', status: 'insufficient-data', months: yms.length, needed: minMonths };
  const outOfBand = yms.filter((ym) => countsByYm[ym] < lo || countsByYm[ym] > hi);
  const cliffs = [];
  for (let i = 1; i < yms.length; i++) {
    const a = countsByYm[yms[i - 1]], b = countsByYm[yms[i]];
    if (a > 0 && Math.abs(b - a) / a > cliffFrac) cliffs.push({ from: yms[i - 1], to: yms[i], counts: [a, b] });
  }
  return {
    gate: 'membership-sanity',
    status: (outOfBand.length === 0 && cliffs.length === 0) ? 'pass' : 'fail',
    months: yms.length, band: [lo, hi], outOfBandMonths: outOfBand, cliffs,
  };
}

// Gate 3: internal consistency — a symbol in the active-at-M snapshot must not
// carry a delistingDate (from the latest delisted table) earlier than M.
function gateInternalConsistency(monthlySnapshots, latestDelistedRecords, { maxViolationFrac = 0.005 } = {}) {
  if (!monthlySnapshots || !monthlySnapshots.length || !latestDelistedRecords || !latestDelistedRecords.length) {
    return { gate: 'internal-consistency', status: 'insufficient-data' };
  }
  const delistedBySym = new Map(latestDelistedRecords.filter((r) => r.delistingDate).map((r) => [r.symbol, r.delistingDate]));
  let checked = 0, violations = 0;
  const examples = [];
  for (const snap of monthlySnapshots) {
    for (const r of snap.records) {
      if (!isCommonStock(r)) continue;
      checked++;
      const dd = delistedBySym.get(r.symbol);
      if (dd && dd < snap.asOfDate) {
        violations++;
        if (examples.length < 25) examples.push({ symbol: r.symbol, activeAsOf: snap.asOfDate, delistingDate: dd });
      }
    }
  }
  if (!checked) return { gate: 'internal-consistency', status: 'insufficient-data' };
  const frac = violations / checked;
  return {
    gate: 'internal-consistency',
    status: frac <= maxViolationFrac ? 'pass' : 'fail',
    checked, violations, violationFraction: +frac.toFixed(5), examples,
    note: 'delisting followed by a RE-listing under the same symbol legitimately appears here; the threshold tolerates that base rate',
  };
}

// Gate 4: known rename chains — after old→new (dated), the OLD symbol must not
// be active and the NEW symbol must exist.
function gateRenameSpotChecks(latestActiveRecords, latestDelistedRecords, checks) {
  if (!latestActiveRecords || !latestActiveRecords.length) return { gate: 'rename-spot-checks', status: 'insufficient-data' };
  const active = new Set(latestActiveRecords.map((r) => r.symbol));
  const known = new Set([...active, ...(latestDelistedRecords || []).map((r) => r.symbol)]);
  const results = (checks || []).map((c) => ({
    ...c,
    oldStillActive: active.has(c.old),
    newKnown: known.has(c.new),
    ok: !active.has(c.old) && known.has(c.new),
  }));
  const failed = results.filter((r) => !r.ok);
  return {
    gate: 'rename-spot-checks',
    status: failed.length === 0 ? 'pass' : 'fail',
    checks: results,
  };
}

// Overall verdict: candidate-authoritative only when every decidable gate
// passes and none is failing; insufficient data never passes by default.
function gatesVerdict(gates) {
  const failing = gates.filter((g) => g.status === 'fail');
  const undecided = gates.filter((g) => g.status === 'insufficient-data');
  if (failing.length) return { verdict: 'FAILED', reason: `gates failing: ${failing.map((g) => g.gate).join(', ')}` };
  if (undecided.length) return { verdict: 'ACCRUING', reason: `gates awaiting data: ${undecided.map((g) => g.gate).join(', ')}` };
  return {
    verdict: 'CANDIDATE_AUTHORITATIVE',
    reason: 'all gates pass — eligible for survivorship-contract citation as a measured historical listing source (final adoption is a reviewed code change)',
  };
}

module.exports = {
  AV_LISTINGS_VERSION, EXPECTED_HEADER, FROM_YM, DEFAULT_RUN_BUDGET, THROTTLE_MS,
  monthEndDate, ymRange, snapshotPlan, parseCsv, classifyResponse,
  partitionDoc, partitionValid, isCommonStock,
  adjudicateDelistingCase,
  gateDelistingReconciliation, gateMembershipSanity, gateInternalConsistency,
  gateRenameSpotChecks, gatesVerdict,
};
