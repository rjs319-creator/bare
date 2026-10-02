'use strict';
// VENDORED: "Let's Be Rational" implied-volatility solver + Black (1976) pricing.
//
// CommonJS port of the official vollib TypeScript packages (all MIT, 2026):
//   • vollib/lets-be-rational-ts  (src/index.ts, src/constants.ts, src/errors.ts)
//   • vollib/cody-special-ts      (Cody's erf/erfc/erfcx rational approximations,
//                                  normCdf/normPdf, Acklam-style inverse normal CDF)
//   • vollib/piecewise-rational-ts (Delbourgo–Gregory rational cubic interpolation)
// The algorithm is Peter Jäckel's "Let's Be Rational" (2013/2016): two Householder
// iterations from a rational initial guess reach machine precision for the normalized
// Black call price → normalized volatility inversion. Function names follow upstream so
// this file can be diffed against the TypeScript sources; only the module system differs.
//
// MIT License
//
// Copyright (c) 2026 vollib
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// ── constants ────────────────────────────────────────────────────────────────
const DBL_MIN = Number.MIN_VALUE;
const DBL_MAX = Number.MAX_VALUE;
const DBL_EPSILON = Number.EPSILON;
const SQRT_DBL_MIN = Math.sqrt(DBL_MIN);
const SQRT_DBL_MAX = Math.sqrt(DBL_MAX);
const SQRT_DBL_EPSILON = Math.sqrt(DBL_EPSILON);
const FOURTH_ROOT_DBL_EPSILON = Math.sqrt(SQRT_DBL_EPSILON);
const EIGHTH_ROOT_DBL_EPSILON = Math.sqrt(FOURTH_ROOT_DBL_EPSILON);
const SIXTEENTH_ROOT_DBL_EPSILON = Math.sqrt(EIGHTH_ROOT_DBL_EPSILON);
const DENORMALIZATION_CUTOFF = 0;

const ONE_OVER_SQRT_TWO = 0.7071067811865475244008443621048490392848359376887;
const ONE_OVER_SQRT_TWO_PI = 0.3989422804014326779399460599343818684758586311649;
const SQRT_TWO = 1.4142135623730950488016887242096980785696718753769;
const SQRT_TWO_PI = 2.506628274631000502415765284811045253006986740610;
const TWO_PI = 6.283185307179586476925286766559005768394338798750;
const SQRT_PI_OVER_TWO = 1.253314137315500251207882642405522626503493370305;
const SQRT_THREE = 1.732050807568877293527446341505872366942805253810;
const SQRT_ONE_OVER_THREE = 0.577350269189625764509148780501957455647601751270;
const TWO_PI_OVER_SQRT_TWENTY_SEVEN = 1.209199576156145233729385505094770488189377498728;
const PI_OVER_SIX = 0.523598775598298873077107230546583814032861566563;

// ── errors ───────────────────────────────────────────────────────────────────
class BelowIntrinsicError extends Error {
  constructor(message = 'The option price is below intrinsic value.') { super(message); this.name = 'BelowIntrinsicError'; }
}
class AboveMaximumError extends Error {
  constructor(message = 'The option price is above the maximum option value.') { super(message); this.name = 'AboveMaximumError'; }
}

// ── cody-special: erf / erfc / erfcx (W. J. Cody, 1969 rational approximations) ──
const A = [3.1611237438705656, 113.864154151050156, 377.485237685302021, 3209.37758913846947, 0.185777706184603153];
const B = [23.6012909523441209, 244.024637934444173, 1282.61652607737228, 2844.23683343917062];
const C = [
  0.564188496988670089, 8.88314979438837594, 66.1191906371416295, 298.635138197400131,
  881.95222124176909, 1712.04761263407058, 2051.07837782607147, 1230.33935479799725,
  2.15311535474403846e-8,
];
const D = [
  15.7449261107098347, 117.693950891312499, 537.181101862009858, 1621.38957456669019,
  3290.79923573345963, 4362.61909014324716, 3439.36767414372164, 1230.33935480374942,
];
const P = [0.305326634961232344, 0.360344899949804439, 0.125781726111229246, 0.0160837851487422766, 6.58749161529837803e-4, 0.0163153871373020978];
const Q = [2.56852019228982242, 1.87295284992346047, 0.527905102951428412, 0.0605183413124413191, 0.00233520497626869185];

