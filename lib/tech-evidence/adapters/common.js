'use strict';
// Tech Operational Evidence — shared adapter plumbing.
// Every outbound request goes through guardedFetch: https-only, host allowlisted
// against the mapping registry (SSRF guard), bounded body size, bounded timeout,
// jittered retry only on retryable classes, and a classified error result instead
// of a throw — one bad source must never take down a collection run.

const { fetchWithTimeout, classifyStatus, classifyError } = require('../../http');
const REGISTRY = require('../registry');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;       // most APIs
const LARGE_MAX_BYTES = 24 * 1024 * 1024;        // SEC companyfacts payloads

const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';

async function guardedFetch(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, headers = {}, method = 'GET', body = null,
  maxBytes = DEFAULT_MAX_BYTES, fetchImpl = null, expectJson = true, extraAllowedHosts = [],
} = {}) {
  // extraAllowedHosts is granted only by adapters that have ALREADY validated the
  // mapping (registry.validateMapping enforces official-company hosts) — e.g. pricing
  // pages on the company's own domain, which are not global API hosts.
  const extraOk = (() => {
    try { return /^https:/.test(String(url)) && extraAllowedHosts.includes(new URL(url).hostname.toLowerCase()); } catch { return false; }
  })();
  if (!REGISTRY.isAllowedUrl(url) && !extraOk) {
    return { ok: false, status: null, category: 'blocked', body: null, error: `host not allowlisted: ${url}` };
  }
  let res;
  try {
    const init = { timeoutMs, retries, headers: { 'User-Agent': 'market-news-app tech-evidence', Accept: 'application/json', ...headers }, method, redirect: 'error' };
    if (body != null) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    res = fetchImpl ? await fetchImpl(url, init) : await fetchWithTimeout(url, init);
  } catch (e) {
    return { ok: false, status: null, category: classifyError(e), body: null, error: String((e && e.message) || e).slice(0, 200) };
  }
  const category = classifyStatus(res);
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null);
  if (Number.isFinite(len) && len > maxBytes) {
    return { ok: false, status: res.status, category: 'oversized', body: null, error: `response ${len}B exceeds cap ${maxBytes}B` };
  }
  let text = '';
  try { text = await res.text(); } catch (e) {
    return { ok: false, status: res.status, category: 'bad_response', body: null, error: 'body read failed: ' + String((e && e.message) || e).slice(0, 120) };
  }
  if (text.length > maxBytes) {
    return { ok: false, status: res.status, category: 'oversized', body: null, error: `body ${text.length}B exceeds cap ${maxBytes}B` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, category, body: null, error: `HTTP ${res.status}`, rateLimited: category === 'rate_limited' };
  }
  if (!expectJson) return { ok: true, status: res.status, category: 'ok', body: text, error: null };
  try {
    return { ok: true, status: res.status, category: 'ok', body: JSON.parse(text), error: null };
  } catch {
    return { ok: false, status: res.status, category: 'bad_response', body: null, error: 'invalid JSON' };
  }
}

// Uniform adapter result: observations may be partial; error describes what failed.
function adapterResult({ source, observations = [], errors = [], rateLimited = false, coverage = null }) {
  return {
    source,
    ok: errors.length === 0,
    partial: errors.length > 0 && observations.length > 0,
    observations,
    errors: errors.slice(0, 10),
    rateLimited,
    coverage,
  };
}

const isoDay = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Bounded fan-out over mappings: up to `limit` concurrent fetches, and no NEW work
// starts once the run's budget is spent (items skipped that way report as such, so a
// starved mapping is visible in coverage instead of silently absent). Overrun is
// bounded by the in-flight fetch timeouts, not by the whole remaining item list.
const MAPPING_CONCURRENCY = 3;
async function mapWithBudget(items, fn, { budget = null, limit = MAPPING_CONCURRENCY } = {}) {
  const { mapLimit } = require('../../map-limit');
  const overBudget = () => budget && Number.isFinite(budget.deadlineMs) && Date.now() - budget.t0 > budget.deadlineMs;
  return mapLimit(items, limit, async (item, idx) => {
    if (overBudget()) return { skippedBudget: true, item };
    return fn(item, idx);
  });
}

module.exports = { guardedFetch, adapterResult, isoDay, mapWithBudget, MAPPING_CONCURRENCY, SEC_UA, DEFAULT_MAX_BYTES, LARGE_MAX_BYTES };
