// PATTERN DETECTORS — bind each template to a candle window and emit a measured detection.
//
// A detection is DESCRIPTIVE: it reports how well the window matches the template
// (separated similarity components), the structural phase, an executable plan derived from
// the geometry, and the objective invalidation level. It makes NO claim of edge — that is
// predict.js / analog.js, and only after leakage-safe outcomes exist.
//
// Every detector runs the SAME measurement pipeline over the same shared geometry, so a
// new family is added purely by adding a template (no bespoke detector code).

const G = require('./geometry');
const S = require('./similarity');
const { classifyPhase, PHASES } = require('./phases');
const { REGISTRY } = require('./templates');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

const MIN_SIMILARITY = 0.5;       // below this the window simply doesn't look like the template
const EXPIRE_BARS = { '20d': 15, '60d': 40, '120d': 80, session: 40 };

// Derive an executable plan (trigger/stop/target) from the measured geometry. The stop
// comes from RECENT structure (the low/high of the trailing consolidation), NOT the full
// base depth — otherwise reward:risk is degenerately 1:1. The target is a measured-move of
// the base depth added past the trigger. Long patterns break UP; shorts are the mirror.
function derivePlan(direction, geo, candles) {
  const hi = geo.windowHigh;
  const lo = geo.windowLow;
  const depth = hi - lo;
  const atr = geo.atr;
  if (![hi, lo].every(isNum) || depth <= 0) return null;

  // Recent consolidation extremes: the trailing third of the window (the flag/handle/base).
  const cs = G.toDaily(candles);
  const tail = cs.slice(-Math.max(3, Math.floor(cs.length / 3)));
  const recentLow = Math.min(...tail.map(c => c.low));
  const recentHigh = Math.max(...tail.map(c => c.high));
  const atrBuf = isNum(atr) && atr > 0 ? atr * 0.75 : depth * 0.15;

  if (direction === 'SHORT') {
    const trigger = lo;
    // Stop above the recent consolidation high (bounded so RR stays sane).
    const stop = Math.min(recentHigh, trigger + Math.max(atrBuf, depth * 0.4));
    const target = trigger - depth;
    return normalizePlan(trigger, stop, target, 'SHORT');
  }
  const trigger = hi;
  const stop = Math.max(recentLow, trigger - Math.max(atrBuf, depth * 0.4));
  const target = trigger + depth;
  return normalizePlan(trigger, stop, target, 'LONG');
}

function normalizePlan(trigger, stop, target, direction) {
  const risk = Math.abs(trigger - stop);
  const reward = Math.abs(target - trigger);
  const rr = risk > 0 ? reward / risk : null;
  return { trigger: round(trigger, 2), stop: round(stop, 2), target: round(target, 2), rr: round(rr, 2), direction };
}

// Run every applicable template against a single window; return sorted detections.
// candles: daily-shape window. context: { marketRegime, liquidity, volPercentile }.
function detectWindow(candles, { timeframe = '20d', context = {}, minSimilarity = MIN_SIMILARITY } = {}) {
  const cs = G.toDaily(candles);
  if (cs.length < 8) return [];
  const geo = G.geometryFeatures(cs, { window: cs.length });
  const vol = G.volumeFeatures(cs, { window: cs.length });
  if (!geo) return [];
  const closes = G.closesOf(cs);
  const windowPath = G.unitPath(closes);
  const last = cs[cs.length - 1].close;
  const atr = geo.atr;

  const out = [];
  for (const tmpl of REGISTRY) {
    if (Array.isArray(tmpl.timeframes) && !tmpl.timeframes.includes(timeframe)) continue;

    const pathCorr = S.pathCorrelation(windowPath, tmpl.path);
    const dtw = S.dtwSimilarity(windowPath, tmpl.path);
    const geoSim = S.geometrySimilarity(geo, tmpl);
    const volSim = S.volumeSimilarity(vol, tmpl);
    const ctxSim = S.contextSimilarity(context, tmpl);

    const components = { pathCorrelation: pathCorr, geometrySimilarity: geoSim, dtwSimilarity: dtw, volumeSimilarity: volSim, contextSimilarity: ctxSim };
    const { combined, used, coverage } = S.combineSimilarity(components);
    if (!isNum(combined) || combined < minSimilarity) continue;

    const plan = derivePlan(tmpl.direction, geo, cs);
    const long = tmpl.direction !== 'SHORT';

    // Structural signals from the geometry + plan (all point-in-time).
    let breakoutConfirmed = false;
    let invalidationHit = false;
    let extensionAtr = null;
    if (plan && isNum(atr) && atr > 0) {
      breakoutConfirmed = long ? last > plan.trigger : last < plan.trigger;
      invalidationHit = long ? last < plan.stop : last > plan.stop;
      extensionAtr = long ? (last - plan.trigger) / atr : (plan.trigger - last) / atr;
    }
    // Retest: broke out earlier in the window but has come back near the trigger now.
    const retesting = breakoutConfirmed && isNum(extensionAtr) && extensionAtr >= 0 && extensionAtr <= 0.4;
    const momentumDeteriorating = long ? geo.trendSlope < 0 && geo.lowerHighs >= 2 : geo.trendSlope > 0 && geo.higherLows >= 2;

    // Structural detection is timeframe-agnostic about age: EXPIRED is a LIVE-layer verdict
    // (the forward/lifecycle tracker knows how long since first detection), so we do not
    // expire here on the analysis-window length. ageBars/expireBars are left unset.
    const phase = classifyPhase({
      direction: tmpl.direction, last, trigger: plan && plan.trigger, stop: plan && plan.stop, atr,
      invalidationHit, breakoutConfirmed, retesting,
      extensionAtr, momentumDeteriorating, similarity: combined,
    });

    out.push({
      family: tmpl.family,
      label: tmpl.label,
      direction: tmpl.direction,
      timeframe,
      phase,
      similarity: {
        pathCorrelation: round(pathCorr),
        geometrySimilarity: geoSim ? geoSim.score : null,
        dtwSimilarity: round(dtw),
        volumeSimilarity: volSim ? volSim.score : null,
        contextSimilarity: round(ctxSim),
        combined: round(combined),
        coverage,
        used,
      },
      geometry: geo,
      volume: vol,
      plan,
      breakoutConfirmed,
      invalidationHit,
      extensionAtr: round(extensionAtr),
      retesting,
      patternStart: cs[0].date,
      patternAsOf: cs[cs.length - 1].date,
      evidenceFamilies: tmpl.evidenceFamilies,
      invalidation: tmpl.invalidation,
    });
  }

  out.sort((a, b) => b.similarity.combined - a.similarity.combined);
  return out;
}

module.exports = { detectWindow, derivePlan, MIN_SIMILARITY, EXPIRE_BARS };
