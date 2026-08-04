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

// v3 (2026-08-03): COMPLETED-BAR SEMANTICS — every confirmation-bearing feature is now
// computed from completed bars only (the forming bar is excluded and surfaced separately as
// a labeled provisional observation), timeOfDayRelVol compares equivalent completed
// intervals, and the session-context fields below (dayChangePct/gapPct/distFromOrHigh/
// closesAboveVwapStreak/timeOfDayDollarRelVol) were added. MODEL_FEATURES is UNCHANGED —
// no trained artifact exists, and the microstructure registry remains deferred until a
// provider is configured (see the MICRO_FIELDS note below).
const FEATURE_SCHEMA_VERSION = 'intraday-features-v3';

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
  timeOfDayRelVol: { kind: 'ratio', desc: 'cumulative volume vs same-minute-of-session average of prior sessions (equivalent COMPLETED intervals on both sides)' },
  timeOfDayDollarRelVol: { kind: 'ratio', desc: 'cumulative DOLLAR volume vs same-minute-of-session average of prior sessions (completed intervals)' },
  volAccel: { kind: 'ratio', desc: 'mean volume last 3 bars ÷ mean volume prior 3 bars' },
  dollarVolAccel: { kind: 'ratio', desc: 'mean dollar volume last 3 bars ÷ prior 3 bars' },
  vwapDist: { kind: 'fraction', desc: 'last close vs session VWAP (fractional)' },
  vwapSlope: { kind: 'fraction', desc: 'per-minute VWAP drift over the last ~15 minutes' },
  distFromHod: { kind: 'fraction', desc: 'last close vs high of day (≤ 0)' },
  distFromOrHigh: { kind: 'fraction', desc: 'last completed close vs the opening-range high (continuous, not just the boolean trigger)' },
  barsSinceHigh: { kind: 'count', desc: 'bars since the high of day' },
  lowerHighs: { kind: 'count', desc: 'consecutive lower highs from the tail' },
  rangeExpansion: { kind: 'ratio', desc: 'mean bar range last 3 bars ÷ mean range prior 10 bars' },
  extensionAtr: { kind: 'atr', desc: 'distance above VWAP in daily-ATR units' },
  remainingRR: { kind: 'ratio', desc: 'remaining reward:risk vs the FROZEN plan (not a per-quote recompute)' },
  closesBelowVwapStreak: { kind: 'count', desc: 'consecutive completed closes below running VWAP' },
  closesAboveVwapStreak: { kind: 'count', desc: 'consecutive completed closes above running VWAP (reclaim-confirmation counter)' },
  dayChangePct: { kind: 'percent', desc: 'current-session change vs prior close (PERCENT — production input to the day-collapse rule)' },
  gapPct: { kind: 'percent', desc: 'overnight gap: session open vs prior close (PERCENT)' },
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

// BROAD-TIER features — the fields available for EVERY captured full-universe dataset row
// (lib/intraday-dataset), not just the ≤30-name Stage-2 deep pool. Units documented because
// the dataset stores discovery-scan values as-is: percent stays percent, ratio stays ratio
// (models standardize, so consistency matters more than the unit itself). The deep-tier
// MODEL_FEATURES above exist on a dataset row only when a Stage-2 evaluation of the same
// ticker/time was captured and joined — otherwise they are null with missingness flags, and
// the model's indicator columns carry that fact honestly.
const BROAD_FIELDS = Object.freeze({
  intervalRetPct: { kind: 'percent', desc: 'return over the last discovery interval (PERCENT)' },
  cusum: { kind: 'ratio', desc: 'one-sided CUSUM of standardized per-minute returns' },
  zShock: { kind: 'ratio', desc: 'standardized interval-return shock' },
  dayPct: { kind: 'percent', desc: 'day return vs prev close (PERCENT)' },
  excessPct: { kind: 'percent', desc: 'day return minus SPY day return (PERCENT — SPY residual)' },
  relVol: { kind: 'ratio', desc: 'day volume vs 20-day average' },
  logDollarVol: { kind: 'ratio', desc: 'log10 of average daily dollar volume' },
  atrPct: { kind: 'fraction', desc: 'daily ATR as a fraction of last price' },
  extensionDayAtr: { kind: 'atr', desc: 'day move in daily-ATR units — how extended the name already is at detection' },
});
const BROAD_FEATURES = Object.freeze(Object.keys(BROAD_FIELDS));

