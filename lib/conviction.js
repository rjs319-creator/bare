// CONVICTION SCORE — Sleeve A of the Edge Book (the momentum/continuation sleeve).
//
// The unified ranker the walk-forward harness validated: the GAI composite but
// REFINED by what the multi-year re-validation proved —
//   • DROP the IN (insider) pillar — marginal/noisy, negative IC on large-cap;
//   • keep the momentum core (RM/AF/SF/AV) + BONUS (the one robustly additive,
//     fundamentally-grounded pillar), with BONUS up-weighted 1.5×;
//   • LONGS only in risk-on / neutral — the regime gate was the single biggest
//     lever (it ~doubled the out-of-sample IC by dropping the risk-off regime
//     where the edge inverts).
//
// This is the ONE place the score is defined, imported by both the live screener
// (api/screener.js) and the validation harness (lib/ghost-backtest.js) so the
// shipped ranker and the back-tested ranker can never diverge.
const ghost = require('./ghost');

const CONV_PILLARS = ['RM', 'AF', 'AV', 'SF', 'BONUS']; // momentum core + BONUS, IN dropped
const BONUS_TILT = 1.5;

// Regime-specific weights: take the GAI priors for the conviction pillars, tilt
// BONUS by 1.5×, drop IN, renormalize to sum 1.
function convictionWeights(regime) {
  const rw = ghost.REGIME_WEIGHTS[regime] || ghost.REGIME_WEIGHTS.neutral;
  const w = {}; let t = 0;
  for (const k of CONV_PILLARS) { w[k] = (rw[k] || 0) * (k === 'BONUS' ? BONUS_TILT : 1); t += w[k]; }
  for (const k of CONV_PILLARS) w[k] = t > 0 ? w[k] / t : 1 / CONV_PILLARS.length;
  return w;
}

// Conviction score (0-100 scale, same as the pillars) for a pillar bundle.
function convictionScore(pillars, regime) {
  if (!pillars) return null;
  const w = convictionWeights(regime);
  return +CONV_PILLARS.reduce((s, k) => s + (pillars[k] || 0) * (w[k] || 0), 0).toFixed(2);
}

// The regime gate: Sleeve A goes long only in risk-on / neutral (never risk-off).
const longOk = regime => regime !== 'risk-off';

module.exports = { convictionScore, convictionWeights, longOk, CONV_PILLARS, BONUS_TILT };
