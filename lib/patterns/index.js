'use strict';
// PATTERN INTELLIGENCE — multi-timeframe orchestrator (v2).
//
// analyzeTicker() runs the family-structural pipeline across independent timeframes and
// reconciles them by TRADE RELEVANCE (reconcile.js), not raw similarity. Everything is
// point-in-time; detectors split formation (≤ t-1) from the confirmation bar (t).
//
// The '5d' daily timeframe was REMOVED (v2): it supplied 5 bars against a detector
// minimum of 8+ and had no family with a compatible minimum duration, so it could never
// produce a valid structure — an unusable timeframe is deleted, not displayed.

const G = require('./geometry');
const S = require('./similarity');
const { detectWindow } = require('./detectors');
const { buildPrediction } = require('./predict');
const { findAnalogs } = require('./analog');
const { decidePattern } = require('./decision');
const { buildPatternPrediction, MODEL_VERSION } = require('./schema');
const { dedupeDetections } = require('./episodes');
const { reconcileDetections } = require('./reconcile');
const { technicalStatusDaily, technicalStatusIntraday, summarizeIntraday, recommendationEligibility } = require('./confirm');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// Analysis windows (daily bars) mapped to horizons. 'session' is intraday bars.
const TIMEFRAMES = [
  { key: 'session', bars: null, horizon: 'intraday' },
  { key: '20d', bars: 22, horizon: 'swing' },
  { key: '60d', bars: 60, horizon: 'swing' },
  { key: '120d', bars: 120, horizon: 'longterm' },
];

const MAX_DETECTIONS_PER_TF = 3;

// ---- context ------------------------------------------------------------------

function dailyLogVol(closes, win = 20) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return G.stdev(rets.slice(-win));
}

function volPercentile(closes, win = 20, lookback = 252) {
  if (closes.length < win + 10) return null;
  const rollWindow = closes.slice(-(lookback + win));
  const series = [];
  for (let i = win; i < rollWindow.length; i++) {
    series.push(dailyLogVol(rollWindow.slice(i - win, i + 1), win));
  }
  if (series.length < 5) return null;
  const cur = series[series.length - 1];
  const below = series.filter(v => v <= cur).length;
  return round((below / series.length) * 100, 1);
}

function liquidityBand(candles) {
  const cs = candles.slice(-20);
  if (!cs.length) return 'UNKNOWN';
  const dollar = cs.map(c => c.close * c.volume).filter(isNum);
  if (!dollar.length) return 'UNKNOWN';
  const avg = dollar.reduce((a, b) => a + b, 0) / dollar.length;
  if (avg >= 5e6) return 'SUPPORTED';
  if (avg >= 1e6) return 'MODERATE';
  return 'THIN';
}

function relStrength(closes, spyCloses, win = 20) {
  if (!Array.isArray(spyCloses) || spyCloses.length < win + 1 || closes.length < win + 1) return 'UNKNOWN';
  const r = closes[closes.length - 1] / closes[closes.length - 1 - win] - 1;
  const rs = spyCloses[spyCloses.length - 1] / spyCloses[spyCloses.length - 1 - win] - 1;
  if (!isNum(r) || !isNum(rs)) return 'UNKNOWN';
  const resid = r - rs;
  if (resid > 0.01) return 'POSITIVE';
  if (resid < -0.01) return 'NEGATIVE';
  return 'NEUTRAL';
}

function buildContext(daily, { spyDaily = null, marketRegime = 'NEUTRAL', sectorRegime = 'UNKNOWN' } = {}) {
  const cs = G.toDaily(daily);
  const closes = G.closesOf(cs);
  const spyCloses = spyDaily ? G.closesOf(G.toDaily(spyDaily)) : null;
  return {
    marketRegime,
    sectorRegime,
    liquidity: liquidityBand(cs),
    volPercentile: volPercentile(closes),
    relativeStrength: relStrength(closes, spyCloses),
    dailyVol: dailyLogVol(closes),
  };
}

// A detection has no persisted episode yet — give the confirmation engine an
// episode-shaped view of its frozen levels.
function pseudoEpisode(d) {
  return {
    direction: d.direction,
    frozen: { trigger: d.triggerLevel, invalidation: d.invalidationLevel, target: d.targetLevel, atr: d.geometry ? d.geometry.atr : null },
    current: { target: d.targetLevel ? d.targetLevel.price : null, invalidation: d.invalidationLevel ? d.invalidationLevel.price : null },
  };
}

// ---- orchestration ------------------------------------------------------------

