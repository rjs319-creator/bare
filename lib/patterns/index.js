// PATTERN INTELLIGENCE — multi-timeframe orchestrator.
//
// analyzeTicker() runs the whole descriptive→predictive→decision pipeline across
// independent timeframes and reconciles them into three horizon summaries (intraday /
// swing / long-term) plus a full detection list for the radar/expert view. Everything is
// point-in-time; nothing here reaches past `now`.

const G = require('./geometry');
const S = require('./similarity');
const { detectWindow } = require('./detectors');
const { buildPrediction } = require('./predict');
const { findAnalogs } = require('./analog');
const { decidePattern } = require('./decision');
const { buildPatternPrediction } = require('./schema');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// Analysis windows (in daily bars) mapped to horizons. 'session' is intraday.
const TIMEFRAMES = [
  { key: 'session', bars: null, horizon: 'intraday' },
  { key: '5d', bars: 5, horizon: 'intraday' },
  { key: '20d', bars: 22, horizon: 'swing' },
  { key: '60d', bars: 60, horizon: 'swing' },
  { key: '120d', bars: 120, horizon: 'longterm' },
];

// ---- context ------------------------------------------------------------------

function dailyLogVol(closes, win = 20) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const tail = rets.slice(-win);
  return G.stdev(tail);
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

// ---- orchestration ------------------------------------------------------------

// analyzeTicker({ ticker, daily, intradayBars, spyDaily, marketRegime, sectorRegime,
//                 corpus, controls, freshness, intraday, now, horizonBars })
// Returns the full multi-timeframe report.
function analyzeTicker(input = {}) {
  const { ticker, daily = [], intradayBars = null, spyDaily = null, marketRegime = 'NEUTRAL', sectorRegime = 'UNKNOWN', corpus = [], controls = null, freshness = null, intraday = null, now = new Date().toISOString() } = input;
  const cs = G.toDaily(daily);
  if (cs.length < 25) {
    return { ticker, ok: false, reason: 'insufficient-history', bars: cs.length, generatedAt: now };
  }
  const context = buildContext(cs, { spyDaily, marketRegime, sectorRegime });
  const currentPrice = cs[cs.length - 1].close;
  const queryDate = cs[cs.length - 1].date;

  const detections = [];
  for (const tf of TIMEFRAMES) {
    let window;
    let tfKey = tf.key;
    if (tf.key === 'session') {
      if (!Array.isArray(intradayBars) || intradayBars.length < 8) continue;
      window = G.toDaily(intradayBars);
    } else {
      if (cs.length < tf.bars) continue;
      window = cs.slice(-tf.bars);
    }
    const dets = detectWindow(window, { timeframe: tfKey, context });
    if (!dets.length) continue;
    const top = dets[0];
    top.timeframe = tfKey;
    top.horizon = tf.horizon;
    top.ticker = ticker;
    top.currentPrice = currentPrice;

    // Attach an honest match tier (descriptive unless a calibrated distribution exists).
    const tier = S.matchTier(top.similarity.combined);
    top.similarity.matchTier = tier.tier;
    top.similarity.calibratedThreshold = tier.calibratedThreshold;

    // Prediction (barrier model-estimate) + optional leakage-safe analogs.
    const analog = corpus && corpus.length
      ? findAnalogs({ path: G.unitPath(G.closesOf(window)), context, family: top.family, direction: top.direction, ticker, queryDate }, corpus, { controls })
      : null;
    const prediction = buildPrediction(top, { dailyVol: context.dailyVol, horizonBars: horizonBarsFor(tf.horizon), analog });

    // Decision (fail-closed) — only the intraday horizon receives the live snapshot.
    const useIntraday = tf.horizon === 'intraday' ? intraday : null;
    const decision = decidePattern(top, { now, freshness, intraday: useIntraday, prediction, analog });

    const canonical = buildPatternPrediction({ ticker, detection: top, decision, prediction, analog, context, freshness, now });
    detections.push({ ...canonical, _combined: top.similarity.combined });
  }

  if (!detections.length) {
    return { ticker, ok: true, bars: cs.length, context, horizons: emptyHorizons(), detections: [], generatedAt: now };
  }

  const horizons = groupHorizons(detections);
  const reconciliation = reconcile(detections);

  return {
    ticker,
    ok: true,
    bars: cs.length,
    context,
    horizons,
    primary: reconciliation.primary,
    secondary: reconciliation.secondary,
    conflicting: reconciliation.conflicting,
    timeframeAlignment: reconciliation.alignment,
    detections: detections.map(d => { const { _combined, ...rest } = d; return rest; }),
    generatedAt: now,
    modelVersion: detections[0].modelVersion,
  };
}

function horizonBarsFor(horizon) {
  return horizon === 'intraday' ? 5 : horizon === 'swing' ? 21 : 63;
}

function groupHorizons(detections) {
  const out = { intraday: null, swing: null, longterm: null };
  for (const h of ['intraday', 'swing', 'longterm']) {
    const cands = detections.filter(d => d.horizon === h);
    if (cands.length) out[h] = cands.reduce((best, d) => (d._combined > best._combined ? d : best));
  }
  return out;
}

function emptyHorizons() { return { intraday: null, swing: null, longterm: null }; }

// Reconcile across timeframes: strongest is primary; strongest same-direction secondary;
// strongest opposite-direction conflicting. Alignment = fraction of detections agreeing
// with the primary direction, weighted by similarity.
function reconcile(detections) {
  const sorted = detections.slice().sort((a, b) => b._combined - a._combined);
  const primary = sorted[0];
  const secondary = sorted.find(d => d !== primary && d.direction === primary.direction) || null;
  const conflicting = sorted.find(d => d.direction !== primary.direction) || null;
  let wAgree = 0;
  let wTotal = 0;
  for (const d of sorted) {
    wTotal += d._combined;
    if (d.direction === primary.direction) wAgree += d._combined;
  }
  const alignment = wTotal > 0 ? round(wAgree / wTotal, 3) : null;
  return { primary: slim(primary), secondary: slim(secondary), conflicting: slim(conflicting), alignment };
}

function slim(d) {
  if (!d) return null;
  return { ticker: d.ticker, patternFamily: d.patternFamily, patternLabel: d.patternLabel, direction: d.direction, timeframe: d.timeframe, horizon: d.horizon, phase: d.phase, matchTier: d.similarity.matchTier, combined: d.similarity.combined, action: d.plan.action };
}

module.exports = { analyzeTicker, buildContext, volPercentile, liquidityBand, relStrength, TIMEFRAMES };
