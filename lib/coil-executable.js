// COIL EXECUTABLE ESTIMATE — the honesty fix for Coil Radar.
//
// THE BUG THIS FIXES: `explodeProbability` (lib/coil.js) returns the empirical rate of an
// ABNORMAL UPSIDE EXCURSION (forward 10d max-gain ≥ 2.5× own vol). The trade plan then
// treated that same number as "probability the trade makes money" — which it is NOT. A
// name can hit an abnormal-break level and still stop you out first, or never fill your
// breakout trigger at all.
//
// This module keeps those quantities SEPARATE and computes the executable ones with a
// transparent, first-principles barrier model. It is deliberately labeled
// `calibrationStatus:'model-estimate'` (UNCALIBRATED): a driftless random-walk
// approximation, not an empirically-fitted probability. It must never be presented as a
// validated win rate. The empirical `pAbnormalExpansion` is reported ALONGSIDE it,
// unchanged, so the calibrated number and the executable estimate never get conflated.
//
// Model (all in log-return space, σ = the name's own trailing daily-return vol):
//   • pTrigger              = P(a driftless walk reaches the buy-stop within the horizon)
//                             — reflection principle: P(max ≥ u) ≈ 2·(1−Φ(u/σ√T)).
//   • pTargetBeforeStop|fill = the driftless two-barrier ruin ratio  d_stop/(d_stop+d_tgt)
//                             (depends ONLY on the barrier distances, not on vol — robust).
//   • pProfitableNet|fill    = P(a net-of-cost profitable exit | fill) = P(target first, in-horizon)
//                             when the net reward is still positive after round-trip cost.
//   • expectedNetR           = fill-weighted expected R after round-trip cost, incl. timeouts.
//   • severeLossProbability  = P(a single-day move gaps straight through the stop).

const isNum = v => typeof v === 'number' && isFinite(v);
const clamp01 = v => Math.max(0, Math.min(1, v));

// Standard normal CDF via Abramowitz-Stegun 7.1.26 erf approximation (no deps).
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// P(a driftless walk touches a barrier `dist` (log-return, >0) away within horizon T).
function pTouch(dist, sigmaT) {
  if (!(dist > 0) || !(sigmaT > 0)) return 0;
  return clamp01(2 * (1 - normCdf(dist / sigmaT)));
}

const DEFAULT_ROUND_TRIP_COST_PCT = 0.002;  // 20 bps round-trip (spread + slippage), documented default

// Compute the separated executable quantities for a coil breakout plan.
//   inputs: current, entry (buy-stop), stop, target — price levels; dailyVol — trailing
//   daily-return stdev; horizon — forward sessions; roundTripCostPct — fraction of price.
// Returns null on unusable geometry; otherwise a frozen estimate object. NEVER fabricates
// a number outside what the model supports — fields it cannot support are null.
function coilExecutable({ current, entry, stop, target, dailyVol, horizon = 10, roundTripCostPct = DEFAULT_ROUND_TRIP_COST_PCT }) {
  if (![current, entry, stop, target, dailyVol].every(isNum)) return null;
  if (!(entry > 0 && stop > 0 && target > entry && stop < entry && dailyVol > 0)) return null;

  const sigmaT = dailyVol * Math.sqrt(horizon);
  const risk = entry - stop;

  // pTrigger — chance the buy-stop above current price actually fills in-window.
  const u = Math.log(entry / current);
  const pTrigger = u <= 0 ? 1 : pTouch(u, sigmaT);       // already at/above → fills immediately

  // Two-barrier geometry (given a fill).
  const dTgt = Math.log(target / entry);
  const dStop = Math.log(entry / stop);
  const pTargetBeforeStopGivenFill = clamp01(dStop / (dTgt + dStop));   // driftless ruin ratio

  // In-horizon touch probabilities → split into target-first / stop-first / timeout.
  const touchTgt = pTouch(dTgt, sigmaT);
  const touchStop = pTouch(dStop, sigmaT);
  const pAnyTouch = clamp01(touchTgt + touchStop - touchTgt * touchStop);  // inclusion-exclusion (independence approx)
  const pTargetFirst = pAnyTouch * pTargetBeforeStopGivenFill;
  const pStopFirst = pAnyTouch * (1 - pTargetBeforeStopGivenFill);
  const pTimeout = clamp01(1 - pAnyTouch);

  // Costs in R-units: round-trip cost as a fraction of price, expressed relative to risk.
  const costR = (roundTripCostPct * entry) / risk;
  const rr = (target - entry) / risk;
  const rrNetWin = rr - costR;          // a winning target exit, net of cost
  const stopNetR = -1 - costR;          // a stop-out, net of cost
  const timeoutNetR = -costR;           // scratch exit at ~flat, still pays the cost

  const pProfitableNetGivenFill = rrNetWin > 0 ? pTargetFirst : 0;
  const expectedNetRGivenFill = pTargetFirst * rrNetWin + pStopFirst * stopNetR + pTimeout * timeoutNetR;
  const expectedNetR = pTrigger * expectedNetRGivenFill;   // unconditional (no-fill contributes 0)

  // Severe loss: a single-day return that gaps straight through the stop.
  const severeLossProbability = clamp01(1 - normCdf(dStop / dailyVol));

  // Model uncertainty band on the headline ordering prob — this is an UNCALIBRATED
  // driftless estimate, so we surface an honest ±0.15 model-risk band (clamped).
  const band = 0.15;
  const uncertaintyInterval = {
    lo: clamp01(pTargetBeforeStopGivenFill - band),
    hi: clamp01(pTargetBeforeStopGivenFill + band),
    metric: 'pTargetBeforeStopGivenFill',
    note: 'model risk — driftless barrier approximation, uncalibrated',
  };

  return Object.freeze({
    pTrigger: +pTrigger.toFixed(3),
    pTargetBeforeStopGivenFill: +pTargetBeforeStopGivenFill.toFixed(3),
    pProfitableNetGivenFill: +pProfitableNetGivenFill.toFixed(3),
    expectedNetR: +expectedNetR.toFixed(3),
    expectedNetRGivenFill: +expectedNetRGivenFill.toFixed(3),
    severeLossProbability: +severeLossProbability.toFixed(3),
    uncertaintyInterval,
    costR: +costR.toFixed(3),
    rrNet: +rrNetWin.toFixed(2),
    calibrationStatus: 'model-estimate',   // UNCALIBRATED — do not present as a validated win rate
    validationStatus: 'research',
    model: 'driftless-barrier-v1',
    horizonDays: horizon,
  });
}

module.exports = { coilExecutable, normCdf, pTouch, DEFAULT_ROUND_TRIP_COST_PCT };
