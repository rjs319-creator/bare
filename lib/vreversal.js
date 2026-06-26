// V-REVERSAL DETECTOR — sharp selloff into a capitulation low, then a sharp
// snap-back (a "V" bottom). Pure function over daily candles → a tiered signal
// with mechanical buy/stop/target levels. NO network, NO state — so it can run
// both in the live scan (api/tracker op=vreversal) and the historical edge test
// (op=vreversaltest) off the exact same logic.
//
// The shape (three legs):
//   1) DOWN-LEG  — price falls ≥ minDrop from a prior high into a local low,
//      ideally getting oversold (RSI at the low < 35 = capitulation).
//   2) PIVOT     — the lowest low a few-to-several sessions ago (the V's point).
//   3) RECOVERY  — a sharp rebound off that low, confirmed by some of: reclaiming
//      the 20-EMA, a bullish MACD, RSI turning up from oversold, a higher high.
//
// Tiers (by how confirmed the turn is):
//   CONFIRMED — ≥3 confirmations incl. 20-EMA reclaim, meaningful rally off low.
//   EMERGING  — partial confirmation; the turn is underway but not sealed.
//   WATCH     — fresh oversold pivot just starting to turn (aggressive bottom-catch).

const lastOf = a => a[a.length - 1];

function emaSeries(vals, period) {
  const k = 2 / (period + 1); const out = []; let prev;
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[i] : vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

// Wilder RSI series (null until enough history).
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) gain += ch; else loss -= ch; }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    ag = (ag * (period - 1) + g) / period; al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function atrLast(h, l, c, period = 14) {
  const n = c.length; if (n < period + 1) return null;
  let tr = 0;
  for (let i = n - period; i < n; i++) tr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  return tr / period;
}

function macdSeries(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const signal = emaSeries(macd, 9);
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
}

// Mechanical reward:risk math shared by every detector. A measured-move setup is
// "expired" once price has already reached (or passed) the target — there is no
// reward left and the structural stop now sits implausibly far from price. Flagging
// it lets the conviction layer refuse a stale entry even on a high-posterior name.
//   side 'long'  : risk = entry − stop, reward = target − entry
//   side 'short' : risk = stop − entry, reward = entry − target
function tradeLevels(side, entry, stop, target) {
  const long = side === 'long';
  const riskAmt = long ? entry - stop : stop - entry;
  const rewardAmt = long ? target - entry : entry - target;
  const rr = riskAmt > 0 ? +(rewardAmt / riskAmt).toFixed(2) : null;
  const riskPct = entry > 0 ? +((Math.abs(riskAmt) / entry) * 100).toFixed(1) : null;
  const expired = !(rewardAmt > 0) || rr == null || rr <= 0;
  return { rr, riskPct, expired };
}

