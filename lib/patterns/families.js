'use strict';
// PATTERN FAMILIES — dedicated structural detectors, one per family.
//
// This replaces the universal-template assumption. Each family declares its OWN required
// structure (pivot sequence, boundaries, contraction, reaction …) and its OWN trade plan
// (trigger / invalidation / target from actual structural levels — never a forced 2.5:1).
//
// HONESTY RULES enforced here:
//   • Every detector runs on FORMATION bars only (bars 0..t-1). The confirmation bar is
//     evaluated elsewhere against the frozen levels (structure.assessBarVsLevel).
//   • Missing REQUIRED features score 0 and are listed in missingRequiredFeatures — the
//     remaining features are NOT renormalized, so a pattern cannot look strong from a
//     small subset of measurable evidence. `pass` fails closed on any missing required.
//   • Every level carries provenance (the bar/pivot identifiers that built it).
//
// Detector contract: detect(formation, ctx) → null | {
//   family, label, direction, structural: { validity, pass, featureCoverage,
//   requiredFeatures, missingRequiredFeatures, perFeature }, pivotsUsed,
//   trigger, invalidation, target, measurements }
// ctx: { atr, piv (zigzag pivots), frac (fractals), geo (geometryFeatures), vol }

const G = require('./geometry');
const ST = require('./structure');
const { rangeScore } = require('./similarity');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

const MIN_VALIDITY = 0.6;   // structural pass floor (with ALL required features present)

// ---- feature evaluation (no renormalization) -----------------------------------

// specs: [{ name, score (0..1 or null), required }]. A required feature with a null
// score counts as ZERO in validity (not dropped) and is reported missing. A required
// feature that IS measurable but scores ~0 (a hard structural violation, e.g. an 80%
// flag retracement) also fails the pattern — it is listed in violatedFeatures.
const REQUIRED_FLOOR = 0.2;
function evalFeatures(specs) {
  const perFeature = {};
  const missingRequired = [];
  const violated = [];
  const required = [];
  let acc = 0;
  let wsum = 0;
  let measured = 0;
  for (const s of specs) {
    if (s.required) required.push(s.name);
    if (s.score == null) {
      if (s.required) { missingRequired.push(s.name); wsum += 1; } // counts as 0 — no renormalize
      continue;
    }
    perFeature[s.name] = round(s.score);
    if (s.required && s.score < REQUIRED_FLOOR) violated.push(s.name);
    acc += s.score;
    wsum += 1;
    measured++;
  }
  const validity = wsum > 0 ? acc / wsum : 0;
  const featureCoverage = specs.length ? round(measured / specs.length, 3) : 0;
  return {
    validity: round(validity, 3),
    pass: missingRequired.length === 0 && violated.length === 0 && validity >= MIN_VALIDITY,
    featureCoverage,
    requiredFeatures: required,
    missingRequiredFeatures: missingRequired,
    violatedFeatures: violated,
    perFeature,
  };
}

function pivotAt(formation, idx, kind, price) {
  const bar = formation[idx];
  return { idx, kind, price: round(price, 4), date: bar ? bar.date : null };
}

function result(family, label, direction, structural, pivotsUsed, trigger, invalidation, target, measurements) {
  if (!trigger || !invalidation || !target) return null;
  return { family, label, direction, structural, pivotsUsed, trigger, invalidation, target, measurements };
}

// ---- flags ---------------------------------------------------------------------

