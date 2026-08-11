'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — relative leadership. PURE.
//
// Raw relative strength (RS lines vs SPY / sector ETF) is kept SEPARATE from
// beta-adjusted residual leadership (delegated to lib/atlasx-residual via
// lib/rlt-residual — one residual engine in this repo, not two). Residual
// leadership is "stock-specific relative trend" in all user-facing surfaces —
// never called alpha. Missing benchmarks are UNKNOWN + support downgrade,
// never zero. High-beta market passengers are separated from true leaders by
// the residual, not by raw excess return.
// ═══════════════════════════════════════════════════════════════════════════

const RLR = require('../rlt-residual');
const { RESIDUAL_HORIZONS, SPEEDS } = require('./config');
const C = require('./continuity');
const J = require('./jump');

const isNum = (x) => Number.isFinite(x);

// ── RS lines ────────────────────────────────────────────────────────────────

/** Date-aligned ratio line stock/bench → { dates[], levels[] }. */
function rsLine(stockBars, benchBars) {
  const bm = new Map((benchBars || []).map((b) => [b.date, b.c]));
  const dates = [], levels = [];
  for (const b of stockBars || []) {
    const bench = bm.get(b.date);
    if (b.c > 0 && bench > 0) { dates.push(b.date); levels.push(b.c / bench); }
  }
  return { dates, levels };
}

/** Feature bundle for one RS line over one window. */
function rsLineFeatures(line, window) {
  const lv = line.levels.slice(-(window + 1));
  if (lv.length < Math.min(window * 0.6, 15)) return { available: false, window };
  const rets = [];
  for (let i = 1; i < lv.length; i++) rets.push(lv[i - 1] > 0 ? lv[i] / lv[i - 1] - 1 : 0);
  const fit = C.robustPathFit(lv);
  const disc = C.informationDiscreteness(rets);
  const conc = C.concentration(rets);
  const hi = Math.max(...lv);
  const hiIdx = lv.lastIndexOf(hi);
  const half = Math.max(2, Math.floor(rets.length / 2));
  const pace = (arr) => { let c = 1; for (const r of arr) c *= 1 + r; return (c - 1) / arr.length; };
  const wk = [];
  for (let i = rets.length; i - 5 >= 0; i -= 5) { let c = 1; for (const r of rets.slice(i - 5, i)) c *= 1 + r; wk.push(c - 1); }
  return {
    available: true,
    window,
    slope: fit.available ? fit.robustSlope : null,
    fit: fit.available ? fit.olsR2 : null,
    posDayPct: disc.available ? disc.posDayPct : null,
    posWeekPct: wk.length ? wk.filter((x) => x > 0).length / wk.length : null,
    distFromHigh: hi > 0 ? lv[lv.length - 1] / hi - 1 : null,
    daysSinceHigh: lv.length - 1 - hiIdx,
    accel: pace(rets.slice(-half)) - pace(rets),
    top1Share: conc.available ? conc.top1Share : null,
    top3Share: conc.available ? conc.top3Share : null,
    pathState: J.classifyPath({ levels: lv, window }).state || null,
  };
}

// ── Residual leadership ─────────────────────────────────────────────────────

/** Cumulative residual index (level path, base 1) from a daily residual series. */
function residualIndex(series, field = 'residual') {
  const dates = [], levels = [];
  let lvl = 1;
  for (const d of series || []) {
    const r = d[field];
    if (!isNum(r)) continue;
    lvl *= 1 + r;
    dates.push(d.date); levels.push(lvl);
  }
  return { dates, levels };
}

/**
 * Residual bundle for one stock: per-horizon residuals (atlasx engine), the
 * daily residual series and cumulative index, continuity on the residual
 * path, and its jump/plateau state.
 */
