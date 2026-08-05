'use strict';
// SAME-SESSION OUTCOMES — measured from the price the USER COULD ACTUALLY SEE.
//
// This is the module that makes the whole validation layer honest, and it exists because
// almost every way of measuring a screener's performance is wrong in the same direction:
//   • from the previous close  → credits you with the overnight gap you never captured
//   • from the session open    → credits you with a move that happened before detection
//   • from the candle low      → credits you with a fill nobody got
//   • from the breakout bar's open → credits you with the bar you needed to see complete
//   • from a hidden scan timestamp → credits you with a signal that was never displayed
// Every one of those flatters the result. So the fill here is anchored to
// `firstUserVisibleTimestamp` and can only occur on a bar that STARTS AFTER it.
//
// SAME-BAR AMBIGUITY. When the target and the stop both fall inside one five-minute bar and
// no finer data exists, we assume THE STOP CAME FIRST. That is the conservative resolution
// and it is applied silently nowhere — every such event is flagged `sameBarAmbiguous` so the
// share of outcomes decided by the assumption is visible and auditable.

const { FRICTION, SCHEMA_VERSION, CONFIG_VERSION } = require('./lowfloat-config');

const MIN_MS = 60_000;
const finite = v => Number.isFinite(v);

// Slippage tier from the CURRENT session's dollar volume. Conservative by construction: the
// app has no NBBO, so a modeled fill is assumed to have paid for the spread.
function slippageBpsFor(sessionDollarVolume) {
  if (!finite(sessionDollarVolume)) return FRICTION.SLIPPAGE_BPS.VERY_THIN;
  if (sessionDollarVolume >= FRICTION.DEEP_SESSION_DOLLAR_VOL) return FRICTION.SLIPPAGE_BPS.DEEP;
  if (sessionDollarVolume >= FRICTION.NORMAL_SESSION_DOLLAR_VOL) return FRICTION.SLIPPAGE_BPS.NORMAL;
  if (sessionDollarVolume >= FRICTION.THIN_SESSION_DOLLAR_VOL) return FRICTION.SLIPPAGE_BPS.THIN;
  return FRICTION.SLIPPAGE_BPS.VERY_THIN;
}

// ── EVENT CONSTRUCTION ───────────────────────────────────────────────────────
// Called at the moment a candidate becomes PAPER_ENTRY_ELIGIBLE (or LIVE_VALIDATED_ENTRY).
// Records the full point-in-time state so the outcome can be resolved later without any
// re-derivation that could leak hindsight.
function buildEntryEvent({
  ticker, sessionDate, signalTimestamp, firstUserVisibleTimestamp, providerTimestamp,
  lastCompletedBarTimestamp, entryTemplate, entryReferencePrice, trigger, structuralStop,
  target1, target2, minutesUntilClose, barResolution = 5, sessionDollarVolume = null,
  actionState = null, explosionPotentialScore = null, tradeQualityScore = null,
  structureState = null, floatTier = null, floatShares = null, catalystTier = null,
  dilutionRisk = null, sessionWindow = null, discoverySources = null, firstDetectedAt = null,
  configurationVersion = CONFIG_VERSION,
} = {}) {
  const visible = firstUserVisibleTimestamp || signalTimestamp;
  const slippageBps = slippageBpsFor(sessionDollarVolume);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `${sessionDate}|${ticker}|${entryTemplate}|${visible}`,
    ticker, sessionDate,
    signalTimestamp,
    firstUserVisibleTimestamp: visible,
    providerTimestamp: providerTimestamp || null,
    lastCompletedBarTimestamp: lastCompletedBarTimestamp || null,
    entryTemplate,
    entryReferencePrice: finite(entryReferencePrice) ? +entryReferencePrice.toFixed(4) : null,
    // The simulated fill is NOT set here. It is resolved against the first bar that STARTS
    // after the signal became visible (see resolveEntryEvent), because that is the earliest
    // price a person reading the screen could have transacted at.
    simulatedFillPrice: null,
    simulatedFillAt: null,
    trigger: finite(trigger) ? +trigger.toFixed(4) : null,
    structuralStop: finite(structuralStop) ? +structuralStop.toFixed(4) : null,
    target1: finite(target1) ? +target1.toFixed(4) : null,
    target2: finite(target2) ? +target2.toFixed(4) : null,
    minutesUntilClose,
    barResolution,
    spreadAssumption: 'no NBBO available — the modeled fill pays the slippage tier below',
    slippageAssumptionBps: slippageBps,
    commissionBps: FRICTION.COMMISSION_BPS,
    configurationVersion,
    // Context carried for the audit and for cohort slicing during validation.
    actionState, explosionPotentialScore, tradeQualityScore, structureState,
    floatTier, floatShares, catalystTier, dilutionRisk, sessionWindow,
    discoverySources, firstDetectedAt,
    sessionDollarVolume,
    resolved: false,
  };
}