// Analyze the most recent bar for a V-reversal. Returns null if no valid V.
function analyzeVReversal(candles, opts = {}) {
  const { lookback = 60, minDrop = 0.15, maxPivotAge = 30, minRecovery = 2, downLegMax = 50 } = opts;
  const n = candles.length;
  if (n < 80) return null;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const i = n - 1, close = closes[i];

  // 1) Pivot low — lowest low between maxPivotAge and minRecovery sessions ago
  //    (must be a few bars back so a recovery leg actually exists).
  const lo = Math.max(0, i - maxPivotAge), hi = i - minRecovery;
  if (hi <= lo) return null;
  let pivotIdx = lo; for (let k = lo; k <= hi; k++) if (lows[k] < lows[pivotIdx]) pivotIdx = k;
  const pivotLow = lows[pivotIdx];

  // 2) Prior high before the pivot (top of the down-leg) → drop depth.
  const dlo = Math.max(0, pivotIdx - downLegMax);
  let priorHighIdx = dlo; for (let k = dlo; k <= pivotIdx; k++) if (highs[k] > highs[priorHighIdx]) priorHighIdx = k;
  const priorHigh = highs[priorHighIdx];
  const drop = (priorHigh - pivotLow) / priorHigh;
  const daysDown = pivotIdx - priorHighIdx;
  if (drop < minDrop || daysDown < 3) return null;          // not a real, sharp down-leg

  // 3) Recovery leg.
  const rallyOffLow = (close - pivotLow) / pivotLow;
  const daysUp = i - pivotIdx;
  if (rallyOffLow <= 0) return null;                        // not turning up yet

  // Indicators.
  const rsi = rsiSeries(closes, 14);
  const rsiNow = rsi[i], rsiAtPivot = rsi[pivotIdx] != null ? rsi[pivotIdx] : 50;
  const ema20 = lastOf(emaSeries(closes, 20));
  const { macd, signal, hist } = macdSeries(closes);
  const atr = atrLast(highs, lows, closes, 14) || pivotLow * 0.02;

  // Confirmations.
  const reclaim20 = close > ema20;
  const macdBull = hist[i] > 0 || macd[i] > signal[i];
  const rsiTurn = rsiNow != null && rsiNow > rsiAtPivot + 5 && rsiNow > 40;
  const sincePivotHigh = highs.slice(pivotIdx + 1, i).reduce((m, h) => Math.max(m, h), -Infinity);
  const higherHigh = isFinite(sincePivotHigh) && close > sincePivotHigh;
  const confirmations = [reclaim20 && 'reclaim20', macdBull && 'macdBull', rsiTurn && 'rsiTurn', higherHigh && 'higherHigh'].filter(Boolean);
  const nConf = confirmations.length;
  const oversoldBottom = rsiAtPivot < 35;
  const slopeDown = drop / Math.max(daysDown, 1), slopeUp = rallyOffLow / Math.max(daysUp, 1);
  const vSharpness = +(slopeUp / (slopeDown + 1e-9)).toFixed(2);

  // Tier.
  let tier;
  if (nConf >= 3 && reclaim20 && rallyOffLow >= 0.04) tier = 'CONFIRMED';
  else if (nConf >= 2 || (nConf >= 1 && rallyOffLow >= 0.03)) tier = 'EMERGING';
  else if (oversoldBottom && daysUp <= 8 && rallyOffLow < 0.08) tier = 'WATCH';
  else return null;

  // Score (0-100): capitulation depth + oversold bottom + confirmations + V sharpness + recovery progress.
  let score = 0;
  score += Math.min(drop / 0.4, 1) * 25;
  score += Math.min((35 - Math.min(rsiAtPivot, 35)) / 35, 1) * 15;
  score += (nConf / 4) * 30;
  score += Math.min(vSharpness, 2) / 2 * 15;
  score += Math.min(rallyOffLow / 0.15, 1) * 15;
  score = Math.round(Math.max(0, Math.min(100, score)));

  // Mechanical buy/sell levels: stop below the V low (−1 ATR), target = the prior
  // high (the measured move back to where it broke down).
  const entry = close, stop = +(pivotLow - atr).toFixed(2), target = +priorHigh.toFixed(2);
  const { rr, riskPct, expired } = tradeLevels('long', entry, stop, target);

  return {
    tier, score,
    geometry: {
      priorHigh: +priorHigh.toFixed(2), pivotLow: +pivotLow.toFixed(2), pivotDate: candles[pivotIdx].date,
      dropPct: +(drop * 100).toFixed(1), daysDown, daysUp, rallyOffLowPct: +(rallyOffLow * 100).toFixed(1),
      rsiAtPivot: +rsiAtPivot.toFixed(0), rsiNow: rsiNow != null ? +rsiNow.toFixed(0) : null, vSharpness,
    },
    confirmations,
    signals: {
      side: 'long', entry: +entry.toFixed(2), stop, target, rr, riskPct, expired,
      exits: [
        `Stop: a close below ${stop} (below the V low) — the reversal failed.`,
        `Target: ${target} (prior high / measured move).`,
        'Momentum exit: MACD crosses back down, or a lower-high forms after a run.',
      ],
      note: expired ? 'Setup expired — price already reached the measured-move target; no fresh long here.'
        : tier === 'WATCH' ? 'Aggressive bottom-catch — UNCONFIRMED. Size small and honor the stop; many of these fail.'
          : tier === 'CONFIRMED' ? 'Confirmed reversal — turn is sealed (20-EMA reclaimed + momentum). Stop below the V low.'
            : 'Emerging reversal — partial confirmation. Wait for a 20-EMA reclaim, or scale in.',
    },
  };
}

