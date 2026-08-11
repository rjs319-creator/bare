'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — pure orchestrator. rows + benchmarks + previous snapshot → snapshot.
//
// No network, no clock, no store: asOf and all data are injected, so the
// engine is deterministic and unit-testable. One evidence DOMAIN: everything
// here is price/volume-derived and must never be counted as independent
// confirmations across screeners.
// ═══════════════════════════════════════════════════════════════════════════

const RES = require('../atlasx-residual');
const CFG = require('./config');
const T = require('./trend');
const C = require('./continuity');
const J = require('./jump');
const L = require('./leadership');
const S = require('./score');
const A = require('./arrows');

const isNum = (x) => Number.isFinite(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function atrPctOf(bars, n = 14) {
  if (!bars || bars.length < n + 1) return null;
  let sum = 0, cnt = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    if (!(pc > 0)) continue;
    const tr = Math.max(
      (b.h ?? b.c) - (b.l ?? b.c),
      Math.abs((b.h ?? b.c) - pc),
      Math.abs((b.l ?? b.c) - pc),
    );
    if (isNum(tr)) { sum += tr / pc; cnt++; }
  }
  return cnt ? sum / cnt : null;
}

/** Volume participation 0..1: up-day vs down-day volume over 21 sessions. */
function participationOf(bars) {
  const w = bars.slice(-22);
  if (w.length < 12) return null;
  let up = 0, down = 0;
  for (let i = 1; i < w.length; i++) {
    const v = w[i].v;
    if (!isNum(v) || v <= 0) continue;
    if (w[i].c > w[i - 1].c) up += v;
    else if (w[i].c < w[i - 1].c) down += v;
  }
  if (up + down <= 0) return null;
  const ratio = down > 0 ? up / down : 2;
  return clamp01((ratio - 0.5) / 1.5);
}

