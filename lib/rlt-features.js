// ═══════════════════════════════════════════════════════════════════════════
// RLT feature construction — path quality, turnover-conditioned momentum,
// absorption proxies, setup/extension. Versioned schema rlt-features-v1.
//
// Honesty rules enforced here:
//   • Missing inputs stay missing (null) and are listed in `missing` — never
//     imputed as bullish evidence, never coerced with !! into booleans.
//   • Absorption features are explicitly OHLCV PROXIES — labeled experimental,
//     not proof of institutional accumulation.
//   • Turnover and momentum interact — they are not independent bullish votes.
//
// Pure module: consumes bars (toBars shape {date,o,h,l,c,v}) and the residual
// daily series from rlt-leadership; performs no I/O.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, LEADERSHIP } = require('./rlt-config');

const PATH_WINDOW = 21;
const TURNOVER_WINDOW = 63;
const PIVOT_LOOKBACK = 20;
// Barrier geometry mirrors ATLAS-X BARRIERS so remaining-RR is comparable.
const TARGET_ATR = 1.5;
const STOP_ATR = 1.0;

function fin(v) { return Number.isFinite(v) ? v : null; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function atr14(bars) {
  const n = bars.length;
  if (n < 15) return null;
  const trs = [];
  for (let i = n - 14; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    if (!(b.h > 0) || !(b.l > 0) || !(p.c > 0)) return null;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  return mean(trs);
}

function closeLoc(b) {
  if (!(b.h > 0) || !(b.l > 0) || b.h <= b.l) return null;
  return (b.c - b.l) / (b.h - b.l);
}

function upperWickShare(b) {
  if (!(b.h > 0) || !(b.l > 0) || b.h <= b.l) return null;
  return (b.h - Math.max(b.c, b.o || b.c)) / (b.h - b.l);
}

function lowerWickShare(b) {
  if (!(b.h > 0) || !(b.l > 0) || b.h <= b.l) return null;
  return (Math.min(b.c, b.o || b.c) - b.l) / (b.h - b.l);
}

// ─── Path quality over the residual daily series ────────────────────────────
function pathQuality(series, bars) {
  const missing = [];
  const rs = series.slice(-PATH_WINDOW).map(x => x.residual).filter(Number.isFinite);
  const out = {};

  if (rs.length >= 10) {
    out.fracPositiveResidualSessions = rs.filter(r => r > 0).length / rs.length;
    // Trend fit: R² of cumulative residual vs time.
    let cum = 0;
    const ys = rs.map(r => (cum += r));
    const n = ys.length, xm = (n - 1) / 2, ym = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xm) * (ys[i] - ym); sxx += (i - xm) ** 2; syy += (ys[i] - ym) ** 2; }
    out.residualTrendFit = syy > 0 ? (sxy * sxy) / (sxx * syy) : null;
    // Smoothness: |sum| / Σ|daily| (path efficiency, 1 = perfectly one-way).
    const absSum = rs.reduce((s, r) => s + Math.abs(r), 0);
    out.smoothness = absSum > 0 ? Math.abs(rs.reduce((s, r) => s + r, 0)) / absSum : null;
    out.spikeShare = absSum > 0 ? Math.max(...rs.map(Math.abs)) / absSum : null;
    const total = rs.reduce((s, r) => s + r, 0);
    out.largestDayContribution = total > 0 ? Math.max(...rs) / total : null;
  } else {
    missing.push('residualPath');
    out.fracPositiveResidualSessions = null;
    out.residualTrendFit = null;
    out.smoothness = null;
    out.spikeShare = null;
    out.largestDayContribution = null;
  }

  const w = bars.slice(-PATH_WINDOW);
  const haveOHLC = w.length >= 10 && w.every(b => b.h > 0 && b.l > 0 && b.o > 0);
  if (haveOHLC) {
    // Gap dependence: share of total move that occurred overnight.
    let gapMove = 0, totalMove = 0;
    for (let i = 1; i < w.length; i++) {
      gapMove += w[i].o - w[i - 1].c;
      totalMove += w[i].c - w[i - 1].c;
    }
    out.gapDependence = Math.abs(totalMove) > 1e-9 ? gapMove / totalMove : null;
    const locs = w.slice(-10).map(closeLoc).filter(Number.isFinite);
    const prevLocs = w.slice(0, -10).map(closeLoc).filter(Number.isFinite);
    out.closeLocationTrend = (locs.length >= 5 && prevLocs.length >= 5)
      ? mean(locs) - mean(prevLocs) : null;
    const wickShares = w.slice(-5).map(upperWickShare).filter(Number.isFinite);
    out.upperWickSequence = wickShares.length ? wickShares.filter(x => x > 0.5).length : null;
    // Higher-low persistence: fraction of rolling 3-bar lows that rose.
    let rising = 0, checks = 0;
    for (let i = 5; i < w.length; i++) {
      const lo = Math.min(w[i].l, w[i - 1].l, w[i - 2].l);
      const prevLo = Math.min(w[i - 3].l, w[i - 4].l, w[i - 5].l);
      checks++; if (lo > prevLo) rising++;
    }
    out.higherLowPersistence = checks ? rising / checks : null;
    // Pullback depth / recovery speed relative to the window high.
    const highs = w.map(b => b.c);
    const peak = Math.max(...highs);
    const peakIdx = highs.lastIndexOf(peak);
    const last = w[w.length - 1].c;
    out.pullbackDepth = peak > 0 ? (peak - last) / peak : null;
    out.sessionsSincePeak = w.length - 1 - peakIdx;
  } else {
    missing.push('ohlc');
    out.gapDependence = null;
    out.closeLocationTrend = null;
    out.upperWickSequence = null;
    out.higherLowPersistence = null;
    out.pullbackDepth = null;
    out.sessionsSincePeak = null;
  }

  return { features: out, missing };
}

