// TREND RIDER — pure climate-light + trend/momentum candidate logic (no network,
// no state). Used by both the live endpoint and (conceptually) the validated
// op=trendopt harness. The traffic light is the star: it says WHEN trend-following
// is favorable (green/yellow) vs when to stand down (red) — the part that proved
// out OOS. The basket is "what to ride when it's green."

const sma = (arr, p, i) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += arr[k]; return s / p; };

// Kaufman efficiency ratio over n bars: |net move| / sum|bar moves|. ~1 = clean
// trend, ~0 = chop. Trend-following needs trend, not chop.
function efficiencyRatio(cl, i, n) {
  if (i < n) return 0;
  let den = 0; for (let j = i - n + 1; j <= i; j++) den += Math.abs(cl[j] - cl[j - 1]);
  return den > 0 ? Math.abs(cl[i] - cl[i - n]) / den : 0;
}

// Market-climate traffic light from the latest bar. Inputs: SPY closes, the
// fraction of sectors above their own 200DMA (breadth), and the macro regime.
function computeClimate(spyCl, breadthFrac, regime) {
  const i = spyCl.length - 1;
  const s200 = sma(spyCl, 200, i), s200p = sma(spyCl, 200, i - 21);
  const trendComp = (s200 == null || s200p == null) ? 0.5 : (spyCl[i] > s200 ? (s200 > s200p ? 1 : 0.5) : 0);
  const eff = Math.min(efficiencyRatio(spyCl, i, 63) * 1.5, 1);
  const breadth = breadthFrac == null ? 0.5 : breadthFrac;
  const risk = regime === 'risk-on' ? 1 : regime === 'risk-off' ? 0 : 0.5;
  const score = Math.round(100 * (0.30 * trendComp + 0.25 * eff + 0.25 * breadth + 0.20 * risk));
  const color = score >= 65 ? 'green' : score >= 45 ? 'yellow' : 'red';
  return {
    score, color,
    components: {
      trend: trendComp, efficiency: +eff.toFixed(2), breadth: +breadth.toFixed(2), regime,
      spyAbove200: s200 != null && spyCl[i] > s200, ma200Rising: s200 != null && s200p != null && s200 > s200p,
    },
    label: color === 'green' ? 'Favorable — ride trends' : color === 'yellow' ? 'Mixed — be selective, size down' : 'Avoid — stand down on new trend longs',
  };
}

// Is the latest bar a Trend-Rider candidate? Confirmed uptrend + positive 12-1
// momentum. Returns the momentum (for cross-sectional ranking) or null.
function trendCandidate(candles) {
  const n = candles.length; if (n < 260) return null;
  const cl = candles.map(c => c.close), i = n - 1;
  const s200 = sma(cl, 200, i), s200p = sma(cl, 200, i - 21), s50 = sma(cl, 50, i);
  if (s200 == null || s200p == null || s50 == null) return null;
  if (!(cl[i] > s200 && s200 > s200p && cl[i] > s50)) return null;       // confirmed uptrend
  const mom = cl[i - 21] / cl[i - 252] - 1;                              // 12-1 momentum
  if (mom <= 0) return null;                                            // absolute momentum positive
  const distTo50 = (cl[i] - s50) / s50;                                 // extension above 50DMA
  return {
    mom: +(mom * 100).toFixed(1), price: +cl[i].toFixed(2),
    ma50: +s50.toFixed(2), ma200: +s200.toFixed(2), extPct: +(distTo50 * 100).toFixed(1),
    trailStop: +s50.toFixed(2),                                         // trend-follow exit reference
  };
}

module.exports = { sma, efficiencyRatio, computeClimate, trendCandidate };