function dollarVol20(bars) {
  const w = bars.slice(-20);
  if (!w.length) return null;
  const v = w.map((b) => (isNum(b.v) && isNum(b.c) ? b.v * b.c : null)).filter(isNum);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** Consecutive sessions with close above SMA50 (trend age, capped by history). */
function trendAgeSessions(bars) {
  const cl = bars.map((b) => b.c);
  if (cl.length < 60) return null;
  let age = 0;
  for (let i = cl.length - 1; i >= 50; i--) {
    let s = 0;
    for (let j = i - 49; j <= i; j++) s += cl[j];
    if (cl[i] > s / 50) age++;
    else break;
  }
  return age;
}

/** Sessions the stock's last bar lags the benchmark calendar. */
function staleSessions(stockBars, spyDates) {
  if (!stockBars.length || !spyDates.length) return null;
  const last = stockBars[stockBars.length - 1].date;
  let lag = 0;
  for (let i = spyDates.length - 1; i >= 0; i--) {
    if (spyDates[i] <= last) break;
    lag++;
  }
  return lag;
}

function eligibility({ bars, spyDates }) {
  const E = CFG.ELIGIBILITY;
  const reasons = [];
  if (bars.length < E.minBarsReduced) reasons.push('INSUFFICIENT_HISTORY');
  const price = bars.length ? bars[bars.length - 1].c : null;
  if (!(price >= E.minPrice)) reasons.push('BELOW_MIN_PRICE');
  const dv = dollarVol20(bars);
  if (!(dv >= E.minDollarVol20)) reasons.push('BELOW_LIQUIDITY_FLOOR');
  const stale = staleSessions(bars, spyDates);
  if (stale == null || stale > E.maxStaleSessions) reasons.push('STALE_DATA');
  for (let i = Math.max(1, bars.length - 130); i < bars.length; i++) {
    const p = bars[i - 1].c, c = bars[i].c;
    if (p > 0 && c > 0 && Math.abs(c / p - 1) >= E.splitAnomalyPct) { reasons.push('SPLIT_ANOMALY'); break; }
  }
  return { eligible: reasons.length === 0, reasons, price, dollarVol: dv, staleSessions: stale };
}

/** Build one card. prevCard = same ticker's card from the previous snapshot. */
function buildCard({ ticker, candles, sector, sectorCandles, spyCandles, asOf, prevCard, eventRisk = null }) {
  const bars = RES.asOfSlice(RES.toBars(candles), asOf);
  const spyBars = RES.asOfSlice(RES.toBars(spyCandles), asOf);
  const sectorBars = sectorCandles ? RES.asOfSlice(RES.toBars(sectorCandles), asOf) : null;
  const spyDates = spyBars.map((b) => b.date);

  const elig = eligibility({ bars, spyDates });
  const base = {
    ticker, sector: sector || null, asOf,
    engineVersion: CFG.VERSIONS.engine, featureVersion: CFG.VERSIONS.features, scoreVersion: CFG.VERSIONS.score,
    liquidity: { price: elig.price, dollarVol: elig.dollarVol },
    eligibility: elig,
    sectorDataAvailable: !!(sectorBars && sectorBars.length > 20),
    eventRisk,
  };
  if (!elig.eligible) {
    return { ...base, available: false, disqualified: true, entry: { state: 'INSUFFICIENT_EVIDENCE', reasons: elig.reasons } };
  }

  const trend = T.absoluteTrend(bars);
  const rets = T.dailyReturns(bars);
  const absContinuity = C.continuityBundle({ rets, levels: bars.map((b) => b.c), bars, window: 63 });
  const absContinuity21 = C.continuityBundle({ rets, levels: bars.map((b) => b.c), bars, window: 21 });
  const absPath = J.classifyPath({ bars, window: 63 });
  const residual = L.residualLeadership({ bars, spyBars, sectorBars, asOf });
  const rsMarket = L.rsLineFeatures(L.rsLine(bars, spyBars), 63);
  const rsSector = sectorBars ? L.rsLineFeatures(L.rsLine(bars, sectorBars), 63) : { available: false };
  const speeds = L.speedStates(trend.byHorizon);
  const participation = participationOf(bars);
  const atrPct = atrPctOf(bars);
  const sma20 = trend.sma?.byN?.[20];
  const extensionAtr = isNum(sma20?.dist) && atrPct > 0 ? sma20.dist / atrPct : null;
  const age = trendAgeSessions(bars);

  const q = L.classifyQuadrant({
    absReturn: trend.byHorizon[63]?.available ? trend.byHorizon[63].totalReturn : trend.byHorizon[21]?.totalReturn,
    marketRel: residual.byHorizon[63]?.marketRel ?? residual.byHorizon[21]?.marketRel,
    sectorRel: residual.byHorizon[63]?.sectorRel ?? residual.byHorizon[21]?.sectorRel,
    residual: residual.byHorizon[63]?.residual ?? residual.byHorizon[21]?.residual,
    continuityOk: absContinuity.discreteness?.available ? absContinuity.discreteness.continuity > 0.4 : null,
    residualSupported: residual.supported,
  });
  const stage = L.classifyStage({
    quadrant: q.quadrant, pathState: absPath.state, trendAgeSessions: age,
    extensionAtr, residualAccel: residual.residualAccel, absSlope: trend.byHorizon[21]?.slope,
  });

  const pts = S.persistentTrendScore({ trend, absContinuity, participation });
  const rls = S.relativeLeadershipScore({ residual });
  const setupQuality = (() => {
    const parts = [
      isNum(extensionAtr) ? 1 - clamp01((extensionAtr - 1) / (CFG.EXTENSION.maxAtr - 1)) : null,
      absPath.state === 'ORDERLY_PAUSE' || absPath.state === 'JUMP_HOLDING' || absPath.state === 'STEADY_ADVANCE' ? 0.8
        : absPath.state === 'ACCELERATING' ? 0.6 : 0.3,
      participation,
    ].filter(isNum);
    return parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : null;
  })();

  const penalties = S.computePenalties({
    absPath, residual, extensionAtr,
    maxDrawdown63: trend.byHorizon[63]?.available ? trend.byHorizon[63].maxDrawdown : null,
    participation,
    gapDependence: absContinuity.gaps?.available ? absContinuity.gaps.gapDependence : null,
  });
  const support = S.supportGrade({
    bars, residual, sectorAvailable: base.sectorDataAvailable,
    stale: elig.staleSessions > CFG.ELIGIBILITY.maxStaleSessions,
  });
  const combinedRes = S.combineScores({
    pts, rls, setupQuality, penalties,
    supportHaircut: support.grade === 'LOW' ? CFG.PENALTIES.lowBetaSupportHaircut : 1,
  });

  const hardBreak = absPath.state === 'TREND_BROKEN';
  const utility = {};
  for (const h of [5, 21, 63]) {
    utility[`h${h}`] = S.baselineUtility({
      combined: combinedRes.afterPenalties, atrPct, dollarVol: elig.dollarVol, horizon: h,
    });
  }
  const rankScore = hardBreak || support.abstain
    ? null
    : Math.round(
      0.75 * (combinedRes.afterPenalties ?? 0) +
      25 * clamp01(((utility.h21.available ? utility.h21.utility : 0) + 0.05) / 0.15),
    );

  const arrowBlock = A.arrowsFor({
    trend, absPath,
    residualByHorizon: residual.byHorizon,
    combined: combinedRes.afterPenalties,
    prevState: prevCard ? { arrowState: prevCard.arrowState, combined: prevCard.scores?.combinedAfterPenalties } : null,
    alert: !!eventRisk || support.grade === 'STALE',
  });
  const entry = A.entryState({
    quadrant: q.quadrant, absPath, support, extensionAtr,
    distSma20Atr: extensionAtr, arrows: arrowBlock.arrows,
  });

  return {
    ...base,
    available: true,
    disqualified: hardBreak || support.abstain,
    trend: {
      byHorizon: trend.byHorizon, skipMomentum: trend.skipMomentum,
      sma: trend.sma, structure: trend.structure, agreement: trend.agreement,
    },
    continuity: { w21: absContinuity21, w63: absContinuity },
    absPath,
    residual: {
      beta: residual.beta, betaObs: residual.betaObs, betaShrunk: residual.betaShrunk,
      sectorLoading: residual.sectorLoading, residualVol: residual.residualVol,
      residualAccel: residual.residualAccel, supported: residual.supported,
      supportBasis: residual.supportBasis, byHorizon: residual.byHorizon,
      continuity63: residual.continuity63, pathState63: residual.pathState63?.state ?? null,
    },
    rsLines: { market: rsMarket, sector: rsSector },
    speeds,
    quadrant: q.quadrant, quadrantReasons: q.reasons, stage,
    trendAge: age,
    extensionAtr, atrPct, participation,
    scores: {
      persistentTrend: pts.score, relativeLeadership: rls.score,
      combined: combinedRes.combined, combinedAfterPenalties: combinedRes.afterPenalties,
      rankScore, contributions: {
        combined: combinedRes.contributions, persistentTrend: pts.contributions, relativeLeadership: rls.contributions,
      },
      setupQuality, scoreVersion: CFG.VERSIONS.score,
    },
    penalties,
    support,
    utility,
    arrows: arrowBlock.arrows, arrowGlyphs: arrowBlock.glyphs, arrowState: arrowBlock.arrowState,
    entry,
  };
}

/**
 * Run PSRL over a universe.
 * rows: [{ticker, candles, sector, sectorCandles}] — sectorCandles nullable.
 * prev: previous snapshot (for hysteresis/trajectory), or null.
 */
function runPsrl({ rows, spyCandles, asOf, prev = null, eventRiskByTicker = {} }) {
  const prevByTicker = new Map((prev?.cards || []).map((c) => [c.ticker, c]));
  const cards = [];
  const skipped = [];
  for (const row of rows || []) {
    try {
      const card = buildCard({
        ticker: row.ticker, candles: row.candles, sector: row.sector,
        sectorCandles: row.sectorCandles, spyCandles, asOf,
        prevCard: prevByTicker.get(row.ticker) || null,
        eventRisk: eventRiskByTicker[row.ticker] || null,
      });
      cards.push(card);
    } catch (e) {
      skipped.push({ ticker: row.ticker, reason: String(e && e.message || e) });
    }
  }
  const ranked = S.rankCards(cards.filter((c) => c.available));
  const excluded = cards.filter((c) => !c.available);
  return {
    schema: 'PsrlSnapshot',
    engineVersion: CFG.VERSIONS.engine,
    featureVersion: CFG.VERSIONS.features,
    scoreVersion: CFG.VERSIONS.score,
    asOf,
    governanceStatus: 'shadow',
    weight: 0,
    calibrationStatus: 'uncalibrated',
    evidenceNote: 'Evidence scores, not probabilities. BASELINE_UNCALIBRATED utility is a ranking axis only.',
    counts: { input: (rows || []).length, scored: ranked.length, excluded: excluded.length, errored: skipped.length },
    cards: ranked,
    excluded: excluded.map((c) => ({ ticker: c.ticker, reasons: c.eligibility?.reasons || [] })),
    skipped,
  };
}

module.exports = { runPsrl, buildCard, eligibility, atrPctOf, participationOf, dollarVol20, trendAgeSessions, staleSessions };
