// CLASSIC TECHNICAL STRATEGIES — the systematic-technical-trader toolkit, as pure
// detectors over daily candles, graded into the same CONFIRMED/EMERGING/WATCH
// tiers the V/sweep detectors use so they run through the identical edge harness
// (op=vreversaltest). Each returns a LONG signal at the most recent bar, or null.
//
//   donchianBreakout — trend-following. New N-day high above the 200DMA. Tiered by
//     lookback: WATCH 20d (Turtle short entry), EMERGING 55d (Turtle long entry),
//     CONFIRMED 252d (a 52-week-high breakout — the academic momentum signal).
//   rsi2Reversion    — Connors mean reversion. Deep RSI(2) oversold ONLY when price
//     is above its 200DMA (buy dips in uptrends). Tiered by how oversold.
//   maPullback       — trend pullback. Above 200DMA with a rising 50DMA above the
//     200DMA, price pulls back to the 50DMA and turns up. Tiered by cleanliness.

const { rsiSeries } = require('./vreversal');

const smaAt = (vals, p, i) => {
  if (i + 1 < p) return null;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += vals[k];
  return s / p;
};

function donchianBreakout(candles) {
  const n = candles.length; if (n < 260) return null;
  const i = n - 1, closes = candles.map(c => c.close), highs = candles.map(c => c.high);
  const close = closes[i], sma200 = smaAt(closes, 200, i);
  const above200 = sma200 != null && close > sma200;
  const priorHigh = N => { let m = -Infinity; for (let k = Math.max(0, i - N); k < i; k++) m = Math.max(m, highs[k]); return m; };
  let tier = null;
  if (close > priorHigh(252) && above200) tier = 'CONFIRMED';
  else if (close > priorHigh(55) && above200) tier = 'EMERGING';
  else if (close > priorHigh(20) && above200) tier = 'WATCH';
  if (!tier) return null;
  return { tier, score: tier === 'CONFIRMED' ? 90 : tier === 'EMERGING' ? 70 : 55, signals: { side: 'long' } };
}

function rsi2Reversion(candles) {
  const n = candles.length; if (n < 210) return null;
  const i = n - 1, closes = candles.map(c => c.close);
  const sma200 = smaAt(closes, 200, i);
  if (sma200 == null || closes[i] < sma200) return null;        // only buy dips in an uptrend
  const r = rsiSeries(closes, 2)[i];
  if (r == null) return null;
  let tier = null;
  if (r < 2) tier = 'CONFIRMED'; else if (r < 5) tier = 'EMERGING'; else if (r < 10) tier = 'WATCH';
  if (!tier) return null;
  return { tier, score: Math.round(90 - r * 3), signals: { side: 'long' } };
}

function maPullback(candles) {
  const n = candles.length; if (n < 210) return null;
  const i = n - 1, closes = candles.map(c => c.close), lows = candles.map(c => c.low);
  const sma200 = smaAt(closes, 200, i), sma50 = smaAt(closes, 50, i), sma50prev = smaAt(closes, 50, i - 10);
  if (sma200 == null || sma50 == null || sma50prev == null) return null;
  const uptrend = closes[i] > sma200 && sma50 > sma200 && sma50 > sma50prev;   // rising 50 above 200
  if (!uptrend) return null;
  const touched = lows[i] <= sma50 * 1.02 || lows[i - 1] <= sma50 * 1.02;       // pulled back to the 50
  if (!touched) return null;
  const turningUp = closes[i] > closes[i - 1];
  const dist = (closes[i] - sma50) / sma50;
  let tier;
  if (turningUp && dist >= 0 && dist < 0.03) tier = 'CONFIRMED';                // clean reclaim off the 50
  else if (turningUp) tier = 'EMERGING';
  else tier = 'WATCH';
  return { tier, score: tier === 'CONFIRMED' ? 85 : tier === 'EMERGING' ? 65 : 50, signals: { side: 'long' } };
}

module.exports = { donchianBreakout, rsi2Reversion, maPullback };