const SQRPI = 0.56418958354775628695;
const THRESH = 0.46875;
const SIXTEEN = 16.0;
const XINF = Number.MAX_VALUE;
const XNEG = -26.628;
const XSMALL = 1.11e-16;
const XBIG = 26.543;
const XHUGE = 6.71e7;
const XMAX = 2.53e307;

function dInt(x) { return x > 0 ? Math.floor(x) : -Math.floor(-x); }

function fixUpForNegativeArgument(jint, result, x) {
  if (jint === 0) {
    result = (0.5 - result) + 0.5;
    if (x < 0) result = -result;
  } else if (jint === 1) {
    if (x < 0) result = 2 - result;
  } else if (x < 0) {
    if (x < XNEG) {
      result = XINF;
    } else {
      const ysq = dInt(x * SIXTEEN) / SIXTEEN;
      const del = (x - ysq) * (x + ysq);
      const y = Math.exp(ysq * ysq) * Math.exp(del);
      result = y + y - result;
    }
  }
  return result;
}

// jint: 0 = erf, 1 = erfc, 2 = erfcx (= exp(x²)·erfc(x))
function calerf(x, jint) {
  const y = Math.abs(x);
  let ysq, xnum, xden, result;
  if (y <= THRESH) {
    ysq = y > XSMALL ? y * y : 0;
    xnum = A[4] * ysq;
    xden = ysq;
    for (let i = 0; i < 3; i += 1) { xnum = (xnum + A[i]) * ysq; xden = (xden + B[i]) * ysq; }
    result = x * (xnum + A[3]) / (xden + B[3]);
    if (jint !== 0) result = 1 - result;
    if (jint === 2) result *= Math.exp(ysq);
    return result;
  }
  if (y <= 4) {
    xnum = C[8] * y;
    xden = y;
    for (let i = 0; i < 7; i += 1) { xnum = (xnum + C[i]) * y; xden = (xden + D[i]) * y; }
    result = (xnum + C[7]) / (xden + D[7]);
    if (jint !== 2) {
      ysq = dInt(y * SIXTEEN) / SIXTEEN;
      const del = (y - ysq) * (y + ysq);
      result *= Math.exp(-ysq * ysq) * Math.exp(-del);
    }
  } else {
    result = 0;
    if (y >= XBIG) {
      if (jint !== 2 || y >= XMAX) return fixUpForNegativeArgument(jint, result, x);
      if (y >= XHUGE) return fixUpForNegativeArgument(jint, SQRPI / y, x);
    }
    ysq = 1 / (y * y);
    xnum = P[5] * ysq;
    xden = ysq;
    for (let i = 0; i < 4; i += 1) { xnum = (xnum + P[i]) * ysq; xden = (xden + Q[i]) * ysq; }
    result = ysq * (xnum + P[4]) / (xden + Q[4]);
    result = (SQRPI - result) / y;
    if (jint !== 2) {
      ysq = dInt(y * SIXTEEN) / SIXTEEN;
      const del = (y - ysq) * (y + ysq);
      result *= Math.exp(-ysq * ysq) * Math.exp(-del);
    }
  }
  return fixUpForNegativeArgument(jint, result, x);
}

const erfCody = (x) => calerf(x, 0);
const erfcCody = (x) => calerf(x, 1);
const erfcxCody = (x) => calerf(x, 2);

// ── cody-special: normal distribution ────────────────────────────────────────
const normCdfAsymptoticExpansionFirstThreshold = -10.0;
const normCdfAsymptoticExpansionSecondThreshold = -1 / Math.sqrt(DBL_EPSILON);
const uMax = 0.3413447460685429;

function normPdf(x) { return ONE_OVER_SQRT_TWO_PI * Math.exp(-0.5 * x * x); }