// ─── Turnover-conditioned momentum (interactions, not independent votes) ────
function turnoverFeatures(bars, series) {
  const missing = [];
  const out = {};
  const w = bars.slice(-TURNOVER_WINDOW);
  const dollar = w.map(b => (b.v > 0 && b.c > 0 ? b.v * b.c : null));
  const valid = dollar.filter(Number.isFinite);
  if (valid.length < 30) {
    missing.push('turnover');
    return {
      features: {
        turnoverPctile: null, residTimesTurnover: null, persistentResidOnTurnover: null,
        lowTurnoverDrift: null, turnoverAccel: null, abnormalDollarVol: null,
        pullbackVolumeContraction: null, breakoutParticipation: null, volumePriceDisagreement: null,
      },
      missing,
    };
  }

  const today = dollar[dollar.length - 1];
  out.turnoverPctile = Number.isFinite(today)
    ? valid.filter(v => v <= today).length / valid.length : null;
  const med = median(valid);

  const resid10 = series.slice(-10).map(x => x.residual).filter(Number.isFinite);
  const r10sum = resid10.length >= 5 ? resid10.reduce((s, r) => s + r, 0) : null;
  out.residTimesTurnover = (r10sum != null && out.turnoverPctile != null)
    ? r10sum * out.turnoverPctile : null;

  // Persistent positive residual on elevated turnover: share of the last 10
  // sessions where residual > 0 AND that session's turnover beat the median.
  const last10 = series.slice(-10);
  const barByDate = new Map(w.map(b => [b.date, b]));
  let hits = 0, obs = 0;
  for (const s of last10) {
    const b = barByDate.get(s.date);
    if (!b || !(b.v > 0) || !Number.isFinite(s.residual) || med == null) continue;
    obs++;
    if (s.residual > 0 && b.v * b.c > med) hits++;
  }
  out.persistentResidOnTurnover = obs >= 5 ? hits / obs : null;

  // Low-turnover drift: 10-session residual accrued on BELOW-median turnover.
  out.lowTurnoverDrift = (r10sum != null && out.turnoverPctile != null && out.turnoverPctile < 0.4)
    ? r10sum : null;

  const vol5 = mean(w.slice(-5).map(b => b.v).filter(v => v > 0));
  const vol20 = mean(w.slice(-20).map(b => b.v).filter(v => v > 0));
  out.turnoverAccel = (vol5 != null && vol20 > 0) ? vol5 / vol20 : null;
  out.abnormalDollarVol = (today != null && med > 0) ? today / med : null;

  // Pullback volume contraction: down-day volume vs up-day volume, last 10.
  const recent = w.slice(-10);
  const downV = [], upV = [];
  for (let i = 1; i < recent.length; i++) {
    const b = recent[i], p = recent[i - 1];
    if (!(b.v > 0) || !(p.c > 0)) continue;
    (b.c < p.c ? downV : upV).push(b.v);
  }
  out.pullbackVolumeContraction = (downV.length >= 2 && upV.length >= 2 && mean(upV) > 0)
    ? mean(downV) / mean(upV) : null;

  // Breakout participation: volume on the largest up-day of the last 10 vs 20d mean.
  let bestUp = null, bestUpVol = null;
  for (let i = 1; i < recent.length; i++) {
    const b = recent[i], p = recent[i - 1];
    if (!(p.c > 0) || !(b.v > 0)) continue;
    const r = b.c / p.c - 1;
    if (bestUp == null || r > bestUp) { bestUp = r; bestUpVol = b.v; }
  }
  out.breakoutParticipation = (bestUpVol != null && vol20 > 0) ? bestUpVol / vol20 : null;

  // Volume/price disagreement: 5d price direction vs 5d volume trend direction.
  const ret5 = (w.length >= 6 && w[w.length - 6].c > 0)
    ? w[w.length - 1].c / w[w.length - 6].c - 1 : null;
  const volTrend = (vol5 != null && vol20 > 0) ? vol5 / vol20 - 1 : null;
  out.volumePriceDisagreement = (ret5 != null && volTrend != null)
    ? (Math.sign(ret5) !== Math.sign(volTrend) ? Math.abs(ret5) : 0) : null;

  return { features: out, missing };
}

