'use strict';
// NIGHTLY CHAIN SUMMARY — the per-night record of what happened to the warm chains.
//
// The 22:00 UTC chains used to be dispatched in-process by api/warm.js, so warm's own
// run record (lib/health.js) was the only account of them — and only for the chains that
// reported back before warm's drain ceiling. Running the chains as a GitHub Actions
// matrix (.github/workflows/nightly-chains.yml) moves the dispatcher OUT of the app, so
// the app needs a record posted back in: the workflow's summary job POSTs one compact
// JSON per night to op=chainsummary, written to chains/<date>.json. op=health reads it.
//
// This module is PURE (validation, normalisation, health derivation, lookback dates,
// the merge rule) so the route and the health merge are unit-tested without Blob or a
// network. The one write lives in lib/chain-summary-routes.js.
//
// DEAD-MAN SEMANTICS (two rules, both needed):
//   1. `missing` — NO summary inside the lookback window while the in-process dispatcher
//      is switched off: nobody has run the chains for days.
//   2. `noMatrixRun` — warm ran with chainsInProcess:false (it handed the night to GitHub)
//      and NO FULL summary for that ET session date exists NO_MATRIX_RUN_GRACE_MS later.
//      On 2026-10-02 a `workflow_dispatch -f only=...` run from the morning had written
//      chains/2026-10-02.json, so rule 1 read "fine" while the scheduled run never fired
//      (GitHub delayed the schedule by hours). A PARTIAL run contributes per-chain
//      statuses but can never mark the night covered — only a full run can.
//
// DATES ARE ET SESSION DATES, not UTC: the workflow's retry schedules run as late as
// 01:00 UTC, which is still the same evening in New York. Everything here that turns an
// instant into a date goes through etDate().

const CHAIN_SUMMARY_PREFIX = 'chains/';
const summaryPath = (date) => `${CHAIN_SUMMARY_PREFIX}${date}.json`;

// Who may author a record. Anything else is rejected at the boundary.
const SOURCES = new Set(['github-matrix', 'in-process', 'manual']);
// Only an external run over the whole root list can cover a night. `in-process` is warm's
// own legacy record and is graded through the run record instead.
const FULL_SOURCES = new Set(['github-matrix', 'manual']);
// Bounds on the untrusted body (the bearer is shared, so still validate every field).
const MAX_CHAINS = 100;
const MAX_STEPS_PER_CHAIN = 50;
const MAX_TEXT = 200;
const MAX_URL = 300;
const MAX_PROVENANCE = 10;
// A record may describe the last week (a late manual re-post) or tomorrow (a run that
// crosses midnight UTC), nothing else — so a bad clock cannot litter the prefix.
const DATE_WINDOW_PAST_DAYS = 7;
const DATE_WINDOW_FUTURE_DAYS = 1;
// op=health looks back this many calendar days for the newest record: the chains run
// nightly, but a Monday-morning health check must still find Friday's night.
const LOOKBACK_DAYS = 3;
// How long after warm handed the night to GitHub before "no full run yet" is a problem.
// The matrix is scheduled 5 min after the cron, takes 15-30 min with max-parallel 4, and
// GitHub lands schedules 3-15 min late on a normal day — 90 min is past every normal
// outcome and still well inside the evening, so the alarm is actionable the same night.
const NO_MATRIX_RUN_GRACE_MS = 90 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHAIN_NAME_RE = /^[a-z0-9]{1,40}$/;
const DAY_MS = 86400000;

// The ET calendar date of an instant — the "session date" every nightly artifact is keyed by.
const etDate = (ms) => require('./market-session').etParts(new Date(ms)).date;
const rootChains = () => require('./warm-chains').ROOT_CHAINS;
const text = (v, max = MAX_TEXT) => (v == null ? null : String(v).slice(0, max));
const strList = (v) => (Array.isArray(v) ? v.slice(0, MAX_STEPS_PER_CHAIN).map((s) => text(s)).filter(Boolean) : []);
const intOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
const isoOrNull = (v) => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function dateInWindow(date, now) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return ms >= now - DATE_WINDOW_PAST_DAYS * DAY_MS && ms <= now + DATE_WINDOW_FUTURE_DAYS * DAY_MS;
}

// One chain's record, reduced to the fields the app reads. `ok` is explicit when the
// poster graded it; otherwise it is derived (a reported failure or a non-ok status fails).
function normalizeChain(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const failed = strList(c.failed);
  const status = text(c.status, 40);
  const ok = typeof c.ok === 'boolean' ? c.ok : (failed.length === 0 && (status == null || status === 'ok'));
  return {
    ok,
    status: status || (ok ? 'ok' : 'failed'),
    httpStatus: intOrNull(c.httpStatus),
    attempts: intOrNull(c.attempts),
    complete: boolOrNull(c.complete),
    failed,
    skipped: strList(c.skipped),
    elapsedMs: intOrNull(c.elapsedMs),
    error: text(c.error),
  };
}

