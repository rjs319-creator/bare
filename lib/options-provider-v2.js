'use strict';
// OPTIONS PROVIDER ADAPTER v2 — one interface, multiple capability tiers.
//
// The ACTIVE provider today is the free delayed Yahoo chain (source mode
// DELAYED_CHAIN) — the app must keep working with it and needs no paid feed.
// Real-time consolidated trades/quotes (REALTIME_TRADE_QUOTE) and complex-order
// (COMPLEX_ORDER) adapters plug in later PURELY through environment
// configuration; until an adapter is configured the resolver reports those
// capabilities as absent and NOTHING may fabricate their evidence.
//
//   OPTIONS_REALTIME_PROVIDER — set to a registered adapter id to enable
//     synchronized trade/NBBO interpretation (none registered yet).
//   OPTIONS_COMPLEX_PROVIDER  — same for linked-leg complex orders.
//
// fetchTickerObservation() wraps the chain fetch with the telemetry the health
// layer requires: latency, expiries requested vs returned, failure reason.
// Provider failure is ALWAYS recorded — never converted into "no activity".

const { fetchChainResult, fetchChainByDate } = require('./options-baseline');
const { planExpiries } = require('./options-universe-v2');
const { SOURCE_MODE, SOURCE_MODE_LABEL, UNIVERSE } = require('./options-config-v2');

// Registered real-time / complex adapters. Deliberately empty: entries appear as
// integrations land (each must implement { fetchTrades, capabilities }).
const REALTIME_ADAPTERS = Object.freeze({});
const COMPLEX_ADAPTERS = Object.freeze({});

function resolveSourceMode(env = process.env) {
  const rt = env.OPTIONS_REALTIME_PROVIDER;
  const cx = env.OPTIONS_COMPLEX_PROVIDER;
  if (cx && COMPLEX_ADAPTERS[cx]) return SOURCE_MODE.COMPLEX_ORDER;
  if (rt && REALTIME_ADAPTERS[rt]) return SOURCE_MODE.REALTIME_TRADE_QUOTE;
  return SOURCE_MODE.DELAYED_CHAIN;
}

// Capability disclosure attached to every payload — what the active feed CAN and
// CANNOT support. The UI derives its labels from this, never from wishful copy.
function capabilities(env = process.env) {
  const mode = resolveSourceMode(env);
  const misconfigured = [];
  if (env.OPTIONS_REALTIME_PROVIDER && !REALTIME_ADAPTERS[env.OPTIONS_REALTIME_PROVIDER]) {
    misconfigured.push(`OPTIONS_REALTIME_PROVIDER='${env.OPTIONS_REALTIME_PROVIDER}' is not a registered adapter — falling back to delayed chains`);
  }
  if (env.OPTIONS_COMPLEX_PROVIDER && !COMPLEX_ADAPTERS[env.OPTIONS_COMPLEX_PROVIDER]) {
    misconfigured.push(`OPTIONS_COMPLEX_PROVIDER='${env.OPTIONS_COMPLEX_PROVIDER}' is not a registered adapter — falling back`);
  }
  return {
    sourceMode: mode,
    sourceModeLabel: SOURCE_MODE_LABEL[mode],
    dataDelayed: mode === SOURCE_MODE.DELAYED_CHAIN,
    canSeeAggressorSide: mode !== SOURCE_MODE.DELAYED_CHAIN,
    canSeeLinkedLegs: mode === SOURCE_MODE.COMPLEX_ORDER,
    canSeeIntradayTape: mode !== SOURCE_MODE.DELAYED_CHAIN,
    misconfigured,
  };
}

/**
 * Fetch one ticker's (multi-expiry, DTE-bucket-planned) chain with telemetry.
 * Returns { result, telemetry } — result is null on failure and telemetry.failure
 * says why; the caller MUST record the failure in coverage diagnostics.
 */
async function fetchTickerObservation(ticker, { maxExtra = UNIVERSE.maxExpiryFetches, nowMs = Date.now() } = {}) {
  const t0 = Date.now();
  const telemetry = { ticker, expiriesRequested: 1, expiriesReturned: 0, latencyMs: null, failure: null };
  let base;
  try {
    base = await fetchChainResult(ticker);
  } catch (e) {
    telemetry.failure = `chain-fetch-error: ${e && e.message ? e.message : String(e)}`;
    telemetry.latencyMs = Date.now() - t0;
    return { result: null, telemetry };
  }
  if (!base || !Array.isArray(base.options) || !base.options[0]) {
    telemetry.failure = base ? 'empty-chain' : 'no-chain-response';
    telemetry.latencyMs = Date.now() - t0;
    return { result: null, telemetry };
  }
  telemetry.expiriesReturned = 1;

  const plan = planExpiries({
    expirationDates: Array.isArray(base.expirationDates) ? base.expirationDates : [],
    nearestTs: base.options[0].expirationDate || null,
    nowSec: nowMs / 1000,
    maxExtra,
  });
  telemetry.expiriesRequested = 1 + plan.extraExpiries.length;
  telemetry.bucketCoverage = plan.buckets;
  for (const ts of plan.extraExpiries) {
    try {
      const r = await fetchChainByDate(ticker, ts);
      const chain = r && r.options && r.options[0];
      if (chain) { base.options.push(chain); telemetry.expiriesReturned++; }
    } catch { /* recorded via requested-vs-returned gap */ }
  }
  telemetry.latencyMs = Date.now() - t0;
  return { result: base, telemetry };
}

module.exports = { resolveSourceMode, capabilities, fetchTickerObservation, REALTIME_ADAPTERS, COMPLEX_ADAPTERS };
