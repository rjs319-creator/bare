'use strict';
// PATTERN RECONCILIATION — decision-aware multi-timeframe synthesis.
//
// Replaces similarity-only reconciliation. Detections are ranked by TRADE RELEVANCE
// (structural validity, actionability, remaining reward:risk, plan quality, validated
// edge, freshness) — not by raw shape similarity. Higher-timeframe trend strengthens or
// downgrades lower-timeframe setups, opposing setups produce an explicit conflict
// explanation, and meaningful secondary detections survive.

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 3) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

const TF_RANK = { session: 0, '20d': 1, '60d': 2, '120d': 3 };

const PHASE_ACTIONABILITY = {
  CONFIRMED: 1.0, RETESTING: 0.9, NEAR_TRIGGER: 0.75,
  FORMING: 0.4, EMERGING: 0.2, STALLING: 0.25, EXTENDED: 0.15, FAILED: 0, EXPIRED: 0,
};

// Trade-relevance score for one detection (0..1). Weights favor structure + actionability;
// validated edge is a bonus, similarity is deliberately absent.
function tradeRelevance(d, { eligible = false } = {}) {
  const validity = isNum(d.structuralValidity) ? d.structuralValidity : 0;
  const act = PHASE_ACTIONABILITY[d.phase] ?? 0.2;
  const rr = d.plan && isNum(d.plan.rr) ? Math.min(d.plan.rr, 3) / 3 : 0;
  const quality = d.plan ? ({ good: 1, acceptable: 0.7, poor: 0.25, invalid: 0 }[d.plan.quality] ?? 0.5) : 0;
  return round(0.35 * validity + 0.3 * act + 0.15 * rr + 0.1 * quality + (eligible ? 0.1 : 0));
}

// The higher-timeframe trend verdict used to condition lower-timeframe setups.
// Derived from the LONGEST available detection plus the market context.
function higherTimeframeTrend(detections, context = {}) {
  const longest = detections
    .filter(d => !d.structurallyInvalid)
    .sort((a, b) => (TF_RANK[b.timeframe] ?? 0) - (TF_RANK[a.timeframe] ?? 0))[0] || null;
  if (!longest) return { direction: 'UNKNOWN', source: null };
  return { direction: longest.direction, source: `${longest.family}@${longest.timeframe}`, phase: longest.phase };
}

// Contextual adjustment of one detection given the higher-timeframe read. Pure and
// explainable: every upgrade/downgrade carries its reason.
function contextualize(d, htf, context = {}) {
  const notes = [];
  let adjustment = 'none';
  if (htf && htf.direction !== 'UNKNOWN' && (TF_RANK[d.timeframe] ?? 0) < 3 && htf.source !== `${d.family}@${d.timeframe}`) {
    if (htf.direction === d.direction) {
      adjustment = 'strengthened';
      notes.push(`Aligned with the ${htf.source} higher-timeframe structure (${htf.direction}).`);
    } else {
      const majorResistance = d.direction === 'LONG' && htf.direction === 'SHORT';
      adjustment = 'tactical-countertrend';
      notes.push(majorResistance
        ? `Bullish setup beneath a bearish higher-timeframe structure (${htf.source}) — tactical countertrend, reduced conviction.`
        : `Bearish setup inside a bullish higher-timeframe structure (${htf.source}) — tactical countertrend, reduced conviction.`);
    }
  }
  if (context.relativeStrength === 'NEGATIVE' && d.direction === 'LONG') notes.push('Relative strength vs the market is negative.');
  if (context.relativeStrength === 'POSITIVE' && d.direction === 'SHORT') notes.push('Relative strength vs the market is positive — shorts fight the tape.');
  return { adjustment, notes };
}

// Reconcile a ticker's detections across timeframes.
//   detections : canonical per-timeframe detections (valid ones carry plans)
//   opts       : { context, eligibilityFor(d) → eligibility object }
// Returns { primary, secondary, conflicts, alignment, htf, ranked }.
function reconcileDetections(detections = [], { context = {}, eligibilityFor = null } = {}) {
  const valid = detections.filter(d => !d.structurallyInvalid && d.plan);
  if (!valid.length) return { primary: null, secondary: [], conflicts: [], alignment: null, htf: { direction: 'UNKNOWN' }, ranked: [] };

  const htf = higherTimeframeTrend(valid, context);
  const ranked = valid.map(d => {
    const eligibility = eligibilityFor ? eligibilityFor(d) : null;
    const ctxAdj = contextualize(d, htf, context);
    let score = tradeRelevance(d, { eligible: !!(eligibility && eligibility.eligible) });
    if (ctxAdj.adjustment === 'strengthened') score = round(Math.min(1, score + 0.08));
    if (ctxAdj.adjustment === 'tactical-countertrend') score = round(Math.max(0, score - 0.12));
    return { detection: d, score, adjustment: ctxAdj.adjustment, contextNotes: ctxAdj.notes, eligibility };
  }).sort((a, b) => b.score - a.score);

  const primary = ranked[0];
  const secondary = ranked.slice(1).filter(r => r.detection.direction === primary.detection.direction);
  const opposing = ranked.slice(1).filter(r => r.detection.direction !== primary.detection.direction);

  // Every opposing pair gets an explicit conflict explanation — never two unexplained
  // recommendations.
  const conflicts = opposing.map(r => ({
    with: `${r.detection.family}@${r.detection.timeframe}`,
    direction: r.detection.direction,
    severity: r.score >= primary.score * 0.8 ? 'high' : 'moderate',
    explanation: `${r.detection.label} (${r.detection.direction}, ${r.detection.timeframe}) opposes the primary ${primary.detection.label} (${primary.detection.direction}, ${primary.detection.timeframe}). `
      + (r.score >= primary.score * 0.8
        ? 'Both are comparably relevant — stand aside or size down until one resolves.'
        : `The ${primary.detection.timeframe} structure carries more trade relevance; treat the opposing read as a risk flag.`),
  }));

  // Direction alignment weighted by trade relevance (not similarity).
  let wAgree = 0;
  let wTotal = 0;
  for (const r of ranked) {
    wTotal += r.score;
    if (r.detection.direction === primary.detection.direction) wAgree += r.score;
  }

  return {
    primary,
    secondary,
    conflicts,
    alignment: wTotal > 0 ? round(wAgree / wTotal) : null,
    htf,
    ranked,
  };
}

module.exports = { reconcileDetections, tradeRelevance, higherTimeframeTrend, contextualize, TF_RANK };