function detectFlag(direction) {
  const long = direction === 'LONG';
  return function flag(formation, ctx) {
    const { atr } = ctx;
    const pole = ST.findPole(formation, atr, { direction: long ? 1 : -1, minMoveAtr: 3 });
    let flagBars = null;
    let retrace = null;
    let drift = null;
    let controlled = null;
    if (pole && formation.length - 1 - pole.endIdx >= 3) {
      flagBars = formation.slice(pole.endIdx + 1);
      const move = Math.abs(pole.endPrice - pole.startPrice);
      const extreme = long ? Math.min(...flagBars.map(c => c.low)) : Math.max(...flagBars.map(c => c.high));
      retrace = move > 0 ? Math.abs(pole.endPrice - extreme) / move : null;
      drift = G.normSlope(G.closesOf(flagBars));
      const flagRange = flagBars.reduce((a, c) => a + (c.high - c.low), 0) / flagBars.length;
      const poleSlice = formation.slice(pole.startIdx, pole.endIdx + 1);
      const poleRange = poleSlice.reduce((a, c) => a + (c.high - c.low), 0) / poleSlice.length;
      controlled = poleRange > 0 ? flagRange / poleRange : null;
    }
    const structural = evalFeatures([
      { name: 'pole', score: pole ? Math.min(1, pole.moveAtr / 5) : null, required: true },
      { name: 'consolidation', score: flagBars ? Math.min(1, flagBars.length / 5) : null, required: true },
      { name: 'retracementLimit', score: isNum(retrace) ? rangeScore(retrace, [0.05, 0.5], 0.15) : null, required: true },
      { name: 'controlledDrift', score: isNum(drift) ? rangeScore(long ? drift : -drift, [-0.02, 0.004], 0.015) : null, required: false },
      { name: 'volatilityContraction', score: isNum(controlled) ? rangeScore(controlled, [null, 1.0], 0.4) : null, required: false },
    ]);
    if (!pole || !flagBars) return withEmptyPlan(long ? 'BULL_FLAG' : 'BEAR_FLAG', long ? 'Bull flag' : 'Bear flag', direction, structural);

    // Trigger: the flag boundary — a robust line through the flag's counter-trend edge,
    // extrapolated ONE bar forward (still built purely from formation bars).
    const edge = flagBars.map((c, i) => ({ x: pole.endIdx + 1 + i, y: long ? c.high : c.low }));
    const line = ST.fitLine(edge);
    const boundaryAt = line ? line.at(formation.length) : null;
    const flagExtreme = long ? Math.max(...flagBars.map(c => c.high)) : Math.min(...flagBars.map(c => c.low));
    const trigPrice = isNum(boundaryAt)
      ? (long ? Math.min(boundaryAt, flagExtreme) : Math.max(boundaryAt, flagExtreme))
      : flagExtreme;
    // Stop just beyond the flag extreme (a small ATR buffer, as a trader would place it).
    const invalPrice = long
      ? Math.min(...flagBars.map(c => c.low)) - 0.25 * atr
      : Math.max(...flagBars.map(c => c.high)) + 0.25 * atr;
    const move = Math.abs(pole.endPrice - pole.startPrice);
    const targetPrice = long ? trigPrice + move : trigPrice - move;
    const srcIdxs = flagBars.map((_, i) => pole.endIdx + 1 + i);

    return result(
      long ? 'BULL_FLAG' : 'BEAR_FLAG', long ? 'Bull flag' : 'Bear flag', direction, structural,
      [pivotAt(formation, pole.startIdx, long ? 'L' : 'H', pole.startPrice), pivotAt(formation, pole.endIdx, long ? 'H' : 'L', pole.endPrice)],
      ST.levelWithProvenance(trigPrice, 'flag-boundary', srcIdxs, formation),
      ST.levelWithProvenance(invalPrice, 'flag-extreme', srcIdxs, formation),
      { price: round(targetPrice, 4), method: 'pole-measured-move' },
      { poleMoveAtr: pole.moveAtr, flagBars: flagBars.length, retracement: round(retrace, 3), drift: round(drift, 5) }
    );
  };
}

// A structurally-incomplete read still reports WHAT is missing (for the negative tests
// and the expert view) but carries no plan, so it can never rank or trade.
function withEmptyPlan(family, label, direction, structural) {
  return { family, label, direction, structural, pivotsUsed: [], trigger: null, invalidation: null, target: null, measurements: {}, incomplete: true };
}

// ---- VCP -----------------------------------------------------------------------

function detectVCP(formation, ctx) {
  const { atr, vol } = ctx;
  if (!isNum(atr) || atr <= 0) return null;
  const hiIdx = argMax(formation, c => c.high);
  const hi = formation[hiIdx].high;
  const first = formation[0];
  const advanceAtr = (hi - first.low) / atr;

  // The BASE is everything after the window high. Contraction is measured on equal
  // segments of the base (robust to pivot noise): each successive segment's range must
  // shrink — that IS the "sequence of progressively smaller contractions", not merely
  // lower recent volatility.
  const base = formation.slice(hiIdx);
  let segRanges = null;
  let lastSeg = null;
  if (base.length >= 9) {
    const segLen = Math.floor(base.length / 3);
    const segs = [base.slice(0, segLen), base.slice(segLen, 2 * segLen), base.slice(2 * segLen)];
    segRanges = segs.map(s => (Math.max(...s.map(c => c.high)) - Math.min(...s.map(c => c.low))) / atr);
    lastSeg = segs[2];
  }
  const contracting = segRanges ? (segRanges[1] <= segRanges[0] * 0.9 && segRanges[2] <= segRanges[1] * 0.9) : null;
  const lastRangeAtr = segRanges ? segRanges[2] : null;
  const structural = evalFeatures([
    { name: 'priorAdvance', score: isNum(advanceAtr) ? rangeScore(advanceAtr, [3, null], 1.5) : null, required: true },
    { name: 'contractionSequence', score: contracting == null ? null : (contracting ? 1 : 0), required: true },
    { name: 'finalContractionTight', score: isNum(lastRangeAtr) ? rangeScore(lastRangeAtr, [null, 2.2], 0.8) : null, required: true },
    { name: 'volumeDryUp', score: vol && isNum(vol.dryUp) ? rangeScore(vol.dryUp, [null, 0.95], 0.3) : null, required: false },
  ]);
  if (!contracting || !lastSeg) return withEmptyPlan('VCP', 'Volatility contraction (VCP)', 'LONG', structural);

  const trigPrice = Math.max(...lastSeg.map(c => c.high));   // final-contraction pivot
  const invalPrice = Math.min(...lastSeg.map(c => c.low));   // final-contraction low
  const baseDepth = hi - Math.min(...base.map(c => c.low));
  const lastSegStart = formation.length - lastSeg.length;
  const segIdxs = lastSeg.map((_, i) => lastSegStart + i);
  return result('VCP', 'Volatility contraction (VCP)', 'LONG', structural,
    [pivotAt(formation, hiIdx, 'H', hi), pivotAt(formation, lastSegStart + argMax(lastSeg, c => c.high), 'H', trigPrice), pivotAt(formation, lastSegStart + argMin(lastSeg, c => c.low), 'L', invalPrice)],
    ST.levelWithProvenance(trigPrice, 'final-contraction-pivot', segIdxs, formation),
    ST.levelWithProvenance(invalPrice, 'final-contraction-low', segIdxs, formation),
    { price: round(trigPrice + baseDepth * 0.6, 4), method: 'base-depth-fraction' },
    { segRangesAtr: segRanges.map(s => round(s, 2)), advanceAtr: round(advanceAtr, 2) });
}

