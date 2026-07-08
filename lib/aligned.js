// DUAL-CONFIRMED picks — the strongest alignment of the dual-horizon read: names
// that are a BUY on BOTH horizons (short-term action bullish AND long-term trend
// bullish = the "trend-continuation" quadrant). Pure ranking helpers so the scan
// route stays thin and this stays testable.

// A pick qualifies only when the fused read is trend-continuation — i.e. both the
// intraday signal and the ~1y trend read point up. (combineDualRead maps
// STRONG_BUY/BUY × bullish → 'trend-continuation'.)
function isAligned(dual) {
  return !!dual && dual.setupClass === 'trend-continuation';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Conviction 0-100: half from the long-term trend strength (score 0-10), half from
// the short-term signal confidence (1-10). Both must be bullish to get here, so
// this ranks HOW strongly aligned, not whether.
function alignedScore(stConf, ltScore) {
  const lt = clamp((+ltScore || 0) / 10, 0, 1);
  const st = clamp((+stConf || 0) / 10, 0, 1);
  return Math.round((lt * 0.5 + st * 0.5) * 100);
}

// Attach conviction + sort strongest-first. Pure (returns a new array).
function rankAligned(items) {
  return (items || [])
    .map(it => ({ ...it, conviction: alignedScore(it.stConf, it.ltScore) }))
    .sort((a, b) => b.conviction - a.conviction || (b.ltScore || 0) - (a.ltScore || 0));
}

module.exports = { isAligned, alignedScore, rankAligned };