// ─── Absorption proxies (EXPERIMENTAL — OHLCV proxies only) ─────────────────
function absorptionFeatures(bars) {
  const missing = [];
  const w = bars.slice(-PATH_WINDOW);
  const ok = w.length >= 15 && w.every(b => b.v > 0 && b.h > 0 && b.l > 0);
  if (!ok) {
    missing.push('absorption');
    return {
      features: {
        downImpactPerVolume: null, upImpactPerVolume: null, decliningDownImpact: null,
        absorptionRatio: null, supplyDryUp: null, closeLocImprovement: null, wickAsymmetry: null,
      },
      missing, experimental: true,
    };
  }
  const volMean = mean(w.map(b => b.v));
  const impacts = [];   // {down: bool, impact: |ret| / relVol}
  for (let i = 1; i < w.length; i++) {
    const b = w[i], p = w[i - 1];
    if (!(p.c > 0)) continue;
    const r = b.c / p.c - 1;
    const relVol = b.v / volMean;
    if (relVol <= 0) continue;
    impacts.push({ down: r < 0, impact: Math.abs(r) / relVol, idx: i, vol: b.v });
  }
  const down = impacts.filter(x => x.down), up = impacts.filter(x => !x.down);
  const downImpact = down.length >= 3 ? mean(down.map(x => x.impact)) : null;
  const upImpact = up.length >= 3 ? mean(up.map(x => x.impact)) : null;
  const half = Math.floor(w.length / 2);
  const downEarly = down.filter(x => x.idx < half), downLate = down.filter(x => x.idx >= half);
  const decliningDownImpact = (downEarly.length >= 2 && downLate.length >= 2)
    ? mean(downEarly.map(x => x.impact)) - mean(downLate.map(x => x.impact)) : null;
  const downVolLate = mean(w.slice(-5).filter((b, i, arr) => i > 0 && b.c < arr[i - 1].c).map(b => b.v));
  const downVolEarly = mean(w.slice(0, -5).filter((b, i, arr) => i > 0 && b.c < arr[i - 1].c).map(b => b.v));
  const locs5 = w.slice(-5).map(closeLoc).filter(Number.isFinite);
  const locs10 = w.slice(-15, -5).map(closeLoc).filter(Number.isFinite);
  const lw = w.slice(-10).map(lowerWickShare).filter(Number.isFinite);
  const uw = w.slice(-10).map(upperWickShare).filter(Number.isFinite);
  return {
    features: {
      downImpactPerVolume: fin(downImpact),
      upImpactPerVolume: fin(upImpact),
      decliningDownImpact: fin(decliningDownImpact),
      absorptionRatio: (downImpact != null && upImpact > 0) ? downImpact / upImpact : null,
      supplyDryUp: (downVolLate != null && downVolEarly > 0) ? downVolLate / downVolEarly : null,
      closeLocImprovement: (locs5.length >= 3 && locs10.length >= 3) ? mean(locs5) - mean(locs10) : null,
      wickAsymmetry: (lw.length >= 5 && uw.length >= 5) ? mean(lw) - mean(uw) : null,
    },
    missing, experimental: true,
  };
}

