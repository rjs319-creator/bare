'use strict';
// 📡 MARKET PULSE v2 — HORIZON-SPECIFIC VIEWS + THE ACTIONABILITY CONTRACT.
//
// Three views with INDEPENDENT clocks and decision policies:
//   • DAY   — needs fresh regular-session data; narrative alone can never arm it.
//   • SWING — daily structure (lib/stock-setup) first; narrative supports or contradicts,
//             it cannot conjure chart structure that does not exist.
//   • INVESTOR — thesis-impact classification; never ranked by social buzz.
//
// Every candidate answers the actionability contract (what happened / verified? /
// price since discovery / horizon / what must happen / trigger / invalidation /
// extension / event risk / missing data / why-not-actionable). A narrative alone can
// NEVER produce PRICE_CONFIRMED — that state requires a fired price trigger on fresh
// data with participation.
//
// Pure: pre-fetched inputs in → view models out.

const { isDirectional } = require('./pulse2-direction');

const TRADE_STATES = Object.freeze([
  'CONTEXT_ONLY', 'INVESTIGATE', 'WATCH', 'ARMED', 'PRICE_CONFIRMED',
  'CONTRADICTED', 'INVALIDATED', 'EXPIRED', 'DATA_STALE',
]);

const THESIS_CLASSES = Object.freeze([
  'THESIS_POSITIVE', 'THESIS_NEGATIVE', 'SENTIMENT_ONLY', 'TRANSITORY',
  'STRUCTURAL', 'ALREADY_PRICED', 'INSUFFICIENT_EVIDENCE',
]);

// Which event families plausibly transmit to a multi-month thesis vs a passing trade.
const STRUCTURAL_FAMILIES = new Set(['earnings', 'guidance', 'regulatory', 'fda-clinical', 'merger-acquisition', 'industry-supply-chain', 'financing']);
const SENTIMENT_FAMILIES = new Set(['positioning-sentiment']);

const T = Object.freeze({
  EXTENDED_ATR: 2.5,
  DAY_MIN_RELVOL: 1.3,          // same-time-of-day participation to confirm/arm
  DAY_TIME_STOP_MIN: 120,       // minutes an unfired day setup stays armed
  SWING_MAX_ENTRY_ATR: 2.0,     // beyond this, a swing entry is chase
  ALREADY_PRICED_PCT: 12,       // move since detection that likely prices a thesis
});

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const verifiedEnough = ev => ev === 'VERIFIED' || ev === 'SUPPORTED';

/** The actionability contract — every candidate carries this, complete. Pure. */
function contract({
  whatHappened, verified, priceSinceDetectionPct, horizon, tradeState,
  whatMustHappen, trigger, invalidation, extended, eventRisk, missingData,
  notActionableReason,
} = {}) {
  return {
    whatHappened: whatHappened || null,
    verified: verified || 'UNVERIFIED',
    priceSinceDetectionPct: round(priceSinceDetectionPct),
    horizon: horizon || null,
    tradeState: tradeState || 'CONTEXT_ONLY',
    whatMustHappen: whatMustHappen || null,
    trigger: trigger ?? null,
    invalidation: invalidation ?? null,
    extended: extended === true,
    eventRisk: eventRisk || null,
    missingData: missingData || [],
    notActionableReason: notActionableReason || null,
  };
}

// ── DAY TRADE VIEW ──────────────────────────────────────────────────────────
/**
 * Day-trade decision for one (event, ticker). Pure.
 * A candidate REQUIRES: fresh regular-session data, a directional thesis, a credible
 * catalyst (or explicitly-labeled market-state setup), an independent price trigger,
 * participation, acceptable extension, and a complete risk plan.
 *
 * @param {object} p
 * @param {object} p.event      ledger event
 * @param {string} p.ticker
 * @param {object|null} p.features  buildIntradayFeatures() output for the ticker
 * @param {object} p.reactionInfo   { reaction, why } from assessReaction
 * @param {boolean} p.executionAllowed  from central session service (fresh REGULAR data)
 * @param {string} p.sessionState
 */