// ---- flat base -----------------------------------------------------------------

function detectFlatBase(formation, ctx) {
  const { atr } = ctx;
  if (!isNum(atr) || atr <= 0) return null;
  // Search TRAILING base lengths directly (decoupled from pole-shape quirks): the base is
  // the longest trailing stretch that is tight, flat, and preceded by a real advance it
  // holds above the midpoint of.
  let best = null;
  const n = formation.length;
  for (let len = Math.min(15, n - 6); len >= 5; len--) {
    const base = formation.slice(n - len);
    const pre = formation.slice(0, n - len);
    if (pre.length < 4) continue;
    const baseHi = Math.max(...base.map(c => c.high));
    const baseLo = Math.min(...base.map(c => c.low));
    const preHi = Math.max(...pre.map(c => c.high));
    const preLo = Math.min(...pre.map(c => c.low));
    const advanceAtr = (preHi - preLo) / atr;
    const depthPct = baseHi > 0 ? (baseHi - baseLo) / baseHi : null;
    const slope = Math.abs(G.normSlope(G.closesOf(base)));
    const midpoint = (preLo + preHi) / 2;
    const cand = { base, baseHi, baseLo, advanceAtr, depthPct, slope, midpoint, len, startIdx: n - len };
    // hard structural requirements for a candidate base
    if (advanceAtr >= 3 && depthPct != null && depthPct <= 0.16 && slope <= 0.012 && baseLo > midpoint && baseHi >= preHi - 1.5 * atr) { best = cand; break; }
    if (!best) best = cand; // keep the last examined for honest missing/violated reporting
  }
  const b = best;
  const structural = evalFeatures([
    { name: 'priorAdvance', score: b ? rangeScore(b.advanceAtr, [3, null], 1.5) : null, required: true },
    { name: 'baseDuration', score: b ? Math.min(1, b.len / 8) : null, required: true },
    { name: 'baseTightness', score: b && isNum(b.depthPct) ? rangeScore(b.depthPct, [0.015, 0.15], 0.06) : null, required: true },
    { name: 'flatSlope', score: b ? rangeScore(b.slope, [null, 0.008], 0.008) : null, required: true },
    { name: 'holdsAboveMidpoint', score: b ? (b.baseLo > b.midpoint ? 1 : 0) : null, required: true },
    { name: 'nearPriorHigh', score: b ? (b.baseHi >= Math.max(...formation.slice(0, b.startIdx).map(c => c.high)) - 1.5 * atr ? 1 : 0) : null, required: true },
  ]);
  if (!b || !structural.pass) return withEmptyPlan('FLAT_BASE', 'Flat base', 'LONG', structural);
  const srcIdxs = b.base.map((_, i) => b.startIdx + i);
  return result('FLAT_BASE', 'Flat base', 'LONG', structural,
    [pivotAt(formation, b.startIdx + argMax(b.base, c => c.high), 'H', b.baseHi), pivotAt(formation, b.startIdx + argMin(b.base, c => c.low), 'L', b.baseLo)],
    ST.levelWithProvenance(b.baseHi, 'base-pivot-high', srcIdxs, formation),
    ST.levelWithProvenance(b.baseLo, 'base-low', srcIdxs, formation),
    { price: round(b.baseHi + (b.baseHi - b.baseLo), 4), method: 'base-depth-measured-move' },
    { baseBars: b.len, depthPct: round(b.depthPct, 4), advanceAtr: round(b.advanceAtr, 2) });
}

// ---- cup and handle ------------------------------------------------------------

