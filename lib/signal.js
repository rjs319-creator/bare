// Shared technical-analysis engine — used by api/chart.js (single ticker, full
// payload) and api/momentum.js (scan many tickers, classify by live signal).

// ── Technical indicator calculations ──────────────────────────────────────
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  result[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = changes.slice(0, period).reduce((a, c) => a + Math.max(0, c), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((a, c) => a + Math.max(0, -c), 0) / period;
  result[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, changes[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -changes[i])) / period;
    result[i + 1] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return result;
}

function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  const ema12 = calcEMA(closes, fast);
  const ema26 = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null);

  const macdVals = macdLine.filter(v => v !== null);
  const sigEMA = calcEMA(macdVals, sig);
  let j = 0;
  const signalLine = macdLine.map(v => v !== null ? (sigEMA[j++] ?? null) : null);
  const histogram = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

function calcAvgVolume(volumes, period = 20) {
  return volumes.map((_, i) => {
    const slice = volumes.slice(Math.max(0, i - period + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// Session-anchored VWAP — resets each trading day (day-trader's institutional line)
function calcVWAP(candles) {
  const out = new Array(candles.length).fill(null);
  let curDay = null, cumPV = 0, cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = (c.date || '').slice(0, 10);
    if (day !== curDay) { curDay = day; cumPV = 0; cumV = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    cumPV += typical * vol;
    cumV  += vol;
    out[i] = cumV > 0 ? cumPV / cumV : c.close;
  }
  return out;
}

// Average True Range — drives stop / target placement
function calcATR(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ── Historical buy/sell markers for the chart ──────────────────────────────
function detectSignals(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol) {
  const signals = [];
  const start = Math.max(3, 26);
  for (let i = start; i < candles.length; i++) {
    if (ema9[i] == null || ema21[i] == null || rsi[i] == null || macd.macdLine[i] == null) continue;
    const c = candles[i], p = candles[i - 1];

    // ── BUY confluence ──
    let bs = 0; const br = [];
    if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1]) { bs += 3; br.push('EMA9×EMA21 cross up'); }
    if (c.close > (vwap[i] ?? 0) && p.close <= (vwap[i - 1] ?? 0)) { bs += 2; br.push('Reclaim VWAP'); }
    if (macd.macdLine[i] > macd.signalLine[i] && macd.macdLine[i - 1] <= macd.signalLine[i - 1]) { bs += 2; br.push('MACD cross up'); }
    if (rsi[i] > 50 && rsi[i] < 70 && rsi[i - 1] <= 50) { bs += 1; br.push('RSI reclaims 50'); }
    if (avgVol[i] && c.volume > avgVol[i] * 1.5 && c.close > c.open) { bs += 2; br.push('Volume thrust'); }
    if (c.high > p.high && c.low > p.low) { bs += 1; br.push('HH+HL'); }

    // ── SELL confluence ──
    let ss = 0; const sr = [];
    if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1]) { ss += 3; sr.push('EMA9×EMA21 cross down'); }
    if (c.close < (vwap[i] ?? 1e9) && p.close >= (vwap[i - 1] ?? 1e9)) { ss += 2; sr.push('Lose VWAP'); }
    if (macd.macdLine[i] < macd.signalLine[i] && macd.macdLine[i - 1] >= macd.signalLine[i - 1]) { ss += 2; sr.push('MACD cross down'); }
    if (rsi[i] > 75) { ss += 1; sr.push('RSI overbought'); }
    if (rsi[i] < 50 && rsi[i - 1] >= 50) { ss += 1; sr.push('RSI loses 50'); }
    if (avgVol[i] && c.volume > avgVol[i] * 1.5 && c.close < c.open) { ss += 2; sr.push('Distribution volume'); }
    if (c.high < p.high && c.low < p.low) { ss += 1; sr.push('LH+LL'); }

    if (bs >= 4 && bs >= ss) {
      signals.push({ time: c.date, price: c.close, side: 'buy', score: bs, type: bs >= 7 ? 'Strong Buy' : 'Buy', reasons: br.slice(0, 3) });
    } else if (ss >= 4 && ss > bs) {
      signals.push({ time: c.date, price: c.close, side: 'sell', score: ss, type: ss >= 7 ? 'Strong Sell' : 'Sell', reasons: sr.slice(0, 3) });
    }
  }
  return signals;
}

// ── The live, real-time verdict on the most recent bar ─────────────────────
function buildLiveSignal(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol, atr, livePrice) {
  const i = candles.length - 1;
  const px = livePrice || candles[i].close;
  const e9 = ema9[i], e21 = ema21[i], e50 = ema50[i], vw = vwap[i];
  const r = rsi[i], m = macd.macdLine[i], sig = macd.signalLine[i], hist = macd.histogram[i];
  const histPrev = macd.histogram[i - 1];
  const a = atr[i] ?? (candles[i].high - candles[i].low);

  let score = 0;
  const bull = [], bear = [];

  // Trend structure (EMA stack)
  if (e9 != null && e21 != null && e50 != null) {
    if (px > e9 && e9 > e21 && e21 > e50) { score += 3; bull.push('Price above stacked EMAs (9>21>50)'); }
    else if (px < e9 && e9 < e21 && e21 < e50) { score -= 3; bear.push('Price below stacked EMAs (9<21<50)'); }
    else if (px > e21) { score += 1; bull.push('Holding above EMA21'); }
    else if (px < e21) { score -= 1; bear.push('Trading below EMA21'); }
  }

  // VWAP — the day-trader's line in the sand
  if (vw != null) {
    if (px > vw) { score += 2; bull.push('Above VWAP (buyers in control)'); }
    else { score -= 2; bear.push('Below VWAP (sellers in control)'); }
  }

  // MACD momentum
  if (m != null && sig != null) {
    if (m > sig && hist > histPrev) { score += 2; bull.push('MACD bullish & expanding'); }
    else if (m > sig) { score += 1; bull.push('MACD above signal'); }
    else if (m < sig && hist < histPrev) { score -= 2; bear.push('MACD bearish & expanding'); }
    else if (m < sig) { score -= 1; bear.push('MACD below signal'); }
  }

  // RSI momentum / exhaustion
  if (r != null) {
    if (r > 78) { score -= 2; bear.push(`RSI overbought (${r.toFixed(0)}) — exhaustion risk`); }
    else if (r >= 55 && r <= 70) { score += 2; bull.push(`RSI strong (${r.toFixed(0)})`); }
    else if (r > 50) { score += 1; bull.push(`RSI bullish (${r.toFixed(0)})`); }
    else if (r < 22) { score += 1; bull.push(`RSI oversold (${r.toFixed(0)}) — bounce setup`); }
    else if (r < 45) { score -= 2; bear.push(`RSI weak (${r.toFixed(0)})`); }
  }

  // Volume confirmation on the latest bar
  if (avgVol[i] && candles[i].volume > avgVol[i] * 1.4) {
    if (candles[i].close >= candles[i].open) { score += 1; bull.push('Above-avg volume on up bar'); }
    else { score -= 1; bear.push('Above-avg volume on down bar'); }
  }

  const bullish = score >= 0;
  const dominant = bullish ? bull.length : bear.length;
  const opposing = bullish ? bear.length : bull.length;
  const hasTrend = e50 != null; // enough bars for a real trend read

  let action, label;
  if (Math.abs(score) < 3 || dominant < 3) {
    action = 'HOLD'; label = 'Hold / Neutral';
  } else if (score >= 7 && dominant >= 4 && opposing <= 1 && hasTrend) {
    action = 'STRONG_BUY'; label = 'Strong Buy';
  } else if (score >= 3) {
    action = 'BUY'; label = 'Buy';
  } else if (score <= -7 && dominant >= 4 && opposing <= 1 && hasTrend) {
    action = 'STRONG_SELL'; label = 'Strong Sell';
  } else if (score <= -3) {
    action = 'SELL'; label = 'Sell';
  } else {
    action = 'HOLD'; label = 'Hold / Neutral';
  }

  const confidence = Math.max(1, Math.min(10,
    Math.round(Math.abs(score) * 1.0 + 2 - opposing * 0.8)));

  let entry, target, stop, rr = null;
  if (a > 0) {
    if (bullish) { entry = px; stop = px - 1.5 * a; target = px + 2.5 * a; }
    else         { entry = px; stop = px + 1.5 * a; target = px - 2.5 * a; }
    rr = (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1);
  }

  return {
    action, label, score, confidence, bullish,
    reasons: (bullish ? bull : bear).slice(0, 5),
    counter: (bullish ? bear : bull).slice(0, 2),
    levels: (a > 0 && action !== 'HOLD') ? {
      entry:  entry.toFixed(2),
      target: target.toFixed(2),
      stop:   stop.toFixed(2),
      riskReward: `1:${rr}`,
      atr: a.toFixed(2),
    } : null,
    rsi: r != null ? +r.toFixed(1) : null,
    vwap: vw != null ? +vw.toFixed(2) : null,
    macdBull: m != null && sig != null ? m > sig : null,
  };
}

// ── Session detection (chart meta has no marketState field) ────────────────
function deriveSession(meta, lastTs) {
  const tp = meta.currentTradingPeriod;
  if (tp && lastTs) {
    if (tp.post && lastTs >= tp.post.start) return 'POST';
    if (tp.regular && lastTs >= tp.regular.start && lastTs < tp.regular.end) return 'REGULAR';
    if (tp.pre && lastTs >= tp.pre.start && lastTs < tp.pre.end) return 'PRE';
    if (tp.regular && lastTs >= tp.regular.end) return 'POST';
    return 'CLOSED';
  }
  if (meta.regularMarketTime && lastTs) return lastTs > meta.regularMarketTime + 120 ? 'POST' : 'REGULAR';
  return meta.marketState || 'CLOSED';
}

// ── Data sources ───────────────────────────────────────────────────────────
async function fetchYahooIntraday(ticker) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=5d&interval=5m&includePrePost=true`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [];
      const q  = result.indicators?.quote?.[0] || {};
      const meta = result.meta || {};
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        candles.push({ date: new Date(ts[i] * 1000).toISOString(), t: ts[i], open: o, high: h, low: l, close: c, volume: v || 0 });
      }
      if (candles.length < 20) continue;
      return { candles, meta, source: 'yahoo' };
    } catch { /* try next host */ }
  }
  return null;
}

// Daily bars (≈3 months) — used for swing-scale stats like the 20-day SMA,
// multi-session returns, and breakout pivots that intraday 5m data can't give.
async function fetchYahooDaily(ticker) {
  const sym = ticker.toUpperCase();
  const path = `/v8/finance/chart/${sym}?range=3mo&interval=1d`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [];
      const q  = result.indicators?.quote?.[0] || {};
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), t: ts[i], open: o, high: h, low: l, close: c, volume: v || 0 });
      }
      if (candles.length < 21) continue;
      return { candles, meta: result.meta || {}, source: 'yahoo' };
    } catch { /* try next host */ }
  }
  return null;
}

async function fetchStooqDaily(ticker) {
  try {
    const url = `https://stooq.com/q/d/l/?s=${ticker.toUpperCase()}.US&i=d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 5) return null;
    const parsed = lines.slice(1).map(line => {
      const [date, open, high, low, close, volume] = line.split(',');
      return { date, t: Math.floor(new Date(date).getTime() / 1000), open: +open, high: +high, low: +low, close: +close, volume: +(volume || 0) };
    }).filter(c => c.date && !isNaN(c.close) && c.close > 0);
    const candles = parsed.reverse().slice(-90);
    if (candles.length < 15) return null;
    return { candles, meta: {}, source: 'stooq' };
  } catch { return null; }
}

