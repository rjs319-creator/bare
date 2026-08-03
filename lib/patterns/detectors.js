'use strict';
// PATTERN DETECTORS — bind each FAMILY-SPECIFIC structural detector to a candle window.
//
// v2 CORRECTNESS CONTRACT (the defects this rewrite closes):
//   • Triggers come from FAMILY STRUCTURE (necklines, boundaries, rims, frozen pivots)
//     built from bars 0..t-1 ONLY (structure.splitFormation). The confirmation bar t is
//     evaluated AGAINST that frozen level — a candle can never define the trigger it is
//     being tested against, so closing confirmation is genuinely reachable.
//   • Trade plans are family-specific: trigger/invalidation/target from actual structural
//     levels, reward:risk COMPUTED (never a forced constant), poor R:R flagged.
//   • Structural validity gates everything. Similarity remains a DESCRIPTIVE layer and
//     cannot rank a structurally-invalid match. Missing required features fail closed
//     (families.evalFeatures counts them as zero — no renormalization).
//   • Intraday penetration vs closing confirmation are kept distinct (confirmation.status).

const G = require('./geometry');
const S = require('./similarity');
const ST = require('./structure');
const { classifyPhase, PHASES } = require('./phases');
const { REGISTRY } = require('./templates');
const { FAMILY_DETECTORS } = require('./families');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

const MIN_RR = 1.2;               // below this the plan is flagged poor (downgraded, not hidden)
const EXPIRE_BARS = { '20d': 15, '60d': 40, '120d': 80, session: 40 };

const TEMPLATE_BY_FAMILY = Object.fromEntries(REGISTRY.map(t => [t.family, t]));

// Descriptive similarity block for one family (secondary to structural validity).
function describeSimilarity(windowPath, geo, vol, context, family) {
  const tmpl = TEMPLATE_BY_FAMILY[family];
  if (!tmpl) return { pathCorrelation: null, geometrySimilarity: null, dtwSimilarity: null, volumeSimilarity: null, contextSimilarity: null, combined: null, coverage: 0, used: {} };
  const pathCorr = S.pathCorrelation(windowPath, tmpl.path);
  const dtw = S.dtwSimilarity(windowPath, tmpl.path);
  const geoSim = S.geometrySimilarity(geo, tmpl);
  const volSim = S.volumeSimilarity(vol, tmpl);
  const ctxSim = S.contextSimilarity(context, tmpl);
  const { combined, used, coverage } = S.combineSimilarity({ pathCorrelation: pathCorr, geometrySimilarity: geoSim, dtwSimilarity: dtw, volumeSimilarity: volSim, contextSimilarity: ctxSim });
  return {
    pathCorrelation: round(pathCorr), geometrySimilarity: geoSim ? geoSim.score : null,
    dtwSimilarity: round(dtw), volumeSimilarity: volSim ? volSim.score : null,
    contextSimilarity: round(ctxSim), combined: round(combined), coverage, used,
  };
}

// Run every applicable family detector against one window. Returns detections sorted by
// structural validity (primary) then descriptive similarity (secondary).
//   candles: daily-shape window (the LAST bar is the confirmation bar).
//   opts: { timeframe, context, includeInvalid } — includeInvalid keeps structurally
//         failed reads (with their missing-feature lists) for diagnostics; they carry no
//         plan and can never rank or trade.
function detectWindow(candles, { timeframe = '20d', context = {}, includeInvalid = false } = {}) {
  const split = ST.splitFormation(candles);
  if (!split) return [];
  const { formation, confirmBar } = split;
  if (formation.length < 8) return [];

  const atr = G.atrOf(formation);
  if (!isNum(atr) || atr <= 0) return [];
  const ctx = {
    atr,
    piv: G.zigzag(formation, { atrMult: 1.0 }),
    frac: G.fractals(formation, 2),
    geo: G.geometryFeatures(formation),
    vol: G.volumeFeatures(formation),
  };
  const windowPath = G.unitPath(G.closesOf(G.toDaily(candles)));

  const out = [];
  for (const def of FAMILY_DETECTORS) {
    if (Array.isArray(def.timeframes) && !def.timeframes.includes(timeframe)) continue;
    if (formation.length < def.minBars) continue;
    let s = null;
    try { s = def.detect(formation, ctx); } catch { s = null; }
    if (!s) continue;

    const structural = s.structural;
    const valid = structural && structural.pass && !s.incomplete && s.trigger && s.invalidation && s.target;
    if (!valid && !includeInvalid) continue;

    const similarity = describeSimilarity(windowPath, ctx.geo, ctx.vol, context, s.family);
    const detection = valid
      ? buildValidDetection(s, def, { formation, confirmBar, atr, similarity, timeframe, ctx })
      : buildInvalidDetection(s, def, { formation, confirmBar, similarity, timeframe });
    out.push(detection);
  }

  out.sort((a, b) => {
    const va = a.structural ? a.structural.validity : 0;
    const vb = b.structural ? b.structural.validity : 0;
    if (vb !== va) return vb - va;
    return (b.similarity.combined || 0) - (a.similarity.combined || 0);
  });
  return out;
}

