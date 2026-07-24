// TREND CORE (SHADOW) — one honest read of the trend-continuation sleeve.
//
// The problem: Breakout, Apex, Momentum, Trend Rider, Confluence and Momentum Ignition
// all re-express the SAME price/trend information (the repo measured Ghost×Breakout ≈ 0.96).
// Counting them as separate confirmations is double-counting one factor. Trend Core
// consolidates them into a SINGLE price-trend evidence unit, so "six trend screens agree"
// becomes the honest "one price-trend domain, strongly aligned."
//
// It does NOT average scores (averaging correlated ranks still launders redundancy into
// false confidence). It takes a robust central rank (median — insensitive to how MANY
// engines pile on) and reports agreement/breadth as DESCRIPTION, never as confidence.
//
// SHADOW by construction: a pure function that returns a canonical prediction stamped
// `validationStatus:'shadow'`. It is not wired into the live rank and must clear the
// promotion policy (docs/model-promotion-policy.md) before it ever could be.

const { makePrediction } = require('./prediction-contract');

// Engines that read the price/trend domain (must match lib/decision.js SOURCE_FAMILY).
// Ghost is deliberately NOT here — it reads volume-accumulation, a genuinely distinct
// overlay, so it counts as its own domain, not another price vote.
const PRICE_TREND_ENGINES = Object.freeze(['screener', 'breakout', 'momentum', 'coremo', 'apex', 'ignition', 'trendrider', 'confluence']);

// Genuinely distinct overlays — each, if present with real evidence, adds ONE independent
// domain beyond price. Kept separate so the app can require incremental OOS proof before
// treating any of them as alpha (none is assumed to add edge).
const DISTINCT_OVERLAYS = Object.freeze(['volumeAccum', 'fundamentalAccel', 'insiderCluster', 'catalyst']);

const isNum = v => typeof v === 'number' && isFinite(v);
const clamp01 = v => Math.max(0, Math.min(1, v));
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// reads: { <engine>: { percentile:0..1, bullish?:bool } , ... } — each engine's own rank.
// overlays: { volumeAccum?: {present:bool, strength?:0..1}, ... } — distinct non-price evidence.
// Returns { consolidated fields, prediction } or null if no price-trend engine reported.
function consolidateTrend(reads = {}, overlays = {}, opts = {}) {
  const present = PRICE_TREND_ENGINES
    .map(k => ({ engine: k, read: reads[k] }))
    .filter(x => x.read && isNum(x.read.percentile));
  if (!present.length) return null;

  const pctiles = present.map(x => clamp01(x.read.percentile));
  const priceTrendPercentile = median(pctiles);   // robust to how MANY engines pile on
  const spread = Math.max(...pctiles) - Math.min(...pctiles);

  // Direction agreement — DESCRIPTIVE only. A high agreement among correlated engines is
  // expected and is NOT evidence strength; we surface it, we do not bank confidence on it.
  const directional = present.filter(x => typeof x.read.bullish === 'boolean');
  const bullCount = directional.filter(x => x.read.bullish).length;
  const agreement = directional.length ? bullCount / directional.length : null;

  // Independent domains: price (1) + each distinct overlay actually present.
  const overlayDomains = DISTINCT_OVERLAYS.filter(k => overlays[k] && overlays[k].present === true);
  const independentEvidenceDomains = 1 + overlayDomains.length;

  // Evidence strength (0..1, NOT a probability): the consolidated price rank, shaded DOWN
  // when the engines disagree a lot (wide spread ⇒ the "consensus" is unreliable).
  const evidenceStrength = clamp01(priceTrendPercentile * (1 - 0.4 * spread));

  const prediction = makePrediction({
    rankPercentile: priceTrendPercentile,      // a RANK, not a probability
    evidenceStrength,
    modelConfidence: clamp01(1 - spread),      // lower when the correlated engines diverge
    independentEvidenceDomains,
    effectiveSampleSize: null,
    calibrationStatus: 'uncalibrated',
    validationStatus: 'shadow',
    survivorshipSafe: false,
    pointInTimeSafe: false,
    modelVersion: 'trend-core-v1',
    featureVersion: 'trend-core-feats-v1',
    asOf: opts.asOf || null,
    nulls: {
      effectiveSampleSize: 'consolidation is cross-sectional rank aggregation; no per-name sample',
    },
    extra: {
      priceTrendPercentile: +priceTrendPercentile.toFixed(3),
      contributingEngines: present.map(x => x.engine),
      nPriceEngines: present.length,
      engineSpread: +spread.toFixed(3),
      directionAgreement: agreement != null ? +agreement.toFixed(2) : null,
      overlayDomains,
      note: `${present.length} trend engines = ONE price domain (correlated); ${overlayDomains.length} distinct overlay domain(s).`,
    },
  });

  return {
    priceTrendPercentile: +priceTrendPercentile.toFixed(3),
    evidenceStrength: +evidenceStrength.toFixed(3),
    independentEvidenceDomains,
    contributingEngines: present.map(x => x.engine),
    directionAgreement: agreement,
    engineSpread: +spread.toFixed(3),
    overlayDomains,
    prediction,
  };
}

module.exports = { consolidateTrend, PRICE_TREND_ENGINES, DISTINCT_OVERLAYS };
