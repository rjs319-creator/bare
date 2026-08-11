'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL addendum — CAUSAL online change-point detection. PURE, deterministic.
//
// Two-sided CUSUM on returns standardized by TRAILING mean/vol (both computed
// strictly from observations before t) — every statistic at time t uses only
// data available at t; retrospective segmentation is structurally impossible
// here. Bayesian Online Change-Point Detection is NOT implemented — this
// deterministic CUSUM is the stack-compatible causal alternative, and that
// choice is documented (addendum §5 honesty clause).
//
// probabilityRecentChange is NULL (uncalibrated) — changeScore is a bounded
// heuristic 0..1 statistic, exposed as a band, never a percentage.
// ═══════════════════════════════════════════════════════════════════════════

const CHANGEPOINT_VERSION = 'psrl-changepoint-v1';

const STAT_WINDOW = 40;   // trailing sessions for mean/vol
const MIN_STAT = 15;      // observations before the detector arms
const DRIFT_K = 0.5;      // CUSUM allowance (σ units)
const THRESHOLD_H = 4.0;  // CUSUM detection threshold (σ units)
const SEG_WINDOW = 21;    // before/after comparison window

const TRANSITIONS = Object.freeze([
  'STEADY_TO_ACCELERATING', 'STEADY_TO_PAUSE', 'STEADY_TO_PLATEAU',
  'STEADY_TO_DECLINING', 'PLATEAU_TO_RESUMING', 'HIGH_VOLATILITY_BREAK',
  'NO_RELIABLE_CHANGE',
]);

const isNum = (x) => Number.isFinite(x);

function meanStd(arr) {
  const v = arr.filter(isNum);
  if (v.length < 5) return { mean: null, std: null };
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  return { mean: m, std: sd };
}

function segStats(values) {
  const { mean, std } = meanStd(values);
  return { slope: mean, vol: std }; // per-session mean return ≈ slope of the log path
}

function classifyTransition(before, after) {
  if (!isNum(before.slope) || !isNum(after.slope)) return 'NO_RELIABLE_CHANGE';
  const volJump = isNum(before.vol) && isNum(after.vol) && before.vol > 0 && after.vol / before.vol > 2;
  if (volJump && after.slope < 0) return 'HIGH_VOLATILITY_BREAK';
  const up = (s) => s > 0.0006, flat = (s) => Math.abs(s) <= 0.0006;
  if (up(before.slope) && up(after.slope) && after.slope > before.slope * 1.5) return 'STEADY_TO_ACCELERATING';
  if (up(before.slope) && flat(after.slope)) return 'STEADY_TO_PAUSE';
  if (up(before.slope) && after.slope < -0.0006) return 'STEADY_TO_DECLINING';
  if (flat(before.slope) && up(after.slope)) return 'PLATEAU_TO_RESUMING';
  if (up(before.slope) && !up(after.slope)) return 'STEADY_TO_PLATEAU';
  return 'NO_RELIABLE_CHANGE';
}

/**
 * Run the causal detector over a daily-return series (ascending).
 * Returns final-state summary plus (optionally) the per-step trace used by
 * the causality tests. Every step's state depends only on returns[0..t].
 */
function detectChangepoints(returns, { trace = false } = {}) {
  const r = (returns || []).map((x) => (isNum(x) ? x : null));
  const n = r.length;
  const steps = trace ? [] : null;
  let cpos = 0, cneg = 0;
  let lastChangeIdx = null;
  let detections = 0;
  let armedAt = null;

  for (let t = 0; t < n; t++) {
    const x = r[t];
    const past = r.slice(Math.max(0, t - STAT_WINDOW), t);
    const { mean, std } = meanStd(past);
    let z = null;
    if (x != null && mean != null && std > 1e-9 && past.filter(isNum).length >= MIN_STAT) {
      if (armedAt == null) armedAt = t;
      z = (x - mean) / std;
      cpos = Math.max(0, cpos + z - DRIFT_K);
      cneg = Math.max(0, cneg - z - DRIFT_K);
      if (cpos > THRESHOLD_H || cneg > THRESHOLD_H) {
        // A sustained shift keeps re-alarming while the trailing stats catch
        // up; alarms within SEG_WINDOW of the last change are the SAME event
        // (keeps lastChangeIdx at the true break so before/after segments
        // stay clean), not a new detection.
        if (lastChangeIdx == null || t - lastChangeIdx > SEG_WINDOW) {
          lastChangeIdx = t;
          detections++;
        }
        cpos = 0; cneg = 0;
      }
    }
    if (steps) steps.push({ t, z, cpos, cneg, lastChangeIdx, detections });
  }

  const score = Math.min(1, Math.max(cpos, cneg) / THRESHOLD_H);
  const runLength = lastChangeIdx == null ? (armedAt == null ? null : n - armedAt) : n - 1 - lastChangeIdx;
  let before = { slope: null, vol: null }, after = { slope: null, vol: null };
  if (lastChangeIdx != null) {
    before = segStats(r.slice(Math.max(0, lastChangeIdx - SEG_WINDOW), lastChangeIdx));
    after = segStats(r.slice(lastChangeIdx, Math.min(n, lastChangeIdx + SEG_WINDOW + 1)));
  }
  const supported = armedAt != null && n - (armedAt || 0) >= MIN_STAT;

  return {
    version: CHANGEPOINT_VERSION,
    method: 'two-sided causal CUSUM on trailing-standardized returns (BOCPD not implemented — documented deterministic alternative)',
    supported,
    n,
    detections,
    lastChangeIdx,
    expectedCurrentRunLength: runLength,
    changeScore: supported ? score : null,           // bounded heuristic, NOT a probability
    probabilityRecentChange: null,                    // uncalibrated — never displayed as %
    probabilityReason: 'uncalibrated — use changeScore band until out-of-fold calibration exists',
    recentChange: supported && lastChangeIdx != null && runLength != null && runLength <= SEG_WINDOW,
    slopeBefore: before.slope, slopeAfter: after.slope,
    volatilityBefore: before.vol, volatilityAfter: after.vol,
    likelyTransition: supported && lastChangeIdx != null ? classifyTransition(before, after) : 'NO_RELIABLE_CHANGE',
    trace: steps,
  };
}

module.exports = { CHANGEPOINT_VERSION, TRANSITIONS, detectChangepoints, STAT_WINDOW, MIN_STAT, THRESHOLD_H };
