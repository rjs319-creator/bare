'use strict';
// ELIGIBLE TRADABLE UNIVERSE — every US exchange-listed COMMON STOCK the app is willing to
// discover a same-session mover in, with an explicit, counted reason for every exclusion.
//
// SOURCE OF TRUTH: the NASDAQ Trader symbol directory (keyless, authoritative, refreshed
// daily by the exchanges) — already parsed by lib/universe-expand.js, which this module
// REUSES rather than duplicating. What this module adds on top:
//   • a securityType classification (COMMON / ETF / FUND / WARRANT / RIGHT / UNIT /
//     PREFERRED / NOTE / TEST / SPAC_UNIT / OTHER) instead of a boolean keep/drop,
//   • optional metadata enrichment (sector, industry, market cap, price, isActivelyTrading)
//     from the FMP company-screener when a key is configured — enrichment NEVER decides
//     eligibility, so a metadata outage shrinks detail, not coverage,
//   • persistence + a coverage report so "full-market coverage" is a measured claim.
//
// EXPLICITLY NOT AN EXCLUSION REASON: low historical average volume, tiny market cap, or
// absence from a curated static list. A dormant micro-cap that gets a catalyst tomorrow must
// already be in this universe today, or the app cannot possibly discover it.

const { parseListed, fetchUniverseSources } = require('./universe-expand');
const { UNIVERSE_VERSION } = require('./lowfloat-config');
const { readUniverse, writeUniverse, hasStore } = require('./lowfloat-store');
const { fetchWithTimeout } = require('./http');

// Financial-status codes that mean deficient / delinquent / bankrupt / suspended.
const BAD_FIN_STATUS = new Set(['D', 'E', 'G', 'H', 'J', 'K', 'Q']);

// NYSE American trades under the 'A' exchange code in otherlisted.txt; NYSE Arca ('P'),
// CBOE BZX ('Z') and IEX ('V') list ETFs and structured products, not operating companies.
const SUPPORTED_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const EXCHANGE_CODE_MAP = { N: 'NYSE', A: 'AMEX', P: 'NYSE Arca', Z: 'CBOE BZX', V: 'IEXG' };

// Security-name classifiers, most specific first. Order matters: "Units" beats "Warrants"
// for a SPAC unit whose name mentions both.
const TYPE_PATTERNS = [
  { type: 'UNIT', rx: /\b(units?)\b/i },
  { type: 'WARRANT', rx: /\bwarrants?\b/i },
  { type: 'RIGHT', rx: /\brights?\b/i },
  { type: 'PREFERRED', rx: /\b(preferred|pfd|depositary shares?)\b/i },
  { type: 'NOTE', rx: /\b(notes?|debentures?|subordinated|bonds?)\b/i },
  { type: 'ETN', rx: /\betn\b|\bexchange[- ]traded notes?\b/i },
  { type: 'FUND', rx: /\b(etf|etv|fund|trust|portfolio|index)\b/i },
];

// Closed-end funds are OPT-IN (spec: "unless intentionally supported"). Default: excluded.
const SUPPORT_CLOSED_END_FUNDS = false;

// A quotable common-stock symbol: 1-5 letters, no class/when-issued punctuation. Symbols
// carrying '.', '$', '=' or '-' are preferreds, when-issued lines, warrants and units that
// the quote providers key differently — they are excluded as NONSTANDARD_SYMBOL, counted.
const QUOTABLE_SYMBOL = /^[A-Z]{1,5}$/;

// ── Pure classification ──────────────────────────────────────────────────────
// Returns { eligible, securityType, exclusionReason }. Pure — no network, no state — so the
// whole eligibility policy is unit-testable against fixture rows.
function classifySecurity(row) {
  const symbol = String(row && row.symbol || '').trim().toUpperCase();
  const name = String(row && row.name || '');

  if (!symbol) return { eligible: false, securityType: 'OTHER', exclusionReason: 'MISSING_SYMBOL' };
  if (row.testIssue === 'Y') return { eligible: false, securityType: 'TEST', exclusionReason: 'TEST_SECURITY' };
  if (!QUOTABLE_SYMBOL.test(symbol)) return { eligible: false, securityType: 'OTHER', exclusionReason: 'NONSTANDARD_SYMBOL' };
  if (row.etf === 'Y') return { eligible: false, securityType: 'ETF', exclusionReason: 'ETF' };

  const exchange = row.exchange || null;
  if (exchange && !SUPPORTED_EXCHANGES.has(exchange)) {
    return { eligible: false, securityType: 'OTHER', exclusionReason: 'UNSUPPORTED_EXCHANGE' };
  }
  if (BAD_FIN_STATUS.has(row.finStatus)) {
    return { eligible: false, securityType: 'COMMON', exclusionReason: 'NOT_ACTIVELY_TRADING' };
  }
  // "5.50% Series A" style names are rate securities (preferreds / notes) regardless of the
  // word used, and the '%' is the reliable tell.
  if (name.includes('%')) return { eligible: false, securityType: 'PREFERRED', exclusionReason: 'RATE_SECURITY' };

  for (const p of TYPE_PATTERNS) {
    if (p.rx.test(name)) {
      if (p.type === 'FUND' && SUPPORT_CLOSED_END_FUNDS) break;
      return { eligible: false, securityType: p.type, exclusionReason: p.type };
    }
  }
  // A blank-check / acquisition-corp COMMON share (not the unit) is still a SPAC shell whose
  // "moves" are redemption mechanics, not demand — excluded, but typed so the audit can tell
  // a SPAC miss from a real one.
  if (/\b(acquisition corp|acquisition co|blank check)\b/i.test(name)) {
    return { eligible: false, securityType: 'SPAC', exclusionReason: 'SPAC' };
  }
  return { eligible: true, securityType: 'COMMON', exclusionReason: null };
}

