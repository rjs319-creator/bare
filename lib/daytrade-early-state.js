'use strict';
// EARLY-SIGNAL RESEARCH STATES — SCOUT → PRIMED → IGNITION → EARLY_CONFIRMED.
//
// WHY. The lifecycle's conservative actionable gate requires a COMPLETED 30-minute opening
// range plus a close above its high — structurally late for many large same-day moves. These
// early states surface a candidate BEFORE that gate using change-detector evidence (CUSUM,
// standardized shock) and participation acceleration, so the user can watch a name igniting
// instead of first hearing about it after confirmation.
//
// HONESTY CONTRACT. These are WATCH/RESEARCH annotations layered BESIDE the deterministic
// lifecycle (which is untouched — its states, gates, hysteresis and tests are unchanged).
// They carry NO buy language, NO probabilities, and NO plan; thresholds are pre-registered
// in lib/daytrade-config EARLY (not fitted), and the capture/label pipeline measures their
// lead time and post-state outcomes BEFORE any of them may ever gate anything. A name past
// the extension ceiling is disqualified — "late and extended" must never be dressed up as
// "early".
//
// Pure: features + discovery evidence in → state + reason-coded evidence out.

const CFG = require('./daytrade-config');

const EARLY_STATES = Object.freeze(['SCOUT', 'PRIMED', 'IGNITION', 'EARLY_CONFIRMED']);
const BASIS = 'early-signal research state (deterministic, uncalibrated — a watch annotation, not a buy signal or probability)';
const VERSION = 'early-state-v1';

const num = v => (v != null && Number.isFinite(v)) ? v : null;

// `f` = canonical intraday features (may be null — discovery-only names have no bars yet);
// `discovery` = { cusum, z, discoveryAgeMin, ... } or null; both missing → no state.
function computeEarlyState({ f = null, discovery = null } = {}) {
  const E = CFG.EARLY;
  const why = [];
  const cusum = num(discovery && discovery.cusum);
  const zShock = num(discovery && discovery.z);
  const mom5 = num(f && f.mom5), momAccel = num(f && f.momAccel);
  const volAccel = num(f && f.volAccel), todRelVol = num(f && f.timeOfDayRelVol);
  const residual15 = num(f && f.residual15), vwapSlope = num(f && f.vwapSlope);
  const rangeExp = num(f && f.rangeExpansion);
  const extension = num(f && f.extensionAtr);
  const aboveVwap = f ? f.aboveVwap === true : null;

  if (cusum == null && zShock == null && f == null) return { state: null, why: [], basis: BASIS, version: VERSION };

  // Disqualifier: already extended = a chase, not an early signal.
  if (extension != null && extension > E.MAX_EXTENSION_ATR) {
    return { state: null, why: [`${extension} ATR above VWAP — extended, not early`], basis: BASIS, version: VERSION };
  }

  const participation = (volAccel != null && volAccel >= E.IGNITION_VOL_ACCEL) || (todRelVol != null && todRelVol >= 1.5);
  const archetypeHit = f && f.archetypes
    ? Object.entries(f.archetypes).filter(([, v]) => v && v.triggered === true).map(([k]) => k)
    : [];

  // IGNITION evidence: a standardized shock, or accelerating momentum WITH participation.
  const igniting = (zShock != null && zShock >= E.IGNITION_Z)
    || (momAccel != null && momAccel > 0 && mom5 != null && mom5 > 0 && participation);
  if (igniting) {
    if (zShock != null && zShock >= E.IGNITION_Z) why.push(`interval shock z=${zShock}`);
    if (momAccel != null && momAccel > 0) why.push('momentum accelerating');
    if (participation) why.push('participation accelerating');
    // EARLY_CONFIRMED: ignition + follow-through structure (bars above VWAP + an early
    // archetype trigger) — still a research state, NOT the lifecycle actionable gate.
    const bars = f ? (f.bars || 0) : 0;
    if (aboveVwap === true && bars >= E.CONFIRM_MIN_BARS && archetypeHit.length) {
      return { state: 'EARLY_CONFIRMED', why: [...why, `structure: ${archetypeHit.join('/')}`], basis: BASIS, version: VERSION };
    }
    return { state: 'IGNITION', why, basis: BASIS, version: VERSION };
  }

  // PRIMED: alarm-level accumulation, or constructive coil (compression + positive residual drift).
  if (cusum != null && cusum >= E.PRIMED_CUSUM) {
    return { state: 'PRIMED', why: [`CUSUM ${cusum} ≥ alarm ${E.PRIMED_CUSUM}`], basis: BASIS, version: VERSION };
  }
  if (residual15 != null && residual15 > 0 && vwapSlope != null && vwapSlope > 0 && rangeExp != null && rangeExp >= 1.3) {
    return { state: 'PRIMED', why: ['positive residual drift with range expanding off compression'], basis: BASIS, version: VERSION };
  }

  // SCOUT: the detector waking up, or quiet residual strength with volume starting to build.
  if (cusum != null && cusum >= E.SCOUT_CUSUM) {
    return { state: 'SCOUT', why: [`CUSUM ${cusum} building (alarm at ${E.PRIMED_CUSUM})`], basis: BASIS, version: VERSION };
  }
  if (residual15 != null && residual15 > 0 && volAccel != null && volAccel >= 1.2) {
    return { state: 'SCOUT', why: ['outpacing SPY with volume building'], basis: BASIS, version: VERSION };
  }

  return { state: null, why: [], basis: BASIS, version: VERSION };
}

module.exports = { computeEarlyState, EARLY_STATES, BASIS, VERSION };