// INVERTED-V (TOP) DETECTOR — the mirror of analyzeVReversal: a sharp run-up into
// a blow-off high, then a sharp rollover. The intended trade is a SHORT (fade the
// exhausted top). Same three legs, flipped:
//   1) UP-LEG    — price rises ≥ minRise from a prior low into a local high,
//      ideally getting overbought (RSI at the high > 65 = blow-off).
//   2) PIVOT     — the highest high a few-to-several sessions ago (the peak).
//   3) ROLLOVER  — a sharp decline off that high, confirmed by some of: losing the
//      20-EMA, a bearish MACD, RSI turning down from overbought, a lower low.
function analyzeInvertedV(candles, opts = {}) {
  const { minRise = 0.15, maxPivotAge = 30, minRollover = 2, upLegMax = 50 } = opts;
  const n = candles.length;
  if (n < 80) return null;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const i = n - 1, close = closes[i];

  // 1) Pivot high — highest high between maxPivotAge and minRollover sessions ago.
  const lo = Math.max(0, i - maxPivotAge), hi = i - minRollover;
  if (hi <= lo) return null;
  let pivotIdx = lo; for (let k = lo; k <= hi; k++) if (highs[k] > highs[pivotIdx]) pivotIdx = k;
  const pivotHigh = highs[pivotIdx];

  // 2) Prior low before the pivot (bottom of the up-leg) → rise depth.
  const ulo = Math.max(0, pivotIdx - upLegMax);
  let priorLowIdx = ulo; for (let k = ulo; k <= pivotIdx; k++) if (lows[k] < lows[priorLowIdx]) priorLowIdx = k;
  const priorLow = lows[priorLowIdx];
  const rise = (pivotHigh - priorLow) / priorLow;
  const daysUp = pivotIdx - priorLowIdx;
  if (rise < minRise || daysUp < 3) return null;            // not a real, sharp up-leg

  // 3) Rollover leg.
  const dropOffHigh = (pivotHigh - close) / pivotHigh;
  const daysDown = i - pivotIdx;
  if (dropOffHigh <= 0) return null;                        // not rolling over yet

  // Indicators.
  const rsi = rsiSeries(closes, 14);
  const rsiNow = rsi[i], rsiAtPivot = rsi[pivotIdx] != null ? rsi[pivotIdx] : 50;
  const ema20 = emaSeries(closes, 20)[i];
  const { macd, signal, hist } = macdSeries(closes);
  const atr = atrLast(highs, lows, closes, 14) || pivotHigh * 0.02;

  // Confirmations (mirror of the V).
  const lose20 = close < ema20;
  const macdBear = hist[i] < 0 || macd[i] < signal[i];
  const rsiTurn = rsiNow != null && rsiNow < rsiAtPivot - 5 && rsiNow < 60;
  const sincePivotLow = lows.slice(pivotIdx + 1, i).reduce((m, l) => Math.min(m, l), Infinity);
  const lowerLow = isFinite(sincePivotLow) && close < sincePivotLow;
  const confirmations = [lose20 && 'lose20', macdBear && 'macdBear', rsiTurn && 'rsiTurn', lowerLow && 'lowerLow'].filter(Boolean);
  const nConf = confirmations.length;
  const overboughtTop = rsiAtPivot > 65;
  const slopeUp = rise / Math.max(daysUp, 1), slopeDown = dropOffHigh / Math.max(daysDown, 1);
  const vSharpness = +(slopeDown / (slopeUp + 1e-9)).toFixed(2);

  // Tier.
  let tier;
  if (nConf >= 3 && lose20 && dropOffHigh >= 0.04) tier = 'CONFIRMED';
  else if (nConf >= 2 || (nConf >= 1 && dropOffHigh >= 0.03)) tier = 'EMERGING';
  else if (overboughtTop && daysDown <= 8 && dropOffHigh < 0.08) tier = 'WATCH';
  else return null;

  // Score (0-100): blow-off depth + overbought top + confirmations + sharpness + rollover progress.
  let score = 0;
  score += Math.min(rise / 0.4, 1) * 25;
  score += Math.min((Math.max(rsiAtPivot, 65) - 65) / 35, 1) * 15;
  score += (nConf / 4) * 30;
  score += Math.min(vSharpness, 2) / 2 * 15;
  score += Math.min(dropOffHigh / 0.15, 1) * 15;
  score = Math.round(Math.max(0, Math.min(100, score)));

  // Mechanical short levels: stop above the peak (+1 ATR), target = the prior low
  // (the measured move back to where the run-up began).
  const entry = close, stop = +(pivotHigh + atr).toFixed(2), target = +priorLow.toFixed(2);
  const { rr, riskPct, expired } = tradeLevels('short', entry, stop, target);

  return {
    tier, score,
    geometry: {
      priorLow: +priorLow.toFixed(2), pivotHigh: +pivotHigh.toFixed(2), pivotDate: candles[pivotIdx].date,
      risePct: +(rise * 100).toFixed(1), daysUp, daysDown, dropOffHighPct: +(dropOffHigh * 100).toFixed(1),
      rsiAtPivot: +rsiAtPivot.toFixed(0), rsiNow: rsiNow != null ? +rsiNow.toFixed(0) : null, vSharpness,
    },
    confirmations,
    signals: {
      side: 'short', entry: +entry.toFixed(2), stop, target, rr, riskPct, expired,
      exits: [
        `Stop: a close above ${stop} (above the peak) — the top held, trend resumed.`,
        `Target: ${target} (prior low / measured move).`,
        'Cover: MACD crosses back up, or a higher-low forms after the drop.',
      ],
      note: expired ? 'Setup expired — price already reached the measured-move target; no fresh short here.'
        : tier === 'WATCH' ? 'Aggressive top-fade — UNCONFIRMED. Shorting strength is dangerous; size small and honor the stop.'
          : tier === 'CONFIRMED' ? 'Confirmed rollover — 20-EMA lost + momentum down. Stop above the peak.'
            : 'Emerging rollover — partial confirmation. Wait for a 20-EMA loss, or scale in.',
    },
  };
}

