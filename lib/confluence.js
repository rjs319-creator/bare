// CONFLUENCE screener — 5 classic technical strategies (EMA crossover, Supertrend,
// RSI mean-reversion, MACD, price-action structure) scored together: a name ranks
// by how many strategies AGREE it's bullish (confluence). Pure: candles in, signals
// out (no network, no state) so it runs in the live op AND the backtest harness.
//
// App-cohesive improvements over the raw single-strategy idea:
//   • CONFLUENCE — strategies vote; agreement is the signal (not any one trigger)
//   • per-STRATEGY weights are LEARNED from realized edge (the algo self-improves)
//   • market-RELATIVE context (excess vs SPY) + regime gating live in the op
//   • clean from-scratch indicators (no pandas_ta column-name fragility)

const { ema, atr } = require('./daytrade');   // reuse the shared EMA + single-value ATR

const STRATEGIES = ['ema', 'supertrend', 'rsi', 'macd', 'priceAction'];
const MIN_BARS = 210;   // need EMA200 + a little history

// ── indicator SERIES (computed once per ticker, read at any index) ──────────
function emaSeries(values, period) {
  const k = 2 / (period + 1), out = new Array(values.length).fill(null);
  let e = values[0]; out[0] = e;
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macdSeries(closes, fast = 12, slow = 26, sig = 9) {
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const macd = closes.map((_, i) => ef[i] - es[i]);
  const signal = emaSeries(macd, sig);
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
}

function atrSeries(candles, period = 14) {
  const n = candles.length, out = new Array(n).fill(null), tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    tr[i] = i === 0 ? candles[i].high - candles[i].low
      : Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  let a = null;
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) { a = tr.slice(0, period).reduce((s, x) => s + x, 0) / period; }
    else a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

// Supertrend (ATR bands with carry-forward). dir: +1 uptrend, -1 downtrend.
function supertrendSeries(candles, period = 10, mult = 3) {
  const n = candles.length, atrS = atrSeries(candles, period);
  const dir = new Array(n).fill(null), val = new Array(n).fill(null);
  let prevUpper = null, prevLower = null, prevDir = 1, started = false;
  for (let i = 0; i < n; i++) {
    const a = atrS[i]; if (a == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let upper = hl2 + mult * a, lower = hl2 - mult * a;
    if (started) {
      const pc = candles[i - 1].close;
      upper = (upper < prevUpper || pc > prevUpper) ? upper : prevUpper;
      lower = (lower > prevLower || pc < prevLower) ? lower : prevLower;
    }
    let d;
    if (!started) d = candles[i].close > hl2 ? 1 : -1;
    else if (prevDir === 1) d = candles[i].close < lower ? -1 : 1;
    else d = candles[i].close > upper ? 1 : -1;
    dir[i] = d; val[i] = d === 1 ? lower : upper;
    prevUpper = upper; prevLower = lower; prevDir = d; started = true;
  }
  return { dir, val };
}

function computeIndicators(candles) {
  const cl = candles.map(c => c.close);
  return {
    ema9: emaSeries(cl, 9), ema21: emaSeries(cl, 21), ema200: emaSeries(cl, 200),
    rsi: rsiSeries(cl, 14), macd: macdSeries(cl), st: supertrendSeries(candles), atr: atrSeries(candles, 14),
  };
}

// Higher-lows price-action structure: above EMA200 with an ascending recent swing-low.
function priceActionScore(candles, ind, k) {
  const c = candles[k].close, e200 = ind.ema200[k];
  if (e200 == null) return 0;
  const lows = [];
  const L = 5;                                    // pivot half-window
  for (let i = Math.max(L, k - 120); i <= k - L; i++) {
    let isLow = true;
    for (let j = i - L; j <= i + L; j++) if (candles[j].low < candles[i].low) { isLow = false; break; }
    if (isLow) lows.push(candles[i].low);
  }
  const above = c > e200;
  const higherLows = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2];
  if (above && higherLows) return 1;
  if (!above && lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2]) return -1;
  return 0;
}

// Per-strategy stance at bar k: +1 bullish / -1 bearish / 0 neutral, plus fresh-trigger flags.
function strategyScoresAt(ind, candles, k) {
  if (k < 1) return null;
  const c = candles[k].close;
  const e9 = ind.ema9[k], e21 = ind.ema21[k], e200 = ind.ema200[k];
  const rsi = ind.rsi[k];
  const macd = ind.macd.macd[k], sig = ind.macd.signal[k], macdP = ind.macd.macd[k - 1], sigP = ind.macd.signal[k - 1];
  const stdir = ind.st.dir[k], stdirP = ind.st.dir[k - 1];
  if ([e9, e21, e200, rsi, macd, sig, stdir].some(v => v == null)) return null;

  const emaScore = (e9 > e21 && c > e200) ? 1 : (e9 < e21 && c < e200) ? -1 : 0;
  const emaFresh = ind.ema9[k - 1] != null && ind.ema21[k - 1] != null && ind.ema9[k - 1] <= ind.ema21[k - 1] && e9 > e21;
  const stScore = stdir === 1 ? 1 : stdir === -1 ? -1 : 0;
  const stFlip = stdir === 1 && stdirP === -1;
  const rsiScore = (rsi < 35 && c > e200) ? 1 : rsi > 65 ? -1 : 0;   // mean-reversion dip-buy in uptrend
  const macdScore = macd > sig ? 1 : macd < sig ? -1 : 0;
  const macdFresh = macdP != null && sigP != null && macdP <= sigP && macd > sig;
  const priceAction = priceActionScore(candles, ind, k);
  return { ema: emaScore, emaFresh, supertrend: stScore, stFlip, rsi: rsiScore, macd: macdScore, macdFresh, priceAction };
}

// Confluence at the latest bar. `weights` (per-strategy, learned) default to 1 each.
// Returns null if not enough history. score = weighted count of bullish strategies.
function confluence(candles, weights) {
  if (!candles || candles.length < MIN_BARS) return null;
  const ind = computeIndicators(candles);
  const k = candles.length - 1;
  const s = strategyScoresAt(ind, candles, k);
  if (!s) return null;
  const w = weights || {};
  const wOf = st => (w[st] != null ? w[st] : 1);
  const bull = STRATEGIES.filter(st => s[st] === 1);
  const bear = STRATEGIES.filter(st => s[st] === -1);
  const score = +bull.reduce((a, st) => a + wOf(st), 0).toFixed(2);
  const maxScore = +STRATEGIES.reduce((a, st) => a + wOf(st), 0).toFixed(2);
  const freshTriggers = [s.emaFresh && 'ema', s.stFlip && 'supertrend', s.macdFresh && 'macd'].filter(Boolean);
  return { score, maxScore, bull, bear, bullishCount: bull.length, perStrategy: s, freshTriggers, atr: ind.atr[k] };
}

module.exports = {
  STRATEGIES, MIN_BARS, confluence, computeIndicators, strategyScoresAt,
  emaSeries, rsiSeries, macdSeries, atrSeries, supertrendSeries,
};