// ── FILL RESOLUTION ──────────────────────────────────────────────────────────
// The fill bar is the first COMPLETED bar whose START is at/after the instant the signal
// became user-visible. The fill price is that bar's OPEN plus slippage — you cannot fill at a
// price printed before you could see the signal.
function findFillBar(bars, visibleIso) {
  const vis = Date.parse(visibleIso);
  if (!Number.isFinite(vis)) return null;
  for (const b of bars || []) {
    if (Date.parse(b.t) >= vis) return b;
  }
  return null;
}

// Walk bars forward from the fill, resolving every horizon and the target/stop race.
function resolveEntryEvent(event, bars, { now = new Date() } = {}) {
  const all = Array.isArray(bars) ? bars : [];
  const fillBar = findFillBar(all, event.firstUserVisibleTimestamp);
  if (!fillBar) {
    return { ...event, resolved: false, unresolvableReason: 'no bar starts at or after the signal became visible' };
  }
  const slip = 1 + (event.slippageAssumptionBps || 0) / 10_000;
  const fill = +(fillBar.o * slip).toFixed(4);
  const fillMs = Date.parse(fillBar.t);
  const after = all.filter(b => Date.parse(b.t) >= fillMs);

  // Returns at each horizon, measured from the SIMULATED FILL.
  const retAt = mins => {
    const cutoff = fillMs + mins * MIN_MS;
    let ref = null;
    for (const b of after) { if (Date.parse(b.t) <= cutoff) ref = b; else break; }
    return ref && fill > 0 ? +(((ref.c / fill) - 1) * 100).toFixed(3) : null;
  };
  const lastBar = after.length ? after[after.length - 1] : fillBar;
  const returnToClose = fill > 0 ? +(((lastBar.c / fill) - 1) * 100).toFixed(3) : null;

  // Excursions.
  const excursion = mins => {
    const cutoff = fillMs + mins * MIN_MS;
    const win = after.filter(b => Date.parse(b.t) <= cutoff);
    if (!win.length) return { mfe: null, mae: null };
    const hi = Math.max(...win.map(b => b.h));
    const lo = Math.min(...win.map(b => b.l));
    return {
      mfe: +(((hi / fill) - 1) * 100).toFixed(3),
      mae: +(((lo / fill) - 1) * 100).toFixed(3),
    };
  };
  const ex30 = excursion(30), ex60 = excursion(60);

  // TARGET-BEFORE-STOP race, at several R/percentage levels. The SAME-BAR rule applies at
  // every level and is flagged wherever it decided the answer.
  const race = (targetPrice, stopPrice, withinMin) => {
    const cutoff = withinMin == null ? Infinity : fillMs + withinMin * MIN_MS;
    let ambiguous = false;
    for (const b of after) {
      if (Date.parse(b.t) > cutoff) break;
      const hitTarget = b.h >= targetPrice;
      const hitStop = b.l <= stopPrice;
      if (hitTarget && hitStop) {
        // Both inside one bar and no finer data exists → assume the STOP came first.
        ambiguous = true;
        return { hit: false, ambiguous, at: b.t, minutes: Math.round((Date.parse(b.t) - fillMs) / MIN_MS) };
      }
      if (hitStop) return { hit: false, ambiguous, at: b.t, minutes: Math.round((Date.parse(b.t) - fillMs) / MIN_MS) };
      if (hitTarget) return { hit: true, ambiguous, at: b.t, minutes: Math.round((Date.parse(b.t) - fillMs) / MIN_MS) };
    }
    return { hit: null, ambiguous, at: null, minutes: null };
  };

  const t2 = race(fill * 1.02, fill * 0.99, 30);
  const t3 = race(fill * 1.03, fill * 0.985, 60);
  const t5 = race(fill * 1.05, fill * 0.975, null);

  // Plan-relative resolution: the event's own target1 / structuralStop.
  const planStop = finite(event.structuralStop) ? event.structuralStop : fill * 0.97;
  const planTarget = finite(event.target1) ? event.target1 : fill * 1.03;
  const planRace = race(planTarget, planStop, null);
  const riskPerShare = fill - planStop;
  // Realized R: target hit → the plan's R multiple; stop hit → −1R; neither → mark to close.
  const rMultiple = riskPerShare > 0
    ? (planRace.hit === true ? +(((planTarget - fill) / riskPerShare)).toFixed(3)
      : planRace.hit === false ? -1
      : +(((lastBar.c - fill) / riskPerShare)).toFixed(3))
    : null;

  const dayHighAfter = after.length ? Math.max(...after.map(b => b.h)) : null;
  const preFillHigh = all.filter(b => Date.parse(b.t) < fillMs).reduce((m, b) => Math.max(m, b.h), -Infinity);

  return {
    ...event,
    resolved: true,
    resolvedAt: new Date(now).toISOString(),
    simulatedFillPrice: fill,
    simulatedFillAt: fillBar.t,
    fillBasis: 'open of the first completed bar starting at/after the signal became user-visible, plus the slippage tier',
    barsAfterFill: after.length,
    return5m: retAt(5), return15m: retAt(15), return30m: retAt(30), return60m: retAt(60),
    returnToClose,
    maximumFavorableExcursion30m: ex30.mfe, maximumFavorableExcursion60m: ex60.mfe,
    maximumAdverseExcursion30m: ex30.mae, maximumAdverseExcursion60m: ex60.mae,
    target2BeforeStop30m: t2.hit, target3BeforeStop60m: t3.hit, target5BeforeStopClose: t5.hit,
    highOfDayBroken: finite(preFillHigh) && finite(dayHighAfter) ? dayHighAfter > preFillHigh : null,
    target1Hit: planRace.hit === true,
    target2Hit: finite(event.target2) ? after.some(b => b.h >= event.target2) : null,
    invalidationHit: planRace.hit === false,
    targetHitBeforeInvalidation: planRace.hit,
    minutesToTarget: planRace.hit === true ? planRace.minutes : null,
    minutesToStop: planRace.hit === false ? planRace.minutes : null,
    rMultiple,
    // AUDIT: how many of this event's verdicts were decided by the conservative same-bar rule.
    sameBarAmbiguous: !!(t2.ambiguous || t3.ambiguous || t5.ambiguous || planRace.ambiguous),
    sameBarRule: 'when target and stop fall in the same five-minute bar and no finer data exists, the STOP is assumed to have come first',
  };
}

// Resolve a whole day's events against a bar map { ticker: bars[] }.
function resolveDay(events, barsByTicker, { now = new Date() } = {}) {
  const out = [];
  let resolved = 0, unresolved = 0, ambiguous = 0;
  for (const e of events || []) {
    if (e.resolved) { out.push(e); resolved++; continue; }
    const bars = barsByTicker[e.ticker];
    if (!bars || !bars.length) { out.push({ ...e, unresolvableReason: 'no bars available' }); unresolved++; continue; }
    const r = resolveEntryEvent(e, bars, { now });
    out.push(r);
    if (r.resolved) { resolved++; if (r.sameBarAmbiguous) ambiguous++; } else unresolved++;
  }
  return {
    events: out,
    summary: {
      total: (events || []).length, resolved, unresolved,
      sameBarAmbiguous: ambiguous,
      ambiguousShare: resolved ? +((ambiguous / resolved) * 100).toFixed(1) : null,
      note: ambiguous
        ? `${ambiguous} of ${resolved} resolved outcomes had a target and stop inside the same five-minute bar and were decided by the conservative stop-first rule.`
        : null,
    },
  };
}

module.exports = {
  slippageBpsFor, buildEntryEvent, findFillBar, resolveEntryEvent, resolveDay,
};
