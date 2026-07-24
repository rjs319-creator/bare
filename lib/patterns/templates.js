// PATTERN TEMPLATE REGISTRY — objective, measurable definitions of each chart structure.
//
// Every template declares:
//   family/label/direction  — identity
//   timeframes               — which analysis windows it is meaningful on
//   path                     — an IDEALIZED unit-normalized price path (for pathCorrelation)
//   geometry                 — measured-feature ranges (ATR-normalized) for geometrySimilarity
//   volume                   — volume contraction/expansion ranges for volumeSimilarity
//   context                  — the regime/liquidity/vol environment it is meant for
//   evidenceFamilies         — which decision evidence families the pattern speaks to
//   invalidation             — the human-readable failure condition
//
// There are NO loose names here — a template that can't be measured doesn't belong. New
// families are added by appending to REGISTRY; detectors.js reads whatever is present.

// Build an idealized unit path by piecewise-linear interpolation of control points.
function pathFrom(points, n = 32) {
  const out = [];
  const segs = points.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * segs;
    const lo = Math.min(Math.floor(pos), segs - 1);
    const frac = pos - lo;
    out.push(points[lo] * (1 - frac) + points[lo + 1] * frac);
  }
  return out;
}

// Idealized shapes as control points in [0,1] price space (time = index).
const SHAPES = {
  bullFlag: pathFrom([0.0, 0.9, 1.0, 0.78, 0.72, 0.7, 0.68]),        // pole up, gentle downward drift
  flatBase: pathFrom([0.6, 0.95, 0.7, 0.9, 0.72, 0.88, 0.75]),        // sideways tight range near highs
  ascTriangle: pathFrom([0.2, 0.9, 0.45, 0.92, 0.6, 0.93, 0.72]),     // flat top, rising lows
  vcp: pathFrom([0.2, 0.95, 0.4, 0.85, 0.55, 0.8, 0.65, 0.78, 0.72]), // successive tighter contractions
  cupHandle: pathFrom([0.95, 0.6, 0.35, 0.3, 0.4, 0.7, 0.95, 0.82, 0.9]),
  breakoutRetest: pathFrom([0.4, 0.5, 0.45, 0.9, 1.0, 0.8, 0.85]),    // break then pull back to breakout
  doubleBottom: pathFrom([0.9, 0.4, 0.15, 0.45, 0.2, 0.55, 0.75]),    // two troughs, rising
  fallingWedge: pathFrom([0.9, 0.55, 0.75, 0.4, 0.6, 0.32, 0.5]),     // lower highs & lows, converging, down-biased
  undercutReclaim: pathFrom([0.6, 0.35, 0.1, 0.05, 0.4, 0.7, 0.85]),  // undercut prior low then reclaim
  bearFlag: pathFrom([1.0, 0.15, 0.05, 0.28, 0.32, 0.35, 0.36]),      // pole down, gentle upward drift
  descTriangle: pathFrom([0.8, 0.1, 0.55, 0.08, 0.4, 0.06, 0.28]),    // flat bottom, falling highs
  doubleTop: pathFrom([0.1, 0.6, 0.85, 0.55, 0.82, 0.45, 0.25]),      // two peaks, falling
  risingWedge: pathFrom([0.1, 0.45, 0.25, 0.6, 0.4, 0.7, 0.5]),       // higher highs & lows, converging, up-into-exhaustion
  failedBreakout: pathFrom([0.4, 0.6, 0.95, 1.0, 0.6, 0.4, 0.3]),     // pop above then fail back inside
};

