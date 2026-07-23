'use strict';
// ATLAS-X — point-in-time state-transition detector.
//
// PURE, DETERMINISTIC, cold-start aware. Answers ATLAS-X's first question: "Is
// this stock undergoing a GENUINE state transition?" — not "is it a buy". It reads
// only bars dated <= asOf and returns bounded transition SCORES (0..1). They are
// scores, not calibrated probabilities: with thin history every score is shrunk
// toward the neutral band so a 12-bar name can never emit a confident transition.
//
// A deterministic multi-window change detector is the shipped baseline. A Bayesian
// online change-point challenger is left as a documented research interface
// (see researchInterface()) — we do NOT fake Bayesian posteriors.

const { VERSIONS } = require('./atlasx-config');
const { toBars, asOfSlice } = require('./atlasx-residual');

const MIN_BARS = 8;         // below this: fail safe, everything neutral/coldStart
const FULL_CONF_BARS = 40;  // at/above this: no cold-start shrink
const COMPRESSION_LOOKBACK = 60;

const TRANSITIONS = Object.freeze([
  'compressionToExpansion',
  'accumulationToDemand',
  'neutralToPositiveResidual',
  'momentumAcceleration',
  'firstPullback',
  'breakoutAcceptance',
  'breakoutRejection',
  'distributionOnset',
  'exhaustion',
  'capitulationReversal',
  'sectorRotation',
]);

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const sig = x => 1 / (1 + Math.exp(-x));

function trueRange(b, prev) {
  const hl = b.h - b.l;
  const hc = prev ? Math.abs(b.h - prev.c) : hl;
  const lc = prev ? Math.abs(b.l - prev.c) : hl;
  return Math.max(hl, hc, lc);
}

function atr(bars, win = 14) {
  if (bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) trs.push(trueRange(bars[i], bars[i - 1]));
  const use = trs.slice(-win);
  if (!use.length) return null;
  return use.reduce((s, v) => s + v, 0) / use.length;
}

