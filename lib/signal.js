// Shared technical-analysis engine — used by api/chart.js (single ticker, full
// payload) and api/momentum.js (scan many tickers, classify by live signal).

const MS = require('./market-session');

// Cached ET-date formatter — VWAP must anchor to the America/New_York trading
// day, not the UTC calendar day (during EST the 19:00–20:00 ET post bars fall
// on the next UTC day and used to reset VWAP mid-session).
const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDayOfEpochSec(sec) { return ET_DAY_FMT.format(new Date(sec * 1000)); }

// Expected move must clear estimated round-trip costs (spread+slippage+fees).
const MIN_EXEC_ATR_PCT = 0.0015;   // ATR below 0.15% of price ⇒ no execution levels

// Regular-session bars only (09:30–16:00 ET) — execution levels must come from
// regular-session volatility, never from thin premarket/after-hours prints.
const ET_MIN_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
function etMinutesOfEpochSec(sec) {
  const parts = ET_MIN_FMT.formatToParts(new Date(sec * 1000));
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0;
  return hh * 60 + parseInt(get('minute'), 10);
}
function regularSessionCandles(candles) {
  return candles.filter(c => {
    if (!Number.isFinite(c.t)) return false;
    const m = etMinutesOfEpochSec(c.t);
    return m >= 9 * 60 + 30 && m < 16 * 60;
  });
}

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

