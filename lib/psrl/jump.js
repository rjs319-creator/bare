'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — jump-then-plateau detection. PURE, deterministic, reason-coded.
//
// Distinguishes a one-day repricing that then goes nowhere (JUMP_PLATEAU)
// from a constructive digestion of a real event (JUMP_HOLDING/ORDERLY_PAUSE)
// and from genuinely gradual advances. NOT every consolidation is a plateau:
// plateau requires concentration + elapsed time + flat post-path + no
// constructive structure. Works on any path expressed as bars (absolute) or
// {rets, levels} (residual paths — gap features unavailable there, flagged).
// ═══════════════════════════════════════════════════════════════════════════

const { JUMP } = require('./config');
const C = require('./continuity');

const STATES = Object.freeze([
  'STEADY_ADVANCE', 'ACCELERATING', 'ORDERLY_PAUSE', 'JUMP_HOLDING',
  'JUMP_CONTINUING', 'JUMP_PLATEAU', 'DECELERATING', 'EXHAUSTED', 'TREND_BROKEN',
]);

const ACCEL_BAND = 0.0008;      // per-session pace delta considered material
const FLAT_SLOPE = 0.0004;      // |normalized slope| below this ⇒ flat
const EXHAUST_DD = -0.12;       // drawdown from window high flagging exhaustion
const NARROW_RANGE_PCT = 0.02;  // daily true-range fraction counted as "narrow"

const isNum = (x) => Number.isFinite(x);

function retsFromLevels(levels) {
  const out = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i - 1] > 0 && levels[i] > 0) out.push(levels[i] / levels[i - 1] - 1);
    else out.push(0);
  }
  return out;
}

