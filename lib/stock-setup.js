'use strict';
// DETERMINISTIC STOCK SETUP — the INDEPENDENT price read that options evidence is judged
// against. Direction, quality, and every level (support, resistance, trigger, invalidation,
// target) come from pure chart math on the candles — NEVER from an LLM and never from the
// options flow. This is what makes an options "confirmation" meaningful: the setup exists
// on its own; options can only agree, conflict, or stay ambiguous about it.
//
// Pure: candles in → setup out. Testable, no network, no clock.

const { calcRSI, calcATR } = require('./signal');

const lastOf = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
const clamp01 = v => Math.max(0, Math.min(1, v));
const r2 = v => (v == null ? null : +v.toFixed(2));

const SWING_LOOKBACK = 20;   // bars for recent swing high/low (the trade's structure)
const RR_TARGET = 2;         // reward:risk used to project the deterministic target

// Evaluate a swing setup from daily candles. Returns a setup with a direction
// ('long' | 'short' | 'none'), a 0-1 quality, and deterministic levels. `none` means no
// valid, tradeable swing structure — options can't "confirm" a setup that isn't there.
function evaluateSetup(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { direction: 'none', quality: 0, reason: 'insufficient-history', valid: false };
  }
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high ?? c.close);
  const lows = candles.map(c => c.low ?? c.close);
  const spot = closes[closes.length - 1];
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  const atr = lastOf(calcATR(candles, 14)) || spot * 0.02;
  const rsi = lastOf(calcRSI(closes, 14));

  const recentHigh = Math.max(...highs.slice(-SWING_LOOKBACK));
  const recentLow = Math.min(...lows.slice(-SWING_LOOKBACK));
  const sma200Prev = closes.length >= 220 ? sma(closes.slice(0, -20), 200) : sma200;
  const sma200Rising = sma200 != null && sma200Prev != null && sma200 > sma200Prev;
  const sma200Falling = sma200 != null && sma200Prev != null && sma200 < sma200Prev;

  // ── Direction from trend structure (independent of options) ──
  let direction = 'none';
  if (sma50 != null && sma200 != null) {
    if (spot > sma200 && sma50 > sma200 && spot > sma50 * 0.97) direction = 'long';
    else if (spot < sma200 && sma50 < sma200 && spot < sma50 * 1.03) direction = 'short';
  }
  if (direction === 'none') {
    return { direction: 'none', quality: 0, valid: false, spot: r2(spot), atr: r2(atr), rsi: rsi != null ? Math.round(rsi) : null,
      support: r2(Math.min(recentLow, sma50 ?? recentLow)), resistance: r2(Math.max(recentHigh, sma50 ?? recentHigh)),
      reason: 'no-clean-trend' };
  }

  // ── Deterministic levels (chart math only) ──
  let support, resistance, trigger, invalidation, target, reasons = [];
  if (direction === 'long') {
    support = Math.max(recentLow, sma50 != null && sma50 < spot ? sma50 : recentLow);   // nearest structural floor
    resistance = recentHigh;
    trigger = resistance > spot ? resistance : r2(spot + 0.25 * atr);                    // break of the swing high
    invalidation = Math.min(support, spot - 1.0 * atr);                                  // below support / an ATR
    target = trigger + RR_TARGET * (trigger - invalidation);                             // 2R projection
    reasons.push(`Uptrend — above the ${sma200Rising ? 'rising ' : ''}200-day, 50 > 200`);
    reasons.push(`Trigger a break of the ${SWING_LOOKBACK}-bar high $${r2(resistance)}; invalid below $${r2(invalidation)}`);
  } else {
    resistance = Math.min(recentHigh, sma50 != null && sma50 > spot ? sma50 : recentHigh);
    support = recentLow;
    trigger = support < spot ? support : r2(spot - 0.25 * atr);                          // break of the swing low
    invalidation = Math.max(resistance, spot + 1.0 * atr);                               // above resistance / an ATR
    target = trigger - RR_TARGET * (invalidation - trigger);
    reasons.push(`Downtrend — below the ${sma200Falling ? 'falling ' : ''}200-day, 50 < 200`);
    reasons.push(`Trigger a break of the ${SWING_LOOKBACK}-bar low $${r2(support)}; invalid above $${r2(invalidation)}`);
  }

  const risk = Math.abs(trigger - invalidation);
  const rr = risk > 0 ? +(Math.abs(target - trigger) / risk).toFixed(2) : null;

  // ── Quality (trend strength, not overbought/oversold, structure) ──
  const trendPart = clamp01(0.5 + (direction === 'long' ? (sma200Rising ? 0.25 : 0) : (sma200Falling ? 0.25 : 0)) + (Math.abs(spot - sma200) / sma200 > 0.05 ? 0.15 : 0));
  const rsiPart = rsi == null ? 0.5 : direction === 'long'
    ? clamp01(1 - Math.max(0, rsi - 70) / 20)   // penalize overbought longs
    : clamp01(1 - Math.max(0, 30 - rsi) / 20);  // penalize oversold shorts
  const quality = +((trendPart * 0.6 + rsiPart * 0.4)).toFixed(3);

  return {
    direction, valid: true, quality,
    spot: r2(spot), atr: r2(atr), rsi: rsi != null ? Math.round(rsi) : null,
    sma20: r2(sma20), sma50: r2(sma50), sma200: r2(sma200),
    support: r2(support), resistance: r2(resistance),
    trigger: r2(trigger), invalidation: r2(invalidation), target: r2(target), rr,
    reasons,
  };
}

module.exports = { evaluateSetup, SWING_LOOKBACK, RR_TARGET };
