'use strict';
// NOVEL SIGNAL LAB — Engine 3: predictable mechanical flow (mechanical-flow-v1).
//
// Some buying/selling pressure is calendar-driven and unrelated to fundamentals: dividend
// reinvestment near ex-dates (demand), IPO lockup expiries (supply). These are FEASIBLE from
// free/keyed sources this app already touches (Yahoo ex-dates; lib/ipo.js FMP lockups). Index
// reconstitution schedules and buyback execution windows require licensed index/proprietary
// data and are emitted UNAVAILABLE. A mechanical flow creates temporary pressure that often
// REVERSES once it clears, so this engine reports a reversal window — it is kept SEPARATE from
// fundamental return expectations and is EXPERIMENTAL (its incremental value is unproven here).
//
// The pure core (assessMechanicalFlow) takes a normalized event list so it is deterministic and
// testable; the wrapper wires whatever event providers are configured.

const { unavailable, makeEnvelope, STATUS, DIRECTION, clamp01 } = require('./registry');

// Event = { type:'dividend'|'lockup', date:'YYYY-MM-DD', direction:+1|-1, sizeVsAdv?:number, source }.
// PURE. As of `asOf`, weight events by proximity (a flow peaks around its date and decays).
function assessMechanicalFlow(events, asOf, { windowDays = 21 } = {}) {
  if (!Array.isArray(events) || !events.length) return null;
  const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  let demand = 0, supply = 0, peakDate = null, minAbsDist = Infinity;
  const active = [];
  for (const e of events) {
    if (!e.date || !e.type) continue;
    const dist = daysBetween(e.date, asOf); // >0 upcoming, <0 past
    if (Math.abs(dist) > windowDays) continue;
    // Triangular proximity weight (1 at the event date, 0 at the window edge).
    const w = Math.max(0, 1 - Math.abs(dist) / windowDays);
    const mag = w * (Number.isFinite(e.sizeVsAdv) ? Math.min(3, e.sizeVsAdv) : 1);
    if (e.direction >= 0) demand += mag; else supply += mag;
    if (Math.abs(dist) < minAbsDist) { minAbsDist = Math.abs(dist); peakDate = e.date; }
    active.push({ ...e, dist, weight: +w.toFixed(3) });
  }
  if (!active.length) return { empty: true };
  const net = demand - supply;
  const ratio = (demand + supply) > 0 ? net / (demand + supply) : 0; // [-1,1]
  // Reversal probability rises once the event date has passed (flow clearing).
  const past = active.filter(e => e.dist <= 0);
  const reversalProb = active.length ? past.length / active.length : 0;
  return { empty: false, demand, supply, net, ratio, peakDate, reversalProb, active };
}

function toEnvelope(a, { ticker, securityId, asOf, unavailableProviders = [] } = {}) {
  if (!a || a.empty) {
    return makeEnvelope({ engine: 3, signal: 'mechanical_flow', signalVersion: 'mechanical-flow-v1', ticker, securityId, asOf,
      status: STATUS.USABLE, score: 0, direction: DIRECTION.NEUTRAL, confidence: 0.4, coverage: 1,
      warnings: ['no mechanical-flow event in window'].concat(unavailableProviders.map(p => `provider unavailable: ${p}`)),
      inputs: { mechanical_demand: 0, mechanical_supply: 0 } });
  }
  return makeEnvelope({
    engine: 3, signal: 'mechanical_flow', signalVersion: 'mechanical-flow-v1', ticker, securityId, asOf,
    status: STATUS.EXPERIMENTAL,
    score: +a.ratio.toFixed(4), // temporary pressure tilt, NOT a fundamental expectation
    direction: a.ratio > 0.1 ? DIRECTION.LONG : (a.ratio < -0.1 ? DIRECTION.SHORT : DIRECTION.NEUTRAL),
    confidence: clamp01(0.3 + 0.2 * Math.min(1, a.active.length / 3)),
    coverage: 1,
    expectedDecay: { halfLifeDays: 10, reversal: true }, // mechanical flow reverses as it clears
    warnings: ['temporary flow — expect continuation then reversal; not a fundamental signal']
      .concat(unavailableProviders.map(p => `provider unavailable: ${p}`)),
    inputs: {
      mechanical_demand: +a.demand.toFixed(3), mechanical_supply: +a.supply.toFixed(3),
      flow_pressure_ratio: +a.ratio.toFixed(3), flow_peak_time: a.peakDate,
      reversal_probability: +a.reversalProb.toFixed(3),
      index_recon: null, buyback_window: null, // licensed/proprietary — UNAVAILABLE
      events: a.active.slice(0, 5),
    },
  });
}

// ASYNC wrapper. `events` may be supplied (already normalized & latency-correct). If no event
// provider yields anything, we still return a USABLE zero (a genuine "no scheduled flow"),
// while listing the licensed providers that remain UNAVAILABLE.
async function computeMechanicalFlow(ticker, { asOf, securityId = null, events = null } = {}) {
  if (!asOf) throw new Error('computeMechanicalFlow requires asOf');
  const a = assessMechanicalFlow(events || [], asOf);
  return toEnvelope(a, { ticker, securityId, asOf, unavailableProviders: ['index_recon', 'buyback_window'] });
}

module.exports = { assessMechanicalFlow, toEnvelope, computeMechanicalFlow };