function detectCupHandle(formation, ctx) {
  const { atr } = ctx;
  const n = formation.length;
  if (n < 30) return null;
  const third = Math.floor(n / 3);
  const leftSeg = formation.slice(0, third);
  const leftRimIdx = argMax(leftSeg, c => c.high);
  const leftRim = leftSeg[leftRimIdx].high;
  const midSeg = formation.slice(leftRimIdx + 1);
  const botRel = argMin(midSeg, c => c.low);
  const bottomIdx = leftRimIdx + 1 + botRel;
  const bottom = formation[bottomIdx].low;
  const afterBottom = formation.slice(bottomIdx + 1);
  if (!afterBottom.length) return null;
  const rightRimRel = argMax(afterBottom, c => c.high);
  const rightRimIdx = bottomIdx + 1 + rightRimRel;
  const rightRim = formation[rightRimIdx].high;
  const cupDepth = Math.max(leftRim, rightRim) - bottom;
  const cupDepthAtr = isNum(atr) && atr > 0 ? cupDepth / atr : null;
  const cupDepthPct = leftRim > 0 ? cupDepth / leftRim : null;
  const rimDiffAtr = isNum(atr) && atr > 0 ? Math.abs(leftRim - rightRim) / atr : null;
  const bottomPos = (bottomIdx - leftRimIdx) / Math.max(1, rightRimIdx - leftRimIdx); // rounded bottom ≈ centred

  // Handle: the bars after the right rim (needs ≥3) staying in the upper half of the cup.
  const handle = formation.slice(rightRimIdx + 1);
  const handleLow = handle.length >= 3 ? Math.min(...handle.map(c => c.low)) : null;
  const handleHigh = handle.length >= 3 ? Math.max(...handle.map(c => c.high)) : null;
  const handleRetrace = isNum(handleLow) && cupDepth > 0 ? (rightRim - handleLow) / cupDepth : null;
  const handleInUpperHalf = isNum(handleLow) ? handleLow > bottom + cupDepth * 0.5 : null;

  const structural = evalFeatures([
    { name: 'cupDepth', score: isNum(cupDepthPct) ? rangeScore(cupDepthPct, [0.1, 0.5], 0.12) : null, required: true },
    { name: 'rimAlignment', score: isNum(rimDiffAtr) ? rangeScore(rimDiffAtr, [null, 1.5], 1) : null, required: true },
    { name: 'roundedBottom', score: isNum(bottomPos) ? rangeScore(bottomPos, [0.25, 0.75], 0.2) : null, required: true },
    { name: 'cupDuration', score: rightRimIdx - leftRimIdx >= 15 ? 1 : (rightRimIdx - leftRimIdx) / 15, required: true },
    { name: 'handlePresent', score: handle.length >= 3 ? Math.min(1, handle.length / 5) : null, required: true },
    { name: 'handleDepth', score: isNum(handleRetrace) ? rangeScore(handleRetrace, [0.03, 0.5], 0.15) : null, required: true },
    { name: 'handleUpperHalf', score: handleInUpperHalf == null ? null : (handleInUpperHalf ? 1 : 0), required: true },
  ]);
  if (handle.length < 3 || !isNum(handleLow)) return withEmptyPlan('CUP_AND_HANDLE', 'Cup and handle', 'LONG', structural);

  const trigPrice = Math.max(rightRim, handleHigh);
  return result('CUP_AND_HANDLE', 'Cup and handle', 'LONG', structural,
    [pivotAt(formation, leftRimIdx, 'H', leftRim), pivotAt(formation, bottomIdx, 'L', bottom), pivotAt(formation, rightRimIdx, 'H', rightRim)],
    ST.levelWithProvenance(trigPrice, 'rim-handle-pivot', [rightRimIdx], formation),
    ST.levelWithProvenance(handleLow, 'handle-low', handle.map((_, i) => rightRimIdx + 1 + i), formation),
    { price: round(trigPrice + cupDepth, 4), method: 'cup-depth-measured-move' },
    { cupDepthAtr: round(cupDepthAtr, 2), cupDepthPct: round(cupDepthPct, 4), handleBars: handle.length, handleRetrace: round(handleRetrace, 3) });
}

// ---- double bottom / double top -------------------------------------------------

function detectDouble(direction) {
  const bottom = direction === 'LONG';
  return function dbl(formation, ctx) {
    const { atr, frac } = ctx;
    const pivots = bottom ? frac.lows : frac.highs;
    if (!isNum(atr) || atr <= 0) return null;
    // Two comparable extremes with real separation and an intervening reaction.
    let bestPair = null;
    for (let i = 0; i < pivots.length; i++) {
      for (let j = i + 1; j < pivots.length; j++) {
        const a = pivots[i];
        const b = pivots[j];
        if (b.idx - a.idx < 5) continue;
        const diffAtr = Math.abs(a.price - b.price) / atr;
        if (diffAtr > 1.25) continue;
        if (!bestPair || diffAtr < bestPair.diffAtr) bestPair = { a, b, diffAtr };
      }
    }
    let reactionAtr = null;
    let neckPrice = null;
    let neckIdx = null;
    if (bestPair) {
      const between = formation.slice(bestPair.a.idx + 1, bestPair.b.idx);
      if (between.length) {
        neckIdx = bestPair.a.idx + 1 + (bottom ? argMax(between, c => c.high) : argMin(between, c => c.low));
        neckPrice = bottom ? formation[neckIdx].high : formation[neckIdx].low;
        reactionAtr = Math.abs(neckPrice - (bottom ? Math.min(bestPair.a.price, bestPair.b.price) : Math.max(bestPair.a.price, bestPair.b.price))) / atr;
      }
    }
    const structural = evalFeatures([
      { name: 'comparablePivots', score: bestPair ? rangeScore(bestPair.diffAtr, [null, 0.75], 0.5) : null, required: true },
      { name: 'pivotSeparation', score: bestPair ? Math.min(1, (bestPair.b.idx - bestPair.a.idx) / 10) : null, required: true },
      { name: 'interveningReaction', score: isNum(reactionAtr) ? rangeScore(reactionAtr, [1.5, null], 0.75) : null, required: true },
      { name: 'neckline', score: isNum(neckPrice) ? 1 : null, required: true },
    ]);
    const family = bottom ? 'DOUBLE_BOTTOM' : 'DOUBLE_TOP';
    const label = bottom ? 'Double bottom' : 'Double top';
    if (!bestPair || !isNum(neckPrice)) return withEmptyPlan(family, label, direction, structural);

    const extremes = [bestPair.a.price, bestPair.b.price];
    const measured = Math.abs(neckPrice - (bottom ? Math.min(...extremes) : Math.max(...extremes)));
    return result(family, label, direction, structural,
      [pivotAt(formation, bestPair.a.idx, bottom ? 'L' : 'H', bestPair.a.price), pivotAt(formation, neckIdx, bottom ? 'H' : 'L', neckPrice), pivotAt(formation, bestPair.b.idx, bottom ? 'L' : 'H', bestPair.b.price)],
      ST.levelWithProvenance(neckPrice, 'neckline', [neckIdx], formation),
      ST.levelWithProvenance(bestPair.b.price, bottom ? 'second-bottom' : 'second-top', [bestPair.b.idx], formation),
      { price: round(bottom ? neckPrice + measured : neckPrice - measured, 4), method: 'neckline-measured-move' },
      { pivotDiffAtr: round(bestPair.diffAtr, 3), reactionAtr: round(reactionAtr, 2), separationBars: bestPair.b.idx - bestPair.a.idx });
  };
}

