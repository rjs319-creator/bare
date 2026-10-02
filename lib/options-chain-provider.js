'use strict';
// OPTIONS CHAIN PROVIDER — one interface, env-selected primary with fallback.
//
// Callers keep the functions they already use (`fetchChainResult`, `fetchChainByDate`,
// `fetchChainMultiExpiry`, same shapes as lib/options-baseline.js) and gain
// `fetchFullChain` (every expiry, `chainComplete:true`) for full-chain analytics (GEX).
//
//   OPTIONS_PROVIDER = 'cboe'       DEFAULT — CBOE delayed chain (vendor greeks) first,
//                                   Yahoo nearest-expiry chain as the fallback.
//                      'yahoo'      ROLLBACK — Yahoo only, exactly the pre-CBOE behaviour.
//                      'cboe-only'  CBOE with no fallback (side-by-side comparison runs).
//
// Every result is stamped `provider`, `source`, `greeksSource`, `chainComplete` so the
// observation layer records WHICH feed produced it. A CBOE body holds every expiry, so the
// per-expiry calls are served from the memoized body with no further network.
// Fallback telemetry (`getChainProviderStats`) counts attempts, fallbacks and failures per
// adapter — a silent switch to Yahoo would otherwise look like "greeks disappeared".

const cboeDefault = require('./cboe-chain');
const yahooDefault = require('./options-baseline');

const CHAIN_PROVIDER_ENV = 'OPTIONS_PROVIDER';
const PROVIDER_MODES = Object.freeze(['cboe', 'yahoo', 'cboe-only']);
const DEFAULT_MODE = 'cboe';
const ORDER_BY_MODE = Object.freeze({ cboe: ['cboe', 'yahoo'], yahoo: ['yahoo'], 'cboe-only': ['cboe'] });
const YAHOO_SOURCE = 'yahoo-delayed';
// A CBOE body lists EVERY expiry, so an expiry missing from it is definitively unlisted —
// falling through to Yahoo would only spend a crumb handshake to learn the same thing.
const NOT_LISTED = Symbol('expiry-not-listed');

/** Resolve the configured provider order. Unknown values fall back to the default and are reported. */
function resolveChainProvider(env = process.env) {
  const raw = String(env[CHAIN_PROVIDER_ENV] || '').toLowerCase().trim();
  const mode = PROVIDER_MODES.includes(raw) ? raw : DEFAULT_MODE;
  const misconfigured = raw && !PROVIDER_MODES.includes(raw)
    ? [`${CHAIN_PROVIDER_ENV}='${raw}' is not one of ${PROVIDER_MODES.join('|')} — using '${DEFAULT_MODE}'`]
    : [];
  return { mode, order: ORDER_BY_MODE[mode], primary: ORDER_BY_MODE[mode][0], hasFallback: ORDER_BY_MODE[mode].length > 1, misconfigured };
}

const stampYahoo = (r) => (r ? { ...r, provider: 'yahoo', source: YAHOO_SOURCE, greeksSource: null, chainComplete: false } : null);

// One expiry of a full CBOE result as a Yahoo-shaped single-expiry result.
function expiryView(full, expirationSec) {
  if (!full || !Array.isArray(full.options)) return null;
  const chain = expirationSec == null ? full.options[0] : full.options.find((ch) => ch.expirationDate === expirationSec);
  return chain ? { ...full, options: [chain], chainComplete: false } : null;
}

function multiExpiryView(full, { targets, maxExtra, nowSec }) {
  if (!full || !Array.isArray(full.options) || !full.options[0]) return null;
  const extras = yahooDefault.pickSwingExpiries({
    expirationDates: full.expirationDates, nearestTs: full.options[0].expirationDate, nowSec,
    ...(targets ? { targets } : {}), maxExtra,
  });
  const chains = [full.options[0], ...extras.map((ts) => full.options.find((ch) => ch.expirationDate === ts)).filter(Boolean)];
  return { ...full, options: chains, chainComplete: false };
}

/**
 * Build a provider instance (tests inject adapters/env; production uses the default below).
 * @param {{cboe?:object, yahoo?:object, env?:object, now?:()=>number}} deps
 */
function createChainProvider({ cboe = cboeDefault, yahoo = yahooDefault, env = process.env, now = Date.now } = {}) {
  const stats = { attempts: { cboe: 0, yahoo: 0 }, failures: { cboe: 0, yahoo: 0 }, fallbacks: 0 };

  // Run `attempt(provider)` over the configured order; a null answer or a throw moves on.
  // Returns null when every provider answered null; rethrows the last error only when
  // every provider THREW (so telemetry can say "chain-fetch-error", not "empty chain").
  async function withFallback(attempt) {
    const { order } = resolveChainProvider(env);
    let lastError = null, sawNull = false;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      stats.attempts[id]++;
      try {
        const r = await attempt(id);
        if (r === NOT_LISTED) return null;
        if (r) return r;
        sawNull = true;
      } catch (e) {
        stats.failures[id]++;
        lastError = e;
      }
      if (i < order.length - 1) stats.fallbacks++;
    }
    if (lastError && !sawNull) throw lastError;
    return null;
  }

  const cboeFull = (ticker) => cboe.fetchCboeChain(ticker, { nowMs: now() });

  const fetchFullChain = (ticker) => withFallback(async (id) => (id === 'cboe'
    ? cboeFull(ticker)
    : stampYahoo(await yahoo.fetchChainMultiExpiry(ticker))));

  const fetchChainResult = (ticker) => withFallback(async (id) => (id === 'cboe'
    ? expiryView(await cboeFull(ticker), null)
    : stampYahoo(await yahoo.fetchChainResult(ticker))));

  const fetchChainByDate = (ticker, dateTs) => withFallback(async (id) => {
    if (id !== 'cboe') return stampYahoo(await yahoo.fetchChainByDate(ticker, dateTs));
    const full = await cboeFull(ticker);
    return full ? (expiryView(full, dateTs) || NOT_LISTED) : null;
  });

  const fetchChainMultiExpiry = (ticker, opts = {}) => withFallback(async (id) => (id === 'cboe'
    ? multiExpiryView(await cboeFull(ticker), { ...opts, nowSec: now() / 1000 })
    : stampYahoo(await yahoo.fetchChainMultiExpiry(ticker, opts))));

  return {
    fetchChainResult, fetchChainByDate, fetchChainMultiExpiry, fetchFullChain,
    resolveChainProvider: () => resolveChainProvider(env),
    getStats: () => ({ ...stats, attempts: { ...stats.attempts }, failures: { ...stats.failures } }),
    resetStats: () => { stats.attempts.cboe = stats.attempts.yahoo = 0; stats.failures.cboe = stats.failures.yahoo = 0; stats.fallbacks = 0; },
  };
}

const DEFAULT = createChainProvider();

module.exports = {
  CHAIN_PROVIDER_ENV, PROVIDER_MODES, DEFAULT_MODE, YAHOO_SOURCE,
  resolveChainProvider, createChainProvider,
  fetchChainResult: DEFAULT.fetchChainResult,
  fetchChainByDate: DEFAULT.fetchChainByDate,
  fetchChainMultiExpiry: DEFAULT.fetchChainMultiExpiry,
  fetchFullChain: DEFAULT.fetchFullChain,
  getChainProviderStats: DEFAULT.getStats,
  resetChainProviderStats: DEFAULT.resetStats,
};