function normCdf(z) {
  if (z <= normCdfAsymptoticExpansionFirstThreshold) {
    let sum = 1;
    if (z >= normCdfAsymptoticExpansionSecondThreshold) {
      const zsqr = z * z;
      let i = 1, g = 1, a = DBL_MAX, lasta;
      do {
        lasta = a;
        const x = (4 * i - 3) / zsqr;
        const y = x * ((4 * i - 1) / zsqr);
        a = g * (x - y);
        sum -= a;
        g *= y;
        i += 1;
        a = Math.abs(a);
      } while (lasta > a && a >= Math.abs(sum * DBL_EPSILON));
    }
    return -normPdf(z) * sum / z;
  }
  return 0.5 * erfcCody(-z * ONE_OVER_SQRT_TWO);
}

function inverseNormCdfForLowProbabilities(p) {
  const r = Math.sqrt(-Math.log(p));
  if (r < 6.7) {
    if (r < 3.41) {
      if (r < 2.05) {
        return (3.691562302945566191 + r * (4.7170590600740689449e1 + r * (6.5451292110261454609e1 + r * (-7.4594687726045926821e1 + r * (-8.3383894003636969722e1 - 1.3054072340494093704e1 * r))))) /
          (1 + r * (2.0837211328697753726e1 + r * (7.1813812182579255459e1 + r * (5.9270122556046077717e1 + r * (9.2216887978737432303 + 1.8295174852053530579e-4 * r)))));
      }
      return (3.2340179116317970288 + r * (1.449177828689122096e1 + r * (6.8397370256591532878e-1 + r * (-1.81254427791789183e1 + r * (-1.005916339568646151e1 - 1.2013147879435525574 * r))))) /
        (1 + r * (8.8820931773304337525 + r * (1.4656370665176799712e1 + r * (7.1369811056109768745 + r * (8.4884892199149255469e-1 + 1.0957576098829595323e-5 * r)))));
    }
    return (3.1252235780087584807 + r * (9.9483724317036560676 + r * (-5.1633929115525534628 + r * (-1.1070534689309368061e1 + r * (-2.8699061335882526744 - 1.5414319494013597492e-1 * r))))) /
      (1 + r * (7.076769154309171622 + r * (8.1086341122361532407 + r * (2.0307076064309043613 + r * (1.0897972234131828901e-1 + 1.3565983564441297634e-7 * r)))));
  }
  if (r < 12.9) {
    return (2.6161264950897283681 + r * (2.250881388987032271 + r * (-3.688196041019692267 + r * (-2.9644251353150605663 + r * (-4.7595169546783216436e-1 - 1.612303318390145052e-2 * r))))) /
      (1 + r * (3.2517455169035921495 + r * (2.1282030272153188194 + r * (3.3663746405626400164e-1 + r * (1.1400087282177594359e-2 + 3.0848093570966787291e-9 * r)))));
  }
  return (2.3226849047872302955 + r * (-4.2799650734502094297e-2 + r * (-2.5894451568465728432 + r * (-8.6385181219213758847e-1 + r * (-6.5127593753781672404e-2 - 1.0566357727202585402e-3 * r))))) /
    (1 + r * (1.9361316119254412206 + r * (6.1320841329197493341e-1 + r * (4.6054974512474443189e-2 + r * (7.471447992167225483e-4 + 2.3135343206304887818e-11 * r)))));
}

function inverseNormCdfmHalfForMidrangeProbabilities(u) {
  const s = uMax * uMax - u * u;
  return u * ((2.92958954698308805 + s * (5.0260572167303103e1 + s * (3.01870541922933937e2 + s * (7.4997781456657924e2 + s * (6.90489242061408612e2 + s * (1.34233243502653864e2 - 7.58939881401259242 * s)))))) /
    (1 + s * (1.8918538074574598e1 + s * (1.29404120448755281e2 + s * (3.86821208540417453e2 + s * (4.79123914509756757e2 + 1.79227008508102628e2 * s))))));
}

function inverseNormCdf(p) {
  const u = p - 0.5;
  if (Math.abs(u) < uMax) return inverseNormCdfmHalfForMidrangeProbabilities(u);
  return u > 0 ? -inverseNormCdfForLowProbabilities(1 - p) : inverseNormCdfForLowProbabilities(p);
}

// ── piecewise-rational: rational cubic interpolation ─────────────────────────
const minimumRationalCubicControlParameterValue = -(1 - Math.sqrt(DBL_EPSILON));
const maximumRationalCubicControlParameterValue = 2 / (DBL_EPSILON * DBL_EPSILON);

