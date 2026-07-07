// Long-term (daily-timeframe) trend read + dual-horizon combiner.
//
// The live signal engine (lib/signal.js buildLiveSignal) is a SINGLE-timeframe
// read on 5-minute intraday bars — it has no idea whether a name is in a
// multi-month up- or down-trend. This module supplies the missing horizon: a
// pure read over ~1y of DAILY bars (SMA50/200 structure, price vs the 200DMA,
// relative strength vs SPY, 50DMA slope, distance from the 52-week high).
//
// combineDualRead() then fuses the short-term action with this long-term trend
// into a named setup ("pullback in an uptrend", "confirmed downtrend", …) — the
// mechanical baseline the Fable narrative layer later refines. Numbers stay
// mechanical here; Fable only relabels/explains.

// Bucketing thresholds for the composite long-term score.
const LT_BULL = 3;
const LT_BEAR = -3;

// Relative-strength deadband (%) — ignore small stock-minus-SPY differences.
const RS_STRONG_3M = 3;
const RS_STRONG_6M = 3;

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sma = (closes, n) => (closes.length >= n ? avg(closes.slice(-n)) : null);

// Simple return over the last n sessions of a close series (fraction).
function retN(closes, n) {
  if (!closes || closes.length <= n) return null;
  const past = closes[closes.length - 1 - n];
  if (!past) return null;
  return (closes[closes.length - 1] - past) / past;
}

// Relative strength vs SPY over n sessions, in percentage points.
function relStrengthPct(closes, spyCloses, n) {
  const s = retN(closes, n), m = retN(spyCloses, n);
  if (s == null || m == null) return null;
  return (s - m) * 100;
}