// Merge + dedupe raw directory rows into the eligible universe plus a counted exclusion map.
// Duplicate symbols across the two directory files keep the FIRST eligible occurrence.
function buildUniverseFromRows(rows, { now = new Date() } = {}) {
  const universeAsOf = new Date(now).toISOString();
  const eligible = [];
  const excludedByReason = {};
  const typeCounts = {};
  const seen = new Set();
  let total = 0;

  for (const row of rows || []) {
    const symbol = String(row && row.symbol || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    total++;
    const c = classifySecurity(row);
    typeCounts[c.securityType] = (typeCounts[c.securityType] || 0) + 1;
    if (!c.eligible) {
      excludedByReason[c.exclusionReason] = (excludedByReason[c.exclusionReason] || 0) + 1;
      continue;
    }
    eligible.push({
      symbol,
      securityType: c.securityType,
      exchange: row.exchange || null,
      company: String(row.name || '').trim() || null,
      sector: null,
      industry: null,
      marketCap: null,
      price: null,
      isActivelyTrading: true,     // directory presence + clean financial status; refined by enrichment
      universeAsOf,
      metadataSource: 'nasdaq-trader-symbol-directory',
    });
  }
  return { eligible, excludedByReason, typeCounts, totalReceived: total, universeAsOf };
}

// ── FMP company-screener metadata enrichment (OPTIONAL) ──────────────────────
// Adds sector / industry / marketCap / price / isActivelyTrading where the provider knows
// the name. A provider failure is REPORTED, never fatal: eligibility is already decided.
async function fetchScreenerMetadata({ timeoutMs = 12000 } = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { rows: [], available: false, error: 'FMP_API_KEY not configured' };
  const url = `https://financialmodelingprep.com/stable/company-screener`
    + `?country=US&isEtf=false&isFund=false&limit=10000&apikey=${key}`;
  try {
    const r = await fetchWithTimeout(url, { timeoutMs });
    if (!r.ok) return { rows: [], available: false, error: `FMP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j)) return { rows: [], available: false, error: 'unexpected shape' };
    return { rows: j, available: true, error: null };
  } catch (e) {
    return { rows: [], available: false, error: String((e && e.message) || e) };
  }
}

// Pure: fold provider rows onto the eligible list. Never adds or removes a security.
function applyMetadata(eligible, providerRows) {
  const byTicker = new Map();
  for (const r of providerRows || []) {
    if (r && r.symbol) byTicker.set(String(r.symbol).toUpperCase(), r);
  }
  let enriched = 0, delisted = 0;
  const out = eligible.map(e => {
    const m = byTicker.get(e.symbol);
    if (!m) return e;
    enriched++;
    // isActivelyTrading===false is the provider asserting the line no longer trades. That IS
    // an eligibility signal (the spec excludes securities no longer actively trading), so it
    // is applied — but counted separately so the audit can see it.
    const active = m.isActivelyTrading === false ? false : true;
    if (!active) delisted++;
    return {
      ...e,
      sector: m.sector || e.sector,
      industry: m.industry || e.industry,
      marketCap: Number.isFinite(m.marketCap) ? m.marketCap : e.marketCap,
      price: Number.isFinite(m.price) ? m.price : e.price,
      exchange: m.exchangeShortName || e.exchange,
      company: m.companyName || e.company,
      isActivelyTrading: active,
      metadataSource: 'nasdaq-trader+fmp-company-screener',
    };
  });
  return { enriched, delisted, rows: out };
}

// ── Build + persist ──────────────────────────────────────────────────────────
async function buildTradableUniverse({ now = new Date(), enrich = true } = {}) {
  const t0 = Date.now();
  const providerFailures = [];
  let rows = [];
  try {
    rows = await fetchUniverseSources();
  } catch (e) {
    providerFailures.push({ provider: 'nasdaq-trader', error: String((e && e.message) || e) });
  }

  const built = buildUniverseFromRows(rows, { now });
  let securities = built.eligible;
  let metadata = { available: false, enriched: 0, delisted: 0, error: null };

  if (enrich && securities.length) {
    const meta = await fetchScreenerMetadata();
    if (!meta.available) {
      providerFailures.push({ provider: 'fmp-company-screener', error: meta.error });
    } else {
      const applied = applyMetadata(securities, meta.rows);
      securities = applied.rows;
      metadata = { available: true, enriched: applied.enriched, delisted: applied.delisted, error: null };
    }
  }

  // Securities the provider says are no longer trading leave the eligible set, counted.
  const stillActive = securities.filter(s => s.isActivelyTrading !== false);
  const inactiveDropped = securities.length - stillActive.length;
  const excludedByReason = { ...built.excludedByReason };
  if (inactiveDropped) excludedByReason.NOT_ACTIVELY_TRADING = (excludedByReason.NOT_ACTIVELY_TRADING || 0) + inactiveDropped;

  const doc = {
    schema: UNIVERSE_VERSION,
    universeAsOf: built.universeAsOf,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    securities: stillActive,
    coverage: buildCoverageReport({
      totalReceived: built.totalReceived,
      eligible: stillActive,
      excludedByReason,
      typeCounts: built.typeCounts,
      metadata,
      providerFailures,
    }),
  };
  return doc;
}

// The honest coverage report. `commonStockCoveragePct` is deliberately expressed against the
// count of directory lines we CLASSIFIED as common stock — not against an outside estimate of
// the US market — because that is the only denominator this data source can support.
function buildCoverageReport({ totalReceived, eligible, excludedByReason, typeCounts, metadata, providerFailures }) {
  const commonClassified = typeCounts.COMMON || 0;
  const byExchange = {};
  for (const s of eligible) byExchange[s.exchange || 'UNKNOWN'] = (byExchange[s.exchange || 'UNKNOWN'] || 0) + 1;
  const metadataAgeNote = metadata.available
    ? `Sector/market-cap metadata from the FMP company-screener as of this build (${metadata.enriched} of ${eligible.length} matched).`
    : 'Sector/market-cap metadata UNAVAILABLE this build — eligibility is unaffected, but float-tier context and cap bands will be sparser.';
  return {
    totalSecuritiesReceived: totalReceived,
    totalEligible: eligible.length,
    exclusionsByReason: excludedByReason,
    securityTypeCounts: typeCounts,
    byExchange,
    metadataAvailable: metadata.available,
    metadataEnriched: metadata.enriched,
    metadataNote: metadataAgeNote,
    providerFailures,
    // "Percentage of eligible US common stocks covered" — 100% of what the exchange directory
    // reported as common stock and that survived the type filters, or a smaller number when
    // the directory fetch itself partially failed.
    commonStockCoveragePct: commonClassified > 0
      ? +((eligible.length / commonClassified) * 100).toFixed(1)
      : null,
    claimsFullMarketCoverage: providerFailures.length === 0 && eligible.length > 2000,
    coverageCaveat: providerFailures.length
      ? 'Provider failures occurred during this build — do NOT read this as full-market coverage.'
      : (eligible.length > 2000
        ? 'Directory-complete: every exchange-listed common stock the NASDAQ Trader directory reported.'
        : 'Eligible count is below the expected full-market range — treat coverage as partial.'),
  };
}

// Load the persisted universe, rebuilding when it is missing or from a prior day. The
// universe refreshes at least daily BEFORE the open; a caller during the session gets the
// pre-open build, which is exactly the point-in-time set the discovery ran against.
async function loadTradableUniverse({ now = new Date(), maxAgeHours = 20, forceRebuild = false } = {}) {
  if (!forceRebuild && hasStore()) {
    const cached = await readUniverse().catch(() => null);
    if (cached && cached.schema === UNIVERSE_VERSION && Array.isArray(cached.securities) && cached.securities.length) {
      const ageH = (new Date(now).getTime() - Date.parse(cached.builtAt || cached.universeAsOf)) / 3_600_000;
      if (Number.isFinite(ageH) && ageH >= 0 && ageH <= maxAgeHours) return { ...cached, fromCache: true, ageHours: +ageH.toFixed(2) };
    }
  }
  const built = await buildTradableUniverse({ now });
  if (hasStore() && built.securities.length) {
    try { await writeUniverse(built); } catch { /* non-durable this run; next build retries */ }
  }
  return { ...built, fromCache: false, ageHours: 0 };
}

module.exports = {
  SUPPORTED_EXCHANGES, EXCHANGE_CODE_MAP, BAD_FIN_STATUS, QUOTABLE_SYMBOL, TYPE_PATTERNS,
  classifySecurity, buildUniverseFromRows, applyMetadata, buildCoverageReport,
  fetchScreenerMetadata, buildTradableUniverse, loadTradableUniverse,
  parseListed,
};
