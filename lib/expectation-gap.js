'use strict';
// 🌡 EXPECTATION-GAP regime challenger (expgap-v1) — objective conditions vs what
// the market is PRICING, reduce-only by construction.
//
// The existing macro layer (lib/macro.js) answers "how stressed are conditions?".
// This challenger answers a different question: "is the market's PRICED expectation
// consistent with the objective read?" The dangerous state is COMPLACENCY —
// objectively deteriorating conditions (credit stress, rising realized vol, thin
// breadth) while implied vol and index price say calm. That gap, not the stress
// level itself, is the conservative early-reduce signal.
//
//   objectiveConditionScore   0-100, higher = objectively worse (credit stress,
//                             realized-vol percentile, breadth deterioration)
//   impliedStressScore        0-100, higher = market already pricing stress
//                             (VIX percentile, drawdown from highs)
//   expectationGap            objective − implied; large POSITIVE = complacency
//   variance risk premium     VIX − realized 21d vol: persistently NEGATIVE VRP
//                             (realized exceeding implied) is underpriced risk
//
// HARD CONSTRAINTS (Phase-8 contract, enforced structurally + by test):
//   • states are RISK_REDUCE / NEUTRAL / INSUFFICIENT_DATA — there is NO
//     RISK_ADD state; this module can never amplify exposure;
//   • recommendedMaxExposure ∈ [FLOOR_EXPOSURE, 1] — a multiplier ≤ 1, never > 1;
//   • transitionProbability is null-with-reason until prospective outcomes
//     support out-of-fold calibration — no hand-mapped probability;
//   • missing core inputs → INSUFFICIENT_DATA (fail closed, exposure untouched).
//
// Pure & deterministic: bars in, read out. `asOf` is an input, never a clock.

const { buildSeries, stateAt } = require('./macro');

const EXPGAP_VERSION = 'expgap-v1';

const STATES = Object.freeze(['RISK_REDUCE', 'NEUTRAL', 'INSUFFICIENT_DATA']);

const POLICY = Object.freeze({
  minBars: 120,             // aligned macro-series floor
  minEtfsForBreadth: 6,     // sector ETFs needed before breadth may be read
  gapReduceThreshold: 20,   // expectationGap points that flag complacency
  vrpZReduceThreshold: -1,  // robust-z of VRP at/below which risk is underpriced
  floorExposure: 0.4,       // reduce-only floor — never below, never above 1
  calibrationMinSamples: 200,
});

const isFin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => (isFin(v) ? +v.toFixed(2) : null);

const sliceAsOf = (candles, asOf) => (Array.isArray(candles) ? candles.filter(c => c && c.date <= asOf && isFin(c.close)) : []);

function dailyReturns(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) out.push(candles[i].close / candles[i - 1].close - 1);
  }
  return out;
}

