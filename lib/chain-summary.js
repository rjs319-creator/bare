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
// This module is PURE (validation, normalisation, health derivation, lookback dates) so
// the route and the health merge are unit-tested without Blob or a network. The one
// write lives in lib/chain-summary-routes.js.
//
// DEAD-MAN SEMANTICS: a night with NO summary inside the lookback window, while the
// in-process dispatcher is switched off, is itself a failure ("nobody ran the chains"),
// which is the one failure a job-failure e-mail can never report.

const CHAIN_SUMMARY_PREFIX = 'chains/';
const summaryPath = (date) => `${CHAIN_SUMMARY_PREFIX}${date}.json`;

// Who may author a record. Anything else is rejected at the boundary.
const SOURCES = new Set(['github-matrix', 'in-process', 'manual']);
// Bounds on the untrusted body (the bearer is shared, so still validate every field).
const MAX_CHAINS = 100;
const MAX_STEPS_PER_CHAIN = 50;
const MAX_TEXT = 200;
const MAX_URL = 300;
// A record may describe the last week (a late manual re-post) or tomorrow (a run that
// crosses midnight UTC), nothing else — so a bad clock cannot litter the prefix.
const DATE_WINDOW_PAST_DAYS = 7;
const DATE_WINDOW_FUTURE_DAYS = 1;
// op=health looks back this many calendar days for the newest record: the chains run
// nightly, but a Monday-morning health check must still find Friday's night.
const LOOKBACK_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHAIN_NAME_RE = /^[a-z0-9]{1,40}$/;
const DAY_MS = 86400000;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
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

// Validate + normalise an untrusted POST body. Returns { value, error } — never throws.
function normalizeChainSummary(payload, { now = Date.now() } = {}) {
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
  return {
    error: null,
    value: {
      date, source,
      runId: text(payload.runId, 40),
      runUrl: text(payload.runUrl, MAX_URL),
      startedAt: isoOrNull(payload.startedAt),
      finishedAt: isoOrNull(payload.finishedAt),
      ok: failed.length === 0,
      failed,
      chainCount: names.length,
      chains,
    },
  };
}

// The compact block op=health exposes as `chains`. Three sources, in order of trust:
//   1. a posted summary (the matrix ran and reported)
//   2. warm's own in-process run record (the legacy dispatcher)
//   3. nothing — which is fine while in-process dispatch is on and no run exists yet
//      (fresh deploy), and a tripped dead-man once in-process dispatch is OFF.
function chainsHealthView({ summary = null, run = null, inProcess = true } = {}) {
  if (summary) {
    const skipped = [...new Set(Object.values(summary.chains || {}).flatMap((c) => (c && c.skipped) || []))];
    return {
      date: summary.date, ok: summary.ok === true, failed: summary.failed || [], skipped,
      source: summary.source || 'github-matrix', runUrl: summary.runUrl || null,
      at: summary.finishedAt || summary.receivedAt || null, missing: false,
    };
  }
  if (!inProcess) {
    return { date: null, ok: false, failed: [], skipped: [], source: 'none', runUrl: null, at: null, missing: true };
  }
  if (!run || !run.chains) return null;
  const failed = [...new Set([...(run.chainDispatchFails || []), ...(run.lateChainFails || [])])];
  const skipped = (run.chainSkips || []).flatMap((s) => (s && s.skipped) || []);
  return {
    date: typeof run.at === 'string' && DATE_RE.test(run.at.slice(0, 10)) ? run.at.slice(0, 10) : null,
    ok: failed.length === 0, failed, skipped: [...new Set(skipped)],
    source: 'in-process', runUrl: null, at: run.at || null, missing: false,
  };
}

// Dates to probe for the newest record, newest first.
function recentSummaryDates(now = Date.now(), lookbackDays = LOOKBACK_DAYS) {
  return Array.from({ length: lookbackDays + 1 }, (_, i) => isoDate(now - i * DAY_MS));
}

module.exports = {
  CHAIN_SUMMARY_PREFIX, summaryPath, SOURCES, MAX_CHAINS, MAX_STEPS_PER_CHAIN, MAX_TEXT, LOOKBACK_DAYS,
  normalizeChainSummary, normalizeChain, chainsHealthView, recentSummaryDates,
};