// The long-term daily read. `dailyCandles`/`spyCandles` are ~1y of daily bars
// ({close, high, …}); SPY may be null (RS factors are then skipped).
function longTermRead(dailyCandles, spyCandles) {
  if (!dailyCandles || dailyCandles.length < 60) {
    return { trend: 'neutral', score: 0, factors: {}, reasons: ['Not enough history for a long-term read.'], insufficient: true };
  }
  const closes = dailyCandles.map(c => c.close);
  const highs = dailyCandles.map(c => c.high ?? c.close);
  const spyCloses = spyCandles ? spyCandles.map(c => c.close) : null;

  const px = closes[closes.length - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const hi52 = Math.max(...highs.slice(-252));

  let score = 0;
  const reasons = [];
  const factors = { price: +px.toFixed(2) };

  // 1. Price vs the 200-day — the primary long-term regime line.
  if (sma200 != null) {
    factors.sma200 = +sma200.toFixed(2);
    const pctFrom200 = ((px - sma200) / sma200) * 100;
    factors.pctFrom200 = +pctFrom200.toFixed(1);
    if (px > sma200) { score += 2; reasons.push(`Above the 200-day (${pctFrom200 >= 0 ? '+' : ''}${pctFrom200.toFixed(0)}%)`); }
    else { score -= 2; reasons.push(`Below the 200-day (${pctFrom200.toFixed(0)}%)`); }
  }

  // 2. 50-day vs 200-day (golden / death structure).
  if (sma50 != null && sma200 != null) {
    factors.sma50 = +sma50.toFixed(2);
    if (sma50 > sma200) { score += 2; reasons.push('50-day above 200-day (uptrend structure)'); }
    else { score -= 2; reasons.push('50-day below 200-day (downtrend structure)'); }
  }

  // 3. Price vs the 50-day (intermediate trend).
  if (sma50 != null) {
    if (px > sma50) { score += 1; reasons.push('Holding above the 50-day'); }
    else { score -= 1; reasons.push('Trading below the 50-day'); }
  }

  // 4. Relative strength vs SPY over 3 months (~63 sessions).
  const rs3 = relStrengthPct(closes, spyCloses, 63);
  if (rs3 != null) {
    factors.rs3mPct = +rs3.toFixed(1);
    if (rs3 > RS_STRONG_3M) { score += 2; reasons.push(`Outperforming SPY over 3mo (+${rs3.toFixed(0)}pts)`); }
    else if (rs3 < -RS_STRONG_3M) { score -= 2; reasons.push(`Lagging SPY over 3mo (${rs3.toFixed(0)}pts)`); }
  }

  // 5. Relative strength vs SPY over 6 months (~126 sessions).
  const rs6 = relStrengthPct(closes, spyCloses, 126);
  if (rs6 != null) {
    factors.rs6mPct = +rs6.toFixed(1);
    if (rs6 > RS_STRONG_6M) { score += 1; reasons.push('Six-month leader vs SPY'); }
    else if (rs6 < -RS_STRONG_6M) { score -= 1; reasons.push('Six-month laggard vs SPY'); }
  }

  // 6. Slope of the 50-day over the last month (is the trend still improving?).
  if (closes.length >= 71) {
    const sma50Prev = avg(closes.slice(-71, -21));
    if (sma50 != null && sma50Prev != null) {
      const slope = ((sma50 - sma50Prev) / sma50Prev) * 100;
      factors.sma50SlopePct = +slope.toFixed(1);
      if (slope > 1) { score += 1; reasons.push('50-day still rising'); }
      else if (slope < -1) { score -= 1; reasons.push('50-day rolling over'); }
    }
  }

  // 7. Distance from the 52-week high (leadership vs damage).
  if (hi52 > 0) {
    const fromHigh = ((px - hi52) / hi52) * 100;
    factors.pctFrom52wHigh = +fromHigh.toFixed(1);
    if (fromHigh > -15) { score += 1; reasons.push('Near 52-week highs'); }
    else if (fromHigh < -25) { score -= 1; reasons.push(`${fromHigh.toFixed(0)}% off the 52-week high`); }
  }

  const trend = score >= LT_BULL ? 'bullish' : score <= LT_BEAR ? 'bearish' : 'neutral';
  factors.score = score;
  return { trend, score, factors, reasons: reasons.slice(0, 5) };
}

// Map the short-term action label to a coarse side.
function stSide(action) {
  if (action === 'STRONG_BUY' || action === 'BUY') return 'bullish';
  if (action === 'STRONG_SELL' || action === 'SELL') return 'bearish';
  return 'neutral';
}

// The nine (short × long) combinations, each a named, tradeable situation.
const QUADRANTS = {
  'bullish|bullish':  { setupClass: 'trend-continuation', verdict: 'Trend continuation — short and long term aligned up', stance: 'aligned' },
  'bullish|neutral':  { setupClass: 'early-strength',      verdict: 'Short-term strength, long-term still basing',       stance: 'confirm' },
  'bullish|bearish':  { setupClass: 'bear-bounce',         verdict: 'Bounce inside a downtrend — fade risk',              stance: 'caution' },
  'neutral|bullish':  { setupClass: 'uptrend-pause',       verdict: 'Long-term uptrend, short-term catching its breath',  stance: 'watch' },
  'neutral|neutral':  { setupClass: 'range',               verdict: 'No clear edge either horizon — range/chop',          stance: 'wait' },
  'neutral|bearish':  { setupClass: 'downtrend-pause',     verdict: 'Long-term downtrend, short-term stalling',           stance: 'avoid' },
  'bearish|bullish':  { setupClass: 'pullback-buy',        verdict: 'Pullback inside an uptrend — buy-the-dip candidate', stance: 'watch' },
  'bearish|neutral':  { setupClass: 'early-weakness',      verdict: 'Short-term weakness, long-term undecided',           stance: 'caution' },
  'bearish|bearish':  { setupClass: 'downtrend',           verdict: 'Confirmed downtrend — short and long term aligned down', stance: 'avoid' },
};

// Fuse the short-term action with the long-term trend into a named setup.
function combineDualRead(stAction, ltTrend) {
  const st = stSide(stAction);
  const lt = ltTrend || 'neutral';
  const key = `${st}|${lt}`;
  const q = QUADRANTS[key] || QUADRANTS['neutral|neutral'];
  return { quadrant: key, stShort: st, ltTrend: lt, ...q };
}

module.exports = { longTermRead, combineDualRead, stSide, LT_BULL, LT_BEAR };