// ---- triangles -----------------------------------------------------------------

function detectTriangle(direction) {
  const asc = direction === 'LONG';
  return function tri(formation, ctx) {
    const { atr, piv } = ctx;
    if (!isNum(atr) || atr <= 0) return null;
    const flatKind = asc ? 'H' : 'L';
    const slopeKind = asc ? 'L' : 'H';
    // The flat boundary is the pivot CLUSTER at the window extreme (an intermediate swing
    // low far above a flat bottom is not part of the bottom).
    const winHi = Math.max(...formation.map(c => c.high));
    const winLo = Math.min(...formation.map(c => c.low));
    const flatPivots = piv.filter(p => p.kind === flatKind && (asc ? winHi - p.price : p.price - winLo) <= 0.75 * atr);
    const flat = ST.fitHorizontal(flatPivots, atr);
    const sloped = ST.fitTrendline(piv, slopeKind, atr);
    const slopeOk = sloped ? (asc ? sloped.slope > 0 : sloped.slope < 0) : null;
    // Convergence: the channel narrows into the apex.
    const n = formation.length;
    let convergence = null;
    if (flat && sloped) {
      const w0 = Math.abs(flat.price - sloped.at(Math.floor(n * 0.2)));
      const w1 = Math.abs(flat.price - sloped.at(n - 1));
      convergence = w0 > 0 ? 1 - w1 / w0 : null; // >0 = narrowing
    }
    // The fitted channel must actually BOUND the recent price — an extrapolated line the
    // tape doesn't respect is a curve-fit, not a boundary.
    const lastClose = formation[n - 1].close;
    let bounded = null;
    if (flat && sloped) {
      const flatOk = asc ? lastClose <= flat.price + 0.5 * atr : lastClose >= flat.price - 0.5 * atr;
      const slopedOk = asc ? lastClose >= sloped.at(n - 1) - 0.75 * atr : lastClose <= sloped.at(n - 1) + 0.75 * atr;
      bounded = flatOk && slopedOk && sloped.maxViolationAtr <= 1;
    }
    const structural = evalFeatures([
      { name: 'flatBoundary', score: flat && flat.touches >= 2 ? rangeScore(flat.flatnessAtr, [null, 0.5], 0.35) : null, required: true },
      { name: asc ? 'risingLows' : 'fallingHighs', score: sloped && sloped.touches >= 2 ? (slopeOk ? 1 : 0) : null, required: true },
      { name: 'convergence', score: isNum(convergence) ? rangeScore(convergence, [0.2, null], 0.2) : null, required: true },
      { name: 'priceInsideChannel', score: bounded == null ? null : (bounded ? 1 : 0), required: true },
      { name: 'touchCount', score: flat && sloped ? Math.min(1, (flat.touches + sloped.touches) / 5) : null, required: false },
    ]);
    const family = asc ? 'ASCENDING_TRIANGLE' : 'DESCENDING_TRIANGLE';
    const label = asc ? 'Ascending triangle' : 'Descending triangle';
    if (!flat || !sloped || !slopeOk || !bounded) return withEmptyPlan(family, label, direction, structural);

    const height = Math.abs(flat.price - sloped.at(Math.floor(n * 0.2)));
    const opposing = sloped.at(n); // opposing boundary extrapolated one bar forward
    return result(family, label, direction, structural,
      piv.map(p => pivotAt(formation, p.idx, p.kind, p.price)),
      ST.levelWithProvenance(flat.price, 'triangle-flat-boundary', flat.pivotIdxs, formation),
      ST.levelWithProvenance(opposing, 'triangle-opposing-boundary', sloped.pivotIdxs, formation),
      { price: round(asc ? flat.price + height : flat.price - height, 4), method: 'triangle-height-measured-move' },
      { flatTouches: flat.touches, slopedTouches: sloped.touches, convergence: round(convergence, 3) });
  };
}

