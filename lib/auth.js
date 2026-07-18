// Shared authorization for the ?op= multiplexer, the daily cron, and ingest.
//
// Trust model (single-user dashboard, no user accounts):
//   • CRON_SECRET is the one shared secret. Vercel automatically sends it as
//     `Authorization: Bearer $CRON_SECRET` on scheduled cron invocations when the
//     env var exists, and api/warm.js forwards it to every sub-request it fans out.
//   • Privileged ops (writes / LLM / expensive rebuilds) require that bearer.
//
// ENVIRONMENT-DEPENDENT FAIL POLICY:
//   • Non-production (local / preview): when CRON_SECRET is unset the gates allow
//     through, so a deploy that lands before the secret is configured never breaks
//     the cron or local dev (deploy-safe bootstrap).
//   • Production: a missing CRON_SECRET FAILS CLOSED — privileged ops are denied
//     (503) rather than silently world-open. Set CRON_SECRET in the production
//     environment (Vercel auto-forwards it on cron invocations) before deploying;
//     otherwise the cron and every privileged op will return 503 by design.
//
// This is cost/write protection, NOT read confidentiality — "public read" ops stay
// world-readable, which is acceptable for a single-user dashboard.

const crypto = require('crypto');

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

function cronSecret() {
  return process.env.CRON_SECRET || '';
}

// True only in the real production deployment. VERCEL_ENV is 'production' | 'preview' |
// 'development' on Vercel; off-Vercel we fall back to NODE_ENV. Preview deploys stay in
// the bootstrap fail-open mode so throwaway URLs are not bricked by a missing secret.
function isProduction() {
  return process.env.VERCEL_ENV === 'production'
    || (!process.env.VERCEL_ENV && process.env.NODE_ENV === 'production');
}

// Constant-time secret comparison. Hashing both sides to a fixed-length digest before
// timingSafeEqual avoids the length-mismatch throw AND keeps the comparison from leaking
// the secret's length via timing. Empty inputs never authorize.
function safeEqual(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  if (!sa || !sb) return false;
  const da = crypto.createHash('sha256').update(sa).digest();
  const db = crypto.createHash('sha256').update(sb).digest();
  return crypto.timingSafeEqual(da, db);
}

function bearer(req) {
  const h = (req && req.headers && req.headers['authorization']) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// Is this a trusted internal/cron call (valid CRON_SECRET bearer)?
function isTrusted(req) {
  const secret = cronSecret();
  return !!secret && safeEqual(bearer(req), secret);
}

// Non-throwing environment validation, surfaced by op=health so a misconfigured prod
// deploy is visible rather than silent. `secretConfigured:false` in production means
// every privileged op is currently failing closed (503).
function validateAuthEnv() {
  const production = isProduction();
  const secretConfigured = !!cronSecret();
  const warnings = [];
  if (production && !secretConfigured) {
    warnings.push('CRON_SECRET is not set in production — privileged ops and the cron fail closed (503).');
  }
  return { ok: !(production && !secretConfigured), production, secretConfigured, warnings };
}

// Gate a privileged op. Returns true to proceed; otherwise writes 401/503 and returns
// false. Fail-open only in NON-production when CRON_SECRET is unset; production without a
// secret fails CLOSED (503, misconfiguration) — never world-open.
function requireTrusted(req, res) {
  if (!cronSecret()) {
    if (isProduction()) {                   // fail CLOSED — a missing secret must not mean "allow" in prod
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ ok: false, error: 'server authorization not configured' });
      return false;
    }
    return true;                            // non-prod bootstrap → deploy-safe pass
  }
  if (isTrusted(req)) return true;
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}

// Method guard. Returns true to proceed; otherwise writes 405 and returns false.
function requireMethod(req, res, methods) {
  const m = ((req && req.method) || 'GET').toUpperCase();
  if (methods.includes(m)) return true;
  res.setHeader('Allow', methods.join(', '));
  res.setHeader('Cache-Control', 'no-store');
  res.status(405).json({ ok: false, error: 'method not allowed' });
  return false;
}

// Authorization for ingest endpoints. Accepts the CRON_SECRET bearer OR the op's
// dedicated ingest token (x-ingest-token header or ?token=). Fail-open only when
// NEITHER a dedicated token NOR CRON_SECRET is configured (bootstrap); once either
// is set, an unauthenticated caller is rejected — closing the fail-OPEN hole where
// a missing token env var previously disabled the check entirely.
function ingestAuthorized(req, tokenEnvName) {
  const token = process.env[tokenEnvName] || '';
  if (!token && !cronSecret()) return !isProduction();   // unconfigured → bootstrap in non-prod only
  if (isTrusted(req)) return true;
  const provided = (req.headers && req.headers['x-ingest-token']) || (req.query && req.query.token) || '';
  return !!token && safeEqual(provided, token);
}

// Headers for internal cron→function fetches: keep x-warm and forward the secret.
function internalHeaders(extra) {
  const h = Object.assign({ 'x-warm': '1' }, extra || {});
  const secret = cronSecret();
  if (secret) h['authorization'] = 'Bearer ' + secret;
  return h;
}

// Strip rebuild-forcing params from an untrusted request so anonymous callers get
// cached data but cannot force an expensive LLM/scan recompute. Mutates req.query
// in place (the request object is request-scoped, not shared state).
function stripForceParams(req) {
  if (isTrusted(req)) return;
  if (req && req.query) {
    delete req.query.force;
    delete req.query.refresh;
    delete req.query.reset;
  }
}

function isValidTicker(t) {
  return typeof t === 'string' && TICKER_RE.test(t.toUpperCase());
}

// Uppercase + validate a comma-separated ticker list, dropping malformed entries.
function sanitizeTickers(raw, max = 25) {
  if (typeof raw !== 'string') return [];
  return raw.split(',')
    .map(s => s.trim().toUpperCase())
    .filter(t => TICKER_RE.test(t))
    .slice(0, max);
}

module.exports = {
  isTrusted, requireTrusted, requireMethod, ingestAuthorized,
  internalHeaders, stripForceParams, isValidTicker, sanitizeTickers, bearer, cronSecret,
  isProduction, safeEqual, validateAuthEnv,
};
