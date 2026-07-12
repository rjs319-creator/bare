// UNIFORM PICK SCORE — one cross-sectionally comparable 0-100 conviction score for EVERY
// pick, regardless of which screener logged it, so the Scoreboard can validate a single
// question board-wide: do higher-conviction picks actually earn better forward returns?
//
// WHY a new score instead of each section's own: the sections score on incomparable
// scales (Apex 0-100 composite, Ghost 0-100 accumulation, momentum rank, raw tier…), so a
// "score decile" across the whole book was impossible — an 80 here ≠ an 80 there. This
// module derives ONE score with an identical construction for every pick, from the
// point-in-time PRICE ACTION the Scoreboard already has candles for. It is:
//   • uniform      — the same formula runs on every section's picks;
//   • directional  — a strong SHORT is a weak stock (conviction is in the pick's side);
//   • regime-aware — the momentum term is EXCESS vs SPY, so a rising tide doesn't inflate
//                    every score in an up-tape (the app's own research: raw momentum edge
//                    ~0.10 rank-IC, and excess/RS is the regime-robust part);
//   • honest       — it is a momentum/trend CONVICTION rank, NOT a calibrated probability.
//
// Pure + deterministic (candles in → number out) → fully unit-testable, no network.

'use strict';

const PICKSCORE_VERSION = 'uscore-v1';

const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Index of the last candle at/or before a date (point-in-time; no look-ahead).
function idxAsOf(candles, date) {
  let i = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) i = k; else break; }
  return i;
}

// Trailing simple-return over `bars` sessions ending at idx (%). null if not enough history.
function momentum(candles, idx, bars) {
  if (idx < bars) return null;
  const prev = candles[idx - bars] && candles[idx - bars].close;
  const now = candles[idx] && candles[idx].close;
  if (!prev || !now) return null;
  return (now / prev - 1) * 100;
}

// +1 if the close is above its `period`-SMA at idx, −1 below, null if not enough history.
function smaSide(candles, idx, period) {
  if (idx < period - 1) return null;
  let s = 0;
  for (let k = idx - period + 1; k <= idx; k++) s += candles[k].close;
  return candles[idx].close > s / period ? 1 : -1;
}

// The raw directional momentum-conviction for one pick, from its point-in-time candles.
// Returns null when there isn't enough history to score it fairly (so it falls OUT of the
// cross-section rather than scoring a partial number that isn't comparable).
function pointInTimeStrength(candles, spyCandles, asOf, { isShort = false } = {}) {
  if (!Array.isArray(candles) || candles.length < 22) return null;
  const idx = idxAsOf(candles, asOf);
  if (idx < 21) return null;                 // need at least a 21-session lookback
  const m21 = momentum(candles, idx, 21);
  if (m21 == null) return null;
  const m63 = momentum(candles, idx, 63);    // may be null on shorter history
  const sma50 = smaSide(candles, idx, 50);
  const sma200 = smaSide(candles, idx, 200);
  // Excess (regime-normalized) 63-session momentum vs SPY over the same window.
  let rs = null;
  if (m63 != null && Array.isArray(spyCandles) && spyCandles.length) {
    const si = idxAsOf(spyCandles, asOf);
    const spyM = si >= 0 ? momentum(spyCandles, si, 63) : null;
    if (spyM != null) rs = m63 - spyM;
  }
  // Long-strength composite (bounded terms so one blow-off name can't dominate the rank).
  let L = 0.2 * clip(m21, -30, 30);
  if (m63 != null) L += 0.4 * clip(m63, -50, 50);
  if (rs != null) L += 0.4 * clip(rs, -40, 40);
  if (sma50 != null) L += 5 * sma50;
  if (sma200 != null) L += 5 * sma200;
  // Direction: conviction is in the pick's SIDE — a falling stock is a strong short.
  return +(isShort ? -L : L).toFixed(3);
}

// Convert an array of raw values → 0-100 cross-sectional percentiles (average-rank, so
// ties share a rank). This is what makes the score cross-comparable: a pick's uscore is
// its momentum-conviction percentile among the whole resolved cohort.
function toPercentiles(values) {
  const n = values.length;
  if (!n) return [];
  if (n === 1) return [50];
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const pct = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;   // tie group [i..j]
    const rank = (i + j) / 2;                                    // average rank
    const p = +((rank / (n - 1)) * 100).toFixed(0);
    for (let k = i; k <= j; k++) pct[order[k][1]] = p;
    i = j + 1;
  }
  return pct;
}

module.exports = { PICKSCORE_VERSION, pointInTimeStrength, toPercentiles, idxAsOf, momentum, smaSide };
