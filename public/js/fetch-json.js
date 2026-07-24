// Shared fetch → JSON with a hard timeout.
//
// A bare fetch() never times out: a stalled request (most often a serverless cold start on a
// heavy read) settles as neither resolve nor reject, so the caller's loading spinner sits up
// forever with no recovery. fetchJSON aborts after `timeoutMs` so the stall lands in the
// caller's existing catch/error path instead.
//
// Throws on: abort (timeout), network failure, or a non-2xx status. Callers keep their own
// try/catch (or `.catch(() => null)` for optional sources) exactly as before.

const DEFAULT_TIMEOUT_MS = 20000;

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
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
