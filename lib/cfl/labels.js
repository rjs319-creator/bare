'use strict';
// CFL — OPPORTUNITY LABELS (path-based + cross-sectional). Pure; no network/store.
//
// Path labels answer "did the upside barrier hit before the downside barrier,
// starting from an EXECUTABLE entry?" with volatility-adjusted barriers computed
// only from information available at the decision timestamp. Cross-sectional
// labels answer "was this one of the period's genuinely large, liquid,
// executable winners relative to the cohort?" — the two label families the
// missed-winner sweep and the dud grader both consume.
//
// Entry honesty: barriers resolve from the NEXT session's fill (lib/execution-policy,
// exec-v1) — never the signal close. Overnight gaps are classified so a move that
// existed only at an unavailable price is never credited as a missed opportunity.

const { planFill, POLICIES } = require('../execution-policy');
const CFG = require('./config');

// Decision-time ATR% (mean true range over `n` bars ending at decisionIdx, as %
// of the decision close). Uses only bars ≤ decisionIdx — nothing forward.
function atrPctAt(candles, decisionIdx, n = 14) {
  if (!Array.isArray(candles) || decisionIdx < 1) return null;
  const from = Math.max(1, decisionIdx - n + 1);
  let sum = 0, cnt = 0;
  for (let i = from; i <= decisionIdx; i++) {
    const b = candles[i], prev = candles[i - 1];
    if (!b || !prev || !(prev.close > 0)) continue;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    sum += tr / prev.close; cnt++;
  }
  const close = candles[decisionIdx] && candles[decisionIdx].close;
  if (!cnt || !(close > 0)) return null;
  return +(100 * (sum / cnt)).toFixed(3);
}

// Volatility-adjusted barrier distances for a horizon, from decision-time facts only.
// Returns percent distances plus the basis used (so a fallback is visible, never silent).
function barriersFor({ atrPct, horizonKey } = {}) {
  const h = CFG.HORIZONS[horizonKey];
  if (!h || h.dataSupport !== 'full') return null;
  const basis = Number.isFinite(atrPct) && atrPct > 0 ? 'atr' : 'fallback-atr';
  const a = basis === 'atr' ? atrPct : CFG.FALLBACK_ATR_PCT;
  const scale = a * Math.sqrt(h.sessions);
  return Object.freeze({
    labelVersion: CFG.LABEL_VERSION, horizon: horizonKey, sessions: h.sessions,
    upPct: +Math.max(CFG.MIN_BARRIER_UP_PCT, h.kUp * scale).toFixed(2),
    downPct: +Math.max(CFG.MIN_BARRIER_DOWN_PCT, h.kDown * scale).toFixed(2),
    atrPct: a, atrBasis: basis,
  });
}

// Overnight-gap classification at the entry: separates "predictable before the
// gap" from "only available at a price nobody could get". overnightShare is the
// fraction of the horizon's total return earned across overnight gaps.
function classifyGap({ candles, decisionIdx, horizonSessions } = {}) {
  const dBar = candles && candles[decisionIdx];
  const nBar = candles && candles[decisionIdx + 1];
  if (!dBar || !nBar || !(dBar.close > 0)) return { class: 'unavailable', gapPct: null, overnightShare: null };
  const gapPct = +((nBar.open / dBar.close - 1) * 100).toFixed(2);
  const last = Math.min(candles.length - 1, decisionIdx + horizonSessions);
  let overnight = 0, total = 0;
  for (let i = decisionIdx + 1; i <= last; i++) {
    const prev = candles[i - 1];
    if (!(prev.close > 0) || !(candles[i].open > 0)) continue;
    overnight += Math.log(candles[i].open / prev.close);
    total += Math.log(candles[i].close / prev.close);
  }
  const overnightShare = total !== 0 ? +(overnight / total).toFixed(3) : null;
  let cls = 'no-gap';
  if (Math.abs(gapPct) >= CFG.CROSS_SECTION.minGapPctForClass) cls = 'entry-gap';
  if (overnightShare != null && overnightShare > CFG.CROSS_SECTION.gapDominantShare && total > 0) cls = 'gap-dominant';
  return { class: cls, gapPct, overnightShare };
}

// Resolve the path from a fill: which barrier hit first, when, and the excursions.
// Same-bar ambiguity resolves to the STOP (conservative — matches lib/outcome.js).
function resolveBarrierPath({ candles, fillIdx, fillPrice, upPct, downPct, horizonSessions } = {}) {
  if (!Number.isFinite(fillIdx) || !(fillPrice > 0)) return { outcome: 'no-fill' };
  const target = fillPrice * (1 + upPct / 100);
  const stop = fillPrice * (1 - downPct / 100);
  const last = candles.length - 1;
  const end = fillIdx + horizonSessions;
  let mae = 0, mfe = 0, hit = null, timeToTarget = null, timeToStop = null;
  for (let i = fillIdx; i <= end && i <= last; i++) {
    const b = candles[i];
    mae = Math.min(mae, b.low / fillPrice - 1);
    mfe = Math.max(mfe, b.high / fillPrice - 1);
    if (!hit) {
      if (b.low <= stop) { hit = 'stop'; timeToStop = i - fillIdx; }
      else if (b.high >= target) { hit = 'target'; timeToTarget = i - fillIdx; }
    }
  }
  const matured = end <= last;
  const closeIdx = Math.min(end, last);
  const closingReturn = +(candles[closeIdx].close / fillPrice - 1).toFixed(4);
  const outcome = hit === 'target' ? 'target-before-stop'
    : hit === 'stop' ? 'stop-before-target'
    : matured ? 'neither-stagnant' : 'pending';
  return {
    outcome, matured,
    targetPrice: +target.toFixed(4), stopPrice: +stop.toFixed(4),
    timeToTarget, timeToStop,
    mae: +mae.toFixed(4), mfe: +mfe.toFixed(4),
    closingReturn, closeDate: candles[closeIdx] ? candles[closeIdx].date : null,
  };
}