function isZero(x) { return Math.abs(x) < DBL_MIN; }

function rationalCubicControlParameterToFitSecondDerivativeAtLeftSide(xL, xR, yL, yR, dL, dR, secondDerivativeL) {
  const h = xR - xL;
  const numerator = 0.5 * h * secondDerivativeL + (dR - dL);
  if (isZero(numerator)) return 0;
  const denominator = (yR - yL) / h - dL;
  if (isZero(denominator)) return numerator > 0 ? maximumRationalCubicControlParameterValue : minimumRationalCubicControlParameterValue;
  return numerator / denominator;
}

function rationalCubicControlParameterToFitSecondDerivativeAtRightSide(xL, xR, yL, yR, dL, dR, secondDerivativeR) {
  const h = xR - xL;
  const numerator = 0.5 * h * secondDerivativeR + (dR - dL);
  if (isZero(numerator)) return 0;
  const denominator = dR - (yR - yL) / h;
  if (isZero(denominator)) return numerator > 0 ? maximumRationalCubicControlParameterValue : minimumRationalCubicControlParameterValue;
  return numerator / denominator;
}

function minimumRationalCubicControlParameter(dL, dR, s, preferShapePreservationOverSmoothness) {
  const monotonic = dL * s >= 0 && dR * s >= 0;
  const convex = dL <= s && s <= dR;
  const concave = dL >= s && s >= dR;
  if (!monotonic && !convex && !concave) return minimumRationalCubicControlParameterValue;
  const dRMdL = dR - dL;
  const dRMS = dR - s;
  const sMDL = s - dL;
  let r1 = -DBL_MAX;
  let r2 = r1;
  if (monotonic) {
    if (!isZero(s)) r1 = (dR + dL) / s;
    else if (preferShapePreservationOverSmoothness) r1 = maximumRationalCubicControlParameterValue;
  }
  if (convex || concave) {
    if (!isZero(sMDL) && !isZero(dRMS)) r2 = Math.max(Math.abs(dRMdL / dRMS), Math.abs(dRMdL / sMDL));
    else if (preferShapePreservationOverSmoothness) r2 = maximumRationalCubicControlParameterValue;
  } else if (monotonic && preferShapePreservationOverSmoothness) {
    r2 = maximumRationalCubicControlParameterValue;
  }
  return Math.max(minimumRationalCubicControlParameterValue, Math.max(r1, r2));
}

function rationalCubicInterpolation(x, xL, xR, yL, yR, dL, dR, r) {
  const h = xR - xL;
  if (Math.abs(h) <= 0) return 0.5 * (yL + yR);
  const t = (x - xL) / h;
  if (!(r >= maximumRationalCubicControlParameterValue)) {
    const omt = 1 - t;
    const t2 = t * t;
    const omt2 = omt * omt;
    return (yR * t2 * t + (r * yR - h * dR) * t2 * omt + (r * yL + h * dL) * t * omt2 + yL * omt2 * omt) /
      (1 + (r - 3) * t * omt);
  }
  return yR * t + yL * (1 - t);
}

function convexRationalCubicControlParameterToFitSecondDerivativeAtLeftSide(xL, xR, yL, yR, dL, dR, secondDerivativeL, preferShapePreservationOverSmoothness) {
  const r = rationalCubicControlParameterToFitSecondDerivativeAtLeftSide(xL, xR, yL, yR, dL, dR, secondDerivativeL);
  const rMin = minimumRationalCubicControlParameter(dL, dR, (yR - yL) / (xR - xL), preferShapePreservationOverSmoothness);
  return Math.max(r, rMin);
}

function convexRationalCubicControlParameterToFitSecondDerivativeAtRightSide(xL, xR, yL, yR, dL, dR, secondDerivativeR, preferShapePreservationOverSmoothness) {
  const r = rationalCubicControlParameterToFitSecondDerivativeAtRightSide(xL, xR, yL, yR, dL, dR, secondDerivativeR);
  const rMin = minimumRationalCubicControlParameter(dL, dR, (yR - yL) / (xR - xL), preferShapePreservationOverSmoothness);
  return Math.max(r, rMin);
}

