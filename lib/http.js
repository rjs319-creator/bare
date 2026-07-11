// Shared fetch with a hard timeout so a hung upstream socket can't consume the
// whole 60s serverless budget (every provider fetch previously had NO timeout —
// a single stalled Yahoo/Finnhub/SEC connection would block the invocation until
// Vercel force-killed it, taking the entire scan down with no partial result).
//
// Optional bounded retry with exponential backoff + jitter, applied ONLY to
// retryable failures (network error / timeout / 429 / 5xx). Retries default OFF so
// wide fan-out callers (the ~515-ticker scan) don't create a retry storm; low-volume
// callers (per-ticker fundamentals, SEC filings) can opt in.

const DEFAULT_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Full jitter: random point in [0, min(cap, base * 2^attempt)].
function backoffMs(attempt, base, cap = 4000) {
  const ceilMs = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceilMs);
}

function isRetryableError(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError' ||
    e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' ||
    e.name === 'TypeError'); // fetch network failure surfaces as TypeError in Node
}

/**
 * fetch() with an AbortSignal timeout and optional bounded retry.
 * @param {string} url
 * @param {object} [opts]  standard fetch init plus:
 *   timeoutMs  (default 8000) — per-attempt hard deadline
 *   retries    (default 0)    — extra attempts on retryable failures
 *   retryBaseMs(default 300)  — backoff base
 * @returns {Promise<Response>}  the final Response (which may be non-ok); throws only
 *   when every attempt errored (network/timeout) — the caller checks r.ok as usual.
 */
async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, retryBaseMs = 300, ...init } = opts;
  let attempt = 0;
  for (;;) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (attempt < retries && (r.status === 429 || r.status >= 500)) {
        attempt++; await sleep(backoffMs(attempt, retryBaseMs)); continue;
      }
      return r;
    } catch (e) {
      if (attempt < retries && isRetryableError(e)) {
        attempt++; await sleep(backoffMs(attempt, retryBaseMs)); continue;
      }
      throw e;
    }
  }
}

// Categorize a fetch outcome for logging / discriminated handling. Callers that
// only need "did it work" can keep checking r.ok; this is for observability and for
// distinguishing a rate-limit / auth failure from a genuine empty result.
function classifyStatus(r) {
  if (!r) return 'unavailable';
  if (r.ok) return 'ok';
  if (r.status === 429) return 'rate_limited';
  if (r.status === 401 || r.status === 403) return 'auth';
  if (r.status >= 500) return 'unavailable';
  if (r.status === 404) return 'empty';
  return 'bad_response';
}

function classifyError(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  return 'unavailable';
}

module.exports = { fetchWithTimeout, classifyStatus, classifyError, isRetryableError, backoffMs, DEFAULT_TIMEOUT_MS };