function dayTradeDecision({ event, ticker, features, reactionInfo, executionAllowed, sessionState } = {}) {
  const dir = event.currentDirection || event.firstSeenDirection || 'UNKNOWN';
  const evd = event.evidence || 'UNVERIFIED';
  const missing = [];
  const mk = (state, extra = {}) => ({
    view: 'day', eventId: event.id, ticker, headline: event.headline,
    direction: dir, evidence: evd,
    reaction: reactionInfo ? reactionInfo.reaction : 'INSUFFICIENT_DATA',
    tradeState: state,
    ...extra,
  });

  if (event.invalidated) return mk('INVALIDATED', { contract: contract({ whatHappened: event.claim, verified: evd, tradeState: 'INVALIDATED', notActionableReason: 'catalyst denied or corrected' }) });

  if (!executionAllowed) {
    const reason = sessionState === 'regular'
      ? 'intraday data stale — no immediately-actionable read'
      : `market session is ${sessionState || 'closed'} — day-trade signals need live regular-session data`;
    return mk(sessionState === 'regular' ? 'DATA_STALE' : 'CONTEXT_ONLY', {
      contract: contract({ whatHappened: event.claim, verified: evd, horizon: 'intraday', tradeState: sessionState === 'regular' ? 'DATA_STALE' : 'CONTEXT_ONLY', notActionableReason: reason, missingData: ['fresh regular-session bars'] }),
    });
  }
  if (!isDirectional(dir)) {
    return mk('CONTEXT_ONLY', { contract: contract({ whatHappened: event.claim, verified: evd, horizon: 'intraday', tradeState: 'CONTEXT_ONLY', notActionableReason: 'no directional thesis — mixed/unknown narratives stay context' }) });
  }
  if (!verifiedEnough(evd)) {
    return mk('INVESTIGATE', { contract: contract({ whatHappened: event.claim, verified: evd, horizon: 'intraday', tradeState: 'INVESTIGATE', whatMustHappen: 'independent confirmation of the catalyst', notActionableReason: 'catalyst not yet credibly verified', missingData: ['verified source'] }) });
  }
  if (!features || !features.hasIntraday) {
    return mk('DATA_STALE', { contract: contract({ whatHappened: event.claim, verified: evd, horizon: 'intraday', tradeState: 'DATA_STALE', notActionableReason: 'no intraday features for this ticker', missingData: ['intraday bars'] }) });
  }

  const long = dir === 'BULLISH';
  const or = features.openingRange;
  const vwap = features.vwap;
  const trigger = or && features.orComplete ? (long ? or.high : or.low) : null;
  const invalidation = or && features.orComplete ? (long ? Math.min(or.low, vwap ?? or.low) : Math.max(or.high, vwap ?? or.high)) : vwap;
  const last = features.last ? features.last.c : null;
  const relVol = features.timeOfDayRelVol;
  const participation = relVol != null && relVol >= T.DAY_MIN_RELVOL;
  const ext = features.extensionAtr;
  const extended = ext != null && Math.abs(ext) >= T.EXTENDED_ATR && (ext > 0) === long;
  const reaction = reactionInfo ? reactionInfo.reaction : 'INSUFFICIENT_DATA';
  const price = round(features.dayChangePct);

  const base = {
    trigger: round(trigger), invalidation: round(invalidation),
    entryBasis: 'break of trigger with participation',
    timeStopMinutes: T.DAY_TIME_STOP_MIN,
    vsVWAPPct: round(features.vwapDist != null ? features.vwapDist * 100 : null),
    sameTimeRelVol: relVol,
    chaseAtr: round(ext),
    rr: (trigger != null && invalidation != null && trigger !== invalidation)
      ? round(Math.abs(trigger - invalidation) > 0 ? 2 : null) : null,   // 2R framework target
  };

  if (reaction === 'CONTRADICTED' || reaction === 'FAILED') {
    return mk('CONTRADICTED', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: price, horizon: 'intraday', tradeState: 'CONTRADICTED', notActionableReason: 'price is moving against the thesis', trigger: base.trigger, invalidation: base.invalidation }) });
  }
  if (extended || reaction === 'EXTENDED') {
    return mk('WATCH', { ...base, chase: true, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: price, horizon: 'intraday', tradeState: 'WATCH', extended: true, whatMustHappen: 'a pullback or base — chasing here is poor risk/reward', trigger: base.trigger, invalidation: base.invalidation, notActionableReason: 'already extended' }) });
  }
  const triggerFired = trigger != null && last != null && (long ? last > trigger : last < trigger);
  if (triggerFired && participation) {
    return mk('PRICE_CONFIRMED', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: price, horizon: 'intraday', tradeState: 'PRICE_CONFIRMED', whatMustHappen: 'manage risk against the invalidation level', trigger: base.trigger, invalidation: base.invalidation }) });
  }
  if (trigger != null && participation) {
    return mk('ARMED', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: price, horizon: 'intraday', tradeState: 'ARMED', whatMustHappen: `${long ? 'break above' : 'break below'} ${round(trigger)} on sustained volume`, trigger: base.trigger, invalidation: base.invalidation }) });
  }
  return mk('WATCH', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: price, horizon: 'intraday', tradeState: 'WATCH', whatMustHappen: participation ? 'a defined trigger (opening range still forming)' : 'participation — same-time-of-day volume is below normal', trigger: base.trigger, invalidation: base.invalidation, missingData: participation ? [] : ['participation'] }) });
}