// ── lets-be-rational core ────────────────────────────────────────────────────
const impliedVolatilityMaximumIterations = 2;
const asymptoticExpansionAccuracyThreshold = -10;
const smallTExpansionOfNormalizedBlackThreshold = 2 * SIXTEENTH_ROOT_DBL_EPSILON;

function square(x) { return x * x; }
function isBelowHorizon(x) { return Math.abs(x) < DENORMALIZATION_CUTOFF; }

function householderFactor(newton, halley, hh3) {
  return (1 + 0.5 * halley * newton) / (1 + newton * (halley + hh3 * newton / 6));
}

function computeFLowerMapAndFirstTwoDerivatives(x, s) {
  const ax = Math.abs(x);
  const z = SQRT_ONE_OVER_THREE * ax / s;
  const y = z * z;
  const s2 = s * s;
  const Phi = normCdf(-z);
  const phi = normPdf(z);
  const fpp = PI_OVER_SIX * y / (s2 * s) * Phi *
    (8 * SQRT_THREE * s * ax + (3 * s2 * (s2 - 8) - 8 * x * x) * Phi / phi) *
    Math.exp(2 * y + 0.25 * s2);
  if (isBelowHorizon(s)) return [0, 1, fpp];
  const Phi2 = Phi * Phi;
  const fp = TWO_PI * y * Phi2 * Math.exp(y + 0.125 * s * s);
  const f = isBelowHorizon(x) ? 0 : TWO_PI_OVER_SQRT_TWENTY_SEVEN * ax * (Phi2 * Phi);
  return [f, fp, fpp];
}

function computeFUpperMapAndFirstTwoDerivatives(x, s) {
  const f = normCdf(-0.5 * s);
  if (isBelowHorizon(x)) return [f, -0.5, 0];
  const w = square(x / s);
  const fp = -0.5 * Math.exp(0.5 * w);
  const fpp = SQRT_PI_OVER_TWO * Math.exp(w + 0.125 * s * s) * w / s;
  return [f, fp, fpp];
}

function inverseFLowerMap(x, f) {
  return isBelowHorizon(f) ? 0 : Math.abs(x / (SQRT_THREE * inverseNormCdf(Math.pow(f / (TWO_PI_OVER_SQRT_TWENTY_SEVEN * Math.abs(x)), 1 / 3))));
}

function inverseFUpperMap(f) { return -2 * inverseNormCdf(f); }

function normalizedIntrinsic(x, q) {
  if (q * x <= 0) return 0;
  const sign = q < 0 ? -1 : 1;
  const x2 = x * x;
  if (x2 < 98 * FOURTH_ROOT_DBL_EPSILON) {
    return Math.abs(Math.max(sign * x * (1 + x2 * (1 / 24 + x2 * (1 / 1920 + x2 * (1 / 322560 + x2 / 92897280)))), 0));
  }
  const bMax = Math.exp(0.5 * x);
  return Math.abs(Math.max(sign * (bMax - 1 / bMax), 0));
}

function normalizedIntrinsicCall(x) { return normalizedIntrinsic(x, 1); }

function normalizedBlackCallUsingNormCdf(x, s) {
  if (s <= 0) return normalizedIntrinsicCall(x);
  const h = x / s;
  const t = 0.5 * s;
  const bMax = Math.exp(0.5 * x);
  const b = normCdf(h + t) * bMax - normCdf(h - t) / bMax;
  return Math.abs(Math.max(b, 0));
}

function smallTExpansionOfNormalizedBlackCall(h, t) {
  const a = 1 + h * (0.5 * SQRT_TWO_PI) * erfcxCody(-ONE_OVER_SQRT_TWO * h);
  const w = t * t;
  const h2 = h * h;
  const c1 = (-1 + 3 * a + a * h2) / 6;
  const c2 = (-7 + 15 * a + h2 * (-1 + 10 * a + a * h2)) / 120;
  const c3 = (-57 + 105 * a + h2 * (-18 + 105 * a + h2 * (-1 + 21 * a + a * h2))) / 5040;
  const c4 = (-561 + 945 * a + h2 * (-285 + 1260 * a + h2 * (-33 + 378 * a + h2 * (-1 + 36 * a + a * h2)))) / 362880;
  const c5 = (-6555 + 10395 * a + h2 * (-4680 + 17325 * a + h2 * (-840 + 6930 * a + h2 * (-52 + 990 * a + h2 * (-1 + 55 * a + a * h2))))) / 39916800;
  const c6 = (-89055 + 135135 * a + h2 * (-82845 + 270270 * a + h2 * (-20370 + 135135 * a + h2 * (-1926 + 25740 * a + h2 * (-75 + 2145 * a + h2 * (-1 + 78 * a + a * h2)))))) / 6227020800;
  const expansion = 2 * t * (a + w * (c1 + w * (c2 + w * (c3 + w * (c4 + w * (c5 + c6 * w))))));
  const b = ONE_OVER_SQRT_TWO_PI * Math.exp(-0.5 * (h * h + t * t)) * expansion;
  return Math.abs(Math.max(b, 0));
}

