'use strict';
// CENTRAL FMP PROVIDER (fmp-client-v1)
//
// One server-only entry point for Financial Modeling Prep requests. The repo
// grew ~20 independent call sites that each re-derive the URL, each with their
// own (or no) retry policy — and the 22:00 UTC cron burst already cost a
// revarchive day to uncoordinated 429s. This module is the mechanism that
// replaces that convention: deterministic error CATEGORIES, bounded retry with
// jitter that honors Retry-After, per-attempt timeouts, call/bandwidth
// accounting, and redaction-by-construction (no error string ever contains the
// query string, and vendor error bodies pass through redactSecrets).
//
// Policy per category (matches lib/pitdata/v3/collector.js, the previous best):
//   400            invalid-request  — never retried (the request is wrong)
//   401/402/403    plan-gated       — never retried (the SUBSCRIPTION is the wall)
//   404            not-found        — never retried (absence is an answer)
//   429            rate-limited     — retried through backoff, Retry-After honored
//   5xx            upstream-error   — retried with backoff + jitter
//   network/abort  network          — retried with backoff + jitter
//   unparseable    invalid-json     — never retried (quarantine, data-quality signal)
//
// NEW code must call fmpRequest(); existing call sites migrate opportunistically
// (behavior-preserving migrations only — see docs/fmp-data-utility.md).
const { redactSecrets } = require('./redact');

const FMP_STABLE_BASE = 'https://financialmodelingprep.com/stable';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRY_AFTER_CAP_MS = 15_000;
const ERROR_TEXT_MAX = 300;

const CATEGORY = Object.freeze({
  OK: 'ok',
  NO_KEY: 'no-key',
  INVALID_REQUEST: 'invalid-request',
  PLAN_GATED: 'plan-gated',
  NOT_FOUND: 'not-found',
  RATE_LIMITED: 'rate-limited',
  UPSTREAM_ERROR: 'upstream-error',
  NETWORK: 'network',
  INVALID_JSON: 'invalid-json',
});

const RETRYABLE = new Set([CATEGORY.RATE_LIMITED, CATEGORY.UPSTREAM_ERROR, CATEGORY.NETWORK]);

function categorizeStatus(status) {
  if (status >= 200 && status < 300) return CATEGORY.OK;
  if (status === 400) return CATEGORY.INVALID_REQUEST;
  if (status === 401 || status === 402 || status === 403) return CATEGORY.PLAN_GATED;
  if (status === 404) return CATEGORY.NOT_FOUND;
  if (status === 429) return CATEGORY.RATE_LIMITED;
  if (status >= 500) return CATEGORY.UPSTREAM_ERROR;
  return CATEGORY.INVALID_REQUEST;
}

// Per-process accounting (per serverless instance — telemetry, not a quota).
const usage = { calls: 0, retries: 0, bytes: 0, byCategory: {} };
const countCategory = (c) => { usage.byCategory[c] = (usage.byCategory[c] || 0) + 1; };
const getFmpUsage = () => ({ ...usage, byCategory: { ...usage.byCategory } });
const resetFmpUsage = () => { usage.calls = 0; usage.retries = 0; usage.bytes = 0; usage.byCategory = {}; };

// Full-jitter backoff; Retry-After (seconds) wins when present, capped so a
// hostile/huge header can never stall a serverless invocation.
function retryDelayMs(attempt, retryAfterSec, jitter) {
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, RETRY_AFTER_CAP_MS);
  }
  const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return backoff + (typeof jitter === 'function' ? jitter(attempt) : Math.floor(Math.random() * 250));
}

// Path only — NEVER the query string (the apikey travels there).
const describe = (path) => `FMP ${String(path).split('?')[0]}`;

function buildUrl(path, params, apiKey) {
  const u = new URL(FMP_STABLE_BASE + (path.startsWith('/') ? path : `/${path}`));
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  u.searchParams.set('apikey', apiKey);
  return u.toString();
}

/**
 * One FMP /stable request with category-aware bounded retry.
 * @param {string} path e.g. '/analyst-estimates' (or 'analyst-estimates')
 * @param {object} [params] query params (apikey injected from env, never passed in)
 * @param {object} [opts] { timeoutMs, attempts, apiKey, fetchImpl, sleep, jitter }
 *   fetchImpl/sleep/jitter are injectable for deterministic tests.
 * @returns {Promise<{ok:boolean, status:number|null, category:string, body:any,
 *   rows:number, bytes:number, attempts:number, elapsedMs:number, error:string|null}>}
 *   Never throws; `error` is always redacted and never contains the URL.
 */
async function fmpRequest(path, params = {}, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_ATTEMPTS,
    apiKey = process.env.FMP_API_KEY, fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), jitter,
  } = opts;
  const t0 = Date.now();
  if (!apiKey) {
    countCategory(CATEGORY.NO_KEY);
    return { ok: false, status: null, category: CATEGORY.NO_KEY, body: null, rows: 0, bytes: 0, attempts: 0, elapsedMs: 0, error: 'FMP_API_KEY not configured' };
  }
  const url = buildUrl(path, params, apiKey);
  let last = null;
  let used = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) { usage.retries++; await sleep(retryDelayMs(attempt - 1, last && last.retryAfterSec, jitter)); }
    usage.calls++;
    used = attempt;
    last = await attemptOnce(url, path, { timeoutMs, fetchImpl });
    if (!RETRYABLE.has(last.category)) break;
  }
  countCategory(last.category);
  const { retryAfterSec, ...result } = last;
  return { ...result, attempts: used, elapsedMs: Date.now() - t0 };
}

async function attemptOnce(url, path, { timeoutMs, fetchImpl }) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    usage.bytes += text.length;
    const category = categorizeStatus(r.status);
    const retryAfterSec = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null);
    if (category !== CATEGORY.OK) {
      return {
        ok: false, status: r.status, category, body: null, rows: 0, bytes: text.length, retryAfterSec,
        error: redactSecrets(`${describe(path)} HTTP ${r.status}: ${text.slice(0, ERROR_TEXT_MAX)}`),
      };
    }
    let body;
    try { body = JSON.parse(text); } catch {
      return {
        ok: false, status: r.status, category: CATEGORY.INVALID_JSON, body: null, rows: 0, bytes: text.length,
        error: redactSecrets(`${describe(path)} unparseable response: ${text.slice(0, ERROR_TEXT_MAX)}`),
      };
    }
    return { ok: true, status: r.status, category: CATEGORY.OK, body, rows: Array.isArray(body) ? body.length : (body ? 1 : 0), bytes: text.length, error: null };
  } catch (e) {
    return {
      ok: false, status: null, category: CATEGORY.NETWORK, body: null, rows: 0, bytes: 0,
      error: redactSecrets(`${describe(path)} ${String((e && e.name) || 'Error')}: ${String((e && e.message) || e)}`),
    };
  }
}

module.exports = { fmpRequest, getFmpUsage, resetFmpUsage, CATEGORY, categorizeStatus, retryDelayMs, buildUrl, FMP_STABLE_BASE };