// ─── Setup, extension and remaining-opportunity ─────────────────────────────
function setupFeatures(bars) {
  const missing = [];
  const n = bars.length;
  const atr = atr14(bars);
  const last = n ? bars[n - 1] : null;
  if (!atr || !last || !(last.c > 0)) {
    missing.push('setup');
    return {
      features: {
        atr: null, pivot: null, distanceToPivotAtr: null, pivotAge: null, baseDuration: null,
        compressionPctile: null, compressionDuration: null, compressionDelta1: null, compressionDelta2: null,
        breakoutAttempts: null, breakoutRejections: null,
        distAbove20MaAtr: null, distAbove50MaAtr: null,
        consumedRangePosition: null, remainingRR: null, parabolicAcceleration: null,
        extensionState: 'unknown',
      },
      missing,
    };
  }
  const out = { atr };

  // Pivot: highest high over the prior PIVOT_LOOKBACK sessions (excluding today).
  const prior = bars.slice(-(PIVOT_LOOKBACK + 1), -1);
  const highsOk = prior.length >= 10 && prior.every(b => b.h > 0);
  if (highsOk) {
    const pivot = Math.max(...prior.map(b => b.h));
    const pivotIdx = prior.map(b => b.h).lastIndexOf(pivot);
    out.pivot = pivot;
    out.distanceToPivotAtr = (pivot - last.c) / atr;
    out.pivotAge = prior.length - 1 - pivotIdx;
    // Base duration: consecutive sessions closing within 1.5 ATR below the pivot.
    let base = 0;
    for (let i = n - 1; i >= Math.max(0, n - 63); i--) {
      const c = bars[i].c;
      if (c <= pivot && c >= pivot - 1.5 * atr * 2) base++;
      else break;
    }
    out.baseDuration = base;
    // Breakout attempts/rejections over the last 21 sessions.
    let attempts = 0, rejections = 0;
    for (const b of bars.slice(-21)) {
      if (b.h >= pivot * 0.995) {
        attempts++;
        if (b.c < pivot) rejections++;
      }
    }
    out.breakoutAttempts = attempts;
    out.breakoutRejections = rejections;
  } else {
    missing.push('pivot');
    out.pivot = null; out.distanceToPivotAtr = null; out.pivotAge = null;
    out.baseDuration = null; out.breakoutAttempts = null; out.breakoutRejections = null;
  }

  // Compression: 10-day range vs its own trailing 63-day distribution.
  const ranges = [];
  for (let i = 10; i <= n; i++) {
    const wnd = bars.slice(i - 10, i);
    if (!wnd.every(b => b.h > 0 && b.l > 0)) continue;
    const hi = Math.max(...wnd.map(b => b.h)), lo = Math.min(...wnd.map(b => b.l));
    if (lo > 0) ranges.push({ idx: i - 1, val: (hi - lo) / lo });
  }
  const recentRanges = ranges.slice(-TURNOVER_WINDOW);
  if (recentRanges.length >= 30) {
    const cur = recentRanges[recentRanges.length - 1].val;
    const vals = recentRanges.map(r => r.val);
    out.compressionPctile = vals.filter(v => v >= cur).length / vals.length;  // high = compressed
    const medR = median(vals);
    let dur = 0;
    for (let i = recentRanges.length - 1; i >= 0; i--) {
      if (recentRanges[i].val < medR) dur++;
      else break;
    }
    out.compressionDuration = dur;
    const m = recentRanges.length;
    out.compressionDelta1 = m >= 2 ? recentRanges[m - 1].val - recentRanges[m - 2].val : null;
    out.compressionDelta2 = m >= 3
      ? (recentRanges[m - 1].val - recentRanges[m - 2].val) - (recentRanges[m - 2].val - recentRanges[m - 3].val)
      : null;
  } else {
    missing.push('compression');
    out.compressionPctile = null; out.compressionDuration = null;
    out.compressionDelta1 = null; out.compressionDelta2 = null;
  }

  // Extension vs moving averages, in ATR units.
  const closes = bars.map(b => b.c);
  const ma = (k) => (closes.length >= k ? mean(closes.slice(-k)) : null);
  const ma20 = ma(20), ma50 = ma(50);
  out.distAbove20MaAtr = ma20 != null ? (last.c - ma20) / atr : null;
  out.distAbove50MaAtr = ma50 != null ? (last.c - ma50) / atr : null;

  // Consumed move: position inside the trailing 21-session range (0..1).
  const w21 = bars.slice(-21);
  const hi21 = Math.max(...w21.map(b => (b.h > 0 ? b.h : b.c)));
  const lo21 = Math.min(...w21.map(b => (b.l > 0 ? b.l : b.c)));
  out.consumedRangePosition = hi21 > lo21 ? (last.c - lo21) / (hi21 - lo21) : null;

  // Remaining reward/risk to a pivot-anchored target (ATLAS-X barrier geometry).
  if (out.pivot != null) {
    const target = out.pivot + TARGET_ATR * atr;
    const stop = last.c - STOP_ATR * atr;
    out.remainingRR = (last.c - stop) > 0 ? (target - last.c) / (last.c - stop) : null;
  } else {
    out.remainingRR = null;
  }

  // Parabolic acceleration: 5-session return measured in ATR units.
  const ret5Abs = (n >= 6 && bars[n - 6].c > 0) ? last.c - bars[n - 6].c : null;
  out.parabolicAcceleration = ret5Abs != null ? ret5Abs / (atr * Math.sqrt(5)) : null;

  out.extensionState =
    out.distAbove20MaAtr == null ? 'unknown'
      : out.distAbove20MaAtr > LEADERSHIP.maxExtensionAtr20 ? 'extended'
      : out.distAbove20MaAtr > LEADERSHIP.maxExtensionAtr20 * 0.66 ? 'stretched'
      : 'normal';

  return { features: out, missing };
}