function normalizedBlackCallUsingErfcx(h, t) {
  const b = 0.5 * Math.exp(-0.5 * (h * h + t * t)) *
    (erfcxCody(-ONE_OVER_SQRT_TWO * (h + t)) - erfcxCody(-ONE_OVER_SQRT_TWO * (h - t)));
  return Math.abs(Math.max(b, 0));
}

function normalizedBlackCall(x, s) {
  if (x > 0) return normalizedIntrinsicCall(x) + normalizedBlackCall(-x, s);
  const ax = Math.abs(x);
  if (s <= ax * DENORMALIZATION_CUTOFF) return normalizedIntrinsicCall(x);
  if (x < s * asymptoticExpansionAccuracyThreshold &&
      0.5 * s * s + x < s * (smallTExpansionOfNormalizedBlackThreshold + asymptoticExpansionAccuracyThreshold)) {
    return normalizedBlackCallUsingErfcx(x / s, 0.5 * s);
  }
  if (0.5 * s < smallTExpansionOfNormalizedBlackThreshold) return smallTExpansionOfNormalizedBlackCall(x / s, 0.5 * s);
  if (x + 0.5 * s * s > s * 0.85) return normalizedBlackCallUsingNormCdf(x, s);
  return normalizedBlackCallUsingErfcx(x / s, 0.5 * s);
}

function normalizedBlack(x, s, q) { return normalizedBlackCall(q < 0 ? -x : x, s); }

// Undiscounted Black (1976) price: F forward, K strike, sigma vol, T years, q = +1 call / -1 put.
function black(F, K, sigma, T, q) {
  const intrinsic = Math.abs(Math.max(q < 0 ? K - F : F - K, 0));
  if (q * (F - K) > 0) return intrinsic + black(F, K, sigma, T, -q);
  return Math.max(intrinsic, Math.sqrt(F) * Math.sqrt(K) * normalizedBlack(Math.log(F / K), sigma * Math.sqrt(T), q));
}

function normalizedVega(x, s) {
  const ax = Math.abs(x);
  if (ax <= 0) return ONE_OVER_SQRT_TWO_PI * Math.exp(-0.125 * s * s);
  return s <= 0 || s <= ax * SQRT_DBL_MIN ? 0 : ONE_OVER_SQRT_TWO_PI * Math.exp(-0.5 * (square(x / s) + square(0.5 * s)));
}

// Shared Householder refinement loop body — used by the three branches of the solver.
// Returns the refined s. `objective` yields { newton, halley, hh3 } or null for a bisection step.
function householderRefine(x, beta, s, sLeft, sRight, iterations, objective) {
  let count = 0, directionReversalCount = 0, ds = -DBL_MAX, dsPrevious = 0;
  while (count < iterations && Math.abs(ds) > DBL_EPSILON * s) {
    if (ds * dsPrevious < 0) directionReversalCount += 1;
    if (count > 0 && (directionReversalCount === 3 || !(s > sLeft && s < sRight))) {
      s = 0.5 * (sLeft + sRight);
      if (sRight - sLeft <= DBL_EPSILON * s) break;
      directionReversalCount = 0;
      ds = 0;
    }
    dsPrevious = ds;
    const b = normalizedBlackCall(x, s);
    const bp = normalizedVega(x, s);
    if (b > beta && s < sRight) sRight = s;
    else if (b < beta && s > sLeft) sLeft = s;
    const step = objective(b, bp, s);
    if (!step) {
      ds = 0.5 * (sLeft + sRight) - s;
    } else {
      ds = step.newton * householderFactor(step.newton, step.halley, step.hh3);
    }
    ds = Math.max(-0.5 * s, ds);
    s += ds;
    count += 1;
  }
  return s;
}

