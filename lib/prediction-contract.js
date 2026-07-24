// CANONICAL PREDICTION CONTRACT — one schema every screener can speak, so a rank,
// a probability, a confidence and an evidence count can never be silently conflated
// again (the recurring honesty bug this repo keeps fighting).
//
// THREE RULES, enforced by construction:
//   1. A RANK is not a PROBABILITY. `rankPercentile` is relative ordering in [0,1];
//      it is NEVER a chance of anything. `isProbabilityField` tells consumers apart.
//   2. An UNKNOWN probability is `null` WITH A REASON — never a fabricated fallback.
//      `makePrediction` refuses a null probability that has no `nulls[field]` reason.
//   3. Confidence / evidence are their own axis. `dataConfidence`, `modelConfidence`,
//      `evidenceStrength` describe how much to trust the read — not the odds of profit.
//
// This is additive: existing screeners keep their own shapes. A screener adopts the
// contract by building one of these alongside its native output (see lib/coil.js).

// ── Field taxonomy ───────────────────────────────────────────────────────────
// Probabilities: MUST be a number in [0,1] or null-with-reason. Nothing else.
const PROBABILITY_FIELDS = Object.freeze([
  'pTrigger',                    // P(entry trigger actually fills within the allowed window)
  'pTargetBeforeStopGivenFill',  // P(target hit before stop | the trade filled)
  'pProfitableNetGivenFill',     // P(net-of-cost P&L > 0 | the trade filled)
  'severeLossProbability',       // P(a severe adverse outcome — e.g. gap-through stop)
]);
// A rank, explicitly NOT a probability. Relative ordering only.
const RANK_FIELDS = Object.freeze(['rankPercentile']);
// Expected values (return space / R-multiple space). May be any finite number or null.
const EXPECTED_FIELDS = Object.freeze(['expectedNetReturn', 'expectedNetR']);
// Trust axis — 0..1 subjective/derived confidence, NOT a probability of profit.
const CONFIDENCE_FIELDS = Object.freeze(['dataConfidence', 'modelConfidence', 'evidenceStrength']);

const CALIBRATION_STATUS = Object.freeze(['calibrated', 'model-estimate', 'uncalibrated', 'unknown']);
const VALIDATION_STATUS = Object.freeze(['validated', 'eligible', 'shadow', 'experimental', 'research', 'provisional', 'unknown']);

// The full canonical field set, each with its default. Probabilities/expecteds/most
// metadata default to null (honest "unknown"), not to a made-up number. Safety flags
// default to the pessimistic value — a result is survivorship-/PIT-safe only when proven.
const FIELD_DEFAULTS = Object.freeze({
  // ranking (NOT a probability)
  rankPercentile: null,
  // executable probabilities (null unless genuinely known)
  pTrigger: null,
  pTargetBeforeStopGivenFill: null,
  pProfitableNetGivenFill: null,
  severeLossProbability: null,
  // expected outcome
  expectedNetReturn: null,
  expectedNetR: null,
  // trust axis
  dataConfidence: null,
  modelConfidence: null,
  evidenceStrength: null,
  // uncertainty / independence
  uncertaintyInterval: null,        // { lo, hi, metric } or null
  effectiveSampleSize: null,
  independentDecisionDates: null,
  independentEvidenceDomains: null,
  // fit / quality
  regimeCompatibility: null,        // -1..1 or 0..1; label in `notes`
  executionQuality: null,           // 0..1 how tradeable the fill assumption is
  // governance status
  calibrationStatus: 'unknown',
  validationStatus: 'unknown',
  survivorshipSafe: false,
  pointInTimeSafe: false,
  // provenance / versioning
  modelVersion: null,
  featureVersion: null,
  asOf: null,                       // data-as-of timestamp/date
  knownAt: null,                    // when the evidence became knowable (leakage guard)
  entryEligibleAt: null,            // earliest an entry could actually execute
});

const CANONICAL_FIELDS = Object.freeze(Object.keys(FIELD_DEFAULTS));

function isProbabilityField(name) { return PROBABILITY_FIELDS.includes(name); }
function isRankField(name) { return RANK_FIELDS.includes(name); }

const isNum = v => typeof v === 'number' && isFinite(v);
const inUnit = v => isNum(v) && v >= 0 && v <= 1;

