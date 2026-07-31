'use strict';
// CANONICAL INTRADAY FEATURE SCHEMA — the ONE versioned contract shared by discovery,
// Stage-2 selection, lifecycle evaluation, canonical cards, immutable snapshots, the
// deterministic scores, the learned models, and UI explanations.
//
// WHY THIS EXISTS. The survival model expected `residual15` while capture stored
// `residualVsSpy` (in PERCENT, not fraction), and `momAccel` was computed but never reached
// the card, the deterministic score, or the snapshot — silent field-name drift that turned
// model features into constant zeros. This module makes that drift a TEST FAILURE instead:
// every consumer goes through the same registry, `toModelRow` performs the (explicit,
// documented) legacy aliasing, and schema tests assert that each model feature is actually
// present in the producer's output.
//
// MISSINGNESS CONTRACT. A feature that cannot be computed is `null`, NEVER a fabricated 0 —
// and downstream models must treat null via explicit missingness indicators (see
// lib/survival-model), not silent zero-imputation. `missingnessOf` exposes the flags.

const FEATURE_SCHEMA_VERSION = 'intraday-features-v2';

// Canonical feature registry. `kind` documents units so a percent/fraction mixup is visible.
//   fraction — fractional return (0.01 = +1%)
//   ratio    — dimensionless multiple (1.0 = baseline)
//   atr      — ATR-normalized distance
//   count    — integer bar/streak count
//   bool     — true/false/null
//   price    — dollars
//   minutes  — minutes
const FEATURE_FIELDS = Object.freeze({
  // Returns over multiple windows. mom1/mom2 are genuinely UNAVAILABLE on 5-minute bars —
  // they stay null with a capability flag rather than being faked from a 5-min interval.
  mom1: { kind: 'fraction', desc: '1-minute return (null on 5-min bars — capability-gated)' },
  mom2: { kind: 'fraction', desc: '2-minute return (null on 5-min bars — capability-gated)' },
  mom5: { kind: 'fraction', desc: '5-minute return' },
  mom10: { kind: 'fraction', desc: '10-minute return' },
  mom15: { kind: 'fraction', desc: '15-minute return' },
  mom30: { kind: 'fraction', desc: '30-minute return' },
  momAccel: { kind: 'fraction', desc: 'momentum acceleration: last-5-min pace minus preceding 10-min pace' },
  momJerk: { kind: 'fraction', desc: 'change in momentum acceleration vs one bar earlier' },
  residual15: { kind: 'fraction', desc: '15-min return minus SPY 15-min return (FRACTION, not %)' },
  residual30: { kind: 'fraction', desc: '30-min return minus SPY 30-min return' },
  residualSector15: { kind: 'fraction', desc: '15-min return minus sector-benchmark 15-min return (null without a sector series)' },
  timeOfDayRelVol: { kind: 'ratio', desc: 'cumulative volume vs same-minute-of-session average of prior sessions' },
  volAccel: { kind: 'ratio', desc: 'mean volume last 3 bars ÷ mean volume prior 3 bars' },
  dollarVolAccel: { kind: 'ratio', desc: 'mean dollar volume last 3 bars ÷ prior 3 bars' },
  vwapDist: { kind: 'fraction', desc: 'last close vs session VWAP (fractional)' },
  vwapSlope: { kind: 'fraction', desc: 'per-minute VWAP drift over the last ~15 minutes' },
  distFromHod: { kind: 'fraction', desc: 'last close vs high of day (≤ 0)' },
  barsSinceHigh: { kind: 'count', desc: 'bars since the high of day' },
  lowerHighs: { kind: 'count', desc: 'consecutive lower highs from the tail' },
  rangeExpansion: { kind: 'ratio', desc: 'mean bar range last 3 bars ÷ mean range prior 10 bars' },
  extensionAtr: { kind: 'atr', desc: 'distance above VWAP in daily-ATR units' },
  remainingRR: { kind: 'ratio', desc: 'remaining reward:risk vs the FROZEN plan (not a per-quote recompute)' },
  closesBelowVwapStreak: { kind: 'count', desc: 'consecutive closes below running VWAP' },
  // Discovery evidence (Stage A) — carried through so Stage-2 selection and models see it.
  cusum: { kind: 'ratio', desc: 'one-sided CUSUM of standardized per-minute returns' },
  zShock: { kind: 'ratio', desc: 'standardized interval-return shock at the last discovery step' },
  discoveryAgeMin: { kind: 'minutes', desc: 'minutes since the first CUSUM alarm today' },
  // Freshness / provenance.
  barAgeSec: { kind: 'minutes', desc: 'age of the newest intraday bar (seconds)' },
  quoteAgeSec: { kind: 'minutes', desc: 'age of the newest quote (seconds)' },
});

// The features the learned (survival/challenger) models may consume. Every key here MUST be
// present (own property — value may be null) in the capture-side metrics object; the schema
// test enforces it so a rename or drop fails loudly instead of training on silent zeros.
const MODEL_FEATURES = Object.freeze([
  'mom15', 'momAccel', 'residual15', 'timeOfDayRelVol', 'volAccel',
  'distFromHod', 'extensionAtr', 'remainingRR',
]);

const isNum = v => v != null && Number.isFinite(v);

// Canonical model row from a captured feature/metrics object. Null-preserving: absent or
// non-finite values stay null (missingness indicators handle them downstream). Performs the
// ONE documented legacy alias: rows captured before v2 stored `residualVsSpy` in PERCENT —
// convert to the canonical `residual15` FRACTION only when `residual15` itself is absent.
function toModelRow(features) {
  const f = features || {};
  const row = {};
  for (const k of MODEL_FEATURES) row[k] = isNum(f[k]) ? f[k] : null;
  if (row.residual15 == null && isNum(f.residualVsSpy)) row.residual15 = +(f.residualVsSpy / 100).toFixed(6);
  return row;
}

// Per-feature missingness flags for a canonical row (true = value unavailable).
function missingnessOf(row, keys = MODEL_FEATURES) {
  const out = {};
  for (const k of keys) out[k] = !isNum(row ? row[k] : null);
  return out;
}

// Validate that a producer's output carries every required feature as an OWN PROPERTY
// (null allowed — that is honest missingness; ABSENT means the pipeline renamed or dropped
// it). Returns { ok, missing } so tests can fail with the exact field list.
function validateFeaturePresence(obj, keys = MODEL_FEATURES) {
  const missing = keys.filter(k => !obj || !Object.prototype.hasOwnProperty.call(obj, k));
  return { ok: missing.length === 0, missing };
}

module.exports = {
  FEATURE_SCHEMA_VERSION, FEATURE_FIELDS, MODEL_FEATURES,
  toModelRow, missingnessOf, validateFeaturePresence,
};