/** Post-event path features for the segment AFTER the largest up-move. */
function postEventFeatures({ levels, rets, bars, jumpIdx }) {
  const postLv = levels.slice(jumpIdx + 1);
  const postR = rets.slice(jumpIdx + 1);
  const n = postR.length;
  if (n < 1) return { sessions: 0 };
  const jumpClose = levels[jumpIdx + 1] ?? levels[jumpIdx];
  const preJump = levels[jumpIdx];
  const last = postLv.length ? postLv[postLv.length - 1] : jumpClose;
  const fit = C.robustPathFit(postLv);
  let cum = 1;
  for (const r of postR) cum *= 1 + r;
  const hi = Math.max(...postLv);
  let newHighs = 0, peak = -Infinity;
  for (const v of postLv) { if (v > peak) { peak = v; if (peak >= jumpClose) newHighs++; } }
  const posDays = postR.filter((r) => r > 0).length;

  // Retention: how much of the jump's gain is still held.
  const jumpGain = preJump > 0 ? jumpClose - preJump : null;
  const retention = jumpGain > 0 ? Math.max(0, Math.min(1.5, (last - preJump) / jumpGain)) : null;

  // Bars-only extras: volume trend, range contraction, higher lows, narrow range.
  let volumeTrend = null, rangeContraction = null, higherLowPct = null, narrowRangeSessions = null;
  if (bars && bars.length) {
    const post = bars.slice(jumpIdx + 1);
    const pre = bars.slice(Math.max(0, jumpIdx - post.length), jumpIdx);
    const avg = (arr, f) => {
      const v = arr.map(f).filter(isNum);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    const vPost = avg(post, (b) => b.v), vPre = avg(pre, (b) => b.v);
    volumeTrend = vPre > 0 && vPost != null ? vPost / vPre - 1 : null;
    const rng = (b) => (b.c > 0 && isNum(b.h) && isNum(b.l) ? (b.h - b.l) / b.c : null);
    const rPost = avg(post, rng), rPre = avg(pre, rng);
    rangeContraction = rPre > 0 && rPost != null ? 1 - rPost / rPre : null;
    let hl = 0, hln = 0;
    for (let i = 1; i < post.length; i++) {
      if (isNum(post[i].l) && isNum(post[i - 1].l)) { hln++; if (post[i].l >= post[i - 1].l) hl++; }
    }
    higherLowPct = hln ? hl / hln : null;
    narrowRangeSessions = post.filter((b) => { const r = rng(b); return r != null && r < NARROW_RANGE_PCT; }).length;
  }

  const hiIdx = postLv.lastIndexOf(Math.max(...postLv));
  const dd = (() => { let p = -Infinity, m = 0; for (const v of postLv) { if (v > p) p = v; if (p > 0) m = Math.min(m, v / p - 1); } return m; })();

  return {
    sessions: n,
    cumReturn: cum - 1,
    slope: fit.available ? fit.robustSlope : null,
    fit: fit.available ? fit.olsR2 : null,
    posDayPct: n ? posDays / n : null,
    newHighs,
    daysSinceHigh: postLv.length - 1 - hiIdx,
    distFromJumpClose: jumpClose > 0 ? last / jumpClose - 1 : null,
    distFromJumpMid: preJump > 0 && jumpClose > 0 ? last / ((preJump + jumpClose) / 2) - 1 : null,
    retention,
    maxDrawdown: dd,
    volumeTrend, rangeContraction, higherLowPct, narrowRangeSessions,
  };
}

/**
 * Classify one path window. Input either bars (absolute) or {levels} (index
 * paths); window = sessions to analyze. Returns
 * { state, reasonCodes[], jump: {...}, post: {...}, available }.
 */
function classifyPath({ bars = null, levels = null, window }) {
  const lv = levels
    ? levels.slice(-(window + 1))
    : (bars || []).slice(-(window + 1)).map((b) => b.c);
  if (lv.length < Math.min(window * 0.6, 15)) return { available: false, reason: 'insufficient-history' };
  const rets = retsFromLevels(lv);
  const winBars = bars ? bars.slice(-(window + 1)) : null;

  const conc = C.concentration(rets);
  const gaps = winBars ? C.gapStats(winBars, window) : { available: false };
  const fit = C.robustPathFit(lv);
  let cum = 1;
  for (const r of rets) cum *= 1 + r;
  const totalReturn = cum - 1;

  // Acceleration: recent-half pace minus full pace.
  const half = Math.max(2, Math.floor(rets.length / 2));
  let cumH = 1;
  for (const r of rets.slice(-half)) cumH *= 1 + r;
  const accel = (cumH - 1) / half - totalReturn / rets.length;

  // Largest positive day ⇒ candidate jump.
  let jumpIdx = -1, jumpRet = 0;
  for (let i = 0; i < rets.length; i++) if (rets[i] > jumpRet) { jumpRet = rets[i]; jumpIdx = i; }
  const top1 = conc.available ? conc.top1Share : null;
  const gapTop = gaps.available ? gaps.largestGapContribution : null;
  const jumpDriven = totalReturn > 0 && (
    (top1 != null && top1 >= JUMP.minTop1Share) ||
    (gapTop != null && gapTop >= JUMP.minGapContribution)
  );

  const post = jumpIdx >= 0 ? postEventFeatures({ levels: lv, rets, bars: winBars, jumpIdx }) : { sessions: 0 };
  const hi = Math.max(...lv);
  const distFromHigh = hi > 0 ? lv[lv.length - 1] / hi - 1 : null;
  const slope = fit.available ? fit.robustSlope : null;

  const reasons = [];
  let state;

  if (totalReturn <= 0 && slope != null && slope < 0) {
    state = 'TREND_BROKEN';
    reasons.push('NEGATIVE_WINDOW_RETURN', 'NEGATIVE_ROBUST_SLOPE');
  } else if (distFromHigh != null && distFromHigh <= EXHAUST_DD && accel < -ACCEL_BAND) {
    state = 'EXHAUSTED';
    reasons.push('DEEP_PULLBACK_FROM_HIGH', 'DECELERATING_PACE');
  } else if (jumpDriven) {
    if (top1 != null && top1 >= JUMP.minTop1Share) reasons.push('HIGH_TOP1_CONCENTRATION');
    if (gapTop != null && gapTop >= JUMP.minGapContribution) reasons.push('HIGH_GAP_CONTRIBUTION');
    const constructive =
      (post.retention == null || post.retention >= JUMP.retentionFloor) &&
      (post.higherLowPct == null || post.higherLowPct >= 0.55) &&
      (post.maxDrawdown == null || post.maxDrawdown > -0.10);
    if (post.sessions < JUMP.plateauMinSessions) {
      state = constructive ? 'JUMP_HOLDING' : 'DECELERATING';
      reasons.push('POST_JUMP_WINDOW_SHORT');
      if (!constructive) reasons.push('JUMP_GAIN_NOT_RETAINED');
    } else if (post.slope != null && post.slope > FLAT_SLOPE && post.newHighs > 0) {
      state = 'JUMP_CONTINUING';
      reasons.push('POST_JUMP_NEW_HIGHS', 'POSITIVE_POST_JUMP_SLOPE');
    } else if (constructive) {
      state = 'JUMP_HOLDING';
      reasons.push('GAIN_RETAINED', 'HIGHER_LOWS_INTACT');
      if (post.rangeContraction != null && post.rangeContraction > 0) reasons.push('RANGE_CONTRACTING');
      if (post.volumeTrend != null && post.volumeTrend < 0) reasons.push('VOLUME_CONTRACTING');
    } else {
      state = 'JUMP_PLATEAU';
      reasons.push('FLAT_POST_JUMP_SLOPE', 'FEW_NEW_HIGHS', 'ELAPSED_TIME_SUFFICIENT');
      if (post.higherLowPct != null && post.higherLowPct < 0.55) reasons.push('NO_HIGHER_LOW_PATTERN');
      if (post.volumeTrend != null && post.volumeTrend < -0.2) reasons.push('VOLUME_FADING');
    }
  } else if (accel > ACCEL_BAND && totalReturn > 0) {
    state = 'ACCELERATING';
    reasons.push('RECENT_PACE_ABOVE_TREND');
  } else if (accel < -ACCEL_BAND && totalReturn > 0) {
    state = 'DECELERATING';
    reasons.push('RECENT_PACE_BELOW_TREND');
  } else if (slope != null && Math.abs(slope) <= FLAT_SLOPE && totalReturn > 0) {
    state = 'ORDERLY_PAUSE';
    reasons.push('FLAT_RECENT_SLOPE', 'WINDOW_GAIN_RETAINED');
  } else if (totalReturn > 0) {
    state = 'STEADY_ADVANCE';
    reasons.push('POSITIVE_TREND_WITHOUT_CONCENTRATION');
  } else {
    state = 'ORDERLY_PAUSE';
    reasons.push('FLAT_WINDOW');
  }

  return {
    available: true,
    state,
    reasonCodes: reasons,
    totalReturn,
    accel,
    distFromHigh,
    slope,
    jump: {
      driven: jumpDriven,
      largestDayReturn: jumpIdx >= 0 ? jumpRet : null,
      top1Share: top1,
      largestGapContribution: gapTop,
      index: jumpIdx,
    },
    post,
  };
}

module.exports = { classifyPath, postEventFeatures, STATES };