// A guarded probability: pass a value + a reason it might be unknown. Returns the number
// if it is a valid [0,1] probability, else null. Out-of-range is a hard error (a bug in
// the caller), because silently clamping a "1.4 probability" is exactly the dishonesty
// this contract exists to prevent.
function prob(value, reason = 'unknown') {
  if (value == null) return { value: null, reason };
  if (!isNum(value)) throw new Error(`prob(): non-numeric probability (${value})`);
  if (value < 0 || value > 1) throw new Error(`prob(): probability out of [0,1] (${value})`);
  return { value, reason: null };
}

// Build a canonical prediction. `input` may set any canonical field; `nulls` maps a
// field name → the reason it is null (required for any null probability field);
// `extra` carries domain-specific fields (e.g. coil's pAbnormalExpansion) untouched.
function makePrediction(input = {}) {
  const nulls = { ...(input.nulls || {}) };
  const out = {};
  for (const f of CANONICAL_FIELDS) {
    out[f] = f in input ? input[f] : FIELD_DEFAULTS[f];
  }

  // Enum guards — reject an unknown status rather than passing it through.
  if (!CALIBRATION_STATUS.includes(out.calibrationStatus)) {
    throw new Error(`makePrediction(): invalid calibrationStatus "${out.calibrationStatus}"`);
  }
  if (!VALIDATION_STATUS.includes(out.validationStatus)) {
    throw new Error(`makePrediction(): invalid validationStatus "${out.validationStatus}"`);
  }

  // Range + null-discipline guards.
  for (const f of PROBABILITY_FIELDS) {
    const v = out[f];
    if (v == null) {
      if (!nulls[f]) nulls[f] = 'not estimated';
    } else if (!inUnit(v)) {
      throw new Error(`makePrediction(): ${f} must be a probability in [0,1] or null (got ${v})`);
    }
  }
  for (const f of RANK_FIELDS) {
    if (out[f] != null && !inUnit(out[f])) {
      throw new Error(`makePrediction(): ${f} must be a percentile in [0,1] or null (got ${out[f]})`);
    }
  }
  for (const f of CONFIDENCE_FIELDS) {
    if (out[f] != null && !inUnit(out[f])) {
      throw new Error(`makePrediction(): ${f} (confidence) must be in [0,1] or null (got ${out[f]})`);
    }
  }
  for (const f of EXPECTED_FIELDS) {
    if (out[f] != null && !isNum(out[f])) {
      throw new Error(`makePrediction(): ${f} must be a finite number or null (got ${out[f]})`);
    }
  }
  if (out.uncertaintyInterval != null) {
    const u = out.uncertaintyInterval;
    if (!isNum(u.lo) || !isNum(u.hi) || u.lo > u.hi) {
      throw new Error('makePrediction(): uncertaintyInterval must be { lo<=hi, metric }');
    }
  }

  out.nulls = Object.freeze(nulls);
  out.extra = Object.freeze({ ...(input.extra || {}) });
  out.contractVersion = 'pred-contract-v1';
  return Object.freeze(out);
}

// Validate a plain object as a canonical prediction WITHOUT throwing — returns
// { ok, errors }. Use at system boundaries (routes, adapters) to fail loud but soft.
function validatePrediction(pred) {
  const errors = [];
  if (!pred || typeof pred !== 'object') return { ok: false, errors: ['not an object'] };
  for (const f of PROBABILITY_FIELDS) {
    const v = pred[f];
    if (v != null && !inUnit(v)) errors.push(`${f} out of [0,1]: ${v}`);
    if (v == null && (!pred.nulls || !pred.nulls[f])) errors.push(`${f} is null without a reason`);
  }
  for (const f of RANK_FIELDS) {
    if (pred[f] != null && !inUnit(pred[f])) errors.push(`${f} out of [0,1]: ${pred[f]}`);
  }
  if (pred.calibrationStatus != null && !CALIBRATION_STATUS.includes(pred.calibrationStatus)) {
    errors.push(`invalid calibrationStatus: ${pred.calibrationStatus}`);
  }
  if (pred.validationStatus != null && !VALIDATION_STATUS.includes(pred.validationStatus)) {
    errors.push(`invalid validationStatus: ${pred.validationStatus}`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  PROBABILITY_FIELDS, RANK_FIELDS, EXPECTED_FIELDS, CONFIDENCE_FIELDS,
  CALIBRATION_STATUS, VALIDATION_STATUS, CANONICAL_FIELDS, FIELD_DEFAULTS,
  isProbabilityField, isRankField, prob, makePrediction, validatePrediction,
};
