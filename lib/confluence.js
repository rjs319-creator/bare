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

// Full Price-Action 3-step (TradingLab): (1) uptrend STRUCTURE — higher highs +
// higher lows; (2) pullback RETEST of the demand zone — the base just before the
// last strong impulse up; (3) R:R ≥ 2.5 (stop below the zone, target = the impulse
// swing high). Fires ONLY on that specific setup (rare), unlike the old "+1 whenever
// price is above EMA200 with higher lows". Returns +1 long setup / −1 downtrend / 0.
function priceActionScore(candles, ind, k) {
  const c = candles[k].close, e200 = ind.ema200[k], atr = ind.atr[k] || 0;
  if (e200 == null || atr <= 0) return 0;

  // Swing pivots over the last ~70 bars (5-bar half-window).
  const L = 5, lows = [], highs = [];
  for (let i = Math.max(L, k - 70); i <= k - L; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - L; j <= i + L; j++) { if (candles[j].low < candles[i].low) isLow = false; if (candles[j].high > candles[i].high) isHigh = false; }
    if (isLow) lows.push(candles[i].low);
    if (isHigh) highs.push(candles[i].high);
  }
  // Downtrend: below EMA200 with lower highs → bearish vote.
  if (c < e200) return (highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2]) ? -1 : 0;

  // Step 1 — uptrend structure: higher highs AND higher lows.
  if (!(highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2]
     && lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2])) return 0;

  // Step 2 — demand zone = the base just before the last strong impulse up
  // (≥2 ATR range over ~3 bars). swingHigh = the high the impulse reached.
  let zoneLo = null, zoneHi = null, swingHigh = -Infinity;
  for (let s = k - 3; s >= Math.max(8, k - 40); s--) {
    if (candles[s + 3].close > candles[s].close && (candles[s + 3].high - candles[s].low) >= 2 * atr) {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, s - 3); j <= s; j++) { lo = Math.min(lo, candles[j].low); hi = Math.max(hi, candles[j].high); }
      zoneLo = lo; zoneHi = hi;
      for (let j = s; j <= k; j++) swingHigh = Math.max(swingHigh, candles[j].high);
      break;
    }
  }
  if (zoneLo == null) return 0;

  // Step 2b — RETEST: price has pulled back into / just above the demand zone.
  if (!(c <= zoneHi * 1.02 && c >= zoneLo * 0.99)) return 0;

  // Step 3 — R:R ≥ 2.5 (stop just below the zone, target = impulse swing high).
  const stop = zoneLo - 0.2 * atr, risk = c - stop, reward = swingHigh - c;
  if (risk <= 0 || reward / risk < 2.5) return 0;
  return 1;
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
  const macdScore = (macd > sig && rsi > 45) ? 1 : macd < sig ? -1 : 0;   // RSI>45 filter on longs (Whitman)
  const macdFresh = macdP != null && sigP != null && macdP <= sigP && macd > sig;
  const priceAction = priceActionScore(candles, ind, k);
  return { ema: emaScore, emaFresh, supertrend: stScore, stFlip, rsi: rsiScore, macd: macdScore, macdFresh, priceAction };
}

// ── market CONDITION (top-trader edge: right strategy for the right tape) ───
// Validated: each strategy does better in its favorable tape — trend-followers in
// TRENDING markets, RSI mean-reversion in CHOPPY markets. Confluence weights each
// strategy by whether the current tape suits it.
const COND_FAVOR = { ema: 'trending', supertrend: 'trending', macd: 'trending', priceAction: 'trending', rsi: 'choppy' };
const ER_TREND = 0.35, ER_CHOP = 0.22;

function efficiencyRatio(closes, i, n) {
  if (i < n) return 0;
  let den = 0; for (let j = i - n + 1; j <= i; j++) den += Math.abs(closes[j] - closes[j - 1]);
  return den > 0 ? Math.abs(closes[i] - closes[i - n]) / den : 0;
}

// Classify the benchmark (SPY) tape: trending (clean directional, above 200DMA) /
// choppy (low efficiency) / mixed / riskoff. regime is the macro regime.
function marketCondition(spyCandles, regime) {
  if (regime === 'risk-off') return 'riskoff';
  if (!spyCandles || spyCandles.length < 200) return 'mixed';
  const cl = spyCandles.map(c => c.close), i = cl.length - 1;
  const er = efficiencyRatio(cl, i, 63);
  let s200 = 0; for (let j = i - 199; j <= i; j++) s200 += cl[j]; s200 /= 200;
  if (er >= ER_TREND && cl[i] > s200) return 'trending';
  if (er < ER_CHOP) return 'choppy';
  return 'mixed';
}

// Confluence at the latest bar. `weights` = learned per-strategy weights (default 1).
// `condition` (optional, from marketCondition) down-weights strategies that don't suit
// the current tape (×0.5) so the score rewards condition-appropriate agreement.
function confluence(candles, weights, condition) {
  if (!candles || candles.length < MIN_BARS) return null;
  const ind = computeIndicators(candles);
  const k = candles.length - 1;
  const s = strategyScoresAt(ind, candles, k);
  if (!s) return null;
  const w = weights || {};
  const condMult = st => (!condition || condition === 'mixed' || condition === 'riskoff') ? 1 : (COND_FAVOR[st] === condition ? 1 : 0.5);
  const wOf = st => (w[st] != null ? w[st] : 1) * condMult(st);
  const bull = STRATEGIES.filter(st => s[st] === 1);
  const bear = STRATEGIES.filter(st => s[st] === -1);
  const matched = condition ? bull.filter(st => COND_FAVOR[st] === condition) : [];
  const score = +bull.reduce((a, st) => a + wOf(st), 0).toFixed(2);
  const maxScore = +STRATEGIES.reduce((a, st) => a + wOf(st), 0).toFixed(2);
  const freshTriggers = [s.emaFresh && 'ema', s.stFlip && 'supertrend', s.macdFresh && 'macd'].filter(Boolean);
  return { score, maxScore, bull, bear, matched, bullishCount: bull.length, perStrategy: s, freshTriggers, condition: condition || null, atr: ind.atr[k] };
}

module.exports = {
  STRATEGIES, MIN_BARS, COND_FAVOR, confluence, marketCondition, efficiencyRatio,
  computeIndicators, strategyScoresAt, emaSeries, rsiSeries, macdSeries, atrSeries, supertrendSeries,
};
