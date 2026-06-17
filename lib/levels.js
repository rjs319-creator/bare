// Swing-structure trade levels shared by the screener, momentum and picks cards:
//   • stop      — just below the breakout pivot (if given) or the recent swing low
//   • risk      — risk per share (entry − stop for longs)
//   • resistance— the next overhead level (nearest swing high above entry; a
//                 measured move if price is in blue sky)
//   • rr        — reward:risk to that resistance
// Mirrored for shorts (stop above swing high, target = next support below).

// Local maxima ('high') / minima ('low') with a ±k confirmation window.
function pivots(vals, k, kind) {
  const out = [];
  for (let i = k; i < vals.length - k; i++) {
    let ok = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (kind === 'high' ? vals[j] > vals[i] : vals[j] < vals[i]) { ok = false; break; }
    }
    if (ok) out.push(vals[i]);
  }
  return out;
}

function atrOf(candles, period = 14) {
  const n = candles.length;
  if (n < 2) return 0;
  const tr = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const s = tr.slice(-period);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

// candles: daily OHLC oldest→newest. entry: actionable price.
// opts: { bullish=true, pivot, baseHeight, atr, lookback=120, targetMode }
//   targetMode 'resistance' (default) → reward to the next swing high/low.
//   targetMode 'measured'             → reward to a measured-move/ATR objective,
//                                       fairer for breakouts that have already
//                                       cleared their resistance (no tiny numerator).
function tradeLevels(candles, entry, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 20 || !(entry > 0)) return null;
  const bullish = opts.bullish !== false;
  const measured = opts.targetMode === 'measured';
  const n = candles.length;
  const look = Math.min(opts.lookback || 120, n);
  const seg = candles.slice(n - look);
  const highs = seg.map(c => c.high);
  const lows = seg.map(c => c.low);
  const atr = opts.atr || atrOf(candles);
  const buffer = Math.max(entry * 0.005, 0.25 * atr); // small cushion past the level
  // Measured-move objective: project the base height (or an ATR multiple) off entry.
  const projection = Math.max(opts.baseHeight || 0, 4 * atr, entry * 0.06);

  if (bullish) {
    // Stop: below the breakout pivot if supplied, else the most recent swing low.
    const swLows = pivots(lows, 3, 'low').filter(p => p <= entry);
    const swingLow = swLows.length ? swLows[swLows.length - 1] : Math.min(...lows.slice(-10));
    const base = opts.pivot != null ? opts.pivot : swingLow;
    const stop = base - buffer;
    const risk = entry - stop;
    if (!(risk > 0)) return null;
    // Target: measured move, or the nearest swing high above entry (blue sky → measured).
    const swHighs = pivots(highs, 3, 'high').filter(p => p > entry * 1.005).sort((a, b) => a - b);
    const blueSky = swHighs.length === 0;
    const useMeasured = measured || blueSky;
    const resistance = useMeasured ? entry + projection : swHighs[0];
    const rr = (resistance - entry) / risk;
    return {
      stop: +stop.toFixed(2),
      risk: +risk.toFixed(2),
      resistance: +resistance.toFixed(2),
      rr: +rr.toFixed(2),
      blueSky,
      targetType: useMeasured ? 'measured' : 'resistance',
      stopBasis: opts.pivot != null ? 'pivot' : 'swing low',
    };
  }

  // Short mirror.
  const swHighs = pivots(highs, 3, 'high').filter(p => p >= entry);
  const swingHigh = swHighs.length ? swHighs[swHighs.length - 1] : Math.max(...highs.slice(-10));
  const base = opts.pivot != null ? opts.pivot : swingHigh;
  const stop = base + buffer;
  const risk = stop - entry;
  if (!(risk > 0)) return null;
  const swLows = pivots(lows, 3, 'low').filter(p => p < entry * 0.995).sort((a, b) => b - a);
  const blueSky = swLows.length === 0;
  const useMeasured = measured || blueSky;
  const support = useMeasured ? entry - projection : swLows[0];
  const rr = (entry - support) / risk;
  return {
    stop: +stop.toFixed(2),
    risk: +risk.toFixed(2),
    resistance: +support.toFixed(2), // "target" level (support) for shorts
    rr: +rr.toFixed(2),
    blueSky,
    targetType: useMeasured ? 'measured' : 'support',
    stopBasis: opts.pivot != null ? 'pivot' : 'swing high',
  };
}

module.exports = { tradeLevels, atrOf };