// ─── Catalyst masks (only genuinely timestamped PIT information) ────────────
function catalystFeatures(catalyst) {
  if (!catalyst || typeof catalyst !== 'object' || catalyst.tsUnix == null) {
    return {
      features: {
        hasCatalyst: null, catalystAgeDays: null, insideHoldingWindow: null,
        earningsSurprise: null, catalystState: 'unknown',
      },
      missing: ['catalyst'],
    };
  }
  const ageDays = Number.isFinite(catalyst.ageDays) ? catalyst.ageDays : null;
  return {
    features: {
      hasCatalyst: true,
      catalystAgeDays: ageDays,
      insideHoldingWindow: ageDays != null ? ageDays <= 10 : null,
      earningsSurprise: fin(catalyst.surprise),
      catalystState: ageDays == null ? 'unknown' : ageDays > 20 ? 'stale' : 'fresh',
    },
    missing: [],
  };
}

/**
 * Assemble the full RLT feature record for one ticker.
 * `series` = residual daily series from rlt-leadership.seriesByTicker.
 */
function computeRltFeatures({ bars = [], series = [], catalyst = null } = {}) {
  const path = pathQuality(series, bars);
  const turnover = turnoverFeatures(bars, series);
  const absorption = absorptionFeatures(bars);
  const setup = setupFeatures(bars);
  const cat = catalystFeatures(catalyst);
  return Object.freeze({
    version: VERSIONS.features,
    path: Object.freeze(path.features),
    turnover: Object.freeze(turnover.features),
    absorption: Object.freeze({ ...absorption.features, experimental: true }),
    setup: Object.freeze(setup.features),
    catalyst: Object.freeze(cat.features),
    missing: Object.freeze([
      ...path.missing, ...turnover.missing, ...absorption.missing,
      ...setup.missing, ...cat.missing,
    ]),
  });
}

module.exports = {
  computeRltFeatures, pathQuality, turnoverFeatures, absorptionFeatures,
  setupFeatures, catalystFeatures, atr14,
  PATH_WINDOW, TURNOVER_WINDOW, TARGET_ATR, STOP_ATR,
};