// ---- wedges --------------------------------------------------------------------

function detectWedge(direction) {
  const falling = direction === 'LONG';  // falling wedge → bullish; rising wedge → bearish
  return function wedge(formation, ctx) {
    const { atr, piv } = ctx;
    if (!isNum(atr) || atr <= 0) return null;
    const upper = ST.fitTrendline(piv, 'H', atr);
    const lower = ST.fitTrendline(piv, 'L', atr);
    const n = formation.length;
    let bothSloped = null;
    let convergence = null;
    let bounded = null;
    let positionOk = null;
    if (upper && lower) {
      bothSloped = falling ? (upper.slope < 0 && lower.slope < 0) : (upper.slope > 0 && lower.slope > 0);
      const w0 = upper.at(Math.floor(n * 0.2)) - lower.at(Math.floor(n * 0.2));
      const w1 = upper.at(n - 1) - lower.at(n - 1);
      convergence = w0 > 0 ? 1 - w1 / w0 : null;
      // The wedge must BOUND the tape: last close inside the channel and neither fitted
      // line badly violated by its own pivots (an extrapolated pole fit is not a wedge).
      const lastClose = formation[n - 1].close;
      bounded = lastClose <= upper.at(n - 1) + 0.5 * atr && lastClose >= lower.at(n - 1) - 0.5 * atr
        && upper.maxViolationAtr <= 1 && lower.maxViolationAtr <= 1;
      // Exhaustion position: a rising wedge is meaningful near the highs, a falling wedge
      // near the lows of its own window.
      const hi = Math.max(...formation.map(c => c.high));
      const lo = Math.min(...formation.map(c => c.low));
      const pos = hi - lo > 0 ? (lastClose - lo) / (hi - lo) : 0.5;
      positionOk = falling ? pos <= 0.45 : pos >= 0.55;
    }
    const structural = evalFeatures([
      { name: 'upperBoundary', score: upper && upper.touches >= 2 ? 1 : null, required: true },
      { name: 'lowerBoundary', score: lower && lower.touches >= 2 ? 1 : null, required: true },
      { name: falling ? 'bothFalling' : 'bothRising', score: bothSloped == null ? null : (bothSloped ? 1 : 0), required: true },
      { name: 'convergence', score: isNum(convergence) ? rangeScore(convergence, [0.25, null], 0.15) : null, required: true },
      { name: 'priceInsideWedge', score: bounded == null ? null : (bounded ? 1 : 0), required: true },
      { name: 'exhaustionPosition', score: positionOk == null ? null : (positionOk ? 1 : 0), required: true },
    ]);
    const family = falling ? 'FALLING_WEDGE' : 'RISING_WEDGE';
    const label = falling ? 'Falling wedge' : 'Rising wedge (exhaustion)';
    if (!upper || !lower || !bothSloped || !bounded || !positionOk) return withEmptyPlan(family, label, direction, structural);

    const width0 = upper.at(Math.floor(n * 0.2)) - lower.at(Math.floor(n * 0.2));
    const trig = falling ? upper.at(n) : lower.at(n);          // break OUT of the wedge
    const inval = falling ? lower.at(n) : upper.at(n);         // opposing boundary
    return result(family, label, direction, structural,
      piv.map(p => pivotAt(formation, p.idx, p.kind, p.price)),
      ST.levelWithProvenance(trig, 'wedge-boundary', (falling ? upper : lower).pivotIdxs, formation),
      ST.levelWithProvenance(inval, 'wedge-opposing-boundary', (falling ? lower : upper).pivotIdxs, formation),
      { price: round(falling ? trig + width0 : trig - width0, 4), method: 'wedge-width-measured-move' },
      { upperSlope: upper.slope, lowerSlope: lower.slope, convergence: round(convergence, 3) });
  };
}

// ---- breakout & retest / failed breakout / undercut & reclaim -------------------

// Locate a prior resistance level (a fractal high) established early in the formation,
// and the first later bar that CLOSED above it. Shared by breakout-retest and
// failed-breakout, both of which must reference a FROZEN historical breakout event.
function priorBreakout(formation, ctx) {
  const { atr, frac } = ctx;
  if (!isNum(atr) || atr <= 0) return null;
  const cutoff = Math.floor(formation.length * 0.6);
  const candidates = frac.highs.filter(p => p.idx <= cutoff);
  for (let ci = candidates.length - 1; ci >= 0; ci--) {
    const level = candidates[ci];
    for (let i = level.idx + 2; i < formation.length; i++) {
      if (formation[i].close > level.price + 0.1 * atr) {
        return { level, breakoutIdx: i, breakoutBar: formation[i] };
      }
    }
  }
  return null;
}