function uncheckedNormalizedImpliedVolatility(beta, x, q, iterations) {
  if (q * x > 0) {
    beta = Math.abs(Math.max(beta - normalizedIntrinsic(x, q), 0));
    q = -q;
  }
  if (q < 0) { x = -x; q = -q; }
  if (beta <= 0 || beta < DENORMALIZATION_CUTOFF) return 0;
  const bMax = Math.exp(0.5 * x);
  if (beta >= bMax) throw new AboveMaximumError();

  let f = -DBL_MAX;
  let s;
  let sLeft = DBL_MIN;
  let sRight = DBL_MAX;
  const sC = Math.sqrt(Math.abs(2 * x));
  const bC = normalizedBlackCall(x, sC);
  const vC = normalizedVega(x, sC);

  if (beta < bC) {
    const sL = sC - bC / vC;
    const bL = normalizedBlackCall(x, sL);
    if (beta < bL) {
      // Lower branch: log-transformed objective (Jäckel §4, the "f_lower" map).
      const [fLowerMapL, dFLowerMapLDBeta, d2FLowerMapLDBeta2] = computeFLowerMapAndFirstTwoDerivatives(x, sL);
      const rLL = convexRationalCubicControlParameterToFitSecondDerivativeAtRightSide(0, bL, 0, fLowerMapL, 1, dFLowerMapLDBeta, d2FLowerMapLDBeta2, true);
      f = rationalCubicInterpolation(beta, 0, bL, 0, fLowerMapL, 1, dFLowerMapLDBeta, rLL);
      if (!(f > 0)) {
        const t = beta / bL;
        f = (fLowerMapL * t + bL * (1 - t)) * t;
      }
      s = inverseFLowerMap(x, f);
      sRight = sL;
      const lnBeta = Math.log(beta);
      return householderRefine(x, beta, s, sLeft, sRight, iterations, (b, bp, sCur) => {
        if (b <= 0 || bp <= 0) return null;
        const lnB = Math.log(b);
        const bpob = bp / b;
        const h = x / sCur;
        const bHalley = h * h / sCur - sCur / 4;
        const newton = (lnBeta - lnB) * lnB / lnBeta / bpob;
        const halley = bHalley - bpob * (1 + 2 / lnB);
        const bHh3 = bHalley * bHalley - 3 * square(h / sCur) - 0.25;
        const hh3 = bHh3 + 2 * square(bpob) * (1 + 3 / lnB * (1 + 1 / lnB)) - 3 * bHalley * bpob * (1 + 2 / lnB);
        return { newton, halley, hh3 };
      });
    }
    const vL = normalizedVega(x, sL);
    const rLM = convexRationalCubicControlParameterToFitSecondDerivativeAtRightSide(bL, bC, sL, sC, 1 / vL, 1 / vC, 0, false);
    s = rationalCubicInterpolation(beta, bL, bC, sL, sC, 1 / vL, 1 / vC, rLM);
    sLeft = sL;
    sRight = sC;
  } else {
    const sH = vC > DBL_MIN ? sC + (bMax - bC) / vC : sC;
    const bH = normalizedBlackCall(x, sH);
    if (beta <= bH) {
      const vH = normalizedVega(x, sH);
      const rHM = convexRationalCubicControlParameterToFitSecondDerivativeAtLeftSide(bC, bH, sC, sH, 1 / vC, 1 / vH, 0, false);
      s = rationalCubicInterpolation(beta, bC, bH, sC, sH, 1 / vC, 1 / vH, rHM);
      sLeft = sC;
      sRight = sH;
    } else {
      // Upper branch: the "f_upper" map toward the maximum price.
      const [fUpperMapH, dFUpperMapHDBeta, d2FUpperMapHDBeta2] = computeFUpperMapAndFirstTwoDerivatives(x, sH);
      if (d2FUpperMapHDBeta2 > -SQRT_DBL_MAX && d2FUpperMapHDBeta2 < SQRT_DBL_MAX) {
        const rHH = convexRationalCubicControlParameterToFitSecondDerivativeAtLeftSide(bH, bMax, fUpperMapH, 0, dFUpperMapHDBeta, -0.5, d2FUpperMapHDBeta2, true);
        f = rationalCubicInterpolation(beta, bH, bMax, fUpperMapH, 0, dFUpperMapHDBeta, -0.5, rHH);
      }
      if (f <= 0) {
        const h = bMax - bH;
        const t = (beta - bH) / h;
        f = (fUpperMapH * (1 - t) + 0.5 * h * t) * (1 - t);
      }
      s = inverseFUpperMap(f);
      sLeft = sH;
      if (beta > 0.5 * bMax) {
        return householderRefine(x, beta, s, sLeft, sRight, iterations, (b, bp, sCur) => {
          if (b >= bMax || bp <= DBL_MIN) return null;
          const bMaxMinusB = bMax - b;
          const g = Math.log((bMax - beta) / bMaxMinusB);
          const gp = bp / bMaxMinusB;
          const bHalley = square(x / sCur) / sCur - sCur / 4;
          const bHh3 = bHalley * bHalley - 3 * square(x / (sCur * sCur)) - 0.25;
          const newton = -g / gp;
          const halley = bHalley + gp;
          const hh3 = bHh3 + gp * (2 * gp + 3 * bHalley);
          return { newton, halley, hh3 };
        });
      }
    }
  }

  // Middle branch: plain objective b(s) − beta.
  return householderRefine(x, beta, s, sLeft, sRight, iterations, (b, bp, sCur) => {
    const newton = (beta - b) / bp;
    const halley = square(x / sCur) / sCur - sCur / 4;
    const hh3 = halley * halley - 3 * square(x / (sCur * sCur)) - 0.25;
    return { newton, halley, hh3 };
  });
}

