'use strict';
// OPTIONS OBSERVATIONS v2 — immutable point-in-time records of what the provider
// actually returned, per ticker, per scan. These docs are the raw material for the
// ticker-relative baselines (lib/options-anomaly-v2) and next-session OI
// confirmation; they are WRITTEN ONCE per decision session and never rewritten with
// later information.
//
// Two levels per ticker:
//   • aggregates — side × DTE-bucket totals (volume, est. notional, OI, active
//     contracts, ATM IV, an OTM put-vs-call skew proxy). Small enough to keep for
//     EVERY scanned ticker every session — that is what makes baselines possible.
//   • contracts — the top rows by est. notional (bounded), used for per-contract
//     anomaly detail and cross-session OI confirmation via the OCC symbol.
//
// Also carries per-ticker fetch telemetry (expiries requested vs returned, failure
// reasons, latency) so provider failure is never silently converted into "normal".
//
// Pure: chain results are passed in; the clock/session context is injected.

const { dteBucketV2, DTE_BUCKETS_V2, SOURCE_MODE } = require('./options-config-v2');
// Concentration statistics live in options-execution-v2 so the FULL-CHAIN tally built
// here and the retained-rows path there can never drift apart.
const { concentrationFromTally } = require('./options-execution-v2');

const CONTRACT_MULT = 100;
const MAX_CONTRACTS_PER_TICKER = 12;
const ATM_BAND = 0.03;       // |strike-spot|/spot ≤ 3% = ATM for IV purposes
const OTM_SKEW_BAND = [0.03, 0.15]; // 3–15% OTM wings for the skew proxy
const IV_MIN = 0.05, IV_MAX = 5;    // reject degenerate chain IVs

const r2 = v => (v == null ? null : +(+v).toFixed(2));
const r4 = v => (v == null ? null : +(+v).toFixed(4));

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function estNotionalOf(c) {
  const px = c.lastPrice != null ? c.lastPrice : (c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : c.ask);
  return (c.volume || 0) * (px || 0) * CONTRACT_MULT;
}

function usableIv(iv) {
  return iv != null && Number.isFinite(iv) && iv >= IV_MIN && iv <= IV_MAX;
}

// One normalized per-contract row from a raw Yahoo chain contract.
function contractRow(c, side, underlying, nowMs) {
  const dte = c.expiration ? Math.max(0, Math.round((c.expiration * 1000 - nowMs) / 86_400_000)) : null;
  return {
    contractSymbol: c.contractSymbol || null,
    side,
    strike: r2(c.strike),
    expiry: c.expiration ? new Date(c.expiration * 1000).toISOString().slice(0, 10) : null,
    dte,
    dteBucket: dteBucketV2(dte),
    bid: r2(c.bid), ask: r2(c.ask), lastPrice: r2(c.lastPrice),
    volume: c.volume || 0,
    openInterest: c.openInterest || 0,
    iv: usableIv(c.impliedVolatility) ? r4(c.impliedVolatility) : null,
    lastTradeTs: c.lastTradeDate || null,
    estNotional: Math.round(estNotionalOf(c)),
    underlying: r2(underlying),
  };
}

// Aggregate one ticker's chains into side × DTE-bucket totals + IV structure.
function aggregateTicker(chains, underlying, nowMs) {
  const byBucket = {};
  for (const b of DTE_BUCKETS_V2) {
    byBucket[b.key] = {
      callVol: 0, putVol: 0, callNotional: 0, putNotional: 0,
      callOI: 0, putOI: 0, activeContracts: 0, atmIV: null,
      activeStrikes: 0,
    };
  }
  const atmIvs = {}, activeStrikes = {};
  const skewPutIvs = [], skewCallIvs = [];
  let contractsInspected = 0;
  // FULL-CHAIN strike tally. Built here, during the walk that already visits every
  // contract, because the stored `contracts` array is truncated to the top
  // MAX_CONTRACTS_PER_TICKER by notional — concentration measured over THAT is an
  // artifact of the display cut, not a property of the chain. Only the derived summary
  // is persisted (a handful of numbers), never the full tally.
  const fullChainStrikeVol = new Map();

  for (const chain of chains) {
    if (!chain) continue;
    for (const [side, list] of [['call', chain.calls || []], ['put', chain.puts || []]]) {
      for (const c of list) {
        contractsInspected++;
        const dte = c.expiration ? Math.max(0, Math.round((c.expiration * 1000 - nowMs) / 86_400_000)) : null;
        const bk = dteBucketV2(dte);
        if (!bk || !byBucket[bk]) continue;
        const agg = byBucket[bk];
        const vol = c.volume || 0;
        const notional = estNotionalOf(c);
        if (side === 'call') { agg.callVol += vol; agg.callNotional += notional; agg.callOI += c.openInterest || 0; }
        else { agg.putVol += vol; agg.putNotional += notional; agg.putOI += c.openInterest || 0; }
        if (vol > 0) {
          agg.activeContracts++;
          (activeStrikes[bk] ??= new Set()).add(`${side}:${c.strike}`);
          const sk = `${side}|${c.strike}`;
          fullChainStrikeVol.set(sk, (fullChainStrikeVol.get(sk) || 0) + vol);
        }
        if (underlying > 0 && c.strike != null && usableIv(c.impliedVolatility)) {
          const m = (c.strike - underlying) / underlying;
          if (Math.abs(m) <= ATM_BAND) (atmIvs[bk] ??= []).push(c.impliedVolatility);
          // Skew wings measured on the swing buckets only (where the read matters).
          if (bk === '21-45' || bk === '8-20') {
            if (side === 'put' && -m >= OTM_SKEW_BAND[0] && -m <= OTM_SKEW_BAND[1]) skewPutIvs.push(c.impliedVolatility);
            if (side === 'call' && m >= OTM_SKEW_BAND[0] && m <= OTM_SKEW_BAND[1]) skewCallIvs.push(c.impliedVolatility);
          }
        }
      }
    }
  }
  for (const bk of Object.keys(byBucket)) {
    const agg = byBucket[bk];
    agg.callNotional = Math.round(agg.callNotional);
    agg.putNotional = Math.round(agg.putNotional);
    agg.atmIV = atmIvs[bk] ? r4(median(atmIvs[bk])) : null;
    agg.activeStrikes = activeStrikes[bk] ? activeStrikes[bk].size : 0;
  }
  const putIv = median(skewPutIvs), callIv = median(skewCallIvs);
  return {
    byBucket,
    contractsInspected,
    // Exact over every contract walked above, not over the retained rows.
    strikeConcentration: concentrationFromTally(fullChainStrikeVol, { basis: 'FULL_CHAIN' }),
    skew: putIv != null && callIv != null ? r4(putIv - callIv) : null,   // >0 = puts richer (classic fear skew)
    // Term structure proxy: near ATM IV minus swing ATM IV (>0 = event/near-term stress).
    termSlope: byBucket['0-7'].atmIV != null && byBucket['21-45'].atmIV != null
      ? r4(byBucket['0-7'].atmIV - byBucket['21-45'].atmIV) : null,
  };
}