// Annualized realized vol (%) of the trailing `n` daily returns.
function realizedVolAnn(candles, n = 21) {
  const rets = dailyReturns(candles).slice(-n);
  if (rets.length < Math.min(15, n)) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

function median(xs) {
  const v = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function pctileOf(arr, x) {
  const v = arr.filter(isFin);
  if (v.length < 10 || !isFin(x)) return null;
  return Math.round((v.filter(n => n <= x).length / v.length) * 100);
}

// Robust z of the latest variance-risk premium vs its own trailing distribution.
function vrpSeries(spyC, vixByDate) {
  const out = [];
  for (let i = 25; i < spyC.length; i++) {
    const rv = realizedVolAnn(spyC.slice(0, i + 1), 21);
    const vix = vixByDate.get(spyC[i].date);
    if (rv != null && isFin(vix)) out.push({ date: spyC[i].date, vrp: vix - rv });
  }
  return out;
}

/**
 * Compute the expectation-gap read as of `asOf`.
 *
 * @param spyBars / vixBars / hygBars / lqdBars   daily candles ({date, close})
 * @param sectorBarsByEtf  { XLK: candles[], ... } — breadth input (optional but
 *                         breadth is null below minEtfsForBreadth, disclosed)
 */
function computeExpectationGap({ spyBars = [], vixBars = [], hygBars = [], lqdBars = [], sectorBarsByEtf = {}, asOf = null } = {}) {
  const spy = sliceAsOf(spyBars, asOf);
  const vix = sliceAsOf(vixBars, asOf);
  const hyg = sliceAsOf(hygBars, asOf);
  const lqd = sliceAsOf(lqdBars, asOf);
  const missing = [];
  if (spy.length < POLICY.minBars) missing.push('spy-history');
  if (vix.length < POLICY.minBars) missing.push('vix-history');
  if (hyg.length < POLICY.minBars || lqd.length < POLICY.minBars) missing.push('credit-history');

  const base = {
    version: EXPGAP_VERSION, asOf,
    transitionProbability: null,
    transitionProbabilityReason: `uncalibrated — requires ${POLICY.calibrationMinSamples} matured prospective outcomes and out-of-fold calibration`,
    reduceOnly: true,
  };
  if (missing.length) {
    return Object.freeze({ ...base, state: 'INSUFFICIENT_DATA', missing, expectationGap: null, recommendedMaxExposure: 1, reasons: ['core inputs missing — exposure untouched (fail closed)'] });
  }

  // ── Objective condition inputs ────────────────────────────────────────────
  const series = buildSeries(vix, hyg, lqd);           // reuses macro.js alignment
  const macro = stateAt(series, series.length - 1);
  if (!macro) {
    return Object.freeze({ ...base, state: 'INSUFFICIENT_DATA', missing: ['macro-series'], expectationGap: null, recommendedMaxExposure: 1, reasons: ['macro series unalignable'] });
  }
  const rvNow = realizedVolAnn(spy, 21);
  const rvHist = [];
  for (let i = 60; i < spy.length; i += 5) {
    const rv = realizedVolAnn(spy.slice(0, i + 1), 21);
    if (rv != null) rvHist.push(rv);
  }
  const rvPctile = pctileOf(rvHist, rvNow);

  const etfs = Object.entries(sectorBarsByEtf).map(([etf, cs]) => ({ etf, cs: sliceAsOf(cs, asOf) })).filter(x => x.cs.length >= 60);
  let breadth = null;
  if (etfs.length >= POLICY.minEtfsForBreadth) {
    const above = etfs.filter(({ cs }) => {
      const last50 = cs.slice(-50).map(c => c.close);
      const sma = last50.reduce((a, b) => a + b, 0) / last50.length;
      return cs[cs.length - 1].close > sma;
    }).length;
    breadth = above / etfs.length;
  }

  // ── Market-implied inputs ─────────────────────────────────────────────────
  const high252 = Math.max(...spy.slice(-252).map(c => c.close));
  const drawdownPct = high252 > 0 ? (1 - spy[spy.length - 1].close / high252) * 100 : null;

  // ── VRP: is implied vol underpricing realized? ────────────────────────────
  const vixByDate = new Map(vix.map(c => [c.date, c.close]));
  const vrps = vrpSeries(spy, vixByDate);
  const vrpNow = vrps.length ? vrps[vrps.length - 1].vrp : null;
  let vrpZ = null;
  if (vrps.length >= 60 && vrpNow != null) {
    const hist = vrps.map(x => x.vrp);
    const med = median(hist);
    const mad = median(hist.map(x => Math.abs(x - med)));
    if (mad > 0) vrpZ = (vrpNow - med) / (1.4826 * mad);
  }

  // ── Scores + gap ──────────────────────────────────────────────────────────
  // Credit-stress subterm mirrors macro.js's ×2000 sub-SMA scaling exactly.
  const creditStress = macro.credit.belowSma ? clamp(((macro.credit.sma50 - macro.credit.ratio) / macro.credit.sma50) * 2000, 0, 100) : 0;
  const objective = round2(clamp(
    0.40 * creditStress +
    0.35 * (rvPctile == null ? 50 : rvPctile) +
    0.25 * (breadth == null ? 50 : (1 - breadth) * 100), 0, 100));
  const implied = round2(clamp(
    0.60 * macro.vix.pctile +
    0.40 * (drawdownPct == null ? 50 : clamp(drawdownPct * 10, 0, 100)), 0, 100));
  const expectationGap = round2(objective - implied);

  const uncertainty = round2(clamp(
    (breadth == null ? 0.25 : 0) + (rvPctile == null ? 0.25 : 0) + (vrpZ == null ? 0.25 : 0) + (drawdownPct == null ? 0.15 : 0), 0, 1));

  const reasons = [];
  const complacent = expectationGap >= POLICY.gapReduceThreshold;
  const vrpUnderpriced = vrpZ != null && vrpZ <= POLICY.vrpZReduceThreshold && macro.vix.pctile < 60;
  if (complacent) reasons.push(`objective conditions (${objective}) run ${expectationGap}pts worse than the market is pricing (${implied}) — complacency`);
  if (vrpUnderpriced) reasons.push(`realized vol is running above implied (VRP z ${round2(vrpZ)}) while VIX sits at the ${macro.vix.pctile}th pctile — risk underpriced`);
  if (macro.riskOff) reasons.push(`macro layer already risk-off (macroRisk ${macro.macroRisk}) — gap read is confirmatory, not additive`);

  const state = (complacent || vrpUnderpriced) ? 'RISK_REDUCE' : 'NEUTRAL';
  const recommendedMaxExposure = state === 'RISK_REDUCE'
    ? round2(clamp(1 - Math.max(expectationGap, 0) / 100 - (vrpUnderpriced ? 0.1 : 0), POLICY.floorExposure, 1))
    : 1;
  if (state === 'NEUTRAL') reasons.push('no complacency gap — this challenger only ever reduces, so NEUTRAL leaves exposure untouched');

  return Object.freeze({
    ...base,
    state,
    expectedCondition: { score: objective, creditStress: round2(macro.credit.trend20), realizedVolAnn: round2(rvNow), realizedVolPctile: rvPctile, breadth: breadth == null ? null : round2(breadth) },
    marketImplied: { score: implied, vix: macro.vix.level, vixPctile: macro.vix.pctile, drawdownFrom252dHighPct: round2(drawdownPct) },
    expectationGap,
    varianceRiskPremium: { now: round2(vrpNow), z: round2(vrpZ), samples: vrps.length },
    macro: { macroRisk: macro.macroRisk, regime: macro.regime },
    uncertainty,
    recommendedMaxExposure,
    reasons,
    missing: [],
  });
}

module.exports = { EXPGAP_VERSION, STATES, POLICY, computeExpectationGap, realizedVolAnn, vrpSeries };
