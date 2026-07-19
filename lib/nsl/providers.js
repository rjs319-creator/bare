'use strict';
// NOVEL SIGNAL LAB — provider registry & availability resolution (nsl-v1).
//
// Declares every external data source the nine engines could use, its licensing
// class, and whether THIS deployment can lawfully reach it right now. Availability
// is resolved from the process environment (which API keys exist) plus a small set
// of known-free public sources (SEC, FINRA) that need no key. Nothing here fabricates
// data — it only reports what is reachable, so an engine can honestly emit UNAVAILABLE.
//
// `kind`:
//   'free'      — public, no key, lawful to use (SEC EDGAR/XBRL/FTD, FINRA short interest)
//   'keyed'     — reachable only if an env API key is present (Finnhub/FMP tiers we hold)
//   'licensed'  — requires a paid data licence this deployment does NOT hold (Ortex/S3
//                 borrow, bond/CDS pricing, alt-data panels). Always UNAVAILABLE here.
// Pure except for reading process.env at call time.

const env = (k) => {
  const v = process.env[k];
  return typeof v === 'string' && v.trim().length > 0;
};

// The provider catalogue. `available()` returns a boolean; `note` explains a false.
const PROVIDERS = Object.freeze({
  // ── free public sources (no key) ──────────────────────────────────────────
  finra_si:      { kind: 'free', label: 'FINRA consolidated short interest', source: 'api.finra.org', available: () => true },
  sec_ftd:       { kind: 'free', label: 'SEC fails-to-deliver files',        source: 'sec.gov/cgi-bin/browse-edgar', available: () => true },
  sec_form4:     { kind: 'free', label: 'SEC EDGAR Form 4 (insider)',        source: 'data.sec.gov',   available: () => true },
  sec_xbrl:      { kind: 'free', label: 'SEC XBRL company facts',            source: 'data.sec.gov/api/xbrl', available: () => true },
  dividend_cal:  { kind: 'free', label: 'Dividend / ex-date calendar (Yahoo)', source: 'query1.finance.yahoo.com', available: () => true },

  // ── keyed sources we already hold ─────────────────────────────────────────
  ipo_lockup:    { kind: 'keyed', label: 'IPO calendar → 180d lockup (FMP/Finnhub)', source: 'financialmodelingprep.com', envKey: 'FMP_API_KEY',
                   available: () => env('FMP_API_KEY') || env('FINNHUB_API_KEY') },
  fundamentals:  { kind: 'keyed', label: 'Finnhub fundamentals', source: 'finnhub.io', envKey: 'FINNHUB_API_KEY', available: () => env('FINNHUB_API_KEY') },

  // ── licensed sources we do NOT hold → always UNAVAILABLE ──────────────────
  borrow_fee:    { kind: 'licensed', label: 'Securities-lending borrow fee / utilization', source: 'Ortex / S3 / IBKR', available: () => false,
                   note: 'requires a securities-lending data licence (Ortex/S3/IBKR); not held' },
  index_recon:   { kind: 'licensed', label: 'Index reconstitution schedule & weights', source: 'index provider', available: () => false,
                   note: 'index add/delete/weight schedules require an index-data licence' },
  buyback_window:{ kind: 'licensed', label: 'Estimated buyback execution windows', source: 'proprietary', available: () => false,
                   note: 'buyback blackout/execution windows are not lawfully derivable from free data' },
  jobs_feed:     { kind: 'licensed', label: 'Company job-posting panel', source: 'Revelio / LinkUp / Thinknum', available: () => false,
                   note: 'job-posting panels are licensed alt-data' },
  app_rank:      { kind: 'licensed', label: 'App download / ranking estimates', source: 'data.ai / Sensor Tower', available: () => false,
                   note: 'app-store analytics are licensed alt-data' },
  web_traffic:   { kind: 'licensed', label: 'Website traffic & engagement', source: 'Similarweb', available: () => false,
                   note: 'web-traffic panels are licensed alt-data' },
  bond_spread:   { kind: 'licensed', label: 'Corporate bond spreads', source: 'TRACE/ICE', available: () => false,
                   note: 'issuer-level bond pricing requires a fixed-income data licence' },
  cds_spread:    { kind: 'licensed', label: 'Credit-default-swap spreads', source: 'Markit', available: () => false,
                   note: 'single-name CDS pricing is licensed' },
  credit_rating: { kind: 'licensed', label: 'Credit-rating actions', source: 'S&P/Moody\'s/Fitch', available: () => false,
                   note: 'rating actions require a ratings-data licence' },
});

function providerStatus(id) {
  const p = PROVIDERS[id];
  if (!p) return { id, exists: false, available: false, kind: null, note: 'unknown provider' };
  let available = false;
  try { available = !!p.available(); } catch { available = false; }
  return { id, exists: true, available, kind: p.kind, label: p.label, source: p.source, note: available ? null : (p.note || (p.envKey ? `missing env ${p.envKey}` : 'unavailable')) };
}

// For a signal-registry entry, resolve provider statuses and an overall availability.
// A signal is USABLE if AT LEAST ONE of its providers is available (engines degrade
// gracefully, using whatever real data is present and marking the rest as gaps);
// engines with NO providers (twin/invariance/representation) are handled by the engine.
function resolveSignal(meta) {
  const providers = (meta.providers || []).map(providerStatus);
  const anyAvailable = providers.some(p => p.available);
  const allAvailable = providers.length > 0 && providers.every(p => p.available);
  return { providers, anyAvailable, allAvailable };
}

module.exports = { PROVIDERS, providerStatus, resolveSignal };