// ── SWING VIEW ──────────────────────────────────────────────────────────────
/**
 * Swing decision for one (event, ticker): daily structure decides; narrative
 * supports/contradicts. Pure.
 * @param {object} p.setup   lib/stock-setup evaluateSetup(candles) result (or null)
 * @param {object} p.enrichment  daily enrichment { dayReturn, ret3, atrExt, relVol }
 */
function swingDecision({ event, ticker, setup, enrichment } = {}) {
  const dir = event.currentDirection || event.firstSeenDirection || 'UNKNOWN';
  const evd = event.evidence || 'UNVERIFIED';
  const mk = (state, extra = {}) => ({
    view: 'swing', eventId: event.id, ticker, headline: event.headline,
    direction: dir, evidence: evd, tradeState: state, ...extra,
  });
  if (event.invalidated) return mk('INVALIDATED', { contract: contract({ whatHappened: event.claim, verified: evd, tradeState: 'INVALIDATED', notActionableReason: 'catalyst denied or corrected' }) });
  if (!isDirectional(dir)) return mk('CONTEXT_ONLY', { contract: contract({ whatHappened: event.claim, verified: evd, horizon: '3-21 sessions', tradeState: 'CONTEXT_ONLY', notActionableReason: 'no directional thesis' }) });
  if (!setup || setup.valid !== true) {
    return mk('INVESTIGATE', {
      setupNote: setup ? setup.reason : 'no setup evaluation',
      contract: contract({ whatHappened: event.claim, verified: evd, horizon: '3-21 sessions', tradeState: 'INVESTIGATE', whatMustHappen: 'a clean daily structure to trade against — none exists today', notActionableReason: 'narrative without chart structure is research, not a setup', missingData: setup ? [] : ['daily candles'] }),
    });
  }
  const wantLong = dir === 'BULLISH';
  const setupLong = setup.direction === 'long';
  if (wantLong !== setupLong) {
    return mk('CONTRADICTED', {
      contract: contract({ whatHappened: event.claim, verified: evd, horizon: '3-21 sessions', tradeState: 'CONTRADICTED', notActionableReason: `narrative is ${dir.toLowerCase()} but the daily chart structure is ${setup.direction} — evidence and price disagree`, trigger: setup.trigger, invalidation: setup.invalidation }),
    });
  }
  const ext = enrichment && enrichment.atrExt != null ? enrichment.atrExt : null;
  const extended = ext != null && Math.abs(ext) >= T.SWING_MAX_ENTRY_ATR && (ext > 0) === wantLong;
  const base = {
    trigger: setup.trigger, invalidation: setup.invalidation, target: setup.target,
    rr: setup.rr, quality: setup.quality, chaseAtr: round(ext),
    evidenceSupport: verifiedEnough(evd) ? 'price + verified narrative' : 'price-only (narrative unverified)',
  };
  if (extended) {
    return mk('WATCH', { ...base, chase: true, contract: contract({ whatHappened: event.claim, verified: evd, horizon: '3-21 sessions', tradeState: 'WATCH', extended: true, whatMustHappen: 'a pullback toward the base — entry here is chase', trigger: setup.trigger, invalidation: setup.invalidation, notActionableReason: 'extended above its mean' }) });
  }
  const spot = setup.spot;
  const fired = spot != null && setup.trigger != null && (wantLong ? spot > setup.trigger : spot < setup.trigger);
  const dailyPartic = enrichment && enrichment.relVol != null && enrichment.relVol >= 1.3;
  if (fired && dailyPartic) {
    return mk('PRICE_CONFIRMED', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: enrichment ? enrichment.ret3 : null, horizon: '3-21 sessions', tradeState: 'PRICE_CONFIRMED', whatMustHappen: 'manage against invalidation; time-stop if momentum stalls', trigger: setup.trigger, invalidation: setup.invalidation }) });
  }
  if (fired) {
    return mk('ARMED', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: enrichment ? enrichment.ret3 : null, horizon: '3-21 sessions', tradeState: 'ARMED', whatMustHappen: 'volume confirmation — the break is there but participation is not', trigger: setup.trigger, invalidation: setup.invalidation, missingData: ['daily participation'] }) });
  }
  return mk('WATCH', { ...base, contract: contract({ whatHappened: event.claim, verified: evd, priceSinceDetectionPct: enrichment ? enrichment.ret3 : null, horizon: '3-21 sessions', tradeState: 'WATCH', whatMustHappen: `${wantLong ? 'a break above' : 'a break below'} ${setup.trigger} on expanding volume`, trigger: setup.trigger, invalidation: setup.invalidation }) });
}

