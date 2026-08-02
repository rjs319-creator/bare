'use strict';
// SECRET REDACTION (redact-v1)
//
// The app's API keys travel in provider query strings (FMP, Finnhub, …). No current
// code path echoes those URLs, but that guarantee rested on every call site continuing
// to not log them — a convention, not a mechanism. This helper is the mechanism: run
// any string (error message, URL, note) destined for a response, log, manifest, or
// snapshot through redactSecrets() and every configured secret value — plus anything
// shaped like a key-bearing query parameter — is masked.
//
// Fail-safe by design: unknown input types pass through String() conversion, and an
// empty/missing env secret can never turn into a match-everything pattern.

const SECRET_ENV_KEYS = Object.freeze([
  'FMP_API_KEY', 'FINNHUB_API_KEY', 'ANTHROPIC_API_KEY', 'BLOB_READ_WRITE_TOKEN',
  'CRON_SECRET', 'ALERTS_INGEST_TOKEN', 'INSIDER_INGEST_TOKEN',
]);

// Params whose VALUES are secrets regardless of which env var supplied them. The
// boundary accepts ?, &, whitespace, or start-of-string — over-redaction is the safe
// failure mode for a helper that guards logs and responses.
const KEY_PARAM_RE = /(^|[?&\s])((?:apikey|api_key|token)=)[^&\s"']+/gi;

const MASK = '[redacted]';

function redactSecrets(input) {
  let s = typeof input === 'string' ? input : (input == null ? '' : String(input));
  if (!s) return s;
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length >= 8) s = s.split(v).join(MASK);
  }
  return s.replace(KEY_PARAM_RE, `$1$2${MASK}`);
}

// Convenience for Error objects on response paths: message only, redacted — never a
// stack trace (stacks can embed URLs with keys via fetch error causes).
function redactedMessage(err) {
  return redactSecrets((err && err.message) || err);
}

module.exports = { redactSecrets, redactedMessage, SECRET_ENV_KEYS, MASK };