// ── Long-term (daily) horizon ───────────────────────────────────────────────
// The live signal above is intraday-only. For the dual-horizon read we also pull
// ~1y of daily bars and score the multi-month trend vs SPY. Only run on the full
// (single-ticker chart) path — NOT the light momentum scan — since it costs an
// extra daily fetch per name. SPY's daily series is shared, so cache it briefly.
const { longTermRead, combineDualRead, DEFAULT_LT_WEIGHTS } = require('./longterm');
const { groupOf } = require('./dualread-group');
let spyDailyCache = { at: 0, candles: null };
const SPY_TTL_MS = 15 * 60 * 1000;

// Active weights come from the self-tuner (dualread/groupweights.json = {global, groups}).
// Cache the whole doc in-process (TTL) so the hot chart path never blocks on Blob — and
// so the live read scores with the SAME weights op=dualreadlog logs (train/serve
// consistency). A stock uses its behavior-group's weights only if that group is
// PERSONALIZED (proven to beat global); otherwise it rides the global weights.
let ltWeightsCache = { at: 0, doc: null };
const LTW_TTL_MS = 15 * 60 * 1000;
async function loadLtWeightsDoc() {
  const now = Date.now();
  if (ltWeightsCache.doc && now - ltWeightsCache.at < LTW_TTL_MS) return ltWeightsCache.doc;
  try {
    const { readJSON, hasStore } = require('./store');
    if (hasStore()) { const d = await readJSON('dualread/groupweights.json', null); ltWeightsCache = { at: now, doc: d || {} }; return ltWeightsCache.doc; }
  } catch { /* fall through to default */ }
  ltWeightsCache = { at: now, doc: {} };
  return ltWeightsCache.doc;
}
function weightsForGroup(doc, group) {
  const g = doc && doc.groups && doc.groups[group];
  if (g && g.personalized && g.weights) return g.weights;
  return (doc && doc.global && doc.global.weights) || DEFAULT_LT_WEIGHTS;
}
async function loadLtWeights(group) { return weightsForGroup(await loadLtWeightsDoc(), group); }

