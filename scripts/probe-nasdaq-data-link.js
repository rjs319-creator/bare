#!/usr/bin/env node
'use strict';
// Nasdaq Data Link connection probe — LOCAL-ONLY diagnostic, never deployed and
// never imported by app routes. Verifies that NASDAQ_DATA_LINK_API_KEY works by
// making ONE bounded request against the free WIKI/PRICES datatable
// (qopts.per_page=1 — a 200 proves auth without touching licensed data).
// The TABLES API is the only viable target: as of 2026 the legacy time-series
// API (/api/v3/datasets/...) is retired — non-browser clients get an Imperva
// HTML 403 wall (or 410 Gone) REGARDLESS of key validity, so probing it would
// misreport a good key as an auth failure (verified live 2026-08-02; see
// Nasdaq/data-link-python#54 "Get returns 403, while Get_Table returns 200").
// Optionally, if NASDAQ_ESTIMATES_TABLE_CODE is set,
// makes one metadata request against that premium datatable to check
// entitlement (schema names only — no licensed row values).
//
// USAGE:  npm run probe:nasdaq      (loads .env.local via --env-file-if-exists)
//
// SAFETY CONTRACT: the full request URL carries the key in a query param, so it
// is built internally and NEVER printed; every string that reaches output goes
// through lib/redact. Response bodies are never echoed — only whitelisted safe
// fields (row count, column names, a pattern-checked provider error code)
// survive into the report. An auth failure is reported as auth failure, never
// as an empty dataset. Exits nonzero on any failed probe.

const path = require('path');
const { redactSecrets } = require(path.join(__dirname, '..', 'lib', 'redact'));

const PROVIDER = 'Nasdaq Data Link';
const BASE = 'https://data.nasdaq.com/api/v3';
const DEFAULT_TIMEOUT_MS = 8000;
// Provider error codes look like QEAx01 / QELx04 — anything else is dropped, not echoed.
const PROVIDER_CODE_RE = /^Q[A-Za-z]{2,3}x?\d{2}$/;
const TABLE_CODE_RE = /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/;

// Distinct outcome categories (never conflated):
//   ok | missing_key | auth_failed | rate_limited | timeout | network |
//   malformed_response | provider_outage | bad_response | invalid_table_code |
//   not_entitled | skipped
function categorizeStatus(status, providerCode) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_outage';
  // Nasdaq returns 400 QEAx.. for unrecognized/missing API keys — that is an
  // AUTH failure, not a data problem.
  if (status === 400 && /^QEA/i.test(providerCode || '')) return 'auth_failed';
  return 'bad_response';
}

async function readJsonSafe(response) {
  try {
    return { json: await response.json() };
  } catch {
    return { json: null, malformed: true };
  }
}

// Extract ONLY a pattern-checked provider error code from a body — never the
// message text (it can embed account details).
function safeProviderCode(json) {
  const code = json && json.quandl_error && json.quandl_error.code;
  return (typeof code === 'string' && PROVIDER_CODE_RE.test(code)) ? code : null;
}

async function probeAuth({ apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const report = { provider: PROVIDER, probe: 'auth', configured: Boolean(apiKey), ok: false, httpStatus: null, category: null, responseType: null, rowCount: null };
  if (!apiKey) return { ...report, category: 'missing_key' };

  const url = `${BASE}/datatables/WIKI/PRICES.json?qopts.per_page=1&api_key=${encodeURIComponent(apiKey)}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ...report, category: isTimeout ? 'timeout' : 'network', error: redactSecrets(e && e.message || 'fetch failed') };
  }

  const { json, malformed } = await readJsonSafe(response);
  if (response.ok) {
    if (malformed || !json || typeof json !== 'object') return { ...report, httpStatus: response.status, category: 'malformed_response' };
    const rows = json.datatable && Array.isArray(json.datatable.data) ? json.datatable.data.length : null;
    if (rows === null) return { ...report, httpStatus: response.status, category: 'malformed_response' };
    return { ...report, ok: true, httpStatus: response.status, category: 'ok', responseType: 'datatable', rowCount: rows };
  }
  const providerCode = safeProviderCode(json);
  return { ...report, httpStatus: response.status, category: categorizeStatus(response.status, providerCode), providerCode };
}

async function probeTable({ apiKey, tableCode, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const report = { provider: PROVIDER, probe: 'estimates_table', configured: Boolean(apiKey), ok: false, httpStatus: null, category: null, responseType: null, columns: null, rowCount: null };
  if (!tableCode) return { ...report, category: 'skipped', note: 'NASDAQ_ESTIMATES_TABLE_CODE not set — premium entitlement untested (NOT an API-key failure). Enter the exact table code from your Nasdaq subscription docs into .env.local.' };
  if (!apiKey) return { ...report, category: 'missing_key' };
  if (!TABLE_CODE_RE.test(tableCode)) return { ...report, category: 'invalid_table_code', note: 'table code must look like VENDOR/TABLE' };

  const url = `${BASE}/datatables/${tableCode}/metadata.json?api_key=${encodeURIComponent(apiKey)}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ...report, category: isTimeout ? 'timeout' : 'network', error: redactSecrets(e && e.message || 'fetch failed') };
  }

  const { json, malformed } = await readJsonSafe(response);
  if (response.ok) {
    if (malformed || !json || typeof json !== 'object') return { ...report, httpStatus: response.status, category: 'malformed_response' };
    const cols = json.datatable && Array.isArray(json.datatable.columns)
      ? json.datatable.columns.map(c => c && c.name).filter(n => typeof n === 'string') : null;
    return { ...report, ok: true, httpStatus: response.status, category: 'ok', responseType: 'datatable_metadata', columns: cols };
  }
  const providerCode = safeProviderCode(json);
  if (response.status === 404) return { ...report, httpStatus: 404, category: 'invalid_table_code' };
  const category = categorizeStatus(response.status, providerCode);
  // 403 with a valid key = authenticated but NOT entitled to this table.
  const refined = (category === 'auth_failed' && response.status === 403) ? 'not_entitled' : category;
  return { ...report, httpStatus: response.status, category: refined, providerCode };
}

async function runProbe({ env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = env.NASDAQ_DATA_LINK_API_KEY || '';
  const tableCode = (env.NASDAQ_ESTIMATES_TABLE_CODE || '').trim();
  const auth = await probeAuth({ apiKey, fetchImpl, timeoutMs });
  // Skip the premium probe when auth itself failed — a table 403 would be ambiguous.
  const table = auth.ok || !tableCode
    ? await probeTable({ apiKey, tableCode, fetchImpl, timeoutMs })
    : { provider: PROVIDER, probe: 'estimates_table', configured: Boolean(apiKey), ok: false, category: 'skipped', note: 'auth probe failed — fix auth before testing entitlement' };
  return { configured: Boolean(apiKey), auth, table };
}

module.exports = { runProbe, probeAuth, probeTable, categorizeStatus, PROVIDER };

if (require.main === module) {
  runProbe().then(result => {
    console.log(redactSecrets(JSON.stringify(result, null, 2)));
    const tableFailed = result.table && result.table.category !== 'ok' && result.table.category !== 'skipped';
    process.exitCode = !result.configured ? 2 : (result.auth.ok && !tableFailed ? 0 : 1);
  }).catch(e => {
    console.error(redactSecrets(e && e.message || 'probe crashed'));
    process.exitCode = 1;
  });
}
