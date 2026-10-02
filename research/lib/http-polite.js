'use strict';
// POLITE HTTP — one small rate-limited fetch for the research-side public APIs
// (Wikimedia REST, Wikidata SPARQL, Yahoo chart). Wikimedia asks every client for a
// descriptive User-Agent with a contact, so the repo's SEC-style identity string is
// reused here. Concurrency and spacing are explicit constants; 429/5xx back off and
// retry a bounded number of times; everything else fails closed with the status.

const RESEARCH_UA = process.env.RESEARCH_USER_AGENT || 'market-news-app research (contact: rjs319@gmail.com)';
const DEFAULT_MIN_SPACING_MS = 120;
const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1500;
const MAX_BACKOFF_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Honour Retry-After when the server states it; otherwise exponential backoff.
function backoffMs(res, attempt) {
  const ra = Number(res && res.headers && res.headers.get && res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, MAX_BACKOFF_MS);
  return Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

// A tiny semaphore + global spacing so N workers never exceed the agreed request rate.
function makeLimiter({ concurrency = DEFAULT_CONCURRENCY, minSpacingMs = DEFAULT_MIN_SPACING_MS } = {}) {
  let active = 0;
  let lastStart = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    const now = Date.now();
    const wait = Math.max(0, lastStart + minSpacingMs - now);
    active++;
    const job = queue.shift();
    lastStart = now + wait;
    setTimeout(() => job().finally(() => { active--; next(); }), wait);
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    next();
  });
}

async function fetchWithRetry(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': RESEARCH_UA, ...headers }, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(backoffMs(res, attempt));
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      await sleep(RETRY_BASE_MS * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('fetch failed');
}

// JSON convenience: { ok, status, json } — a 404 is a normal answer (no data), not a throw.
async function fetchJSON(url, opts = {}) {
  const res = await fetchWithRetry(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) return { ok: false, status: res.status, json: null };
  try { return { ok: true, status: res.status, json: await res.json() }; }
  catch (e) { return { ok: false, status: res.status, json: null, error: String(e && e.message || e) }; }
}

module.exports = { RESEARCH_UA, makeLimiter, fetchWithRetry, fetchJSON, sleep, backoffMs };
