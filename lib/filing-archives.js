'use strict';
// FMP FILING-FEED ARCHIVES (op=sec8karchive → sec8karchive/<date>.json,
//                           op=insarchive  → insarchive/<date>.json)
//
// Both endpoints were established AVAILABLE by the 2026-08-09 capability audit
// (op=fmpaudit) — market-wide 8-K filings and market-wide insider transactions.
// Like the analyst-event feeds, they are rolling windows at the vendor: what
// scrolls past uncaptured is unrecoverable, so these are archive-first streams
// with NO features and NO reads into outcomes (the alpha-archive doctrine).
//
// Conventions (lib/alpha-archive-routes.js): date-keyed write-once shards,
// same-day pulls MERGE via dedup keys (frequency is the coverage), page caps
// and truncation RECORDED never silent, plan-gate recorded as data, 503 on
// total transient failure so the scheduler sees starvation.
//
// PIT contract: filingDate/acceptedDate is the event's publication time — the
// first tradable timestamp (never transactionDate, which precedes the filing).
// doc savedAt records when WE first held the shard.
const { nowET } = require('./stats');
const { fmpRequest, CATEGORY } = require('./fmp-client');

// alpha-archive's dedupeEvents is coupled to the grade/target row shape
// (requires .symbol/.publishedDate) — these streams carry compact rows, so the
// identity filter lives in the key functions and this stays shape-agnostic.
function dedupeByKey(rows, keyFn) {
  const seen = new Set(); const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

const FEED_PAGE_LIMIT = 100;                    // proven fine on the news feeds; page>0 may be the wall
const FEED_MAX_PAGES = 8;
const FEED_CALL_SPACING_MS = 150;
const FEED_LOOKBACK_DAYS = 3;                   // daily pulls overlap; read-time dedup absorbs it

const str = (v) => (v == null ? null : String(v));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const day = (v) => (v ? String(v).slice(0, 10) : null);

// ── 8-K filings ─────────────────────────────────────────────────────────────
function compact8kRow(row) {
  if (!row || typeof row !== 'object') return null;
  const s = str(row.symbol) ? String(row.symbol).toUpperCase() : null;
  const fd = day(row.filingDate);
  if (!fd) return null;                          // a filing without a filing date is not an event
  return {
    s, cik: str(row.cik), fd, ad: str(row.acceptedDate),
    ft: str(row.formType), fin: row.hasFinancials === true,
    url: str(row.finalLink || row.link),
  };
}
// The SEC document URL is globally unique per filing; fall back to identity fields.
const filing8kKey = (e) => e.url || [e.cik, e.s, e.fd, e.ft].join('|');

// ── Insider transactions ────────────────────────────────────────────────────
// Archive the vendor's own transaction coding VERBATIM (transactionType carries
// the Form 4 code — P-Purchase, S-Sale, A-Award, M-Exercise, G-Gift…). The
// Phase-8 normalization (open-market vs grant vs routine) is a FEATURE-layer
// concern built later, on top of preserved codes — never baked into the archive.
function compactInsiderRow(row) {
  if (!row || typeof row !== 'object') return null;
  const s = str(row.symbol) ? String(row.symbol).toUpperCase() : null;
  const fd = day(row.filingDate);
  if (!s || !fd) return null;
  return {
    s, fd, td: day(row.transactionDate),
    rc: str(row.reportingCik), rn: str(row.reportingName), ro: str(row.typeOfOwner),
    tc: str(row.transactionType), ad: str(row.acquisitionOrDisposition), di: str(row.directOrIndirect),
    ft: str(row.formType), qty: num(row.securitiesTransacted), px: num(row.price), own: num(row.securitiesOwned),
  };
}
const insiderEventKey = (e) => [e.s, e.rc || e.rn, e.td, e.tc, e.qty, e.px, e.di].join('|');

// ── Shared paginated-feed sweep ─────────────────────────────────────────────
// Stops on: feed exhausted (short page), page cap hit (recorded), transient
// failure past page 0 (partial kept), or every row on a page older than the
// lookback window (daily pulls need no deeper history).
async function sweepFeed({ path, params = {}, cutoffDate, request = fmpRequest, sleep }) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rows = [];
  const out = { rows, pagesFetched: 0, pageCapped: false, gated: false, feedOk: true, error: null };
  for (let p = 0; p < FEED_MAX_PAGES; p++) {
    if (p > 0) await wait(FEED_CALL_SPACING_MS);
    const r = await request(path, { ...params, page: p, limit: FEED_PAGE_LIMIT }, { attempts: p === 0 ? 3 : 2 });
    if (!r.ok) {
      if (r.category === CATEGORY.PLAN_GATED && p === 0) { out.gated = true; out.feedOk = false; out.error = r.error; }
      else if (p === 0) { out.feedOk = false; out.error = r.error; }        // transient page-0 loss = feed loss
      else if (r.category === CATEGORY.PLAN_GATED || r.category === CATEGORY.INVALID_REQUEST) out.pageCapped = true;
      else out.error = r.error;                  // transient mid-sweep: keep the partial, record why
      return out;
    }
    if (!Array.isArray(r.body)) { out.feedOk = p > 0; out.error = 'unexpected response shape'; return out; }
    out.pagesFetched = p + 1;
    rows.push(...r.body);
    if (r.body.length < FEED_PAGE_LIMIT) return out;                        // exhausted
    if (cutoffDate && r.body.every((row) => (day(row && row.filingDate) || '9999') < cutoffDate)) return out;
  }
  out.pageCapped = true;                          // full sweep with full last page — there was more
  return out;
}