// Benchmark leg on the SAME entry basis (next-session open → close at decision+H).
function benchmarkForward(benchCandles, decisionDate, horizonSessions) {
  if (!Array.isArray(benchCandles)) return null;
  const i = benchCandles.findIndex(b => b.date === decisionDate);
  if (i < 0 || !benchCandles[i + 1] || i + horizonSessions > benchCandles.length - 1) return null;
  const a = benchCandles[i + 1], b = benchCandles[i + horizonSessions];
  return a.open > 0 ? +(b.close / a.open - 1).toFixed(4) : null;
}

// Full path label for one (symbol, checkpoint, horizon): executable entry, barriers,
// path resolution, gap classification, benchmark/sector relatives. Never fabricates:
// a missing next session yields outcome 'no-fill', a short window yields 'pending'.
function pathLabel({ candles, decisionDate, horizonKey, spyCandles = null, sectorCandles = null, tier = 'liquid' } = {}) {
  const h = CFG.HORIZONS[horizonKey];
  if (!h || h.dataSupport !== 'full') return { ok: false, reason: 'unsupported-horizon' };
  const decisionIdx = candles ? candles.findIndex(b => b.date === decisionDate) : -1;
  if (decisionIdx < 0) return { ok: false, reason: 'no-decision-bar' };
  const atrPct = atrPctAt(candles, decisionIdx);
  const barriers = barriersFor({ atrPct, horizonKey });
  const fill = planFill(candles, decisionDate, { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', tier });
  if (!fill.filled || fill.fillIdx == null) {
    return { ok: true, labelVersion: CFG.LABEL_VERSION, horizon: horizonKey, outcome: 'no-fill', reason: fill.fillReason || 'no-fill', barriers, timestamps: fill.timestamps };
  }
  const path = resolveBarrierPath({
    candles, fillIdx: fill.fillIdx, fillPrice: fill.fillPrice,
    upPct: barriers.upPct, downPct: barriers.downPct, horizonSessions: h.sessions,
  });
  const gap = classifyGap({ candles, decisionIdx, horizonSessions: h.sessions });
  const benchReturn = benchmarkForward(spyCandles, decisionDate, h.sessions);
  const sectorReturn = benchmarkForward(sectorCandles, decisionDate, h.sessions);
  const rawReturn = path.closingReturn;
  return {
    ok: true, labelVersion: CFG.LABEL_VERSION, horizon: horizonKey,
    decisionDate, entryPrice: fill.fillPrice, entryDate: candles[fill.fillIdx].date,
    earliestExecutableAt: fill.timestamps.earliestExecutableAt,
    barriers, gap,
    ...path,
    rawReturn,
    benchmarkReturn: benchReturn,
    excessReturn: (rawReturn != null && benchReturn != null) ? +(rawReturn - benchReturn).toFixed(4) : null,
    sectorReturn,
    sectorExcess: (rawReturn != null && sectorReturn != null) ? +(rawReturn - sectorReturn).toFixed(4) : null,
    bigMove: barriers && path.mfe != null
      ? path.mfe * 100 >= h.bigMoveAtr * barriers.atrPct * Math.sqrt(h.sessions)
      : false,
  };
}

// Cross-sectional labels over one checkpoint's cohort. rows: [{symbol, excessReturn,
// dollarVol, gapClass, outcome}]. Ranks by excess (benchmark-residual) return; flags
// the configured top percentile and the largest LIQUID winners; separates moves that
// were gap-dominant (not actionable at the assumed entry) from executable ones.
function crossSectionLabels(rows = []) {
  const scored = rows.filter(r => Number.isFinite(r.excessReturn));
  const sorted = [...scored].sort((a, b) => a.excessReturn - b.excessReturn);
  const n = sorted.length;
  const rankOf = new Map(sorted.map((r, i) => [r.symbol, i]));
  const liquidWinners = [...scored]
    .filter(r => (r.dollarVol || 0) >= CFG.CROSS_SECTION.minDollarVol)
    .sort((a, b) => b.excessReturn - a.excessReturn)
    .slice(0, CFG.CROSS_SECTION.largestWinnerCount);
  const winnerSet = new Set(liquidWinners.map(r => r.symbol));
  return rows.map(r => {
    const rank = rankOf.has(r.symbol) ? rankOf.get(r.symbol) : null;
    const pctile = (rank != null && n > 1) ? +(rank / (n - 1)).toFixed(3) : null;
    const executable = r.gapClass !== 'gap-dominant' && r.gapClass !== 'unavailable' && r.outcome !== 'no-fill';
    return Object.freeze({
      symbol: r.symbol,
      residualRank: rank, residualPctile: pctile, cohortN: n,
      topPercentile: pctile != null && pctile >= CFG.CROSS_SECTION.topPercentile,
      largestLiquidWinner: winnerSet.has(r.symbol),
      executable,
      gapClass: r.gapClass || null,
    });
  });
}

module.exports = { atrPctAt, barriersFor, classifyGap, resolveBarrierPath, benchmarkForward, pathLabel, crossSectionLabels };
