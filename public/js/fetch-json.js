// Shared fetch → JSON with a hard timeout.
//
// A bare fetch() never times out: a stalled request (most often a serverless cold start on a
// heavy read) settles as neither resolve nor reject, so the caller's loading spinner sits up
// forever with no recovery. fetchJSON aborts after `timeoutMs` so the stall lands in the
// caller's existing catch/error path instead.
//
// Throws on: abort (timeout), network failure, or a non-2xx status. Callers keep their own
// try/catch (or `.catch(() => null)` for optional sources) exactly as before.

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