const oldestFd = (rows) => rows.reduce((m, r) => (r.fd && (!m || r.fd < m) ? r.fd : m), null);
const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// ── Route runners ───────────────────────────────────────────────────────────
async function runFeedArchive(res, { op, path, params, compact, keyOf, readDay, writeDay, docExtra = {} }) {
  const { hasStore } = require('./store');
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op });
  if (!process.env.FMP_API_KEY) return res.status(200).json({ ok: false, error: 'FMP_API_KEY required', op });
  const t0 = Date.now();
  const { date } = nowET();
  const cutoffDate = isoDaysAgo(FEED_LOOKBACK_DAYS);

  const sweep = await sweepFeed({ path, params, cutoffDate });
  if (sweep.gated) {
    return res.status(200).json({ ok: false, op, date, gated: true, error: sweep.error, elapsedMs: Date.now() - t0 });
  }
  if (!sweep.feedOk && sweep.rows.length === 0) {
    // 503, not silent-200: the warmchain/workflow classifies by HTTP status.
    return res.status(503).json({ ok: false, op, date, error: sweep.error || 'feed failed (after retries) — no shard written', elapsedMs: Date.now() - t0 });
  }

  const fresh = sweep.rows.map(compact).filter(Boolean);
  const prior = await readDay(date);
  const events = dedupeByKey([...((prior && prior.events) || []), ...fresh], keyOf);
  await writeDay(date, {
    date, ...docExtra, pagesFetched: sweep.pagesFetched, pageCapped: sweep.pageCapped,
    sweepError: sweep.error, events,
  });
  return res.status(200).json({
    ok: true, op, date, fetched: fresh.length, events: events.length, mergedWithPrior: !!prior,
    pagesFetched: sweep.pagesFetched, pageCapped: sweep.pageCapped, oldestFilingDate: oldestFd(events),
    elapsedMs: Date.now() - t0,
  });
}

async function runSec8kArchive(req, res) {
  const { readSec8kArchiveDay, writeSec8kArchiveDay } = require('./store');
  return runFeedArchive(res, {
    op: 'sec8karchive', path: '/sec-filings-8k',
    params: { from: isoDaysAgo(FEED_LOOKBACK_DAYS), to: new Date().toISOString().slice(0, 10) },
    compact: compact8kRow, keyOf: filing8kKey,
    readDay: readSec8kArchiveDay, writeDay: writeSec8kArchiveDay,
    docExtra: { source: 'fmp/sec-filings-8k' },
  });
}

async function runInsiderArchive(req, res) {
  const { readInsArchiveDay, writeInsArchiveDay } = require('./store');
  return runFeedArchive(res, {
    op: 'insarchive', path: '/insider-trading/latest', params: {},
    compact: compactInsiderRow, keyOf: insiderEventKey,
    readDay: readInsArchiveDay, writeDay: writeInsArchiveDay,
    docExtra: { source: 'fmp/insider-trading-latest' },
  });
}

module.exports = {
  runSec8kArchive, runInsiderArchive, sweepFeed, dedupeByKey,
  compact8kRow, filing8kKey, compactInsiderRow, insiderEventKey,
  FEED_PAGE_LIMIT, FEED_MAX_PAGES, FEED_LOOKBACK_DAYS,
};