// Session-anchored VWAP — resets each trading day (day-trader's institutional line).
// The day key is the AMERICA/NEW_YORK trading date (when the bar carries an epoch
// timestamp), so late post-market bars can't reset VWAP at the UTC midnight.
function calcVWAP(candles) {
  const out = new Array(candles.length).fill(null);
  let curDay = null, cumPV = 0, cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Number.isFinite(c.t) ? etDayOfEpochSec(c.t) : (c.date || '').slice(0, 10);
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
// opts.execAtr: ATR to use for stop/target placement. Pass a number (regular-
// session ATR) or null ("no defensible volatility estimate → no levels").
// When omitted entirely, legacy behavior (full-series ATR incl. extended-hours
// bars) is kept for old callers.
function buildLiveSignal(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol, atr, livePrice, opts = {}) {
  const i = candles.length - 1;
  const px = livePrice || candles[i].close;
  const e9 = ema9[i], e21 = ema21[i], e50 = ema50[i], vw = vwap[i];
  const r = rsi[i], m = macd.macdLine[i], sig = macd.signalLine[i], hist = macd.histogram[i];
  const histPrev = macd.histogram[i - 1];
  const hasExecAtr = Object.prototype.hasOwnProperty.call(opts, 'execAtr');
  const a = hasExecAtr ? opts.execAtr : (atr[i] ?? (candles[i].high - candles[i].low));

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

  // A score of exactly 0 is NEUTRAL, not bullish — it must not select the bull
  // reason list, a long-side plan, or a green glyph anywhere downstream.
  const bullish = score > 0;
  const neutral = score === 0;
  const dominant = neutral ? Math.max(bull.length, bear.length) : bullish ? bull.length : bear.length;
  const opposing = neutral ? Math.min(bull.length, bear.length) : bullish ? bear.length : bull.length;
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

  // Evidence floor is 0 when there is genuinely nothing (score 0), else 1.
  const confidence = Math.max(neutral ? 0 : 1, Math.min(10,
    Math.round(Math.abs(score) * 1.0 + 2 - opposing * 0.8)));

  // Cost hurdle: the expected move must be worth paying spread/slippage/fees
  // for. A sub-0.15%-of-price ATR cannot clear realistic round-trip costs, so
  // no execution levels are published off it.
  const clearsCosts = a != null && a > 0 && px > 0 && (a / px) >= MIN_EXEC_ATR_PCT;

  let entry, target, stop, rr = null;
  if (clearsCosts) {
    if (bullish) { entry = px; stop = px - 1.5 * a; target = px + 2.5 * a; }
    else         { entry = px; stop = px + 1.5 * a; target = px - 2.5 * a; }
    rr = (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1);
  }

  return {
    action, label, score, confidence, bullish,
    reasons: (neutral ? [...bull, ...bear] : bullish ? bull : bear).slice(0, 5),
    counter: (neutral ? [] : bullish ? bear : bull).slice(0, 2),
    levels: (clearsCosts && action !== 'HOLD') ? {
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

// ── Session detection ──────────────────────────────────────────────────────
// LEGACY (kept only for back-compat exports): infers the session from the LAST
// CANDLE'S timestamp, so stale data self-certifies its own session. The live
// path now uses lib/market-session sessionInfoAt(now) — the CLOCK decides the
// session; the data only decides freshness.
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
const { swingRead } = require('./swingread');
const { synthesizeHorizons } = require('./horizon-synthesis');
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
    // Central adaptive policy: 'disable' scores with the shipped default weights
    // even when a tuned doc exists (empty doc → weightsForGroup falls through).
    if ((await require('./adaptive-layers').layerPolicy('dualread-adapt')) === 'disable') {
      ltWeightsCache = { at: now, doc: {} };
      return ltWeightsCache.doc;
    }
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

// Sector benchmark (SPDR ETF) daily bars — cached per ETF like SPY so the swing
// engine gets sector-relative strength without a per-lookup provider tax.
const SECTOR_ETF = {
  Technology: 'XLK', 'Communication Services': 'XLC', 'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP', 'Health Care': 'XLV', Financials: 'XLF', Industrials: 'XLI',
  Energy: 'XLE', Utilities: 'XLU', 'Real Estate': 'XLRE', Materials: 'XLB',
};
const sectorDailyCache = new Map();   // etf → { at, candles }
async function sectorDaily(fetchDailyHistory, ticker) {
  try {
    const { SECTOR_OF } = require('./universe');
    const etf = SECTOR_ETF[SECTOR_OF[ticker.toUpperCase()]];
    if (!etf) return null;
    const now = Date.now();
    const hit = sectorDailyCache.get(etf);
    if (hit && now - hit.at < SPY_TTL_MS) return hit.candles;
    const d = await fetchDailyHistory(etf, '1y');
    if (d && d.candles) { sectorDailyCache.set(etf, { at: now, candles: d.candles }); return d.candles; }
  } catch { /* sector benchmark is optional */ }
  return null;
}

// Daily-horizon reads (long-term trend + INDEPENDENT swing) + mechanical dual-read
// for one ticker, all off a SINGLE daily+SPY fetch (no extra provider calls — the
// swing engine reuses the exact bars the long-term read already pulled). Returns
// null only on total data failure (caller degrades to the intraday-only view).
async function dailyHorizonsFor(ticker, stAction, horizonOpts = {}) {
  try {
    const { fetchDailyHistory } = require('./screener'); // lazy: avoids circular init
    const [daily, spy, sector] = await Promise.all([
      fetchDailyHistory(ticker, '2y'),                   // ~1–2y: enough for a stable swing read
      spyDaily(fetchDailyHistory),
      sectorDaily(fetchDailyHistory, ticker),
    ]);
    if (!daily || !daily.candles || daily.candles.length < 60) return null;
    const group = groupOf(daily.candles);          // behavior bucket (drives which weights apply)
    const weights = await loadLtWeights(group);
    const lt = longTermRead(daily.candles, spy, weights);
    lt.group = group;
    const dailyAsOf = daily.candles[daily.candles.length - 1].date;
    // Extend the long-term read with the explicit horizon contract fields.
    lt.available = true;
    lt.calibrated = false;                         // adaptive weights ≠ a calibrated probability
    lt.version = 'lt-v1';
    lt.dataAsOf = dailyAsOf;
    lt.freshness = 'daily-close';
    lt.horizon = '6–12 months';

    // Independent swing read (2–12 weeks) off the SAME bars. A daily bar dated
    // the current ET session (before the close) is a FORMING candle — the swing
    // engine computes its confirmed read from completed bars only.
    const lastBarIncomplete = !!(horizonOpts.etDate
      && String(dailyAsOf).slice(0, 10) === horizonOpts.etDate
      && (horizonOpts.marketSession === 'premarket' || horizonOpts.marketSession === 'regular'));
    const swing = swingRead(daily.candles, spy, { sectorCandles: sector, lastBarIncomplete });
    swing.freshness = 'daily-close';

    const dual = combineDualRead(stAction, lt.trend);
    return { longTerm: lt, dual, swing };
  } catch { return null; }
}
// Back-compat alias (older callers imported longTermFor).
const longTermFor = dailyHorizonsFor;

// ── Intraday freshness / fail-open guard ────────────────────────────────────
// The single most important honesty fix: DAILY fallback bars (Stooq, or Yahoo
// daily) must NEVER be presented as a live intraday BUY/SELL, and a STALE
// intraday tape must be marked and demoted — a green BUY on hour-old data is a lie.
const STALE_INTRADAY_MIN = 20;            // regular-session bar older than this ⇒ stale
const STALE_EXTENDED_MIN = 45;            // pre/post bar older than this ⇒ stale (thin tape prints less often)
const BAR_INTERVAL_SEC = 5 * 60;          // the intraday feed is 5-minute bars

// The age check applies to EVERY open session — a stale premarket or after-hours
// bar must not escape it (the old code short-circuited on PRE/POST/CLOSED and
// only age-checked REGULAR). `marketState` must be the CLOCK-derived session.
function classifyIntradayFreshness(source, marketState, lastCandleT, nowSec) {
  if (source !== 'yahoo') return 'daily-fallback';
  if (marketState === 'CLOSED') return 'closed';
  // Bar timestamps are bar STARTS: a 5-min bar is "current" until start+300s.
  const ageMin = lastCandleT ? Math.max(0, (nowSec - (lastCandleT + BAR_INTERVAL_SEC)) / 60) : Infinity;
  if (marketState === 'PRE' || marketState === 'PREPRE') {
    return ageMin > STALE_EXTENDED_MIN ? 'stale' : 'premarket';
  }
  if (marketState === 'POST') {
    return ageMin > STALE_EXTENDED_MIN ? 'stale' : 'afterhours';
  }
  return ageMin > STALE_INTRADAY_MIN ? 'stale' : 'live';
}

// Shape the intraday HORIZON object and, when the tape is untrustworthy, demote
// the legacy `live` verdict in place so the shared chart renderer can't paint a
// live BUY/SELL off daily-fallback, stale, OR closed-market data. During closed
// periods the last regular-session read survives as clearly-labeled HISTORICAL
// context — never as a live trade. Extended-hours reads stay but are PROVISIONAL.
function shapeIntradayHorizon(live, source, marketState, freshness, dataAsOf, sessionMeta = null) {
  live.evidenceStrength = live.confidence;   // renamed framing (NOT a probability)
  live.calibrated = false;
  live.intradayAvailable = source === 'yahoo';

  const fallback = freshness === 'daily-fallback';
  const stale = freshness === 'stale';
  const closed = freshness === 'closed';
  const extended = freshness === 'premarket' || freshness === 'afterhours';
  const priorAction = live.action;
  const priorBias = live.bullish === true ? 'bullish' : live.bullish === false ? 'bearish' : null;
  if (fallback || stale || closed) {
    // Neutralize the mechanical action + strip levels so no green banner shows.
    live.action = 'HOLD';
    live.label = fallback ? 'Intraday unavailable (daily fallback)'
      : stale ? 'Intraday data stale'
      : 'Market closed — last session read is historical context, not a live trade';
    live.levels = null;
  }

  const available = !fallback;
  const executionAllowed = sessionMeta ? sessionMeta.executionAllowed === true : freshness === 'live';
  return {
    action: fallback ? 'UNAVAILABLE' : live.action,
    label: live.label,
    evidenceStrength: live.evidenceStrength,
    reasons: fallback
      ? ['Intraday feed unavailable — daily fallback data cannot produce a live intraday signal.']
      : stale ? ['Intraday tape is stale — last bar is older than the freshness threshold.', ...(live.reasons || [])].slice(0, 4)
      : closed ? [`Exchange is closed — this is the last available session read${priorAction && priorAction !== 'HOLD' ? ` (was ${priorAction.replace('_', ' ')})` : ''}, shown as context only.`, ...(live.reasons || [])].slice(0, 4)
      : (live.reasons || []),
    counter: fallback ? [] : (live.counter || []),
    levels: live.levels,                       // execution levels (null when demoted / no regular-session ATR)
    rsi: live.rsi, vwap: live.vwap,
    session: marketState,
    dataAsOf,
    freshness,
    available,
    executionAllowed,
    provisional: extended,                     // pre/after-hours reads are provisional by definition
    priorBias: (closed || stale) ? priorBias : null,  // retained direction context after demotion
    calibrated: false,
    version: 'intraday-v1',
    horizon: 'today / current session',
  };
}

// ── High-level analysis: fetch + indicators + signal for one ticker ─────────
// opts.light = true → omit bulky candle/indicator arrays (for multi-ticker scans)
// opts.now   = injectable evaluation instant (Date/ISO/epoch-ms) for tests
// GOVERNANCE STAMP for the three ticker-lookup horizon reads (alpha-research pass 3).
//
// Until this, /api/chart published an ACTION (STRONG_BUY / BUY / SELL / STRONG_SELL)
// plus a concrete entry/stop/target triple per horizon — with no registry entry, no
// contract, and therefore no visit to lib/eligibility, lib/strategy-gate or
// lib/maturity. The four control points the signal inventory claims "no strategy may
// bypass" were bypassed by the app's most-used surface.
//
// Each read is now a registered strategy and carries its own state. Pure and exported so
// the contract is testable without a network fetch.
const LOOKUP_STRATEGY_IDS = Object.freeze({
  intraday: 'lookup-intraday',
  swing: 'lookup-swing',
  longTerm: 'lookup-longterm',
});
function stampLookupGovernance(out) {
  const SG = require('./strategy-gate');
  for (const [key, id] of Object.entries(LOOKUP_STRATEGY_IDS)) {
    const read = out && out[key];
    if (!read || typeof read !== 'object') continue;
    read.strategyId = id;
    read.maturity = SG.statusOf(id);           // fail-closed: unknown id ⇒ 'shadow'
    read.tradeEligible = SG.isTradeEligible(id);
    // Levels stay visible — an ATR-derived stop is a genuine risk reference and remains
    // useful for sizing. What a weight-0 read may not do is present them as a validated
    // plan, so the honest framing travels with the numbers.
    read.planBasis = read.tradeEligible
      ? null
      : 'risk reference (ATR-derived) — NOT a validated trade plan';
  }
  return out;
}

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

  // THE CLOCK decides the session (weekend/holiday/early-close aware); the data
  // only decides freshness. The last candle can no longer self-certify "REGULAR".
  const now = opts.now != null ? new Date(opts.now) : new Date();
  const sessionMeta = MS.assessFreshness({
    sourceKind: source === 'yahoo' ? 'intraday' : 'daily',
    barTimestamp: lastCandle.t,
    barIntervalSec: 5 * 60,
    quoteTimestamp: meta.regularMarketTime || null,
    delayedByMin: meta.exchangeDataDelayedBy || 0,
    now,
  });
  const marketState  = MS.legacyMarketState(sessionMeta.marketSession);
  const livePrice    = closes[closes.length - 1];
  const isExtended   = (marketState === 'PRE' || marketState === 'POST') && Math.abs(livePrice - regularPrice) > 0.001;

  const regChangePct = prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : null;
  const ahChange     = isExtended ? livePrice - regularPrice : 0;
  const ahChangePct  = isExtended && regularPrice ? (ahChange / regularPrice) * 100 : 0;

  // Execution levels must come from REGULAR-SESSION volatility. A thin premarket
  // ATR would place stop/target a few cents from entry; if we can't compute a
  // regular-session ATR, levels are declared unavailable rather than invented.
  let execAtr = null;
  if (source === 'yahoo') {
    const regBars = regularSessionCandles(candles);
    const regAtrSeries = calcATR(regBars, 14);
    const v = regAtrSeries.length ? regAtrSeries[regAtrSeries.length - 1] : null;
    execAtr = Number.isFinite(v) && v > 0 ? v : null;
  }

  const live = buildLiveSignal(candles, ema9, ema21, ema50, vwap, rsi, macd, avgVol, atr, livePrice, { execAtr });

  // Intraday freshness + fail-open guard. Compute BEFORE building the payload so
  // the demoted `live` (fallback/stale/closed) propagates to every consumer.
  const nowSec = Math.floor(now.getTime() / 1000);
  const intradayFreshness = classifyIntradayFreshness(source, marketState, lastCandle.t, nowSec);
  const intradayAsOf = lastCandle.date;
  const intraday = shapeIntradayHorizon(live, source, marketState, intradayFreshness, intradayAsOf, sessionMeta);

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
    live,                       // legacy field (demoted in place when fallback/stale/closed)
    intraday,                   // intraday HORIZON (today / current session)
    // Authoritative session/freshness metadata — ONE object every consumer trusts.
    sessionMeta: {
      marketSession: sessionMeta.marketSession,
      dataAsOf: sessionMeta.dataAsOf || intradayAsOf,
      ageSeconds: sessionMeta.ageSeconds,
      barComplete: sessionMeta.barComplete,
      delayed: sessionMeta.delayed,
      freshnessState: sessionMeta.freshnessState,
      freshnessReason: sessionMeta.freshnessReason,
      executionAllowed: sessionMeta.executionAllowed,
      provisional: sessionMeta.provisional,
      etDate: sessionMeta.etDate,
      isEarlyClose: sessionMeta.isEarlyClose,
      isHoliday: sessionMeta.isHoliday,
      lastRegularSession: MS.lastCompletedRegularSession(now),
    },
    generatedAt: now.toISOString(),
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

    // Daily horizons: long-term trend + INDEPENDENT swing read + mechanical
    // dual-read, all off one shared daily+SPY fetch (skippable via opts.noLongTerm).
    if (!opts.noLongTerm) {
      const daily = await dailyHorizonsFor(out.ticker, live.action,
        { etDate: sessionMeta.etDate, marketSession: sessionMeta.marketSession });
      if (daily) {
        out.longTerm = daily.longTerm;   // legacy consumers + horizon fields
        out.dual = daily.dual;           // legacy short×long quadrant
        out.swing = daily.swing;         // NEW independent 2–12 week horizon
      } else {
        // Daily feed failed → swing/long-term are UNAVAILABLE, never neutral.
        out.swing = { action: 'UNAVAILABLE', available: false, calibrated: false,
          version: 'swing-v1', horizon: '2–12 weeks',
          reasons: ['Daily price feed unavailable.'], counter: [], risks: [], factors: {}, plan: null };
      }
      // GOVERNANCE STAMP (alpha-research pass 3). Each horizon read is now a REGISTERED
      // strategy (lookup-intraday / lookup-swing / lookup-longterm) and carries its own
      // registry state on the payload. Until this, /api/chart published an action plus a
      // concrete entry/stop/target triple with no registry entry at all, so the central
      // fail-closed gate never saw the app's most-used surface.
      //
      // `tradeEligible` is what the client must branch on. It comes from the SAME
      // lib/strategy-gate the rest of the app uses, so a wording change here can never
      // grant live status, and a future promotion needs no code edit.
      stampLookupGovernance(out);

      // Deterministic three-horizon synthesis (never alters any horizon action).
      out.horizonSummary = synthesizeHorizons({
        intraday: out.intraday, swing: out.swing,
        longTerm: out.longTerm || { available: false },
      });

      // ONE authoritative recommendation per horizon × position-state (the
      // orchestrator applies freshness/trigger/session gates; supporting
      // engines render below it as evidence, not as competing verdicts).
      const { orchestrate } = require('./lookup-orchestrator');
      const dailyAsOf = (out.longTerm && out.longTerm.dataAsOf) || (out.swing && out.swing.dataAsOf) || null;
      // A daily bar dated TODAY is only a confirmed close after the regular
      // session ends; before that it is a forming candle.
      const dailyBarComplete = !(dailyAsOf
        && String(dailyAsOf).slice(0, 10) === sessionMeta.etDate
        && (sessionMeta.marketSession === 'premarket' || sessionMeta.marketSession === 'regular'));
      const orchArgs = {
        ticker: out.ticker,
        intraday: out.intraday,
        swing: out.swing,
        longTerm: out.longTerm || { available: false },
        sessionMeta: out.sessionMeta,
        dailyBarComplete,
      };
      const byPosition = {};
      for (const positionState of ['new', 'holding', 'short']) {
        byPosition[positionState] = {
          intraday: orchestrate({ ...orchArgs, horizon: 'intraday', positionState, price: price.live }),
          swing: orchestrate({ ...orchArgs, horizon: 'swing', positionState, price: price.regular ?? price.live }),
          longterm: orchestrate({ ...orchArgs, horizon: 'longterm', positionState, price: price.regular ?? price.live }),
        };
      }
      out.primary = {
        version: 'lookup-primary-v1',
        defaultHorizon: 'swing',
        defaultPosition: 'new',
        dailyBarComplete,
        byPosition,
      };
    }
  }

  return out;
}

module.exports = {
  calcEMA, calcRSI, calcMACD, calcAvgVolume, calcVWAP, calcATR,
  detectSignals, buildLiveSignal, deriveSession,
  fetchYahooIntraday, fetchYahooDaily, fetchStooqDaily, analyze,
  longTermFor, dailyHorizonsFor,
  classifyIntradayFreshness, shapeIntradayHorizon,
  stampLookupGovernance, LOOKUP_STRATEGY_IDS,
};