// ── INVESTOR VIEW ───────────────────────────────────────────────────────────
/** Thesis-impact classification for the weeks-to-months lens. Pure. */
function investorClassification({ event, enrichment } = {}) {
  const evd = event.evidence || 'UNVERIFIED';
  const dir = event.currentDirection || event.firstSeenDirection || 'UNKNOWN';
  if (!verifiedEnough(evd)) return SENTIMENT_FAMILIES.has(event.family) ? 'SENTIMENT_ONLY' : 'INSUFFICIENT_EVIDENCE';
  if (SENTIMENT_FAMILIES.has(event.family)) return 'SENTIMENT_ONLY';
  const moved = enrichment && enrichment.ret3 != null ? Math.abs(enrichment.ret3) : null;
  if (moved != null && moved >= T.ALREADY_PRICED_PCT) return 'ALREADY_PRICED';
  if (!STRUCTURAL_FAMILIES.has(event.family)) return 'TRANSITORY';
  if (dir === 'BULLISH') return 'THESIS_POSITIVE';
  if (dir === 'BEARISH') return 'THESIS_NEGATIVE';
  return 'STRUCTURAL';
}

function investorDecision({ event, ticker, enrichment } = {}) {
  const cls = investorClassification({ event, enrichment });
  const evd = event.evidence || 'UNVERIFIED';
  const actionable = cls === 'THESIS_POSITIVE' || cls === 'THESIS_NEGATIVE';
  return {
    view: 'investor', eventId: event.id, ticker, headline: event.headline,
    direction: event.currentDirection || 'UNKNOWN', evidence: evd,
    thesisClass: cls,
    tradeState: actionable ? 'INVESTIGATE' : 'CONTEXT_ONLY',
    horizonSessions: [21, 63],
    contract: contract({
      whatHappened: event.claim, verified: evd,
      priceSinceDetectionPct: enrichment ? enrichment.ret3 : null,
      horizon: '21-63 sessions',
      tradeState: actionable ? 'INVESTIGATE' : 'CONTEXT_ONLY',
      whatMustHappen: actionable ? 'confirm the thesis change in filings/guidance before positioning' : null,
      notActionableReason: actionable ? null
        : cls === 'SENTIMENT_ONLY' ? 'social attention alone is not an investment signal'
        : cls === 'ALREADY_PRICED' ? 'the market has likely already priced this'
        : cls === 'TRANSITORY' ? 'unlikely to alter a multi-month thesis'
        : 'insufficient verified evidence',
    }),
  };
}

module.exports = {
  TRADE_STATES, THESIS_CLASSES, STRUCTURAL_FAMILIES, SENTIMENT_FAMILIES, T,
  contract, dayTradeDecision, swingDecision, investorClassification, investorDecision,
};