function detectBreakoutRetest(formation, ctx) {
  const { atr } = ctx;
  const bo = priorBreakout(formation, ctx);
  let retest = null;
  if (bo) {
    const after = formation.slice(bo.breakoutIdx + 1);
    for (let i = 0; i < after.length; i++) {
      const c = after[i];
      const nearLevel = c.low <= bo.level.price + 0.75 * atr;
      const heldAbove = c.close >= bo.level.price - 0.5 * atr;
      if (nearLevel && heldAbove) { retest = { idx: bo.breakoutIdx + 1 + i, bar: c }; break; }
    }
  }
  const structural = evalFeatures([
    { name: 'priorLevel', score: bo ? 1 : null, required: true },
    { name: 'breakoutEvent', score: bo ? 1 : null, required: true },
    { name: 'retest', score: retest ? 1 : null, required: true },
    { name: 'retestHeld', score: retest ? (retest.bar.close >= bo.level.price ? 1 : 0.4) : null, required: false },
  ]);
  if (!bo || !retest) return withEmptyPlan('BREAKOUT_RETEST', 'Breakout & retest', 'LONG', structural);

  const postRetest = formation.slice(retest.idx);
  const resumeHigh = Math.max(...postRetest.map(c => c.high));
  const retestLow = Math.min(...postRetest.map(c => c.low));
  const baseLow = Math.min(...formation.slice(0, bo.breakoutIdx + 1).map(c => c.low));
  const baseHeight = bo.level.price - baseLow;
  const trig = Math.max(bo.level.price, resumeHigh);
  return result('BREAKOUT_RETEST', 'Breakout & retest', 'LONG', structural,
    [pivotAt(formation, bo.level.idx, 'H', bo.level.price), pivotAt(formation, bo.breakoutIdx, 'H', bo.breakoutBar.close), pivotAt(formation, retest.idx, 'L', retest.bar.low)],
    ST.levelWithProvenance(trig, 'retest-resume', [bo.level.idx, retest.idx], formation),
    ST.levelWithProvenance(retestLow, 'retest-low', [retest.idx], formation),
    { price: round(bo.level.price + Math.max(baseHeight * 0.8, 2 * atr), 4), method: 'base-height-measured-move' },
    { frozenBreakoutLevel: bo.level.price, breakoutIdx: bo.breakoutIdx, retestIdx: retest.idx });
}

function detectFailedBreakout(formation, ctx) {
  const { atr } = ctx;
  const bo = priorBreakout(formation, ctx);
  let failure = null;
  if (bo) {
    const horizon = Math.min(formation.length, bo.breakoutIdx + 9);
    for (let i = bo.breakoutIdx + 1; i < horizon; i++) {
      if (formation[i].close < bo.level.price - 0.1 * atr) { failure = { idx: i, bar: formation[i] }; break; }
    }
  }
  const rallyHigh = bo && failure ? Math.max(...formation.slice(bo.breakoutIdx, failure.idx + 1).map(c => c.high)) : null;
  const structural = evalFeatures([
    { name: 'priorLevel', score: bo ? 1 : null, required: true },
    { name: 'breakoutEvent', score: bo ? 1 : null, required: true },
    { name: 'failureEvent', score: failure ? 1 : null, required: true },
    { name: 'promptFailure', score: failure ? rangeScore(failure.idx - bo.breakoutIdx, [null, 6], 3) : null, required: false },
  ]);
  if (!bo || !failure) return withEmptyPlan('FAILED_BREAKOUT', 'Failed breakout', 'SHORT', structural);

  const baseLow = Math.min(...formation.slice(0, bo.breakoutIdx + 1).map(c => c.low));
  const trig = Math.min(bo.level.price, failure.bar.low);
  return result('FAILED_BREAKOUT', 'Failed breakout', 'SHORT', structural,
    [pivotAt(formation, bo.level.idx, 'H', bo.level.price), pivotAt(formation, failure.idx, 'L', failure.bar.low)],
    ST.levelWithProvenance(trig, 'failure-bar-low', [failure.idx], formation),
    ST.levelWithProvenance(rallyHigh, 'failed-rally-high', [bo.breakoutIdx], formation),
    { price: round(Math.max(baseLow, trig - (rallyHigh - trig)), 4), method: 'failed-range-measured-move' },
    { frozenBreakoutLevel: bo.level.price, failureIdx: failure.idx });
}