function normalizedImpliedVolatilityFromATransformedRationalGuessWithLimitedIterations(beta, x, q, iterations) {
  if (q * x > 0) {
    beta -= normalizedIntrinsic(x, q);
    q = -q;
  }
  if (beta < 0) throw new BelowIntrinsicError();
  return uncheckedNormalizedImpliedVolatility(beta, x, q, iterations);
}

function normalizedImpliedVolatilityFromATransformedRationalGuess(beta, x, q) {
  return normalizedImpliedVolatilityFromATransformedRationalGuessWithLimitedIterations(beta, x, q, impliedVolatilityMaximumIterations);
}

// Implied Black volatility of an UNDISCOUNTED option price. Throws BelowIntrinsicError /
// AboveMaximumError for prices outside the no-arbitrage band.
function impliedVolatilityFromATransformedRationalGuessWithLimitedIterations(price, F, K, T, q, iterations) {
  const intrinsic = Math.abs(Math.max(q < 0 ? K - F : F - K, 0));
  if (price < intrinsic) throw new BelowIntrinsicError();
  const maxPrice = q < 0 ? K : F;
  if (price >= maxPrice) throw new AboveMaximumError();
  const x = Math.log(F / K);
  if (q * x > 0) {
    price = Math.abs(Math.max(price - intrinsic, 0));
    q = -q;
  }
  return uncheckedNormalizedImpliedVolatility(price / (Math.sqrt(F) * Math.sqrt(K)), x, q, iterations) / Math.sqrt(T);
}

function impliedVolatilityFromATransformedRationalGuess(price, F, K, T, q) {
  return impliedVolatilityFromATransformedRationalGuessWithLimitedIterations(price, F, K, T, q, impliedVolatilityMaximumIterations);
}

module.exports = {
  // special functions
  erfCody, erfcCody, erfcxCody, normCdf, normPdf, inverseNormCdf,
  // rational cubic
  rationalCubicInterpolation,
  // lets-be-rational
  normalizedBlackCall, normalizedBlack, black, normalizedVega, normalizedIntrinsic,
  normalizedImpliedVolatilityFromATransformedRationalGuess,
  normalizedImpliedVolatilityFromATransformedRationalGuessWithLimitedIterations,
  impliedVolatilityFromATransformedRationalGuess,
  impliedVolatilityFromATransformedRationalGuessWithLimitedIterations,
  impliedVolatilityMaximumIterations,
  BelowIntrinsicError, AboveMaximumError,
};