const coversRoots = (chains, roots) => roots.every((r) => chains && Object.prototype.hasOwnProperty.call(chains, r));

// Is this doc a FULL run — one that may cover its night? The poster's explicit `partial`
// flag is believed (scripts/nightly-chains-summary.js sets it from `only=`). A legacy doc
// without the flag is full only when it reports every root: that is what makes this
// morning's `only=delisting,dilution,...` doc partial even though it predates the flag.
function isFullSummary(doc, roots = rootChains()) {
  if (!doc || typeof doc !== 'object' || !FULL_SOURCES.has(doc.source)) return false;
  if (typeof doc.partial === 'boolean') return !doc.partial;
  return coversRoots(doc.chains, roots);
}

// Validate + normalise an untrusted POST body. Returns { value, error } — never throws.
function normalizeChainSummary(payload, { now = Date.now(), roots = rootChains() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { value: null, error: 'expected a JSON object' };
  const date = String(payload.date || '');
  if (!DATE_RE.test(date) || !dateInWindow(date, now)) return { value: null, error: `date must be YYYY-MM-DD within the last ${DATE_WINDOW_PAST_DAYS} days` };
  const source = String(payload.source || '');
  if (!SOURCES.has(source)) return { value: null, error: `source must be one of ${[...SOURCES].join(', ')}` };
  const rawChains = payload.chains;
  if (!rawChains || typeof rawChains !== 'object' || Array.isArray(rawChains)) return { value: null, error: 'chains must be an object keyed by chain name' };
  const names = Object.keys(rawChains);
  if (!names.length || names.length > MAX_CHAINS) return { value: null, error: `chains must name 1..${MAX_CHAINS} chains` };
  const badName = names.find((n) => !CHAIN_NAME_RE.test(n));
  if (badName) return { value: null, error: `invalid chain name "${String(badName).slice(0, 40)}"` };

  const chains = Object.fromEntries(names.map((n) => [n, normalizeChain(rawChains[n])]));
  const failed = names.filter((n) => !chains[n].ok);
  const partial = typeof payload.partial === 'boolean' ? payload.partial : !coversRoots(chains, roots);
  return {
    error: null,
    value: {
      date, source,
      runId: text(payload.runId, 40),
      runUrl: text(payload.runUrl, MAX_URL),
      startedAt: isoOrNull(payload.startedAt),
      finishedAt: isoOrNull(payload.finishedAt),
      ok: failed.length === 0,
      // A partial run (workflow_dispatch only=...) reports statuses for the chains it ran
      // and nothing about the night. Stored explicitly so the reader never has to guess.
      partial,
      covered: names,
      failed,
      chainCount: names.length,
      chains,
    },
  };
}

const provenance = (doc) => ({ runId: doc.runId ?? null, runUrl: doc.runUrl ?? null, receivedAt: doc.receivedAt ?? null, source: doc.source ?? null });
const gradeChains = (chains) => {
  const names = Object.keys(chains);
  const failed = names.filter((n) => !(chains[n] && chains[n].ok));
  return { ok: failed.length === 0, failed, covered: names, chainCount: names.length };
};

// THE MERGE RULE for chains/<date>.json (pure; applied under CAS in the route).
//   • full incoming → replaces the night; earlier posts are kept as `priorRuns` provenance.
//   • partial incoming onto an existing doc → per-chain statuses fold in (newest wins), the
//     night keeps the existing doc's identity and fullness, and the post is listed under
//     `patches`. A `only=maturity` re-run after a red night can therefore turn the night
//     green — but a partial post onto NOTHING is just itself: still partial, never covering.
function mergeChainSummary(existing, incoming) {
  if (!existing || typeof existing !== 'object' || existing.date !== incoming.date) return incoming;
  if (incoming.partial !== true) {
    const priorRuns = [provenance(existing), ...(existing.priorRuns || [])].slice(0, MAX_PROVENANCE);
    return { ...incoming, priorRuns };
  }
  const chains = { ...(existing.chains || {}), ...(incoming.chains || {}) };
  const { priorRuns, patches, ...base } = existing;
  return {
    ...base,
    ...gradeChains(chains),
    chains,
    finishedAt: incoming.finishedAt || existing.finishedAt || null,
    ...(priorRuns ? { priorRuns } : {}),
    patches: [provenance(incoming), ...(patches || [])].slice(0, MAX_PROVENANCE),
  };
}

// Rule 2 of the dead-man: warm handed the night to GitHub (chainsInProcess:false) and no
// FULL summary for that ET session date has arrived within the grace period. Judged by
// the warm run's own date — "today" until 04:00 UTC and still last night the next
// morning — but only while that date is inside the summaries we actually read, so a warm
// record older than the lookback cannot keep an alarm alive that nothing can clear.
function matrixRunOverdue({ run = null, summaries = [], now = Date.now(), roots = rootChains() } = {}) {
  if (!run || run.chainsInProcess !== false) return null;
  const warmMs = Date.parse(run.at);
  if (!Number.isFinite(warmMs) || now - warmMs < NO_MATRIX_RUN_GRACE_MS) return null;
  const date = etDate(warmMs);
  if (!recentSummaryDates(now).includes(date)) return null;
  const covered = (summaries || []).some((s) => s && s.date === date && isFullSummary(s, roots));
  return covered ? null : { date, warmAt: run.at, graceMs: NO_MATRIX_RUN_GRACE_MS };
}

// The view of ONE posted summary (the newest night). A full summary that lacks a root —
// a root added after the run posted — lists it as failed: it did not run tonight.
function summaryView(doc, roots) {
  const chains = doc.chains || {};
  const full = isFullSummary(doc, roots);
  const covered = Object.keys(chains);
  const reported = covered.filter((n) => !(chains[n] && chains[n].ok));
  const missingRoots = full ? roots.filter((r) => !covered.includes(r)) : [];
  const failed = [...new Set([...reported, ...missingRoots])];
  const skipped = [...new Set(Object.values(chains).flatMap((c) => (c && c.skipped) || []))];
  return {
    date: doc.date, ok: full && failed.length === 0, full, partial: !full, covered, failed, skipped,
    source: doc.source || 'github-matrix', runUrl: doc.runUrl || null,
    at: doc.finishedAt || doc.receivedAt || null, missing: false,
  };
}

// The compact block op=health exposes as `chains`. Three sources, in order of trust:
//   1. posted summaries (the matrix ran and reported) — the newest night
//   2. warm's own in-process run record (the legacy dispatcher)
//   3. nothing — which is fine while in-process dispatch is on and no run exists yet
//      (fresh deploy), and a tripped dead-man once in-process dispatch is OFF.
// `noMatrixRun` (rule 2) rides along on every branch so the banner can name the night.
function chainsHealthView({ summaries = null, summary = null, run = null, inProcess = true, now = Date.now(), roots = rootChains() } = {}) {
  const docs = (Array.isArray(summaries) ? summaries : (summary ? [summary] : [])).filter((d) => d && d.date);
  const noMatrixRun = matrixRunOverdue({ run, summaries: docs, now, roots });
  if (docs.length) {
    const newest = docs.reduce((a, b) => (b.date > a.date ? b : a));
    return { ...summaryView(newest, roots), noMatrixRun };
  }
  if (!inProcess) {
    return { date: null, ok: false, full: false, partial: false, covered: [], failed: [], skipped: [], source: 'none', runUrl: null, at: null, missing: true, noMatrixRun };
  }
  if (!run || !run.chains) return null;
  const failed = [...new Set([...(run.chainDispatchFails || []), ...(run.lateChainFails || [])])];
  const skipped = (run.chainSkips || []).flatMap((s) => (s && s.skipped) || []);
  return {
    date: typeof run.at === 'string' && DATE_RE.test(run.at.slice(0, 10)) ? run.at.slice(0, 10) : null,
    ok: failed.length === 0, full: true, partial: false, covered: Object.keys(run.chains), failed, skipped: [...new Set(skipped)],
    source: 'in-process', runUrl: null, at: run.at || null, missing: false, noMatrixRun,
  };
}

// ET dates to probe for recent records, newest first.
function recentSummaryDates(now = Date.now(), lookbackDays = LOOKBACK_DAYS) {
  return Array.from({ length: lookbackDays + 1 }, (_, i) => etDate(now - i * DAY_MS));
}

module.exports = {
  CHAIN_SUMMARY_PREFIX, summaryPath, SOURCES, FULL_SOURCES, MAX_CHAINS, MAX_STEPS_PER_CHAIN, MAX_TEXT, LOOKBACK_DAYS, NO_MATRIX_RUN_GRACE_MS,
  etDate, isFullSummary, normalizeChainSummary, normalizeChain, mergeChainSummary, matrixRunOverdue, chainsHealthView, recentSummaryDates,
};
