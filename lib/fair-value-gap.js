'use strict';

// Research-only ICT-style three-candle fair value gaps.  This module describes
// zones from candles available at the decision time; it does not affect a live rank.
const finite = Number.isFinite;
const round = (x, n = 4) => finite(x) ? +x.toFixed(n) : null;

function detectFairValueGaps(candles, { maxAge = 63, atr = null } = {}) {
  const c = (candles || []).filter(x => x && finite(x.high) && finite(x.low));
  if (c.length < 3) return [];
  const start = Math.max(2, c.length - maxAge - 2);
  const out = [];
  for (let i = start; i < c.length; i++) {
    const left = c[i - 2], right = c[i];
    let side = null, lower = null, upper = null;
    if (right.low > left.high) { side = 'bullish'; lower = left.high; upper = right.low; }
    else if (right.high < left.low) { side = 'bearish'; lower = right.high; upper = left.low; }
    if (!side || !(upper > lower)) continue;

    const later = c.slice(i + 1);
    let deepest = side === 'bullish' ? upper : lower;
    let firstTouchDate = null;
    for (const bar of later) {
      if (side === 'bullish') {
        if (bar.low < deepest) deepest = bar.low;
        if (!firstTouchDate && bar.low <= upper) firstTouchDate = bar.date || null;
      } else {
        if (bar.high > deepest) deepest = bar.high;
        if (!firstTouchDate && bar.high >= lower) firstTouchDate = bar.date || null;
      }
    }
    const width = upper - lower;
    const fillPct = side === 'bullish'
      ? Math.max(0, Math.min(1, (upper - deepest) / width))
      : Math.max(0, Math.min(1, (deepest - lower) / width));
    const active = fillPct < 1;
    const px = c[c.length - 1].close;
    const distancePct = side === 'bullish'
      ? (px > upper ? (px - upper) / px : px < lower ? (lower - px) / px : 0)
      : (px < lower ? (lower - px) / px : px > upper ? (px - upper) / px : 0);
    out.push({
      side, formedDate: right.date || null, ageBars: c.length - 1 - i,
      lower: round(lower, 2), upper: round(upper, 2), widthPct: round(width / px * 100, 2),
      fillPct: round(fillPct, 3), active, firstTouchDate,
      distancePct: round(distancePct * 100, 3), distanceAtr: finite(atr) && atr > 0 ? round((distancePct * px) / atr, 3) : null,
    });
  }
  return out;
}

function bullishFvgFeature(candles, opts = {}) {
  const zones = detectFairValueGaps(candles, opts).filter(z => z.side === 'bullish' && z.active);
  if (!zones.length) return { present: false, score: 0, zone: null };
  // Favor fresh, meaningfully sized zones that price has approached or partially mitigated.
  for (const z of zones) {
    const freshness = Math.max(0, 1 - z.ageBars / (opts.maxAge || 63));
    const proximity = Math.max(0, 1 - z.distancePct / 8);
    const mitigation = z.fillPct > 0 && z.fillPct < 1 ? 1 : 0.55;
    const width = Math.min(1, (z.widthPct || 0) / 2);
    z.researchScore = round(100 * (0.35 * freshness + 0.35 * proximity + 0.2 * mitigation + 0.1 * width), 1);
  }
  zones.sort((a, b) => b.researchScore - a.researchScore || a.ageBars - b.ageBars);
  return { present: true, score: zones[0].researchScore, zone: zones[0], count: zones.length };
}

module.exports = { detectFairValueGaps, bullishFvgFeature };