/**
 * Build one ticker's immutable observation from a (possibly multi-expiry) Yahoo
 * chain result. `ctx` injects the clock + session so nothing here reads Date.now().
 *
 * @param {string} ticker
 * @param {object|null} result Yahoo optionChain.result[0] (quote + options[])
 * @param {{nowMs:number, session:string, sessionFraction:number|null, sourceMode?:string,
 *          expiriesRequested?:number, expiriesReturned?:number, latencyMs?:number,
 *          failure?:string|null, source?:string}} ctx
 */
function observeTicker(ticker, result, ctx = {}) {
  const nowMs = ctx.nowMs != null ? ctx.nowMs : 0;
  const base = {
    ticker: String(ticker).toUpperCase(),
    session: ctx.session || null,
    observedAt: new Date(nowMs).toISOString(),
    sourceMode: ctx.sourceMode || SOURCE_MODE.DELAYED_CHAIN,
    universeSource: ctx.source || null,
    sessionFraction: ctx.sessionFraction != null ? +(+ctx.sessionFraction).toFixed(3) : null,
    expiriesRequested: ctx.expiriesRequested ?? null,
    expiriesReturned: ctx.expiriesReturned ?? null,
    latencyMs: ctx.latencyMs ?? null,
  };
  if (!result || !Array.isArray(result.options) || !result.options.length) {
    return { ...base, ok: false, failure: ctx.failure || 'no-chain', contracts: [], aggregates: null };
  }
  const q = result.quote || {};
  const underlying = q.regularMarketPrice != null ? q.regularMarketPrice : null;
  const undVolume = q.regularMarketVolume != null ? q.regularMarketVolume : null;
  const agg = aggregateTicker(result.options, underlying, nowMs);

  // Bounded per-contract detail: top rows by estimated notional with any volume.
  const rows = [];
  for (const chain of result.options) {
    if (!chain) continue;
    for (const [side, list] of [['call', chain.calls || []], ['put', chain.puts || []]]) {
      for (const c of list) if ((c.volume || 0) > 0) rows.push(contractRow(c, side, underlying, nowMs));
    }
  }
  rows.sort((a, b) => b.estNotional - a.estNotional);

  return {
    ...base,
    ok: true,
    failure: null,
    underlying: r2(underlying),
    underlyingChangePct: q.regularMarketChangePercent != null ? r2(q.regularMarketChangePercent) : null,
    underlyingVolume: undVolume,
    underlyingDollarVolume: underlying != null && undVolume != null ? Math.round(underlying * undVolume) : null,
    providerTimestamp: q.regularMarketTime || null,
    delayedByMin: q.exchangeDataDelayedBy != null ? q.exchangeDataDelayedBy : null,
    aggregates: {
      byBucket: agg.byBucket, skew: agg.skew, termSlope: agg.termSlope,
      // Derived over the FULL chain above; `contracts` below is truncated, so this is the
      // only concentration figure that is a property of the chain rather than the cut.
      strikeConcentration: agg.strikeConcentration,
    },
    contractsInspected: agg.contractsInspected,
    contracts: rows.slice(0, MAX_CONTRACTS_PER_TICKER),
  };
}

// Total option volume / notional across buckets for one observation (convenience).
function totals(obs) {
  const out = { vol: 0, notional: 0, callVol: 0, putVol: 0, callNotional: 0, putNotional: 0 };
  const byBucket = obs && obs.aggregates && obs.aggregates.byBucket;
  if (!byBucket) return out;
  for (const bk of Object.keys(byBucket)) {
    const a = byBucket[bk];
    out.callVol += a.callVol; out.putVol += a.putVol;
    out.callNotional += a.callNotional; out.putNotional += a.putNotional;
  }
  out.vol = out.callVol + out.putVol;
  out.notional = out.callNotional + out.putNotional;
  return out;
}

module.exports = {
  observeTicker, aggregateTicker, contractRow, totals, estNotionalOf, median,
  MAX_CONTRACTS_PER_TICKER,
};
