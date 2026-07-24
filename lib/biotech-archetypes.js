'use strict';
// 🧬 BIOTECH ARCHETYPE CLASSIFIER (Phase 4) — route each candidate to exactly ONE opportunity
// lane so distinct biotech situations are never ranked as interchangeable. Pure: takes the
// mechanical features, the (possibly null/unverified) event, the deterministic capital state,
// and the AI's catalyst class, and returns a single archetype + the reasons for the routing.
//
// The routing is deliberately SAFETY-FIRST: anything with an unresolved binary inside the
// holding period, an M&A near consideration, or a distress/dilution overhang is pulled out of
// the normal actionable lanes before any continuation/base logic runs. The gates (Phase 6)
// then enforce the honesty ceilings; archetype only decides which lane's features/plan apply.

const { ARCHETYPES: A, CAPITAL_STATES: S } = require('./biotech-config');

const MIN_PREEVENT_SESSIONS = 3;         // need this many sessions to run a pre-event trade w/ exit-before
const POST_CATALYST_MAX_SESSIONS = 10;   // fresh continuation window
const PULLBACK_MIN_DEPTH = -8;           // % off the post-event high to call it a pullback
const BINARY_EVENT_TYPES = new Set(['FDA_DECISION', 'PDUFA', 'TRIAL_READOUT']);

function classifyArchetype(ctx = {}) {
  const f = ctx.features || {};
  const ev = ctx.event || null;
  const cap = ctx.capital || null;
  const aiClass = ctx.aiClass || null;
  const timing = ctx.timing || 'NA';
  const daysToBinary = ctx.daysToBinary;
  const efeat = f.event || null;
  const reasons = [];

  // 1. M&A → always special-situation routing (near consideration value = little remaining upside).
  if (aiClass === 'MA' || (ev && ev.eventType === 'MA')) {
    return { archetype: A.BINARY_WATCH, reasons: ['M&A situation — routed to special situations (limited remaining upside near offer)'] };
  }

  // 2. Running INTO a dated future binary. Tradeable ONLY as a pre-event run-up that exits
  // before the date; if the binary is too close to structure an exit-before, it is a watch.
  if (timing === 'Ahead' && ev && BINARY_EVENT_TYPES.has(ev.eventType)) {
    if (daysToBinary != null && daysToBinary >= MIN_PREEVENT_SESSIONS) {
      return { archetype: A.PRE_EVENT, reasons: [`dated ${ev.eventType} in ~${daysToBinary}d — run-up with a MANDATORY exit before the event`] };
    }
    return { archetype: A.BINARY_WATCH, reasons: ['unresolved binary inside the holding period — no room to exit before it'] };
  }

  // 3. Completed financing → overhang-relief lane (only if price is holding, not broken).
  if (cap && cap.state === S.COMPLETED_FINANCING_RELIEF && (!efeat || efeat.holdsEventLow !== false)) {
    return { archetype: A.FINANCING_RELIEF, reasons: ['completed priced offering — overhang cleared, may now be funded through a catalyst'] };
  }

  // 4. Mechanistic sympathy (needs a defensible read-through; the AI names the leader).
  if (aiClass === 'SYMPATHY') {
    return { archetype: A.SYMPATHY, reasons: ['mechanistic read-through from a verified sector leader'] };
  }

  // 5. Post-catalyst family — a catalyst already out (verified behind, or a mechanical event bar).
  if (efeat) {
    const ss = efeat.sessionsSince;
    const pulledBack = efeat.pullbackDepthPct != null && efeat.pullbackDepthPct <= PULLBACK_MIN_DEPTH
      && (efeat.holdsEventLow === true || f.higherLow === true);
    if (pulledBack && (f.volDryUp == null || f.volDryUp < 1.1)) {
      return { archetype: A.POST_EVENT_PULLBACK, reasons: [`orderly pullback ${efeat.pullbackDepthPct}% off the post-event high, event low holding`] };
    }
    if (ss != null && ss <= POST_CATALYST_MAX_SESSIONS && (efeat.gapRetain1 == null || efeat.gapRetain1 >= 0.88)) {
      return { archetype: A.POST_CATALYST, reasons: [`fresh event (~${ss}d ago), gap retained — repricing continuation`] };
    }
    if (ss != null && ss > POST_CATALYST_MAX_SESSIONS && (f.volContraction != null && f.volContraction < 1)) {
      return { archetype: A.CATALYST_BASE, reasons: [`prior catalyst (~${ss}d ago) + constructive base (contraction ${f.volContraction})`] };
    }
  }

  // 6. Mechanical fallbacks (no identifiable event bar).
  if (f.volContraction != null && f.volContraction < 0.8 && f.aboveSma50 === true) {
    return { archetype: A.CATALYST_BASE, reasons: ['tight base / volatility contraction above the 50-day (breakout setup)'] };
  }
  if ((f.ret5 != null && f.ret5 >= 15) && f.higherHigh === true) {
    return { archetype: A.POST_CATALYST, reasons: ['strong multi-day advance with higher highs (unverified catalyst — capped until confirmed)'] };
  }

  return { archetype: A.UNCLASSIFIED, reasons: ['no defensible archetype — insufficient structure/evidence'] };
}

module.exports = {
  classifyArchetype, MIN_PREEVENT_SESSIONS, POST_CATALYST_MAX_SESSIONS, PULLBACK_MIN_DEPTH, BINARY_EVENT_TYPES,
};