function residualLeadership({ bars, spyBars, sectorBars, asOf, window = 130 }) {
  const bundle = RLR.residualBundle({ bars, spyBars, sectorBars: sectorBars || [], asOf, horizons: [...RESIDUAL_HORIZONS] });
  const series = RLR.residualDailySeries({
    bars, spyBars, sectorBars: sectorBars || [], asOf,
    beta: bundle.beta ?? 1,
    sectorLoading: bundle.sectorLoading ?? 0,
    sectorBetaMkt: bundle.sectorBetaMkt ?? 1,
    window,
  });
  const idx = residualIndex(series);
  const mktIdx = residualIndex(series, 'marketResidual');
  const rets = series.map((d) => d.residual).filter(isNum);
  const supported = bundle.beta != null && !bundle.degenerate && (bundle.betaObs ?? 0) >= 20;

  const byHorizon = {};
  for (const h of RESIDUAL_HORIZONS) {
    const bh = bundle.byHorizon?.[h] || {};
    byHorizon[h] = {
      raw: bh.raw ?? null,
      spy: bh.spy ?? null,
      sector: bh.sector ?? null,
      marketRel: isNum(bh.raw) && isNum(bh.spy) ? bh.raw - bh.spy : null,
      sectorRel: isNum(bh.raw) && isNum(bh.sector) ? bh.raw - bh.sector : null,
      expected: bh.expected ?? null,
      residual: bh.residual ?? null,
      partial: bh.partial !== false,
    };
  }

  return {
    beta: bundle.beta ?? null,
    betaObs: bundle.betaObs ?? 0,
    betaShrunk: bundle.betaShrunk ?? true,
    sectorLoading: bundle.sectorLoading ?? null,
    sectorBetaMkt: bundle.sectorBetaMkt ?? null,
    residualVol: bundle.vol ?? null,
    residualAccel: bundle.residualAccel ?? null,
    supported,
    supportBasis: !supported
      ? (bundle.beta != null ? 'market-only-low-obs' : 'unavailable')
      : (bundle.coverage?.sector ? 'market+sector' : 'market-only-no-sector'),
    coverage: bundle.coverage,
    byHorizon,
    continuity21: C.continuityBundle({ rets, levels: idx.levels, window: 21 }),
    continuity63: C.continuityBundle({ rets, levels: idx.levels, window: 63 }),
    pathState63: idx.levels.length ? J.classifyPath({ levels: idx.levels, window: Math.min(63, idx.levels.length - 1) }) : { available: false },
    index: idx,
    marketOnlyIndex: mktIdx,
    seriesLength: series.length,
  };
}

// ── Speed states (fast / intermediate / slow) ───────────────────────────────

function speedDirection(slope) {
  if (!isNum(slope)) return 'UNKNOWN';
  if (slope > 0.0006) return 'UP';
  if (slope < -0.0006) return 'DOWN';
  return 'FLAT';
}

