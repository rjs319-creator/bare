'use strict';
// PATTERN CONFIRMATION — professional two-path confirmation, honest two-concept output.
//
// Two SEPARATE paths (a swing setup must not require a live intraday feed):
//   • technicalStatusDaily    — the completed daily bar vs the episode's FROZEN levels
//                               (daily-close confirmation → next-session execution)
//   • technicalStatusIntraday — a live intraday snapshot (VWAP, relative volume, session)
//                               for same-session confirmation
//
// Two SEPARATE concepts, never blended:
//   1. technicalStatus            — what the chart DID (trigger crossed, held, closed…)
//   2. recommendationEligibility  — whether this family×direction×timeframe has enough
//                                   independently VALIDATED edge to issue an actionable
//                                   recommendation. Fails closed: no artifact → research
//                                   only, no matter how good the chart looks.

const ST = require('./structure');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// ---- shared plan math ----------------------------------------------------------

// Remaining reward:risk from the CURRENT price against frozen levels — the number that
// decides whether a late entry still makes sense.
function remainingRR(price, { trigger, stop, target, direction }) {
  if (![price, stop, target].every(isNum)) return null;
  const long = direction !== 'SHORT';
  const reward = long ? target - price : price - target;
  const risk = long ? price - stop : stop - price;
  if (risk <= 0) return null; // already through the stop — no valid trade
  if (reward <= 0) return 0;
  return round(reward / risk, 2);
}

function levelsOf(episode) {
  return {
    trigger: episode.frozen.trigger.price,
    stop: isNum(episode.current.invalidation) ? episode.current.invalidation : episode.frozen.invalidation.price,
    target: isNum(episode.current.target) ? episode.current.target : episode.frozen.target.price,
    direction: episode.direction,
    atr: episode.frozen.atr,
  };
}

// ---- daily-close path ----------------------------------------------------------

// bar: the completed daily bar. volumeContext: { avgVolume } (trailing average, optional).
function technicalStatusDaily(episode, bar, { avgVolume = null } = {}) {
  if (!episode || !bar) return null;
  const L = levelsOf(episode);
  const atr = isNum(L.atr) && L.atr > 0 ? L.atr : Math.max(1e-6, (bar.high - bar.low) || 1);
  const vsTrigger = ST.assessBarVsLevel(bar, L.trigger, L.direction, atr);
  const vsStop = ST.assessBarVsLevel(bar, L.stop, L.direction === 'SHORT' ? 'LONG' : 'SHORT', atr);
  const relVol = isNum(avgVolume) && avgVolume > 0 && isNum(bar.volume) ? round(bar.volume / avgVolume, 2) : null;
  const rr = remainingRR(bar.close, L);
  const triggered = !!(vsTrigger && vsTrigger.closedThrough);
  return {
    path: 'daily-close',
    asOf: bar.date || null,
    triggered,
    penetration: vsTrigger ? (vsTrigger.closedThrough ? 'close' : vsTrigger.penetrated ? 'intraday' : 'none') : 'none',
    gapThroughTrigger: !!(vsTrigger && vsTrigger.gapThrough),
    invalidated: !!(vsStop && vsStop.closedThrough),
    invalidationPenetrated: !!(vsStop && vsStop.penetrated),
    relVol,
    volumeOk: relVol == null ? null : relVol >= 1.2,
    remainingRR: rr,
    remainingRROk: rr == null ? null : rr >= 1,
    extensionAtr: vsTrigger ? vsTrigger.distanceAtr : null,
    executionIntent: triggered ? 'next-session' : 'none',
  };
}

// ---- intraday path -------------------------------------------------------------

// Reduce raw intraday bars ({t,o,h,l,c,v} or daily-shape) to the live snapshot the
// confirmation needs. Pure — the fetch lives in the route.
function summarizeIntraday(bars = []) {
  const xs = (bars || [])
    .map(b => ({ h: b.high ?? b.h, l: b.low ?? b.l, c: b.close ?? b.c, v: b.volume ?? b.v ?? 0, t: b.date ?? b.t ?? null }))
    .filter(b => [b.h, b.l, b.c].every(isNum));
  if (xs.length < 2) return null;
  let pv = 0;
  let vol = 0;
  for (const b of xs) { const typ = (b.h + b.l + b.c) / 3; pv += typ * b.v; vol += b.v; }
  const last = xs[xs.length - 1];
  return {
    last: last.c,
    lastBarAt: last.t,
    vwap: vol > 0 ? round(pv / vol, 4) : null,
    dayHigh: Math.max(...xs.map(b => b.h)),
    dayLow: Math.min(...xs.map(b => b.l)),
    cumVolume: vol,
    bars: xs.length,
  };
}