// Every feature a dataset-trained model may consume: broad tier (always capturable) plus the
// deep Stage-2 tier (null unless a deep evaluation was joined). One list, one order.
const DATASET_FEATURES = Object.freeze([...BROAD_FEATURES, ...MODEL_FEATURES]);

// ── Microstructure fields (provider-gated — see lib/microstructure.js) ──────────
// DELIBERATELY NOT part of DATASET_FEATURES / MODEL_FEATURES yet: appending fields to
// those lists silently changes every trained model's design matrix, and the version
// fail-closed tests treat the FEATURE_SCHEMA_VERSION + list pair as one immutable
// contract. These fields therefore live in a SEPARATE registry; captured rows may carry
// them (null when no provider — the missingness contract applies unchanged, and
// `missingnessOf(row, MICROSTRUCTURE_FIELDS)` already handles arbitrary key lists).
// They join DATASET_FEATURES at the NEXT FEATURE_SCHEMA_VERSION bump, when old rows are
// versioned out rather than silently reinterpreted.
const MICRO_FIELDS = Object.freeze({
  signedAggressorVolume: { kind: 'ratio', desc: 'buy-initiated minus sell-initiated volume, normalized (aggressor-signed)' },
  orderFlowImbalance: { kind: 'ratio', desc: 'net order-flow imbalance over the decision interval' },
  queueImbalance: { kind: 'ratio', desc: 'top-of-book bid vs ask queue imbalance' },
  quoteDepletion: { kind: 'ratio', desc: 'rate at which the inside quote is consumed/refreshed' },
  spreadBps: { kind: 'ratio', desc: 'quoted bid-ask spread in basis points' },
  bidDepth: { kind: 'count', desc: 'displayed size at the inside bid' },
  askDepth: { kind: 'count', desc: 'displayed size at the inside ask' },
  tradeThroughRate: { kind: 'ratio', desc: 'fraction of trades sweeping beyond the inside quote' },
  persistenceScore: { kind: 'ratio', desc: 'autocorrelation of signed flow — is the pressure persistent or one print' },
  microAvailable: { kind: 'bool', desc: 'true only when a provider supplied at least one real field — never inferred' },
});
// Numeric fields only (the adapter's canonical order); microAvailable is the availability flag.
const MICROSTRUCTURE_FIELDS = Object.freeze(Object.keys(MICRO_FIELDS).filter(k => k !== 'microAvailable'));
// Full schema-facing list (fields + flag) — what joins DATASET_FEATURES at the next bump.
const MICRO_FEATURES = Object.freeze([...MICROSTRUCTURE_FIELDS, 'microAvailable']);

const isNum = v => v != null && Number.isFinite(v);

// Broad-tier canonical row from one PIT dataset row (lib/intraday-dataset schema). Pure,
// null-preserving, deterministic. Derived fields (log dollar-vol, ATR fraction, extension)
// are transforms of captured values only — nothing here can see the future.
function datasetRowFeatures(row) {
  const r = row || {};
  const atrPct = isNum(r.atr) && isNum(r.last) && r.last > 0 ? +(r.atr / r.last).toFixed(6) : null;
  return {
    intervalRetPct: isNum(r.intervalRet) ? r.intervalRet : null,
    cusum: isNum(r.cusum) ? r.cusum : null,
    zShock: isNum(r.z) ? r.z : null,
    dayPct: isNum(r.dayPct) ? r.dayPct : null,
    excessPct: isNum(r.excessPct) ? r.excessPct : null,
    relVol: isNum(r.relVol) ? r.relVol : null,
    logDollarVol: isNum(r.avgDollarVol) && r.avgDollarVol > 0 ? +Math.log10(r.avgDollarVol).toFixed(4) : null,
    atrPct,
    extensionDayAtr: isNum(r.dayPct) && atrPct > 0 ? +((r.dayPct / 100) / atrPct).toFixed(3) : null,
  };
}

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
  BROAD_FIELDS, BROAD_FEATURES, DATASET_FEATURES, datasetRowFeatures,
  MICRO_FIELDS, MICROSTRUCTURE_FIELDS, MICRO_FEATURES,
  toModelRow, missingnessOf, validateFeaturePresence,
};