/** One speed state from horizon features (absolute or residual). */
function speedState(byHorizon, horizons) {
  const fs = horizons.map((h) => byHorizon[h]).filter((f) => f && f.available !== false);
  if (!fs.length) return { available: false };
  const avg = (sel) => {
    const v = fs.map(sel).filter(isNum);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const slope = avg((f) => f.slope);
  return {
    available: true,
    direction: speedDirection(slope),
    slope,
    fit: avg((f) => f.fit),
    accel: avg((f) => f.accel),
    maxDrawdown: avg((f) => f.maxDrawdown),
    distFromHigh: avg((f) => f.distFromHigh),
    posDayPct: avg((f) => f.posDayPct),
    support: fs.length / horizons.length,
  };
}

const SPEED_COMBO = Object.freeze({
  'UP|UP': 'HEALTHY_CONTINUATION',
  'UP|FLAT': 'ORDERLY_PAUSE_OR_EMERGING_PLATEAU',
  'UP|DOWN': 'DETERIORATION_WARNING',
  'FLAT|UP': 'EMERGING_LEADER',
  'DOWN|UP': 'REBOUND_NOT_ESTABLISHED',
  'DOWN|DOWN': 'AVOID',
  'FLAT|FLAT': 'DORMANT',
  'FLAT|DOWN': 'FADING',
  'DOWN|FLAT': 'BASING_ATTEMPT',
});

function speedStates(byHorizon) {
  const fast = speedState(byHorizon, SPEEDS.fast);
  const intermediate = speedState(byHorizon, SPEEDS.intermediate);
  const slow = speedState(byHorizon, SPEEDS.slow);
  const key = `${slow.direction || 'UNKNOWN'}|${fast.direction || 'UNKNOWN'}`;
  return { fast, intermediate, slow, interpretation: SPEED_COMBO[key] || 'UNKNOWN' };
}

// ── Leadership quadrants ────────────────────────────────────────────────────

const QUADRANTS = Object.freeze(['TRUE_LEADER', 'DEFENSIVE_LEADER', 'MARKET_CARRIED_LAGGARD', 'AVOID']);
const STAGES = Object.freeze([
  'EMERGING_LEADER', 'CONFIRMED_LEADER', 'PERSISTENT_LEADER', 'ACCELERATING_LEADER',
  'ORDERLY_PAUSE', 'EXTENDED_LEADER', 'LOSING_LEADERSHIP', 'BROKEN_LEADERSHIP',
]);

/**
 * Primary quadrant on the intermediate horizon (21+63 blend).
 * A name that merely FELL LESS than SPY (positive relative, negative absolute)
 * is DEFENSIVE_LEADER — the entry layer must never mark it a buy.
 * A rising name whose residual is weak/negative is MARKET_CARRIED_LAGGARD.
 */
function classifyQuadrant({ absReturn, marketRel, sectorRel, residual, continuityOk, residualSupported }) {
  const reasons = [];
  const absUp = isNum(absReturn) && absReturn > 0;
  const relUp = isNum(marketRel) && marketRel > 0;
  const secUp = sectorRel == null ? null : sectorRel > 0;
  const resUp = isNum(residual) && residual > 0;

  let quadrant;
  if (absUp && relUp && (secUp !== false) && resUp && residualSupported) {
    if (continuityOk === false) { reasons.push('CONTINUITY_WEAK'); }
    quadrant = 'TRUE_LEADER';
    reasons.push('ABS_UP', 'MARKET_REL_UP', secUp == null ? 'SECTOR_UNKNOWN' : 'SECTOR_REL_UP', 'RESIDUAL_UP');
  } else if (!absUp && relUp) {
    quadrant = 'DEFENSIVE_LEADER';
    reasons.push('ABS_FLAT_OR_DOWN', 'HOLDING_UP_VS_MARKET', 'NOT_A_LONG_MOMENTUM_SIGNAL');
  } else if (absUp && (!resUp || !residualSupported)) {
    quadrant = 'MARKET_CARRIED_LAGGARD';
    reasons.push('ABS_UP', residualSupported ? 'RESIDUAL_WEAK_OR_NEGATIVE' : 'RESIDUAL_UNSUPPORTED');
    if (secUp === false) reasons.push('BELOW_SECTOR_EXPECTATION');
  } else if (absUp && resUp) {
    // abs up, residual up, but market-rel not positive (e.g. sector-led tape)
    quadrant = 'TRUE_LEADER';
    reasons.push('ABS_UP', 'RESIDUAL_UP', 'MARKET_REL_MIXED');
  } else {
    quadrant = 'AVOID';
    reasons.push('ABS_AND_RELATIVE_WEAK');
  }
  return { quadrant, reasons };
}

/** Secondary stage from trend age, path state, extension and trajectory. */
function classifyStage({ quadrant, pathState, trendAgeSessions, extensionAtr, residualAccel, absSlope }) {
  if (quadrant === 'AVOID') return 'BROKEN_LEADERSHIP';
  if (pathState === 'TREND_BROKEN') return 'BROKEN_LEADERSHIP';
  if (pathState === 'EXHAUSTED' || (isNum(extensionAtr) && extensionAtr >= 5)) return 'EXTENDED_LEADER';
  if (pathState === 'DECELERATING' || (isNum(residualAccel) && residualAccel < -0.002)) return 'LOSING_LEADERSHIP';
  if (pathState === 'ORDERLY_PAUSE' || pathState === 'JUMP_HOLDING') return 'ORDERLY_PAUSE';
  if (pathState === 'ACCELERATING') return 'ACCELERATING_LEADER';
  if (isNum(trendAgeSessions) && trendAgeSessions >= 126) return 'PERSISTENT_LEADER';
  if (isNum(trendAgeSessions) && trendAgeSessions >= 42) return 'CONFIRMED_LEADER';
  return 'EMERGING_LEADER';
}

module.exports = {
  rsLine, rsLineFeatures, residualIndex, residualLeadership,
  speedState, speedStates, SPEED_COMBO,
  classifyQuadrant, classifyStage, QUADRANTS, STAGES,
};