const REGISTRY = [
  {
    family: 'BULL_FLAG', label: 'Bull flag', direction: 'LONG',
    timeframes: ['20d', '60d', 'session'],
    path: SHAPES.bullFlag,
    geometry: {
      trendSlope: { range: [-0.02, null], tol: 0.03, weight: 1 },       // pole + only mild pullback drift
      baseDepthAtr: { range: [0.5, 4.5], tol: 1.5, weight: 1.5 },       // flag pulls back a modest amount
      posInRange: { range: [0.45, null], tol: 0.2, weight: 1 },
      lowerHighs: { range: [null, 3], tol: 1 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 80 },
    evidenceFamilies: ['patternGeometry', 'priceTrend'],
    invalidation: 'Loss of the flag low / close back below the pole midpoint.',
  },
  {
    family: 'FLAT_BASE', label: 'Flat base', direction: 'LONG',
    timeframes: ['20d', '60d'],
    path: SHAPES.flatBase,
    geometry: {
      baseDepthAtr: { range: [1, 5], tol: 2, weight: 1 },
      contraction: { range: [null, 1.0], tol: 0.3, weight: 1.5 },
      posInRange: { range: [0.4, null], tol: 0.25 },
      trendSlope: { range: [-0.01, 0.02], tol: 0.02 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 70 },
    evidenceFamilies: ['patternGeometry', 'priceTrend'],
    invalidation: 'Break below the base low.',
  },
  {
    family: 'ASCENDING_TRIANGLE', label: 'Ascending triangle', direction: 'LONG',
    timeframes: ['20d', '60d'],
    path: SHAPES.ascTriangle,
    geometry: {
      higherLows: { range: [2, null], tol: 1, weight: 1.5 },
      lowerHighs: { range: [null, 1], tol: 1 },
      posInRange: { range: [0.5, null], tol: 0.2 },
    },
    volume: { dryUp: { range: [null, 1.1], tol: 0.3 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 80 },
    evidenceFamilies: ['patternGeometry', 'priceTrend'],
    invalidation: 'Break below the rising trendline of higher lows.',
  },
  {
    family: 'VCP', label: 'Volatility contraction (VCP)', direction: 'LONG',
    timeframes: ['20d', '60d'],
    path: SHAPES.vcp,
    geometry: {
      contraction: { range: [null, 0.85], tol: 0.25, weight: 2 },       // tightening dispersion
      baseDepthAtr: { range: [1, 6], tol: 2 },
      posInRange: { range: [0.45, null], tol: 0.25 },
    },
    volume: { dryUp: { range: [null, 0.9], tol: 0.25 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 70 },
    evidenceFamilies: ['patternGeometry', 'volumeParticipation'],
    invalidation: 'Break below the final contraction low.',
  },
  {
    family: 'CUP_AND_HANDLE', label: 'Cup and handle', direction: 'LONG',
    timeframes: ['60d', '120d'],
    path: SHAPES.cupHandle,
    geometry: {
      baseDepthAtr: { range: [3, 14], tol: 4, weight: 1 },
      posInRange: { range: [0.55, null], tol: 0.2, weight: 1.5 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 70 },
    evidenceFamilies: ['patternGeometry', 'priceTrend'],
    invalidation: 'Break below the handle low.',
  },
  {
    family: 'BREAKOUT_RETEST', label: 'Breakout & retest', direction: 'LONG',
    timeframes: ['20d', '60d', 'session'],
    path: SHAPES.breakoutRetest,
    geometry: {
      posInRange: { range: [0.6, null], tol: 0.2, weight: 1.5 },
      distFromHighAtr: { range: [null, 1.5], tol: 1 },
    },
    volume: { expansion: { range: [1.0, null], tol: 0.5 } },
    context: { regime: ['RISK_ON', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 85 },
    evidenceFamilies: ['patternGeometry', 'priceTrend'],
    invalidation: 'Close back below the breakout level (retest fails).',
  },
  {
    family: 'DOUBLE_BOTTOM', label: 'Double bottom', direction: 'LONG',
    timeframes: ['20d', '60d'],
    path: SHAPES.doubleBottom,
    geometry: {
      higherLows: { range: [1, null], tol: 1, weight: 1 },
      distFromLowAtr: { range: [1, null], tol: 1.5, weight: 1 },
    },
    volume: { expansion: { range: [1.0, null], tol: 0.5 } },
    context: { regime: ['NEUTRAL', 'RISK_ON', 'RISK_OFF'], liquidity: 'SUPPORTED', volMax: 90 },
    evidenceFamilies: ['patternGeometry', 'meanReversion'],
    invalidation: 'Break below the second bottom.',
  },
  {
    family: 'FALLING_WEDGE', label: 'Falling wedge', direction: 'LONG',
    timeframes: ['20d', '60d'],
    path: SHAPES.fallingWedge,
    geometry: {
      lowerHighs: { range: [2, null], tol: 1 },
      contraction: { range: [null, 0.95], tol: 0.3, weight: 1.5 },
      trendSlope: { range: [null, 0.005], tol: 0.02 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['NEUTRAL', 'RISK_ON'], liquidity: 'SUPPORTED', volMax: 85 },
    evidenceFamilies: ['patternGeometry', 'meanReversion'],
    invalidation: 'Break below the lower wedge line with no reclaim.',
  },
  {
    family: 'UNDERCUT_RECLAIM', label: 'Undercut & reclaim', direction: 'LONG',
    timeframes: ['20d', '60d', 'session'],
    path: SHAPES.undercutReclaim,
    geometry: {
      distFromLowAtr: { range: [1.5, null], tol: 1.5, weight: 1.5 },    // reclaimed well off the undercut
      posInRange: { range: [0.5, null], tol: 0.25 },
    },
    volume: { expansion: { range: [1.0, null], tol: 0.5 } },
    context: { regime: ['NEUTRAL', 'RISK_ON'], liquidity: 'SUPPORTED', volMax: 90 },
    evidenceFamilies: ['patternGeometry', 'meanReversion'],
    invalidation: 'Loss of the reclaimed level (undercut resumes).',
  },
  {
    family: 'BEAR_FLAG', label: 'Bear flag', direction: 'SHORT',
    timeframes: ['20d', '60d', 'session'],
    path: SHAPES.bearFlag,
    geometry: {
      trendSlope: { range: [null, 0.02], tol: 0.03, weight: 1 },
      posInRange: { range: [null, 0.55], tol: 0.2, weight: 1 },
      higherLows: { range: [null, 3], tol: 1 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['RISK_OFF', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 100 },
    evidenceFamilies: ['patternGeometry', 'failureRisk'],
    invalidation: 'Reclaim of the flag high / pole midpoint (short thesis broken).',
  },
  {
    family: 'DESCENDING_TRIANGLE', label: 'Descending triangle', direction: 'SHORT',
    timeframes: ['20d', '60d'],
    path: SHAPES.descTriangle,
    geometry: {
      lowerHighs: { range: [2, null], tol: 1, weight: 1.5 },
      posInRange: { range: [null, 0.5], tol: 0.2 },
    },
    volume: {},
    context: { regime: ['RISK_OFF', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 100 },
    evidenceFamilies: ['patternGeometry', 'failureRisk'],
    invalidation: 'Break above the falling highs trendline.',
  },
  {
    family: 'DOUBLE_TOP', label: 'Double top', direction: 'SHORT',
    timeframes: ['20d', '60d'],
    path: SHAPES.doubleTop,
    geometry: {
      lowerHighs: { range: [1, null], tol: 1 },
      distFromHighAtr: { range: [1, null], tol: 1.5, weight: 1 },
    },
    volume: {},
    context: { regime: ['RISK_OFF', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 100 },
    evidenceFamilies: ['patternGeometry', 'failureRisk'],
    invalidation: 'Reclaim above the second top.',
  },
  {
    family: 'RISING_WEDGE', label: 'Rising wedge (exhaustion)', direction: 'SHORT',
    timeframes: ['20d', '60d'],
    path: SHAPES.risingWedge,
    geometry: {
      higherLows: { range: [2, null], tol: 1 },
      contraction: { range: [null, 0.95], tol: 0.3, weight: 1.5 },
      posInRange: { range: [0.5, null], tol: 0.25 },
    },
    volume: { dryUp: { range: [null, 1.0], tol: 0.3 } },
    context: { regime: ['RISK_OFF', 'NEUTRAL'], liquidity: 'SUPPORTED', volMax: 100 },
    evidenceFamilies: ['patternGeometry', 'failureRisk'],
    invalidation: 'Break above the upper wedge line (thesis void).',
  },
  {
    family: 'FAILED_BREAKOUT', label: 'Failed breakout', direction: 'SHORT',
    timeframes: ['20d', '60d', 'session'],
    path: SHAPES.failedBreakout,
    geometry: {
      distFromHighAtr: { range: [1, null], tol: 1.5, weight: 1.5 },
      posInRange: { range: [null, 0.6], tol: 0.2 },
    },
    volume: { expansion: { range: [1.0, null], tol: 0.5 } },
    context: { regime: ['RISK_OFF', 'NEUTRAL', 'RISK_ON'], liquidity: 'SUPPORTED', volMax: 100 },
    evidenceFamilies: ['patternGeometry', 'failureRisk'],
    invalidation: 'Reclaim of the broken level (breakout re-established).',
  },
];

const BY_FAMILY = Object.fromEntries(REGISTRY.map(t => [t.family, t]));

module.exports = { REGISTRY, BY_FAMILY, SHAPES, pathFrom };
