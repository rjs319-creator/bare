'use strict';
// FMP SUBSCRIPTION CAPABILITY AUDITOR (fmp-audit-v1)
//
// The repo asserts the plan's limits in scattered comments ("estimates are
// plan-gated", "batch-quote is 402", "vintage history unverified — probe before
// claiming availability") — none of it established empirically in one place.
// This auditor probes one representative, CHEAP request per endpoint family and
// classifies each as:
//   AVAILABLE            2xx with rows
//   EMPTY_BUT_ACCESSIBLE 2xx, zero rows (accessible; the query just has no data)
//   PLAN_GATED           401/402/403 — the subscription is the wall
//   INVALID_OR_LEGACY    400/404 — the path/params are wrong or retired
//   TEMPORARILY_FAILED   429/5xx/network/unparseable after bounded retries
//
// The report is counts/fields/dates only — never bulk vendor payloads, never
// the key, never a full URL. Exposed as op=fmpaudit (PRIVILEGED: it spends
// ~25 FMP calls) and `npm run fmp:audit` locally. The latest report is also
// persisted to Blob (fmp/capability-audit.json + a dated vintage copy) so
// collectors can gate on ESTABLISHED capability instead of assumptions.
const { fmpRequest, CATEGORY } = require('./fmp-client');

const PROBE_SPACING_MS = 250;                    // serial, deliberately gentle
const PROBE_SYMBOL = 'AAPL';                     // never empty on an accessible endpoint

const isoDay = (msOffset = 0) => new Date(Date.now() + msOffset).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

// One representative probe per endpoint family. `knownUse` marks endpoints the
// app already consumes (their status is a control that validates the probe
// itself). `limit` present ⇒ rows===limit is reported as `capped` (a full page
// means "there may be more", which matters for feed-coverage planning).
function probeList() {
  const weekAgo = isoDay(-7 * DAY_MS);
  const today = isoDay();
  const lastYear = new Date().getUTCFullYear() - 1;
  return [
    // ── Analyst estimates — the top new-data priority ──
    { id: 'analyst-estimates-annual', family: 'estimates', path: '/analyst-estimates', params: { symbol: PROBE_SYMBOL, period: 'annual', page: 0, limit: 10 }, limit: 10 },
    { id: 'analyst-estimates-quarter', family: 'estimates', path: '/analyst-estimates', params: { symbol: PROBE_SYMBOL, period: 'quarter', page: 0, limit: 10 }, limit: 10 },
    // ── Analyst events / consensus ──
    { id: 'price-target-summary', family: 'analyst', path: '/price-target-summary', params: { symbol: PROBE_SYMBOL } },
    { id: 'price-target-consensus', family: 'analyst', path: '/price-target-consensus', params: { symbol: PROBE_SYMBOL } },
    { id: 'price-target-latest-news', family: 'analyst', path: '/price-target-latest-news', params: { page: 0, limit: 10 }, limit: 10, knownUse: 'revarchive' },
    { id: 'grades', family: 'analyst', path: '/grades', params: { symbol: PROBE_SYMBOL } },
    { id: 'grades-consensus', family: 'analyst', path: '/grades-consensus', params: { symbol: PROBE_SYMBOL } },
    { id: 'grades-historical', family: 'analyst', path: '/grades-historical', params: { symbol: PROBE_SYMBOL, limit: 5 }, limit: 5, knownUse: 'revisions' },
    // ── News / press releases ──
    { id: 'news-stock', family: 'news', path: '/news/stock', params: { symbols: PROBE_SYMBOL, limit: 5 }, limit: 5, knownUse: 'fundamentals' },
    { id: 'press-releases-symbol', family: 'news', path: '/news/press-releases', params: { symbols: PROBE_SYMBOL, limit: 5 }, limit: 5 },
    { id: 'press-releases-latest', family: 'news', path: '/news/press-releases-latest', params: { page: 0, limit: 5 }, limit: 5 },
    // ── SEC filings ──
    { id: 'sec-filings-8k', family: 'sec', path: '/sec-filings-8k', params: { from: weekAgo, to: today, page: 0, limit: 10 }, limit: 10 },
    { id: 'sec-filings-search-symbol', family: 'sec', path: '/sec-filings-search/symbol', params: { symbol: PROBE_SYMBOL, from: weekAgo, to: today, page: 0, limit: 10 }, limit: 10 },
    // ── Insider activity ──
    { id: 'insider-trading-search', family: 'insider', path: '/insider-trading/search', params: { symbol: PROBE_SYMBOL, page: 0, limit: 10 }, limit: 10 },
    { id: 'insider-trading-latest', family: 'insider', path: '/insider-trading/latest', params: { page: 0, limit: 10 }, limit: 10 },
    { id: 'insider-trading-statistics', family: 'insider', path: '/insider-trading/statistics', params: { symbol: PROBE_SYMBOL } },
    // ── Institutional / 13F ──
    { id: 'institutional-ownership-latest', family: 'institutional', path: '/institutional-ownership/latest', params: { page: 0, limit: 10 }, limit: 10 },
    // ── Transcripts ──
    { id: 'earning-call-transcript', family: 'transcripts', path: '/earning-call-transcript', params: { symbol: PROBE_SYMBOL, year: lastYear, quarter: 4 }, knownUse: 'earnings-tone' },
    // ── Float / market cap ──
    { id: 'shares-float', family: 'reference', path: '/shares-float', params: { symbol: PROBE_SYMBOL }, knownUse: 'float-data' },
    { id: 'all-shares-float', family: 'reference', path: '/all-shares-float', params: { page: 0, limit: 10 }, limit: 10 },
    { id: 'historical-market-capitalization', family: 'reference', path: '/historical-market-capitalization', params: { symbol: PROBE_SYMBOL, limit: 5 }, limit: 5 },
    // ── Earnings ──
    { id: 'earnings', family: 'earnings', path: '/earnings', params: { symbol: PROBE_SYMBOL, limit: 5 }, limit: 5, knownUse: 'pead' },
    { id: 'earnings-calendar', family: 'earnings', path: '/earnings-calendar', params: { from: today, to: isoDay(7 * DAY_MS) }, knownUse: 'calarchive' },
    // ── Bulk quotes (known 402 — a deliberate PLAN_GATED control) ──
    { id: 'batch-quote', family: 'quotes', path: '/batch-quote', params: { symbols: 'AAPL,MSFT' }, knownUse: 'quote-provider (skipped: 402)' },
    // ── Intraday bars ──
    { id: 'historical-chart-1min', family: 'intraday', path: '/historical-chart/1min', params: { symbol: PROBE_SYMBOL }, knownUse: 'research/intraday' },
  ];
}

const STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  EMPTY_BUT_ACCESSIBLE: 'EMPTY_BUT_ACCESSIBLE',
  PLAN_GATED: 'PLAN_GATED',
  INVALID_OR_LEGACY: 'INVALID_OR_LEGACY',
  TEMPORARILY_FAILED: 'TEMPORARILY_FAILED',
  UNTESTED: 'UNTESTED',
});

function classifyProbe(r) {
  if (r.category === CATEGORY.OK) return r.rows > 0 ? STATUS.AVAILABLE : STATUS.EMPTY_BUT_ACCESSIBLE;
  if (r.category === CATEGORY.PLAN_GATED) return STATUS.PLAN_GATED;
  if (r.category === CATEGORY.INVALID_REQUEST || r.category === CATEGORY.NOT_FOUND) return STATUS.INVALID_OR_LEGACY;
  return STATUS.TEMPORARILY_FAILED;              // 429/5xx/network/invalid-json/no-key
}

// min/max of anything date-shaped in the sample rows — the report's "earliest/
// latest observed" is about the PROBE WINDOW, not the endpoint's full history.
const DATE_FIELDS = ['date', 'publishedDate', 'filingDate', 'acceptedDate', 'transactionDate', 'fillingDate'];
function dateRangeOf(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let min = null; let max = null;
  for (const row of rows) {
    for (const f of DATE_FIELDS) {
      const v = row && row[f] ? String(row[f]).slice(0, 10) : null;
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
  }
  return min ? { earliest: min, latest: max } : null;
}

function summarizeProbe(probe, r) {
  const status = classifyProbe(r);
  const rows = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
  return {
    family: probe.family, path: probe.path, status, httpStatus: r.status,
    rows: r.rows, capped: probe.limit != null ? r.rows === probe.limit : null,
    fields: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 14) : null,
    dateRange: dateRangeOf(rows),
    knownUse: probe.knownUse || null,
    attempts: r.attempts, error: r.error,        // fmp-client redacts; never a URL
  };
}

/**
 * Run every probe serially (gentle spacing — this must never be a burst) and
 * return the machine-readable capability report. deps are injectable for tests.
 */
async function runFmpCapabilityAudit(deps = {}) {
  const { request = fmpRequest, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), spacingMs = PROBE_SPACING_MS } = deps;
  const t0 = Date.now();
  const probes = {};
  const summary = Object.fromEntries(Object.keys(STATUS).map((s) => [s, []]));
  const list = probeList();
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && spacingMs > 0) await sleep(spacingMs);
    const probe = list[i];
    const r = await request(probe.path, probe.params, { attempts: 2 });
    probes[probe.id] = summarizeProbe(probe, r);
    summary[probes[probe.id].status].push(probe.id);
  }
  return {
    version: 'fmp-audit-v1', auditedAt: new Date().toISOString(), probeSymbol: PROBE_SYMBOL,
    probeCount: list.length, probes, summary, elapsedMs: Date.now() - t0,
  };
}

// ── op=fmpaudit (PRIVILEGED — spends ~25 FMP calls, writes the capability doc) ──
async function runFmpAudit(req, res) {
  if (!process.env.FMP_API_KEY) return res.status(200).json({ ok: false, op: 'fmpaudit', error: 'FMP_API_KEY required' });
  const report = await runFmpCapabilityAudit();
  const { hasStore, writeFmpCapabilityDoc } = require('./store');
  let persisted = false;
  if (hasStore()) {
    await writeFmpCapabilityDoc(report);
    persisted = true;
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, op: 'fmpaudit', persisted, ...report });
}

module.exports = { runFmpCapabilityAudit, runFmpAudit, classifyProbe, summarizeProbe, dateRangeOf, probeList, STATUS };
