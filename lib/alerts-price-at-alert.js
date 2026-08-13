'use strict';
// IMMUTABLE PRICE-AT-ALERT — captured once, at ingest, with provenance.
//
// THE P0 DEFECT THIS REPLACES: episodes carried `execRef` (the "decision-time underlying"),
// but nothing on the ingest path ever set it — `buildLeads` produced no `execRef`, so
// `foldEpisodes` always stored `null`. Every decision card therefore rendered
// "priceAtAlert: null" and `moveSinceAlertPct: null`: the app could not say how much of
// the move had already been consumed, which is the single most important guard against
// chasing. Worse, any later "fix" that stamped a CURRENT price onto an OLD episode would
// silently backfill history and manufacture a flattering record.
//
// The contract:
//   • A capture requires a price AND a provider quote timestamp AND a market session AND
//     a source. Missing any of those ⇒ UNAVAILABLE with a reason, never a server-time stamp.
//   • Once CAPTURED, the record is immutable: `mergePriceAtAlert` refuses to overwrite it.
//   • Episodes created before this module exists are reported LEGACY_NOT_CAPTURED and are
//     NEVER backfilled — the UI shows the gap instead of inventing a number.
//
// Pure; the clock and the quote are injected.

const STATE = Object.freeze({
  CAPTURED: 'CAPTURED',
  UNAVAILABLE: 'UNAVAILABLE',
  LEGACY_NOT_CAPTURED: 'LEGACY_NOT_CAPTURED',
});

const MAX_QUOTE_AGE_MIN = 30;   // a quote older than this is not the "price at alert"
const VERSION = 'alerts-price-at-alert-v1';

const unavailable = reason => ({
  version: VERSION, state: STATE.UNAVAILABLE,
  price: null, quoteAsOf: null, quoteAgeSec: null, marketSession: null, source: null,
  capturedAt: null, reason,
});

/**
 * Capture the immutable alert-time price for one ticker. Pure.
 *
 * @param {object} p
 * @param {string} p.ticker
 * @param {object} p.quote        a lib/quote-provider row: { price, asOf, ... }
 * @param {string} p.source       provider id the quote came from (e.g. 'yahoo-quote')
 * @param {object} p.sessionInfo  lib/market-session sessionInfoAt(now) — { marketSession }
 * @param {number|Date} p.now
 * @returns {object} price-at-alert record (CAPTURED or UNAVAILABLE — never a guess)
 */
function capturePriceAtAlert({ ticker = null, quote = null, source = null, sessionInfo = null, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!quote || quote.price == null || !Number.isFinite(+quote.price)) {
    return unavailable(`no quote returned for ${ticker || 'this ticker'} at alert time — alert price not captured`);
  }
  if (!quote.asOf) {
    // Deliberately fail closed: stamping server time would fabricate provenance.
    return unavailable('provider quote carried no timestamp — an unverifiable price is not captured as the alert price');
  }
  const quoteMs = Date.parse(quote.asOf);
  if (Number.isNaN(quoteMs)) return unavailable('provider quote timestamp is unparseable — alert price not captured');
  const ageSec = Math.max(0, Math.round((nowMs - quoteMs) / 1000));
  if (ageSec > MAX_QUOTE_AGE_MIN * 60) {
    return unavailable(`the newest available quote is ${Math.round(ageSec / 60)} min old (limit ${MAX_QUOTE_AGE_MIN} min) — not recorded as the alert price`);
  }
  const session = sessionInfo && sessionInfo.marketSession ? sessionInfo.marketSession : null;
  if (!session) return unavailable('market session unknown at capture time — alert price not captured');
  if (!source) return unavailable('no quote source identified — alert price not captured');

  return {
    version: VERSION,
    state: STATE.CAPTURED,
    price: +(+quote.price).toFixed(4),
    quoteAsOf: new Date(quoteMs).toISOString(),
    quoteAgeSec: ageSec,
    marketSession: session,
    source,
    capturedAt: new Date(nowMs).toISOString(),
    reason: null,
  };
}

/**
 * Immutability guard. An already-CAPTURED record is returned unchanged; a fresh capture
 * only fills a genuinely empty or UNAVAILABLE slot. Pure — returns a new object.
 */
function mergePriceAtAlert(existing, fresh) {
  if (existing && existing.state === STATE.CAPTURED) return { ...existing };
  if (fresh && fresh.state === STATE.CAPTURED) return { ...fresh };
  return existing ? { ...existing } : (fresh ? { ...fresh } : null);
}

/**
 * Read the alert price off an episode for display/decision use. Pure.
 * Legacy episodes (no capture record) are reported as such and NEVER backfilled.
 */
function readPriceAtAlert(episode) {
  const ep = episode || {};
  if (ep.priceAtAlert && ep.priceAtAlert.state) return { ...ep.priceAtAlert };
  // Pre-capture episodes: `execRef` was the intended slot but was never populated on the
  // ingest path. If a historical value exists, surface it WITHOUT provenance rather than
  // pretending it was a timestamped capture.
  if (ep.execRef != null && Number.isFinite(+ep.execRef)) {
    return {
      version: VERSION, state: STATE.LEGACY_NOT_CAPTURED,
      price: +ep.execRef, quoteAsOf: null, quoteAgeSec: null,
      marketSession: null, source: 'legacy-execRef', capturedAt: null,
      reason: 'Legacy episode: a price exists but carries no quote timestamp, session, or source — treated as unverified.',
    };
  }
  return {
    version: VERSION, state: STATE.LEGACY_NOT_CAPTURED,
    price: null, quoteAsOf: null, quoteAgeSec: null, marketSession: null, source: null, capturedAt: null,
    reason: 'This episode predates immutable alert-price capture. It is NOT backfilled — move-since-alert is unavailable.',
  };
}

/** Move consumed since the alert, side-signed. Null whenever either leg is unavailable. */
function moveSinceAlert(priceAtAlertRecord, priceNow, side) {
  const rec = priceAtAlertRecord || {};
  if (rec.price == null || priceNow == null || !Number.isFinite(+priceNow) || rec.price === 0) {
    return { movePct: null, consumedPct: null, available: false, reason: rec.reason || 'no alert price to compare against' };
  }
  const movePct = +(((+priceNow - rec.price) / rec.price) * 100).toFixed(2);
  const dir = side === 'short' ? -1 : 1;
  return {
    movePct,
    consumedPct: +(dir * movePct).toFixed(2),   // positive = the thesis already paid out pre-entry
    available: true,
    verified: rec.state === STATE.CAPTURED,
    reason: rec.state === STATE.CAPTURED ? null : rec.reason,
  };
}

module.exports = {
  STATE, VERSION, MAX_QUOTE_AGE_MIN,
  capturePriceAtAlert, mergePriceAtAlert, readPriceAtAlert, moveSinceAlert,
};