function buildValidDetection(s, def, { formation, confirmBar, atr, similarity, timeframe, ctx }) {
  const long = s.direction !== 'SHORT';
  const trigger = s.trigger.price;
  const stop = s.invalidation.price;
  const target = s.target.price;
  const rr = ST.structuralRR(trigger, stop, target);
  // A risk smaller than a fraction of one ATR is a degenerate plan (trigger ≈ stop): the
  // reward:risk it produces is meaningless and it would be stopped by noise.
  const riskAtr = isNum(atr) && atr > 0 ? Math.abs(trigger - stop) / atr : null;
  const planQuality = !isNum(rr) || (isNum(riskAtr) && riskAtr < 0.25)
    ? 'invalid'
    : rr < MIN_RR ? 'poor' : rr < 2 ? 'acceptable' : 'good';

  // The confirmation bar vs the FROZEN structural levels (built without it).
  const confirmVsTrigger = ST.assessBarVsLevel(confirmBar, trigger, s.direction, atr);
  const confirmVsInval = ST.assessBarVsLevel(confirmBar, stop, long ? 'SHORT' : 'LONG', atr);
  const breakoutConfirmed = !!(confirmVsTrigger && confirmVsTrigger.closedThrough);
  const intradayPenetration = !!(confirmVsTrigger && confirmVsTrigger.penetrated && !confirmVsTrigger.closedThrough);
  const invalidationHit = !!(confirmVsInval && confirmVsInval.closedThrough);
  const extensionAtr = confirmVsTrigger ? confirmVsTrigger.distanceAtr : null;
  const retesting = breakoutConfirmed && isNum(extensionAtr) && extensionAtr >= 0 && extensionAtr <= 0.4;
  const momentumDeteriorating = long
    ? ctx.geo.trendSlope < 0 && ctx.geo.lowerHighs >= 2
    : ctx.geo.trendSlope > 0 && ctx.geo.higherLows >= 2;

  const phase = classifyPhase({
    direction: s.direction, last: confirmBar.close, trigger, stop, atr,
    invalidationHit, breakoutConfirmed, retesting, extensionAtr,
    momentumDeteriorating, similarity: s.structural.validity,
  });

  return {
    family: s.family,
    label: s.label,
    direction: s.direction,
    timeframe,
    phase,
    structural: s.structural,
    pivotsUsed: s.pivotsUsed,
    triggerLevel: s.trigger,
    invalidationLevel: s.invalidation,
    targetLevel: s.target,
    measurements: { ...s.measurements, atr: round(atr) },
    similarity,
    geometry: ctx.geo,
    volume: ctx.vol,
    plan: {
      trigger: round(trigger, 2), stop: round(stop, 2), target: round(target, 2),
      rr, direction: s.direction, quality: planQuality, targetMethod: s.target.method,
      triggerType: s.trigger.type, invalidationType: s.invalidation.type,
    },
    confirmation: {
      status: breakoutConfirmed ? 'CLOSE_CONFIRMED' : intradayPenetration ? 'INTRADAY_PENETRATION' : 'NONE',
      penetrated: !!(confirmVsTrigger && confirmVsTrigger.penetrated),
      closedThrough: breakoutConfirmed,
      gapThrough: !!(confirmVsTrigger && confirmVsTrigger.gapThrough),
      distanceAtr: extensionAtr,
      invalidationPenetrated: !!(confirmVsInval && confirmVsInval.penetrated),
      invalidationClosedThrough: invalidationHit,
      confirmBarDate: confirmBar.date,
    },
    breakoutConfirmed,
    invalidationHit,
    extensionAtr: round(extensionAtr),
    retesting,
    structuralValidity: s.structural.validity,
    featureCoverage: s.structural.featureCoverage,
    missingRequiredFeatures: s.structural.missingRequiredFeatures,
    patternStart: formation[0].date,
    patternAsOf: confirmBar.date,
    formationAsOf: formation[formation.length - 1].date,
    evidenceFamilies: (TEMPLATE_BY_FAMILY[s.family] || {}).evidenceFamilies || ['patternGeometry'],
    invalidation: (TEMPLATE_BY_FAMILY[s.family] || {}).invalidation || `Fails through ${round(stop, 2)}.`,
  };
}

// A structurally-invalid read: reported only when asked for (diagnostics / negative
// display), never with a plan, never rankable, never tradable.
function buildInvalidDetection(s, def, { formation, confirmBar, similarity, timeframe }) {
  return {
    family: s.family,
    label: s.label,
    direction: s.direction,
    timeframe,
    phase: PHASES.EMERGING,
    structural: s.structural,
    pivotsUsed: s.pivotsUsed || [],
    similarity,
    plan: null,
    confirmation: null,
    breakoutConfirmed: false,
    invalidationHit: false,
    retesting: false,
    structuralValidity: s.structural ? s.structural.validity : 0,
    featureCoverage: s.structural ? s.structural.featureCoverage : 0,
    missingRequiredFeatures: s.structural ? s.structural.missingRequiredFeatures : [],
    structurallyInvalid: true,
    patternStart: formation[0].date,
    patternAsOf: confirmBar.date,
  };
}

module.exports = { detectWindow, MIN_RR, EXPIRE_BARS };
