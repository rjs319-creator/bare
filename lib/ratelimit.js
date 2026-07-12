// Best-effort in-memory sliding-window rate limiter for expensive ops.
//
// HONEST CAVEAT: Vercel serverless instances are ephemeral and per-region, so this
// throttles bursts against a single warm instance — it is NOT a global limit. Without
// a shared KV store, this is defense-in-depth against accidental hammering / cost
// runaway (an anonymous caller looping an expensive LLM/scan op), not a hard security
// boundary. Trusted (CRON_SECRET) callers are exempt so the daily cron is never limited.

const buckets = new Map(); // key -> [timestampsMs]

// Returns { ok, remaining, retryAfterMs }. Records the hit when ok.
function rateLimit(key, { limit, windowMs }, nowMs = Date.now()) {
  const arr = (buckets.get(key) || []).filter(t => nowMs - t < windowMs);
  if (arr.length >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: windowMs - (nowMs - arr[0]) };
  }
  arr.push(nowMs);
  buckets.set(key, arr);
  // Bound memory: occasionally drop fully-expired keys.
  if (buckets.size > 500) {
    for (const [k, v] of buckets) { if (!v.some(t => nowMs - t < windowMs)) buckets.delete(k); }
  }
  return { ok: true, remaining: limit - arr.length, retryAfterMs: 0 };
}

// Client key from the forwarded IP (Vercel sets x-forwarded-for). Falls back to a
// constant so the limiter still applies (globally, per instance) if the header absent.
function clientKey(req) {
  const xff = (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  return String(xff).split(',')[0].trim() || 'unknown';
}

// Reset — test-only helper.
function _reset() { buckets.clear(); }

module.exports = { rateLimit, clientKey, _reset };