// snapshot: from summarizeIntraday. volumeContext: { avgVolume } = full-day average daily
// volume; relVol is measured against the session-elapsed fraction when provided.
function technicalStatusIntraday(episode, snapshot, { avgVolume = null, sessionElapsed = null } = {}) {
  if (!episode || !snapshot || !isNum(snapshot.last)) return null;
  const L = levelsOf(episode);
  const long = L.direction !== 'SHORT';
  const price = snapshot.last;
  const beyondTrigger = long ? price > L.trigger : price < L.trigger;
  const touchedTrigger = long ? snapshot.dayHigh >= L.trigger : snapshot.dayLow <= L.trigger;
  const aboveVwap = isNum(snapshot.vwap) ? price > snapshot.vwap : null;
  const vwapAligned = aboveVwap == null ? null : (long ? aboveVwap : !aboveVwap);
  let relVol = null;
  if (isNum(avgVolume) && avgVolume > 0 && isNum(snapshot.cumVolume)) {
    const frac = isNum(sessionElapsed) && sessionElapsed > 0.05 ? sessionElapsed : 1;
    relVol = round(snapshot.cumVolume / (avgVolume * frac), 2);
  }
  const rr = remainingRR(price, L);
  const atr = isNum(L.atr) && L.atr > 0 ? L.atr : null;
  const extensionAtr = atr ? round((long ? price - L.trigger : L.trigger - price) / atr, 2) : null;
  const invalidated = long ? price < L.stop : price > L.stop;
  // Live confirmation: beyond the trigger, VWAP-aligned, volume participating, and the
  // trade still has room. Any unknown input degrades to "not confirmed" (fail closed).
  const confirmed = beyondTrigger && vwapAligned === true && (relVol == null ? false : relVol >= 1.2) && isNum(rr) && rr >= 1 && !invalidated;
  return {
    path: 'intraday',
    asOf: snapshot.lastBarAt || null,
    last: price,
    triggered: beyondTrigger,
    touchedTrigger,
    holding: beyondTrigger && touchedTrigger,
    vwap: snapshot.vwap,
    vwapAligned,
    relVol,
    volumeOk: relVol == null ? null : relVol >= 1.2,
    remainingRR: rr,
    remainingRROk: rr == null ? null : rr >= 1,
    extensionAtr,
    invalidated,
    confirmed,
    executionIntent: confirmed ? 'live' : beyondTrigger ? 'live-unconfirmed' : 'none',
  };
}

// ---- recommendation eligibility (fail-closed) ----------------------------------

// evidenceTable: the versioned calibration/validation artifact produced offline by
// research.js — { cells: { '<family>|<direction>|<timeframe>': { proven, effectiveN,
// incrementalLift, ciLow, reasons... } }, version }. No table / no cell / not proven →
// NOT eligible. `analog.sufficient` has no vote here at all.
function recommendationEligibility({ evidenceTable = null, family, direction, timeframe } = {}) {
  const base = { family, direction, timeframe };
  if (!evidenceTable || !evidenceTable.cells) {
    return { ...base, eligible: false, status: 'no-validated-evidence', reason: 'No independently graded Pattern Radar history yet for this family.', sampleSize: 0, artifactVersion: null };
  }
  const cell = evidenceTable.cells[`${family}|${direction}|${timeframe}`] || evidenceTable.cells[`${family}|${direction}`] || null;
  if (!cell) {
    return { ...base, eligible: false, status: 'no-validated-evidence', reason: 'No resolved out-of-sample record for this family yet.', sampleSize: 0, artifactVersion: evidenceTable.version || null };
  }
  if (cell.proven !== true) {
    return {
      ...base, eligible: false, status: 'not-validated',
      reason: cell.reasons && cell.reasons.length ? cell.reasons.join('; ') : 'Family has resolved history but has not passed validation.',
      sampleSize: cell.effectiveN || 0, artifactVersion: evidenceTable.version || null,
    };
  }
  return {
    ...base, eligible: true, status: 'validated',
    reason: `Validated: cost-net incremental lift ${cell.incrementalLift} over matched controls (n=${cell.effectiveN}).`,
    sampleSize: cell.effectiveN || 0,
    incrementalLift: cell.incrementalLift ?? null,
    artifactVersion: evidenceTable.version || null,
  };
}

module.exports = {
  technicalStatusDaily, technicalStatusIntraday, summarizeIntraday,
  remainingRR, recommendationEligibility,
};
