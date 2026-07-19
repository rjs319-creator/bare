// ORBIT latent idiosyncratic drift state (orbit-state-v1) — a causal scalar
// Kalman filter over the factor-residual return series.
//
//   observed residual return_t = latent drift_t + noise_t          (obs eq.)
//   latent drift_t             = persistence · latent drift_(t−1) + shock_t   (state eq.)
//
// The filtered `drift` is ORBIT's estimate of the *persistent* company-specific
// upward (or downward) pressure per day, separated from day-to-day noise.
//
// Parameter policy (per the build spec): `persistence` is a DECLARED conservative
// fixed prior (mean-reverting, <1). The observation and state variances are
// estimated CAUSALLY from an EXPANDING window of residuals seen so far (never
// from future data), so the filtered estimate at time t depends only on
// observations 1..t. Appending future residuals therefore never changes an
// earlier drift estimate — the causal-invariance property the test suite checks.

const M = require('./orbit-math');

const STATE_VERSION = 'orbit-state-v1';

const DEFAULTS = Object.freeze({
  persistence: 0.94,   // declared prior — half-life ≈ 11 sessions; mean-reverting
  qRatio: 0.05,        // state-shock variance as a fraction of observation variance
  minObs: 20,          // below this we return sufficient:false
  varFloor: 1e-8,      // floor on variance so a flat series can't divide-by-zero
});

// Run the causal filter over `residuals` (oldest→newest, finite numbers only —
// callers should pass the residual window from the factor model). Returns the
// filtered state at the LAST observation plus interpretable diagnostics.
function estimateDrift(residuals, opts = {}) {
  const { persistence, qRatio, minObs, varFloor } = { ...DEFAULTS, ...opts };
  const z = (residuals || []).filter(x => x != null && Number.isFinite(x));
  if (z.length < minObs) return insufficient(z.length, persistence);

  const phi = M.clamp(persistence, 0, 0.999);
  // Welford running variance of the observation series (causal, expanding).
  let n = 0, runMean = 0, runM2 = 0;
  const obsVarThrough = (x) => {
    n += 1; const d = x - runMean; runMean += d / n; runM2 += d * (x - runMean);
    return n > 1 ? runM2 / (n - 1) : Math.max(x * x, varFloor);
  };

  let drift = 0;                    // d_{0|0}
  let P = Math.max(M.variance(z.slice(0, Math.min(z.length, 20))) || varFloor, varFloor); // diffuse-ish init
  let prevDrift = 0, lastInnov = 0, lastS = P, R = P, Q = P * qRatio;

  for (let t = 0; t < z.length; t++) {
    R = Math.max(obsVarThrough(z[t]), varFloor);   // observation noise from data ≤ t
    Q = Math.max(R * qRatio, varFloor);            // state-shock variance
    // Predict
    const dPred = phi * drift;
    const Ppred = phi * phi * P + Q;
    // Update
    const innov = z[t] - dPred;
    const S = Ppred + R;
    const K = Ppred / S;
    prevDrift = drift;
    drift = dPred + K * innov;
    P = (1 - K) * Ppred;
    lastInnov = innov; lastS = S;
  }

  const driftSd = Math.sqrt(Math.max(P, varFloor));
  const driftZ = drift / driftSd;
  const acceleration = drift - prevDrift;
  const halfLife = phi > 0 && phi < 1 ? +(Math.log(0.5) / Math.log(phi)).toFixed(2) : null;
  // P(latent drift > 0) given filter uncertainty.
  const probabilityPositive = +M.normCdf(driftZ).toFixed(4);
  // Standardised last innovation → "how surprising was the newest observation".
  const stdInnov = lastInnov / Math.sqrt(Math.max(lastS, varFloor));
  const changeProbability = +(2 * (M.normCdf(Math.abs(stdInnov)) - 0.5)).toFixed(4);

  return {
    version: STATE_VERSION,
    sufficient: true,
    drift: +drift.toFixed(8),
    driftZ: +driftZ.toFixed(4),
    acceleration: +acceleration.toFixed(8),
    persistence: phi,
    halfLife,
    stateVariance: +Q.toFixed(10),
    observationVariance: +R.toFixed(10),
    probabilityPositive,
    changeProbability,
    nObs: z.length,
  };
}

function insufficient(nObs, persistence) {
  return {
    version: STATE_VERSION,
    sufficient: false,
    drift: null, driftZ: null, acceleration: null,
    persistence, halfLife: null,
    stateVariance: null, observationVariance: null,
    probabilityPositive: null, changeProbability: null,
    nObs,
  };
}

module.exports = { STATE_VERSION, DEFAULTS, estimateDrift };