// LIQUIDITY-SWEEP DETECTOR — the ICT / "stop-hunt" reversal. A short (1-3 bar)
// event, NOT a multi-week shape: price wicks THROUGH a prior swing low/high
// (taking out the stops clustered just beyond it), then snaps back and reclaims
// the level. You enter in the reversal direction off the sweep.
//   dir=+1 (bullish): sweep a prior swing LOW, reclaim → LONG.
//   dir=-1 (bearish): sweep a prior swing HIGH, reject → SHORT.
// Mechanical, same tiering vocabulary as the V detectors so the edge harness and
// UI treat all three patterns uniformly.
function analyzeLiquiditySweep(candles, opts = {}) {
  const { dir = 1, swingLookback = 40, swingHalf = 3, sweepWindow = 3, minWick = 0.33, maxPenetration = 0.05 } = opts;
  const n = candles.length;
  if (n < 80) return null;
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high),
    lows = candles.map(c => c.low), opens = candles.map(c => c.open);
  const i = n - 1, close = closes[i];
  const atr = atrLast(highs, lows, closes, 14) || close * 0.02;
  const ema10 = emaSeries(closes, 10)[i];

  if (dir === 1) {
    // 1) Sweep bar = the lowest low in the last sweepWindow bars.
    let sweepIdx = i; for (let k = Math.max(0, i - sweepWindow + 1); k <= i; k++) if (lows[k] < lows[sweepIdx]) sweepIdx = k;
    const sweepLow = lows[sweepIdx];
    // 2) The liquidity pool = the most recent prior swing-LOW pivot before the sweep.
    let swingLow = null;
    for (let j = sweepIdx - 1; j >= Math.max(swingHalf, sweepIdx - swingLookback); j--) {
      let pivot = true;
      for (let w = 1; w <= swingHalf; w++) if (lows[j] > lows[j - w] || lows[j] > lows[j + w]) { pivot = false; break; }
      if (pivot) { swingLow = lows[j]; break; }
    }
    if (swingLow == null) return null;
    // 3) Must take the liquidity then reclaim — not a trivial poke, not a full breakdown.
    if (!(sweepLow < swingLow)) return null;
    if (sweepLow < swingLow * (1 - maxPenetration)) return null;   // a real breakdown, not a sweep
    if (!(close > swingLow)) return null;                          // not reclaimed

    const rng = (highs[sweepIdx] - lows[sweepIdx]) || 1e-9;
    const lowerWick = (Math.min(opens[sweepIdx], closes[sweepIdx]) - lows[sweepIdx]) / rng;
    const strongWick = lowerWick >= minWick;
    const reclaimClose = closes[sweepIdx] > swingLow;             // the sweep bar itself closed back above
    const backAbove = close > ema10;
    const followThrough = close > closes[Math.max(0, i - 1)];
    const conf = [strongWick && 'wick', reclaimClose && 'reclaimClose', backAbove && 'backAbove', followThrough && 'followThrough'].filter(Boolean);
    const nConf = conf.length;
    let tier;
    if (nConf >= 3 && reclaimClose) tier = 'CONFIRMED';
    else if (nConf >= 2) tier = 'EMERGING';
    else tier = 'WATCH';

    let swingHigh = highs[i]; for (let k = Math.max(0, i - swingLookback); k <= i; k++) if (highs[k] > swingHigh) swingHigh = highs[k];
    const penetration = (swingLow - sweepLow) / swingLow;
    let score = 0;
    score += Math.min(lowerWick / 0.6, 1) * 30;
    score += (nConf / 4) * 30;
    score += Math.min(penetration / 0.03, 1) * 20;               // a clean stop-run, not a deep break
    score += reclaimClose ? 20 : 0;
    score = Math.round(Math.max(0, Math.min(100, score)));

    const entry = close, stop = +(sweepLow - atr * 0.25).toFixed(2), target = +swingHigh.toFixed(2);
    const { rr, riskPct, expired } = tradeLevels('long', entry, stop, target);
    return {
      tier, score,
      geometry: {
        sweptLevel: +swingLow.toFixed(2), sweepLow: +sweepLow.toFixed(2), sweepDate: candles[sweepIdx].date,
        penetrationPct: +(penetration * 100).toFixed(2), lowerWickPct: +(lowerWick * 100).toFixed(0),
        targetSwingHigh: +swingHigh.toFixed(2),
      },
      confirmations: conf,
      signals: {
        side: 'long', entry: +entry.toFixed(2), stop, target, rr, riskPct, expired,
        exits: [
          `Stop: a close below ${stop} (back under the sweep low) — the sweep failed / real breakdown.`,
          `Target: ${target} (next liquidity above = prior swing high).`,
          'Cover/trim: into the swing high, or if a lower-high forms.',
        ],
        note: 'Bullish liquidity sweep — stops below a swing low were taken then reclaimed. Stop below the sweep low.',
      },
    };
  }

  // dir === -1 : bearish mirror — sweep a swing HIGH then reject → SHORT.
  let sweepIdx = i; for (let k = Math.max(0, i - sweepWindow + 1); k <= i; k++) if (highs[k] > highs[sweepIdx]) sweepIdx = k;
  const sweepHigh = highs[sweepIdx];
  let swingHigh = null;
  for (let j = sweepIdx - 1; j >= Math.max(swingHalf, sweepIdx - swingLookback); j--) {
    let pivot = true;
    for (let w = 1; w <= swingHalf; w++) if (highs[j] < highs[j - w] || highs[j] < highs[j + w]) { pivot = false; break; }
    if (pivot) { swingHigh = highs[j]; break; }
  }
  if (swingHigh == null) return null;
  if (!(sweepHigh > swingHigh)) return null;
  if (sweepHigh > swingHigh * (1 + maxPenetration)) return null;  // a real breakout, not a sweep
  if (!(close < swingHigh)) return null;                          // not rejected

  const rng = (highs[sweepIdx] - lows[sweepIdx]) || 1e-9;
  const upperWick = (highs[sweepIdx] - Math.max(opens[sweepIdx], closes[sweepIdx])) / rng;
  const strongWick = upperWick >= minWick;
  const rejectClose = closes[sweepIdx] < swingHigh;
  const backBelow = close < ema10;
  const followThrough = close < closes[Math.max(0, i - 1)];
  const conf = [strongWick && 'wick', rejectClose && 'rejectClose', backBelow && 'backBelow', followThrough && 'followThrough'].filter(Boolean);
  const nConf = conf.length;
  let tier;
  if (nConf >= 3 && rejectClose) tier = 'CONFIRMED';
  else if (nConf >= 2) tier = 'EMERGING';
  else tier = 'WATCH';

  let swingLow = lows[i]; for (let k = Math.max(0, i - swingLookback); k <= i; k++) if (lows[k] < swingLow) swingLow = lows[k];
  const penetration = (sweepHigh - swingHigh) / swingHigh;
  let score = 0;
  score += Math.min(upperWick / 0.6, 1) * 30;
  score += (nConf / 4) * 30;
  score += Math.min(penetration / 0.03, 1) * 20;
  score += rejectClose ? 20 : 0;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const entry = close, stop = +(sweepHigh + atr * 0.25).toFixed(2), target = +swingLow.toFixed(2);
  const { rr, riskPct, expired } = tradeLevels('short', entry, stop, target);
  return {
    tier, score,
    geometry: {
      sweptLevel: +swingHigh.toFixed(2), sweepHigh: +sweepHigh.toFixed(2), sweepDate: candles[sweepIdx].date,
      penetrationPct: +(penetration * 100).toFixed(2), upperWickPct: +(upperWick * 100).toFixed(0),
      targetSwingLow: +swingLow.toFixed(2),
    },
    confirmations: conf,
    signals: {
      side: 'short', entry: +entry.toFixed(2), stop, target, rr, riskPct, expired,
      exits: [
        `Stop: a close above ${stop} (back over the sweep high) — the sweep failed / real breakout.`,
        `Target: ${target} (next liquidity below = prior swing low).`,
        'Cover/trim: into the swing low, or if a higher-low forms.',
      ],
      note: 'Bearish liquidity sweep — stops above a swing high were taken then rejected. Stop above the sweep high.',
    },
  };
}

module.exports = { analyzeVReversal, analyzeInvertedV, analyzeLiquiditySweep, tradeLevels, rsiSeries, emaSeries, macdSeries, atrLast };
