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

// FRESH MOMENTUM MOVER — a large/mid-cap name in an established uptrend making a RECENT
// thrust, with positive relative strength. Complements trendCandidate (which ranks 12-month
// leaders and misses names that just started moving). Validated by the size-tiered backtest
// (research 2026-07-09): non-biotech momentum forward 21d excess vs SPY is +2.15% for $150M+
// $-vol names, and gating on an established uptrend (above 50 & 200-SMA) + RS>SPY roughly
// DOUBLES it to +4.96% with a 54% win rate. The $-vol floor matters — the same signal is
// flat/negative below $50M (small-cap momentum reverts). `spyByDate` supplies the RS leg.
const MOVER_MIN_DVOL = 150e6;   // the $-vol tier where momentum persists
const MOVER_MIN_RET5 = 8;       // a fresh multi-day thrust
const MOVER_MAX_RET5 = 30;      // above this → parabolic / fade risk, not a clean entry
function freshMoverCandidate(candles, spyByDate) {
  const n = candles ? candles.length : 0;
  if (n < 210) return null;                                   // need 200-SMA + a 21d RS lookback
  const cl = candles.map(c => c.close), i = n - 1, px = cl[i];
  if (!(px >= 5)) return null;
  const s50 = sma(cl, 50, i), s200 = sma(cl, 200, i);
  if (s50 == null || s200 == null || !(px > s50 && px > s200)) return null;   // established uptrend
  let dv = 0, dn = 0;
  for (let k = i - 19; k <= i; k++) { if (candles[k]) { dv += candles[k].close * candles[k].volume; dn++; } }
  const dollarVol = dn ? dv / dn : 0;
  if (dollarVol < MOVER_MIN_DVOL) return null;                // large/mid-cap liquidity only
  const b5 = cl[i - 5], b20 = cl[i - 20];
  const ret5 = b5 > 0 ? (px / b5 - 1) * 100 : 0;
  if (ret5 < MOVER_MIN_RET5 || ret5 > MOVER_MAX_RET5) return null;   // a fresh thrust, not parabolic
  const ret20 = b20 > 0 ? (px / b20 - 1) * 100 : null;
  // Relative strength vs SPY over the trailing ~21 sessions (must be LEADING, not lagging).
  let rs = null;
  if (spyByDate) {
    const sNow = spyByDate[candles[i].date], sThen = candles[i - 21] && spyByDate[candles[i - 21].date];
    if (sNow > 0 && sThen > 0 && cl[i - 21] > 0) rs = (px / cl[i - 21] - 1) * 100 - (sNow / sThen - 1) * 100;
  }
  if (!(rs > 0)) return null;
  const extPct = (px - s50) / s50 * 100;
  const score = Math.round(Math.max(0, Math.min(100,
    ret5 * 1.6 + Math.min(rs, 30) * 1.2 + (ret20 != null ? Math.min(ret20, 40) * 0.4 : 0) - Math.max(0, extPct - 25) * 0.6)));
  return {
    price: +px.toFixed(2), ret5: +ret5.toFixed(1), ret20: ret20 != null ? +ret20.toFixed(1) : null,
    rs: +rs.toFixed(1), extPct: +extPct.toFixed(1), dollarVol: Math.round(dollarVol),
    ma50: +s50.toFixed(2), ma200: +s200.toFixed(2), trailStop: +s50.toFixed(2), score,
  };
}

module.exports = { sma, efficiencyRatio, computeClimate, trendCandidate, freshMoverCandidate, MOVER_MIN_DVOL };
