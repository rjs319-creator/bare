// pcarry — HONEST momentum-continuation odds for Day Trade picks.
//
// WHAT THE RESEARCH ACTUALLY FOUND (research/33-daytrade-continuation.py, survivorship-
// corrected, 26,271 candidate-days). Two labels, same features:
//   • close-to-close 3d continuation: STRONGLY predictable (OOS AUC 0.70, +18% decile
//     spread, beats permutation null p=0.000) — BUT that edge lives in the CLOSE→NEXT-OPEN
//     OVERNIGHT leg you cannot trade (the screener is EOD; you buy at the next open).
//   • tradeable NEXT-OPEN 3d continuation: ~COIN FLIP (OOS AUC 0.47–0.50, FAILS the
//     permutation null p=0.77). Both deciles NEGATIVE — day-trade candidates on average
//     UNDERPERFORM SPY over 3 sessions once you enter at the open.
// So there is NO tradeable "these will keep running" edge. The momentum you see is mostly
// overnight and already gone. A sign-constrained fit kept only 2 of 10 price/volume
// features (extHinge<0, nearHigh5>0) — i.e. the only durable, causal, tradeable-relevant
// signal is FADE AVOIDANCE: don't chase overextended blow-offs; favor names still holding
// near their recent high.
//
// pcarry is therefore an HONEST, CALIBRATED FADE-AWARE odds — NOT a winner-picker. It
// anchors at the empirical base rate (~49% beat-SPY) and tilts with the few causally-
// grounded, validated levers: overextension (−), near-high (+), news catalyst (dilution/
// M&A −, FDA/guidance/contract +, from the gap-cause pilot), regime (risk-off −), and the
// scan's own empirical base rate (explosive small-caps fade). Data-fit price coefficients;
// theory-prior news/regime offsets (Fable-5 staged design — news history isn't trainable).

// --- data-fit price sub-model (research/data/pcarry-model.json, standardized logistic) ---
const PRICE = {
  intercept: 0.0850,
  extHinge:  { mean: 0.0366, std: 0.3090, coef: -0.0383 },   // overextension penalty
  nearHigh5: { mean: 0.9473, std: 0.0504, coef: 0.0675 },    // holding near recent high
};
const BASE_RATE = 0.493;

// theory-prior offsets on the logit (from THIS project's validated findings, not fit here):
// gap-cause pilot: offering/dilution 21d +0.0%, M&A −5.7% (FADE) vs FDA/guidance/contract
// +5.0% vs +3.6% baseline (CONTINUE); regime avoidance is the one durable macro lever.
const CATALYST_OFFSET = { FADE_OFFERING: -0.45, MA: -0.55, FDA: 0.18, GUIDE: 0.14, CONTRACT: 0.12, OTHER: 0, NONE: 0 };
const REGIME_OFFSET = { 'risk-off': -0.22, neutral: 0, 'risk-on': 0.05 };
// empirical by-scan continuation base rates (43% explosive / 47% liquid / 51% building) → logit offset
const SCAN_OFFSET = { explosive_small: -0.26, momentum_liquid: -0.08, momentum_building: 0.10, momentum_run: 0.02 };

const CLAMP = [0.30, 0.66];   // honest bounds — this is NOT a high-confidence predictor
const sigmoid = x => 1 / (1 + Math.exp(-x));

// Pure: compute the two price features from daily candles (index = last bar = signal day).
function pcarryPriceFeatures(candles) {
  const n = candles.length;
  if (n < 22) return null;
  const c = candles[n - 1], prev = candles[n - 2];
  if (!c || !prev || !(prev.close > 0)) return null;
  const pctChange = (c.close - prev.close) / prev.close * 100;
  let adrSum = 0, k = 0;
  for (let i = n - 21; i < n - 1; i++) { const b = candles[i]; if (b && b.close > 0) { adrSum += (b.high - b.low) / b.close * 100; k++; } }
  const adr = k ? adrSum / k : null;
  const extADR = adr && adr > 0 ? Math.max(0, Math.min(8, pctChange / adr)) : 1;
  const extHinge = Math.max(0, Math.min(5, extADR - 3));
  let hh5 = 0; for (let i = n - 5; i < n; i++) if (candles[i] && candles[i].high > hh5) hh5 = candles[i].high;
  const nearHigh5 = hh5 > 0 ? Math.max(0.7, Math.min(1.0, c.close / hh5)) : 0.9;
  return { pctChange, adr, extADR, extHinge, nearHigh5 };
}

// Pure: honest carry odds (0.30–0.66). `ctx` = { scan, catalyst, regime }. Missing → neutral.
function scorePcarry(feat, ctx = {}) {
  if (!feat) return null;
  const z = (v, s) => (v - s.mean) / (s.std || 1);
  let raw = PRICE.intercept
    + PRICE.extHinge.coef * z(feat.extHinge, PRICE.extHinge)
    + PRICE.nearHigh5.coef * z(feat.nearHigh5, PRICE.nearHigh5)
    + (SCAN_OFFSET[ctx.scan] || 0)
    + (CATALYST_OFFSET[ctx.catalyst] ?? 0)
    + (REGIME_OFFSET[ctx.regime] ?? 0);
  const p = Math.max(CLAMP[0], Math.min(CLAMP[1], sigmoid(raw)));
  return {
    carry: +(p * 100).toFixed(0),                 // honest odds, %
    extADR: +feat.extADR.toFixed(2),
    overextended: feat.extADR >= 3,               // blow-off / fade risk flag
    nearHigh: feat.nearHigh5 >= 0.97,
    drivers: {
      overextension: feat.extHinge > 0 ? -1 : 0,
      catalyst: (CATALYST_OFFSET[ctx.catalyst] || 0) < 0 ? 'fade' : (CATALYST_OFFSET[ctx.catalyst] || 0) > 0 ? 'continue' : null,
      regime: ctx.regime === 'risk-off' ? 'risk-off' : null,
    },
  };
}

module.exports = { pcarryPriceFeatures, scorePcarry, BASE_RATE, CLAMP, SCAN_OFFSET, CATALYST_OFFSET };
