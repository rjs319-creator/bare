// PATTERN PHASE — the structural lifecycle of a pattern, distinct from the ACTIONABILITY
// lifecycle (opportunity-lifecycle.js). A pattern PHASE describes how developed the shape
// is ("bull flag forming" vs "bull flag breakout confirmed"); the actionability STATE
// (owned by the existing lifecycle engine) decides whether you may act right now.
//
// A pattern label WITHOUT its phase is insufficient, so every detection carries one.

const PHASES = Object.freeze({
  EMERGING: 'EMERGING',           // early hints, shape not yet defined
  FORMING: 'FORMING',             // shape is developing, no trigger yet
  NEAR_TRIGGER: 'NEAR_TRIGGER',   // coiled right under the trigger
  CONFIRMED: 'CONFIRMED',         // trigger broken with confirmation
  RETESTING: 'RETESTING',         // pulled back to the broken level
  ACTIONABLE_NOW: 'ACTIONABLE_NOW', // reserved — set ONLY by the actionability gate, never here
  EXTENDED: 'EXTENDED',           // moved too far past trigger to chase
  STALLING: 'STALLING',           // losing momentum / structure deteriorating
  FAILED: 'FAILED',               // invalidation hit
  EXPIRED: 'EXPIRED',             // aged out without triggering
});

const isNum = v => typeof v === 'number' && isFinite(v);

// Classify the structural phase from measured, point-in-time signals. This NEVER returns
// ACTIONABLE_NOW — actionability is decided by the freshness/lifecycle gate downstream, so
// a pure structural read can't accidentally green-light a stale chart.
//
// signals: {
//   direction 'LONG'|'SHORT', last, trigger, stop, target, atr,
//   invalidationHit bool, breakoutConfirmed bool, retesting bool,
//   extensionAtr number (distance past trigger in ATRs), ageBars, expireBars,
//   momentumDeteriorating bool, similarity number (combined, 0..1)
// }
function classifyPhase(signals = {}) {
  const {
    direction = 'LONG', last, trigger, stop, atr,
    invalidationHit = false, breakoutConfirmed = false, retesting = false,
    extensionAtr = null, ageBars = 0, expireBars = null,
    momentumDeteriorating = false, similarity = 0,
  } = signals;

  if (invalidationHit) return PHASES.FAILED;

  const long = direction !== 'SHORT';

  // Extended: chased too far beyond the trigger.
  if (isNum(extensionAtr) && extensionAtr >= 2.5) return PHASES.EXTENDED;

  if (breakoutConfirmed) {
    if (retesting) return PHASES.RETESTING;
    if (momentumDeteriorating) return PHASES.STALLING;
    return PHASES.CONFIRMED;
  }

  // Not yet broken out. Aged out without a trigger → expired.
  if (isNum(expireBars) && ageBars > expireBars) return PHASES.EXPIRED;

  // Distance to trigger in ATRs (positive = still below a long trigger / above a short trigger).
  let distAtr = null;
  if (isNum(last) && isNum(trigger) && isNum(atr) && atr > 0) {
    distAtr = long ? (trigger - last) / atr : (last - trigger) / atr;
  }

  if (isNum(distAtr) && distAtr <= 0.5 && distAtr >= -0.25 && similarity >= 0.55) return PHASES.NEAR_TRIGGER;
  if (similarity >= 0.6) return PHASES.FORMING;
  return PHASES.EMERGING;
}

// Human phase note for novices.
const PHASE_NOTE = {
  EMERGING: 'A possible setup is just starting to take shape — nothing to do yet.',
  FORMING: 'The pattern is developing but has not triggered. Watch, do not buy.',
  NEAR_TRIGGER: 'Coiled just under the trigger. Wait for the breakout to confirm.',
  CONFIRMED: 'The trigger broke with confirmation. Entry is valid only if it is still live and fresh.',
  RETESTING: 'Price pulled back to the breakout level — the retest decides it.',
  ACTIONABLE_NOW: 'Live and confirmed right now.',
  EXTENDED: 'Already moved too far past the trigger — do not chase.',
  STALLING: 'Momentum is fading and the structure is weakening.',
  FAILED: 'The pattern failed — its invalidation level was hit.',
  EXPIRED: 'The setup aged out without triggering.',
};

module.exports = { PHASES, classifyPhase, PHASE_NOTE };