// Fraction of `arr` <= v (an empirical percentile of v within arr).
function fracLE(v, arr) {
  if (!arr.length) return 0.5;
  let below = 0;
  for (const x of arr) if (x <= v) below++;
  return below / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function closeLoc(b) {
  const rng = b.h - b.l;
  if (!(rng > 0)) return 0.5;
  return clamp01((b.c - b.l) / rng);
}

function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

/**
 * Detect state transitions as of a date.
 * @param {object} p {candles, spy?, sector?, residual?, asOf?}
 * @returns {object} frozen assessment
 */
function detectTransition({ candles, residual = null, asOf } = {}) {
  const bars = asOfSlice(toBars(candles), asOf);
  const asOfDate = asOf || (bars.length ? bars[bars.length - 1].date : null);

  if (bars.length < MIN_BARS) {
    return freeze(asOfDate, neutralScores(), 'INSUFFICIENT_DATA', true, false, {});
  }

  const coldStart = bars.length < FULL_CONF_BARS;
  const conf = coldStart ? clamp01((bars.length - MIN_BARS) / (FULL_CONF_BARS - MIN_BARS)) : 1;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // ── raw dynamics (all PIT) ──────────────────────────────────────────────
  const N = bars.length;
  const brk = 3;               // "break" window (most recent bars)
  const baseLo = Math.max(0, N - 35); // baseline window start
  const atrPctSeries = bars.map((b, i) => {
    if (i < 1) return 0;
    const a = atr(bars.slice(0, i + 1), 14);
    return a && b.c > 0 ? a / b.c : 0;
  });

  // Expansion is a FRESH break: the last few bars' range vs the base BEFORE them,
  // so a name that just started expanding scores high while one ramping uniformly
  // (or one statically tight) does not.
  const ranges = bars.map(b => b.h - b.l);
  const baseRanges = ranges.slice(baseLo, N - brk);
  const recentRanges = ranges.slice(-brk);
  const baselineRange = avg(baseRanges) || avg(ranges) || 1;
  const recentRange = avg(recentRanges) || baselineRange;
  const expansionNow = baselineRange > 0 ? recentRange / baselineRange : 1;

  const vols = bars.map(b => b.v);
  const baseVol = avg(vols.slice(baseLo, N - brk)) || avg(vols) || 1;
  const recentVol = avg(vols.slice(-brk)) || baseVol;
  const volAccel = baseVol > 0 ? recentVol / baseVol : 1;

  // Was the base TIGHT relative to the name's own ATR history (compressed)?
  const atrPctAll = atrPctSeries.filter(x => x > 0);
  const baseAtrPctVals = atrPctSeries.slice(baseLo, N - brk).filter(x => x > 0);
  const baseAtrPct = baseAtrPctVals.length ? median(baseAtrPctVals)
    : (atrPctAll.length ? median(atrPctAll) : 0);
  const wasCompressed = atrPctAll.length ? 1 - fracLE(baseAtrPct, atrPctAll) : 0.5;
  const compressionPct = atrPctAll.length ? fracLE(atrPctSeries[N - 1] || baseAtrPct, atrPctAll) : null;

  const rets = [];
  for (let i = 1; i < bars.length; i++) rets.push(bars[i].c / bars[i - 1].c - 1);
  const ret5 = pctRet(bars, 5), ret10 = pctRet(bars, 10), ret20 = pctRet(bars, 20);

  const resid10 = residual && residual.byHorizon && residual.byHorizon[10] ? residual.byHorizon[10].residual : null;
  const resid5 = residual && residual.byHorizon && residual.byHorizon[5] ? residual.byHorizon[5].residual : null;
  const residAccel = residual ? residual.residualAccel : null;

  const clocRecent = avg(bars.slice(-5).map(closeLoc));
  const priorHigh = Math.max(...bars.slice(-22, -2).map(b => b.h));
  const brokeOut = last.c > priorHigh;
  const tagged = last.h >= priorHigh;
  const upperWick = last.h > last.c ? (last.h - last.c) / (last.h - last.l || 1) : 0;

  // higher-lows over last ~6 swing lows (controlled uptrend structure)
  const lows = bars.slice(-8).map(b => b.l);
  let higherLows = 0;
  for (let i = 1; i < lows.length; i++) if (lows[i] >= lows[i - 1]) higherLows++;
  const higherLowFrac = lows.length > 1 ? higherLows / (lows.length - 1) : 0;

  // accumulation / distribution proxy (money-flow direction over last 10)
  const ad = avg(bars.slice(-10).map(b => (closeLoc(b) - 0.5) * 2 * (b.v / (baseVol || 1))));

  // pullback depth from recent high
  const recentHigh = Math.max(...bars.slice(-10).map(b => b.h));
  const pullbackDepth = recentHigh > 0 ? (recentHigh - last.c) / recentHigh : 0;
  const sellVol = avg(bars.slice(-3).filter(b => b.c < b.o).map(b => b.v / (baseVol || 1)));

  // downside climax / capitulation
  const downMove = ret5 != null ? -ret5 : 0;

  // ── transition scores (bounded, shrunk by confidence) ───────────────────
  const s = {};
  s.compressionToExpansion = shrink(conf,
    clamp01(wasCompressed) * sig(2.2 * (expansionNow - 1.4)) * sig(2 * (volAccel - 1.2)));

  s.accumulationToDemand = shrink(conf,
    sig(1.5 * ad) * sig(2 * (volAccel - 1.1)) * sig(3 * ((ret5 || 0))));

  s.neutralToPositiveResidual = shrink(conf, residCross(resid5, resid10));

  s.momentumAcceleration = shrink(conf,
    sig(3 * (ret5 || 0)) * (residAccel != null ? sig(60 * residAccel) : sig(2 * ((ret5 || 0) - (ret20 || 0) / 4))));

  s.firstPullback = shrink(conf,
    sig(4 * (ret20 || 0)) * clamp01(higherLowFrac) *
    bell(pullbackDepth, 0.05, 0.05) * sig(2 * (1.1 - (sellVol || 1))) * clamp01(clocRecent + 0.1));

  s.breakoutAcceptance = shrink(conf,
    (brokeOut ? 1 : 0) * sig(2 * (volAccel - 1.1)) * clamp01(closeLoc(last)) * sig(2 * (1 - upperWick * 2)));

  s.breakoutRejection = shrink(conf,
    (tagged ? 1 : 0) * sig(3 * (upperWick - 0.4)) * sig(2 * (0.9 - expansionNowClose(last))) *
    (last.c < priorHigh ? 1 : 0.5));

  s.distributionOnset = shrink(conf,
    sig(2 * (volAccel - 1.2)) * sig(3 * (-(ad))) * sig(2 * (0.45 - clocRecent)));

  s.exhaustion = shrink(conf,
    sig(3 * ((ret20 || 0) - 0.15)) * sig(2 * (volAccel - 1.4)) * sig(3 * (upperWick - 0.35)));

  s.capitulationReversal = shrink(conf,
    sig(4 * (downMove - 0.08)) * sig(2 * (volAccel - 1.3)) * clamp01(closeLoc(last)) *
    (last.c > prev.c ? 1 : 0.3));

  // sector rotation needs residual sector context; without it, low + flagged
  s.sectorRotation = shrink(conf, resid10 != null ? sig(50 * resid10) * 0.6 : 0.1);

  for (const t of TRANSITIONS) s[t] = round4(clamp01(s[t] || 0));

  let dominant = { type: null, score: 0 };
  for (const t of TRANSITIONS) if (s[t] > dominant.score) dominant = { type: t, score: s[t] };

  return freeze(asOfDate, s, dominant.type, coldStart, true, {
    dominant,
    features: Object.freeze({
      compressionPct, wasCompressed: round4(wasCompressed), expansionNow: round4(expansionNow),
      volAccel: round4(volAccel), ret5, ret10, ret20, resid5, resid10, residAccel,
      closeLocRecent: round4(clocRecent), brokeOut, tagged, upperWick: round4(upperWick),
      higherLowFrac: round4(higherLowFrac), ad: round4(ad), pullbackDepth: round4(pullbackDepth),
    }),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────
function pctRet(bars, h) {
  if (bars.length < h + 1) return null;
  const now = bars[bars.length - 1].c, then = bars[bars.length - 1 - h].c;
  return then > 0 ? now / then - 1 : null;
}
function residCross(short, long) {
  if (short == null || long == null) return 0.15; // unknown residual → low, not zero
  // neutral-or-negative longer residual turning positive on the short window
  if (long <= 0.005 && short > 0.005) return clamp01(sig(120 * short));
  if (short > 0 && short > long) return clamp01(0.4 * sig(120 * short));
  return 0.1;
}
function bell(x, center, width) {
  const z = (x - center) / (width || 1e-6);
  return Math.exp(-0.5 * z * z);
}
function expansionNowClose(b) {
  const rng = b.h - b.l;
  return rng > 0 ? (b.c - b.o) / rng : 0; // >0 up close, <0 down close within range
}
function shrink(conf, score) {
  // pull toward the neutral band (0) proportional to lack of confidence, so thin
  // data never yields an extreme transition score.
  return clamp01(score) * (0.3 + 0.7 * conf);
}
const round4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);

function neutralScores() {
  const o = {};
  for (const t of TRANSITIONS) o[t] = 0;
  return o;
}

function freeze(asOf, scores, dominantType, coldStart, dataOk, extra) {
  return Object.freeze({
    version: VERSIONS.transition,
    asOf,
    dataOk,
    coldStart,
    scores: Object.freeze(scores),
    dominantTransition: dominantType,
    ...extra,
  });
}

// Documented research interface for the Bayesian online change-point challenger.
// Intentionally returns a not-implemented marker rather than fabricated posteriors.
function researchInterface() {
  return Object.freeze({
    method: 'bayesian-online-changepoint',
    status: 'research-only',
    implemented: false,
    note: 'Deterministic multi-window detector is the shipped baseline. A BOCPD ' +
      'challenger requires a run-length posterior; it will be added as a shadow ' +
      'research module and must beat the deterministic detector out-of-sample ' +
      'before it can affect any score. No fabricated posteriors are emitted.',
  });
}

module.exports = { detectTransition, TRANSITIONS, researchInterface, atr, closeLoc };