function detectUndercutReclaim(formation, ctx) {
  const { atr, frac } = ctx;
  if (!isNum(atr) || atr <= 0) return null;
  const cutoff = Math.floor(formation.length * 0.6);
  const priorLows = frac.lows.filter(p => p.idx <= cutoff);
  let event = null;
  for (let li = priorLows.length - 1; li >= 0 && !event; li--) {
    const pl = priorLows[li];
    for (let i = pl.idx + 2; i < formation.length; i++) {
      if (formation[i].low < pl.price - 0.05 * atr) {
        // undercut found — now need a later close back ABOVE the prior low.
        for (let j = i; j < formation.length; j++) {
          if (formation[j].close > pl.price + 0.05 * atr) { event = { priorLow: pl, undercutIdx: i, reclaimIdx: j }; break; }
        }
        break;
      }
    }
  }
  const structural = evalFeatures([
    { name: 'priorLow', score: priorLows.length ? 1 : null, required: true },
    { name: 'undercut', score: event ? 1 : null, required: true },
    { name: 'reclaim', score: event ? 1 : null, required: true },
    { name: 'reclaimStrength', score: event ? rangeScore((formation[event.reclaimIdx].close - event.priorLow.price) / atr, [0.25, null], 0.5) : null, required: false },
  ]);
  if (!event) return withEmptyPlan('UNDERCUT_RECLAIM', 'Undercut & reclaim', 'LONG', structural);

  const undercutLow = Math.min(...formation.slice(event.undercutIdx, event.reclaimIdx + 1).map(c => c.low));
  const reclaimHigh = formation[event.reclaimIdx].high;
  const rangeHigh = Math.max(...formation.slice(Math.floor(formation.length / 2)).map(c => c.high));
  return result('UNDERCUT_RECLAIM', 'Undercut & reclaim', 'LONG', structural,
    [pivotAt(formation, event.priorLow.idx, 'L', event.priorLow.price), pivotAt(formation, event.undercutIdx, 'L', undercutLow), pivotAt(formation, event.reclaimIdx, 'H', reclaimHigh)],
    ST.levelWithProvenance(Math.max(event.priorLow.price, reclaimHigh), 'reclaim-resume', [event.priorLow.idx, event.reclaimIdx], formation),
    ST.levelWithProvenance(undercutLow, 'undercut-low', [event.undercutIdx], formation),
    { price: round(Math.max(rangeHigh, reclaimHigh + 2 * atr), 4), method: 'range-high-objective' },
    { priorLowPrice: event.priorLow.price, undercutIdx: event.undercutIdx, reclaimIdx: event.reclaimIdx });
}

// ---- registry ------------------------------------------------------------------

// Every family the app displays has a DEDICATED structural detector. There are no
// generic-template families left; a family that loses its detector must be moved to
// DISABLED_FAMILIES (displayed "not implemented"), never silently kept.
const FAMILY_DETECTORS = [
  { family: 'BULL_FLAG', label: 'Bull flag', direction: 'LONG', timeframes: ['20d', '60d', 'session'], minBars: 10, detect: detectFlag('LONG') },
  { family: 'BEAR_FLAG', label: 'Bear flag', direction: 'SHORT', timeframes: ['20d', '60d', 'session'], minBars: 10, detect: detectFlag('SHORT') },
  { family: 'VCP', label: 'Volatility contraction (VCP)', direction: 'LONG', timeframes: ['20d', '60d'], minBars: 15, detect: detectVCP },
  { family: 'FLAT_BASE', label: 'Flat base', direction: 'LONG', timeframes: ['20d', '60d'], minBars: 12, detect: detectFlatBase },
  { family: 'CUP_AND_HANDLE', label: 'Cup and handle', direction: 'LONG', timeframes: ['60d', '120d'], minBars: 30, detect: detectCupHandle },
  { family: 'DOUBLE_BOTTOM', label: 'Double bottom', direction: 'LONG', timeframes: ['20d', '60d'], minBars: 15, detect: detectDouble('LONG') },
  { family: 'DOUBLE_TOP', label: 'Double top', direction: 'SHORT', timeframes: ['20d', '60d'], minBars: 15, detect: detectDouble('SHORT') },
  { family: 'ASCENDING_TRIANGLE', label: 'Ascending triangle', direction: 'LONG', timeframes: ['20d', '60d'], minBars: 15, detect: detectTriangle('LONG') },
  { family: 'DESCENDING_TRIANGLE', label: 'Descending triangle', direction: 'SHORT', timeframes: ['20d', '60d'], minBars: 15, detect: detectTriangle('SHORT') },
  { family: 'FALLING_WEDGE', label: 'Falling wedge', direction: 'LONG', timeframes: ['20d', '60d'], minBars: 15, detect: detectWedge('LONG') },
  { family: 'RISING_WEDGE', label: 'Rising wedge (exhaustion)', direction: 'SHORT', timeframes: ['20d', '60d'], minBars: 15, detect: detectWedge('SHORT') },
  { family: 'BREAKOUT_RETEST', label: 'Breakout & retest', direction: 'LONG', timeframes: ['20d', '60d', 'session'], minBars: 12, detect: detectBreakoutRetest },
  { family: 'FAILED_BREAKOUT', label: 'Failed breakout', direction: 'SHORT', timeframes: ['20d', '60d', 'session'], minBars: 12, detect: detectFailedBreakout },
  { family: 'UNDERCUT_RECLAIM', label: 'Undercut & reclaim', direction: 'LONG', timeframes: ['20d', '60d', 'session'], minBars: 10, detect: detectUndercutReclaim },
];

// Families intentionally NOT implemented (none currently). Kept as the honest mechanism:
// a family listed here is labeled "not implemented" in the UI instead of borrowing a
// generic match.
const DISABLED_FAMILIES = [];

const argMax = (arr, f) => arr.reduce((bi, c, i) => (f(c) > f(arr[bi]) ? i : bi), 0);
const argMin = (arr, f) => arr.reduce((bi, c, i) => (f(c) < f(arr[bi]) ? i : bi), 0);

module.exports = { FAMILY_DETECTORS, DISABLED_FAMILIES, evalFeatures, MIN_VALIDITY, priorBreakout };
