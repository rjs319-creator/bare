'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — scoring and ranking. PURE, deterministic.
//
// Three inspectable scores (0-100): Persistent Trend Score, Relative
// Leadership Score, Combined Evidence Score — plus independent penalties and
// a data-support grade. These are EVIDENCE scores, not probabilities: every
// probability-shaped output is stamped BASELINE_UNCALIBRATED and must never
// be displayed as a percentage (prediction-contract discipline). Correlated
// price signals are one evidence domain — component contributions are exposed
// so nothing here can masquerade as multiple independent confirmations.
// ═══════════════════════════════════════════════════════════════════════════

const { SCORE_WEIGHTS, PENALTIES, EXTENSION, VERSIONS } = require('./config');

const isNum = (x) => Number.isFinite(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Linear squash of x from [lo,hi] onto [0,1]. */
const squash = (x, lo, hi) => (isNum(x) ? clamp01((x - lo) / (hi - lo)) : null);

/** Weighted mean over possibly-null components; renormalizes over available. */
function weightedScore(components, weights) {
  let num = 0, den = 0;
  const contributions = {};
  for (const [k, w] of Object.entries(weights)) {
    const v = components[k];
    if (isNum(v)) { num += w * v; den += w; contributions[k] = { value: v, weight: w }; }
    else contributions[k] = { value: null, weight: w };
  }
  return { score: den > 0 ? num / den : null, coverage: den, contributions };
}

// ── Persistent Trend Score ──────────────────────────────────────────────────

function persistentTrendScore({ trend, absContinuity, participation }) {
  const bh = trend.byHorizon || {};
  const vols = [21, 63, 126].map((h) => bh[h]).filter((f) => f && f.available);
  const volAdj = vols.length
    ? vols.map((f) => squash(f.volAdjReturn, -0.5, 2.5)).filter(isNum).reduce((s, x, _, a) => s + x / a.length, 0)
    : null;
  const agree = trend.agreement?.available ? trend.agreement.score : null;
  const disc = absContinuity?.discreteness;
  const eff = absContinuity?.efficiency;
  const conc = absContinuity?.concentration;
  const fit = absContinuity?.fit;
  const continuity = [
    disc?.available ? disc.continuity : null,
    eff?.available ? eff.upsideEfficiency : null,
    conc?.available ? 1 - clamp01(conc.top3Share) : null,
  ].filter(isNum);
  const sma = trend.sma || {};
  const struct = trend.structure?.available
    ? 0.5 * trend.structure.higherHighPct + 0.5 * trend.structure.higherLowPct
    : null;
  const structure = [
    struct,
    isNum(sma.alignScore) ? sma.alignScore : null,
    isNum(sma.pctAboveRising20) ? sma.pctAboveRising20 : null,
  ].filter(isNum);

  const components = {
    multiHorizonTrend: volAdj != null || agree != null
      ? 0.6 * (volAdj ?? agree) + 0.4 * (agree ?? volAdj) : null,
    continuity: continuity.length ? continuity.reduce((s, x) => s + x, 0) / continuity.length : null,
    robustFit: fit?.available ? clamp01(0.6 * (fit.olsR2 ?? 0) + 0.4 * (fit.pctNearTrend ?? 0)) : null,
    structure: structure.length ? structure.reduce((s, x) => s + x, 0) / structure.length : null,
    participation: isNum(participation) ? participation : null,
  };
  const w = weightedScore(components, SCORE_WEIGHTS.persistentTrend);
  return { score: w.score != null ? Math.round(w.score * 100) : null, contributions: w.contributions, coverage: w.coverage };
}

// ── Relative Leadership Score ───────────────────────────────────────────────

function relativeLeadershipScore({ residual }) {
  const bh = residual.byHorizon || {};
  const res = (h) => bh[h]?.residual;
  const scaleFor = (h) => 0.06 * Math.sqrt(h / 21);      // residual band per horizon
  const trendOf = (hs) => {
    const vals = hs.map((h) => (isNum(res(h)) ? squash(res(h), -scaleFor(h), scaleFor(h) * 1.5) : null)).filter(isNum);
    return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
  };
  const secRel = [21, 63].map((h) => bh[h]?.sectorRel).filter(isNum);
  const rc = residual.continuity63 || residual.continuity21 || {};
  const contVals = [
    rc.discreteness?.available ? rc.discreteness.continuity : null,
    rc.efficiency?.available ? rc.efficiency.upsideEfficiency : null,
    rc.fit?.available ? clamp01(rc.fit.olsR2 ?? 0) : null,
  ].filter(isNum);
  const horizons = [5, 10, 21, 63, 126].map(res).filter(isNum);
  const posFrac = horizons.length ? horizons.filter((x) => x > 0).length / horizons.length : null;

  const components = {
    marketResidualTrend: trendOf([21, 63]),
    sectorResidualTrend: secRel.length
      ? secRel.map((v, i) => squash(v, -scaleFor([21, 63][i]), scaleFor([21, 63][i]) * 1.5)).reduce((s, x) => s + x, 0) / secRel.length
      : null,
    residualContinuity: contVals.length ? contVals.reduce((s, x) => s + x, 0) / contVals.length : null,
    horizonAgreement: posFrac,
    residualAcceleration: squash(residual.residualAccel, -0.004, 0.004),
  };
  const w = weightedScore(components, SCORE_WEIGHTS.relativeLeadership);
  return {
    score: w.score != null ? Math.round(w.score * 100) : null,
    contributions: w.contributions,
    coverage: w.coverage,
    sectorDataMissing: components.sectorResidualTrend == null,
  };
}

// ── Penalties (independent, reason-coded) ───────────────────────────────────

function computePenalties({ absPath, residual, extensionAtr, maxDrawdown63, participation, gapDependence }) {
  const items = [];
  const add = (code, points, detail) => items.push({ code, points: Math.round(points), detail });

  if (absPath?.state === 'JUMP_PLATEAU') {
    const sev = clamp01((absPath.jump?.top1Share ?? 0.5) / 0.8);
    add('JUMP_PLATEAU', PENALTIES.jumpPlateau * Math.max(0.5, sev), 'one-day repricing with flat aftermath');
  }
  if (isNum(extensionAtr) && extensionAtr > EXTENSION.warnAtr) {
    const sev = clamp01((extensionAtr - EXTENSION.warnAtr) / (EXTENSION.maxAtr - EXTENSION.warnAtr));
    add('EXCESSIVE_EXTENSION', PENALTIES.excessiveExtension * sev, `${extensionAtr.toFixed(1)} ATR above SMA20`);
  }
  if (isNum(residual?.residualAccel) && residual.residualAccel < -0.001) {
    const sev = clamp01(-residual.residualAccel / 0.005);
    add('DETERIORATING_RESIDUAL', PENALTIES.deterioratingResidual * sev, 'stock-specific relative trend weakening');
  }
  if (isNum(gapDependence) && gapDependence > 0.5) {
    add('GAP_DEPENDENCE', PENALTIES.gapDependence * clamp01((gapDependence - 0.5) / 0.4), 'move driven by overnight gaps');
  }
  if (isNum(maxDrawdown63) && maxDrawdown63 < -0.15) {
    add('ADVERSE_EXCURSION', PENALTIES.adverseExcursion * clamp01((-maxDrawdown63 - 0.15) / 0.2), 'large drawdown inside the window');
  }
  if (isNum(participation) && participation < 0.35) {
    add('WEAK_PARTICIPATION', PENALTIES.weakParticipation * clamp01((0.35 - participation) / 0.35), 'volume does not confirm');
  }
  return items;
}

// ── Support grade ───────────────────────────────────────────────────────────

function supportGrade({ bars, residual, sectorAvailable, stale }) {
  if (stale) return { grade: 'STALE', abstain: true, reasons: ['DATA_STALE'] };
  const reasons = [];
  let grade = 'FULL';
  if ((bars?.length ?? 0) < 253) { grade = 'REDUCED'; reasons.push('UNDER_252_SESSIONS'); }
  if (!sectorAvailable) { grade = grade === 'FULL' ? 'REDUCED' : grade; reasons.push('SECTOR_DATA_MISSING'); }
  if (!residual?.supported) { grade = 'LOW'; reasons.push('BETA_MODEL_LOW_SUPPORT'); }
  if ((bars?.length ?? 0) < 130) return { grade: 'UNAVAILABLE', abstain: true, reasons: [...reasons, 'INSUFFICIENT_HISTORY'] };
  return { grade, abstain: false, reasons };
}

// ── Combined evidence + baseline utility + rank key ─────────────────────────

/**
 * Baseline expected-utility tilt per horizon. UNCALIBRATED by construction:
 * numbers exist only so the ranking has an economics-aware axis; every field
 * carries calibrationStatus 'uncalibrated' + basis BASELINE_UNCALIBRATED and
 * must be displayed as an evidence band, never a percentage.
 */
function baselineUtility({ combined, atrPct, dollarVol, horizon }) {
  if (!isNum(combined) || !isNum(atrPct)) return { available: false, basis: 'BASELINE_UNCALIBRATED' };
  const tilt = (combined - 50) / 50;                       // −1..1 evidence tilt
  const expMove = atrPct * Math.sqrt(horizon) * 1.6;       // ATR-scaled envelope
  const costPct = (dollarVol >= 10e6 ? 0.0025 : 0.006);    // omega cost proxy
  const eu = tilt * expMove - costPct;
  return {
    available: true,
    basis: 'BASELINE_UNCALIBRATED',
    calibrationStatus: 'uncalibrated',
    horizon,
    utility: eu,
    expectedMoveEnvelope: expMove,
    costPct,
  };
}

function combineScores({ pts, rls, setupQuality, penalties, supportHaircut }) {
  const w = weightedScore(
    { persistentTrend: pts.score != null ? pts.score / 100 : null,
      relativeLeadership: rls.score != null ? rls.score / 100 : null,
      setupQuality: isNum(setupQuality) ? setupQuality : null },
    SCORE_WEIGHTS.combined,
  );
  if (w.score == null) return { combined: null, afterPenalties: null, contributions: w.contributions };
  let combined = Math.round(w.score * 100);
  const penaltyPts = penalties.reduce((s, p) => s + p.points, 0);
  let after = Math.max(0, combined - penaltyPts);
  if (isNum(supportHaircut) && supportHaircut < 1) after = Math.round(after * supportHaircut);
  return { combined, afterPenalties: after, penaltyPoints: penaltyPts, contributions: w.contributions };
}

/** Deterministic ranking: evidence desc → liquidity desc → ticker asc. */
function rankCards(cards) {
  const key = (c) => [
    c.disqualified ? 1 : 0,
    -(c.scores?.rankScore ?? -1),
    -(c.liquidity?.dollarVol ?? 0),
    c.ticker,
  ];
  const sorted = [...cards].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return sorted.map((c, i) => ({ ...c, rank: i + 1 }));
}

module.exports = {
  VERSION: VERSIONS.score,
  persistentTrendScore, relativeLeadershipScore, computePenalties,
  supportGrade, baselineUtility, combineScores, rankCards, squash, weightedScore,
};
