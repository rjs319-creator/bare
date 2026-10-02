// Shared fetch → JSON with a hard timeout.
//
// A bare fetch() never times out: a stalled request (most often a serverless cold start on a
// heavy read) settles as neither resolve nor reject, so the caller's loading spinner sits up
// forever with no recovery. fetchJSON aborts after `timeoutMs` so the stall lands in the
// caller's existing catch/error path instead.
//
// Throws on: abort (timeout), network failure, or a non-2xx status. Callers keep their own
// try/catch (or `.catch(() => null)` for optional sources) exactly as before.
//
// Offline-first additions: a payload the service worker served from its cache (sw.js tags it
// `x-sw-served: cache`) comes back flagged `stale:true, asOf` so no tab can mistake it for fresh;
// fetchSnapshot() adds the last-good layer (last-good.js) for snapshot-shaped reads.
import { withLastGood } from './last-good.js';

// Fine for the ~110 sub-second reads: fails a genuinely stalled request fast enough that the
// tab recovers instead of hanging. NOT safe for endpoints that do real server-side work — see
// HEAVY_TIMEOUT_MS.
export const DEFAULT_TIMEOUT_MS = 20000;

// For a tab's PRIMARY payload when the endpoint does real work (self-fetches, LLM calls, wide
// scans). Measured cold on prod: atlasx 15.4s, omega 13.6s, swingmonitor 13.3s, challenger
// 12.7s, ignition 11.9s, evolve 11.5s, today 11-13s, scoreboard 10.5s, pulse gather 29s.
// Against the 20s default those either fail outright or sit on a few seconds of headroom.
//
// The value sits ABOVE the 60s function wall (vercel.json maxDuration) on purpose: every one of
// these endpoints already bounds ITSELF (per-source AbortSignal, LLM timeouts, last-known-good
// fallbacks), and the platform kills the function at 60s regardless. A client abort below that
// can only ever fire while the server is still legitimately working — it cannot save the user
// any time, it just replaces a real answer (or an honest stale-fallback) with a false error.
export const HEAVY_TIMEOUT_MS = 70000;

// For OPTIONAL enrichment that shares a Promise.all with a primary payload. Promise.all waits
// for a rejected-then-caught promise to SETTLE, so an optional call's timeout is the primary
// render's worst-case delay. These must degrade (render without the overlay) rather than hold
// the board hostage for the full heavy budget.
export const OPTIONAL_TIMEOUT_MS = 30000;

const SW_SERVED_HEADER = 'x-sw-served';
const SW_CACHED_AT_HEADER = 'x-sw-cached-at';

// A response the service worker answered from its cache is LAST-GOOD data, not fresh — flag it
// (new object, input untouched). Only plain objects carry flags; arrays pass through.
export function markSwServed(json, headers) {
  const get = headers && typeof headers.get === 'function' ? (k) => headers.get(k) : () => null;
  if (get(SW_SERVED_HEADER) !== 'cache') return json;
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return json;
  return { ...json, stale: true, asOf: get(SW_CACHED_AT_HEADER) || json.generatedAt || null, staleSource: 'sw-cache' };
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number } & RequestInit} [opts]
 * @returns {Promise<any>} parsed JSON body
 */
export async function fetchJSON(url, { timeoutMs = DEFAULT_TIMEOUT_MS, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return markSwServed(await res.json(), res.headers);
  } finally {
    clearTimeout(timer);
  }
}

// Default last-good key: the op (or the API path) — one slot per logical snapshot.
export function snapshotKey(url) {
  try {
    const u = new URL(String(url), 'https://local.invalid');
    return u.searchParams.get('op') || u.pathname.replace(/^\/api\//, '').replace(/\W+/g, '-') || 'snapshot';
  } catch { return 'snapshot'; }
}

/**
 * fetchJSON + the last-good layer for snapshot-shaped reads: a usable payload is remembered under
 * `key`; a failed / empty / sw-cached read returns the remembered one flagged {stale:true, asOf}.
 * With nothing remembered it behaves exactly like fetchJSON (throws on failure).
 * @param {string} url
 * @param {{ key?: string, store?: object, nowMs?: number, timeoutMs?: number } & RequestInit} [opts]
 */
export async function fetchSnapshot(url, { key = snapshotKey(url), store, nowMs, ...opts } = {}) {
  const lgOpts = {};
  if (store !== undefined) lgOpts.store = store;
  if (nowMs !== undefined) lgOpts.nowMs = nowMs;
  return withLastGood(key, () => fetchJSON(url, opts), lgOpts);
}