// analyzeTicker({ ticker, daily, intradayBars, spyDaily, marketRegime, sectorRegime,
//                 corpus, controls, freshness, evidenceTable, now })
function analyzeTicker(input = {}) {
  const {
    ticker, daily = [], intradayBars = null, spyDaily = null,
    marketRegime = 'NEUTRAL', sectorRegime = 'UNKNOWN',
    corpus = [], controls = null, freshness = null, evidenceTable = null,
    now = new Date().toISOString(),
  } = input;
  const cs = G.toDaily(daily);
  if (cs.length < 25) {
    return { ticker, ok: false, reason: 'insufficient-history', bars: cs.length, generatedAt: now };
  }
  const context = buildContext(cs, { spyDaily, marketRegime, sectorRegime });
  const currentPrice = cs[cs.length - 1].close;
  const queryDate = cs[cs.length - 1].date;
  const avgVolume = cs.slice(-20).reduce((a, c) => a + (c.volume || 0), 0) / Math.min(20, cs.length);
  const intradaySnap = Array.isArray(intradayBars) ? summarizeIntraday(intradayBars) : null;

  const canonical = [];
  for (const tf of TIMEFRAMES) {
    let window;
    if (tf.key === 'session') {
      if (!Array.isArray(intradayBars) || intradayBars.length < 10) continue;
      window = G.toDaily(intradayBars);
    } else {
      if (cs.length < tf.bars) continue;
      window = cs.slice(-tf.bars);
    }
    let dets = [];
    try { dets = detectWindow(window, { timeframe: tf.key, context }); } catch { dets = []; }
    const valid = dedupeDetections(dets.filter(d => d.plan && !d.structurallyInvalid))
      .slice(0, MAX_DETECTIONS_PER_TF);

    for (const top of valid) {
      top.timeframe = tf.key;
      top.horizon = tf.horizon;
      top.ticker = ticker;
      top.currentPrice = currentPrice;
      const tier = S.matchTier(top.similarity.combined);
      top.similarity.matchTier = tier.tier;
      top.similarity.calibratedThreshold = tier.calibratedThreshold;

      const analog = corpus && corpus.length
        ? findAnalogs({ path: G.unitPath(G.closesOf(window)), context, family: top.family, direction: top.direction, ticker, queryDate }, corpus, { controls })
        : null;
      const prediction = buildPrediction(top, { dailyVol: context.dailyVol, horizonBars: horizonBarsFor(tf.horizon), analog });

      // Live confirmation object — built HERE in the real runtime path. Intraday snapshot
      // (when present) refines any horizon; the daily confirmation bar always applies.
      const pe = pseudoEpisode(top);
      const dailyStatus = technicalStatusDaily(pe, window[window.length - 1], { avgVolume });
      const intradayStatus = intradaySnap ? technicalStatusIntraday(pe, intradaySnap, { avgVolume }) : null;

      const decision = decidePattern(top, { now, freshness, dailyStatus, intradayStatus, evidenceTable });
      canonical.push({ ...buildPatternPrediction({ ticker, detection: top, decision, prediction, analog, context, freshness, now }), structuralValidity: top.structuralValidity, _det: top });
    }
  }

  if (!canonical.length) {
    return { ticker, ok: true, bars: cs.length, context, horizons: emptyHorizons(), detections: [], conflicts: [], timeframeAlignment: null, generatedAt: now, modelVersion: MODEL_VERSION };
  }

  // Decision-aware reconciliation across all detections (raw detection objects carry the
  // fields reconcile needs; canonical objects mirror them 1:1 by index).
  const rec = reconcileDetections(canonical.map(c => c._det), {
    context,
    eligibilityFor: d => recommendationEligibility({ evidenceTable, family: d.family, direction: d.direction, timeframe: d.timeframe }),
  });
  const canonOf = det => canonical.find(c => c._det === det) || null;

  const horizons = groupHorizons(canonical, rec);
  const detections = canonical.map(({ _det, ...rest }) => rest);

  return {
    ticker,
    ok: true,
    bars: cs.length,
    context,
    horizons,
    primary: slim(canonOf(rec.primary && rec.primary.detection), rec.primary),
    secondary: rec.secondary.length ? slim(canonOf(rec.secondary[0].detection), rec.secondary[0]) : null,
    conflicting: rec.conflicts.length ? { ...rec.conflicts[0] } : null,
    conflicts: rec.conflicts,
    failedNotes: rec.failedNotes || [],
    timeframeAlignment: rec.alignment,
    higherTimeframeTrend: rec.htf,
    detections,
    generatedAt: now,
    modelVersion: MODEL_VERSION,
  };
}

function horizonBarsFor(horizon) {
  return horizon === 'intraday' ? 5 : horizon === 'swing' ? 21 : 63;
}

// Best canonical detection per horizon by reconciled trade relevance.
function groupHorizons(canonical, rec) {
  const scoreOf = new Map((rec.ranked || []).map(r => [r.detection, r.score]));
  const out = { intraday: null, swing: null, longterm: null };
  for (const h of ['intraday', 'swing', 'longterm']) {
    const cands = canonical.filter(c => c.horizon === h);
    if (!cands.length) continue;
    out[h] = cands.reduce((best, c) => ((scoreOf.get(c._det) || 0) > (scoreOf.get(best._det) || 0) ? c : best));
  }
  return { intraday: strip(out.intraday), swing: strip(out.swing), longterm: strip(out.longterm) };
}

function strip(c) {
  if (!c) return null;
  const { _det, ...rest } = c;
  return rest;
}

function emptyHorizons() { return { intraday: null, swing: null, longterm: null }; }

function slim(c, ranked) {
  if (!c) return null;
  return {
    ticker: c.ticker, patternFamily: c.patternFamily, patternLabel: c.patternLabel,
    direction: c.direction, timeframe: c.timeframe, horizon: c.horizon, phase: c.phase,
    matchTier: c.similarity.matchTier, combined: c.similarity.combined,
    structuralValidity: c.structural ? c.structural.validity : null,
    tradeRelevance: ranked ? ranked.score : null,
    adjustment: ranked ? ranked.adjustment : null,
    contextNotes: ranked ? ranked.contextNotes : [],
    action: c.plan.action,
  };
}

module.exports = { analyzeTicker, buildContext, volPercentile, liquidityBand, relStrength, TIMEFRAMES };