async function spyDaily(fetchDailyHistory) {
  const now = Date.now();
  if (spyDailyCache.candles && now - spyDailyCache.at < SPY_TTL_MS) return spyDailyCache.candles;
  try {
    const d = await fetchDailyHistory('SPY', '1y');
    if (d && d.candles) spyDailyCache = { at: now, candles: d.candles };
  } catch { /* keep any stale cache */ }
  return spyDailyCache.candles;
}

// Long-term read + mechanical dual-horizon verdict for one ticker. Returns null
// on data failure (the caller degrades to the short-term-only banner).
async function longTermFor(ticker, stAction) {
  try {
    const { fetchDailyHistory } = require('./screener'); // lazy: avoids circular init
    const [daily, spy] = await Promise.all([
      fetchDailyHistory(ticker, '1y'),
      spyDaily(fetchDailyHistory),
    ]);
    if (!daily || !daily.candles || daily.candles.length < 60) return null;
    const group = groupOf(daily.candles);          // behavior bucket (drives which weights apply)
    const weights = await loadLtWeights(group);
    const lt = longTermRead(daily.candles, spy, weights);
    lt.group = group;
    const dual = combineDualRead(stAction, lt.trend);
    return { longTerm: lt, dual };
  } catch { return null; }
}

// ── High-level analysis: fetch + indicators + signal for one ticker ─────────
// opts.light = true → omit bulky candle/indicator arrays (for multi-ticker scans)
async function analyze(ticker, opts = {}) {
  let data = await fetchYahooIntraday(ticker);
  if (!data) data = await fetchStooqDaily(ticker);
  if (!data) return null;

  const { candles, meta, source } = data;
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const rsi    = calcRSI(closes, 14);
  const macd   = calcMACD(closes);
  const avgVol = calcAvgVolume(volumes, 20);
  const vwap   = source === 'yahoo' ? calcVWAP(candles) : new Array(candles.length).fill(null);
  const atr    = calcATR(candles, 14);

  const signals = detectSignals(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol);

  const lastCandle   = candles[candles.length - 1];
  const regularPrice = meta.regularMarketPrice ?? closes[closes.length - 1];
  // previousClose is yesterday's regular-session close (the right day-change base).
  // chartPreviousClose is the close BEFORE the chart window — on a multi-day range
  // (this fetch is 5d) that's ~a week ago, which would mislabel the 5-day move as
  // today's change. Prefer previousClose; fall back to chartPreviousClose.
  const prevClose    = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const marketState  = source === 'yahoo' ? deriveSession(meta, lastCandle.t) : 'CLOSED';
  const livePrice    = closes[closes.length - 1];
  const isExtended   = (marketState === 'PRE' || marketState === 'POST') && Math.abs(livePrice - regularPrice) > 0.001;

  const regChangePct = prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : null;
  const ahChange     = isExtended ? livePrice - regularPrice : 0;
  const ahChangePct  = isExtended && regularPrice ? (ahChange / regularPrice) * 100 : 0;

  const live = buildLiveSignal(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol, atr, livePrice);

  const price = {
    live: +livePrice.toFixed(2),
    regular: +regularPrice.toFixed(2),
    previousClose: prevClose != null ? +prevClose.toFixed(2) : null,
    regChange: regChangePct != null ? +(regularPrice - prevClose).toFixed(2) : null,
    regChangePct: regChangePct != null ? +regChangePct.toFixed(2) : null,
    afterHours: isExtended ? {
      price: +livePrice.toFixed(2),
      change: +ahChange.toFixed(2),
      changePct: +ahChangePct.toFixed(2),
      session: marketState === 'PRE' || marketState === 'PREPRE' ? 'pre' : 'post',
    } : null,
  };

  const out = {
    ticker: ticker.toUpperCase(),
    source,
    interval: source === 'yahoo' ? '5m' : '1d',
    marketState,
    price,
    live,
    generatedAt: new Date().toISOString(),
  };

  if (!opts.light) {
    const N = source === 'yahoo' ? 130 : 60;
    const s = Math.max(0, candles.length - N);
    const slice = arr => arr.slice(s);
    out.candles = slice(candles);
    out.indicators = {
      ema9: slice(ema9), ema21: slice(ema21), ema50: slice(ema50),
      vwap: slice(vwap), rsi: slice(rsi),
      macdLine: slice(macd.macdLine), signalLine: slice(macd.signalLine), histogram: slice(macd.histogram),
    };
    out.signals = signals.slice(-12);

    // Long-term daily horizon + mechanical dual-read (skippable via opts.noLongTerm).
    if (!opts.noLongTerm) {
      const dual = await longTermFor(out.ticker, live.action);
      if (dual) { out.longTerm = dual.longTerm; out.dual = dual.dual; }
    }
  }

  return out;
}

module.exports = {
  calcEMA, calcRSI, calcMACD, calcAvgVolume, calcVWAP, calcATR,
  detectSignals, buildLiveSignal, deriveSession,
  fetchYahooIntraday, fetchYahooDaily, fetchStooqDaily, analyze, longTermFor,
};
