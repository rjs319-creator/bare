// ADVERSARIAL FAILURE-PATTERN MODEL (spec §5)
//
// A SEPARATE model whose job is NOT to find winners but to flag when an otherwise-attractive
// setup is likely to FAIL. It must not be the winner score inverted — so it reads its OWN
// features (extension/climax/earnings-gap/illiquidity/failed-breakouts/breadth-divergence/…),
// produces a failure probability + expected failure mode + top drivers + a position-size
// multiplier, and — per §5 — stays in SHADOW until a validation proves that the names it
// REJECTS actually do worse out-of-sample. The live read is computed and surfaced honestly as
// "shadow — not affecting the rank"; only the validation harness (lib/failure-model-eval.js)
// can promote it, and on this app's no-durable-edge tape the honest default is that it stays
// shadow. Pure: a feature vector in → a failure assessment out. Two extractors share ONE
// scorer so the live read and the candle-reconstructed validation read can never diverge.

'use strict';

const FAILURE_MODEL_VERSION = 'failure-v1';

const FAILURE_MODES = {
  earningsGap: { label: 'Earnings gap', blurb: 'A binary print lands inside the hold window — a coin-flip gap the setup can’t control.' },
  chased: { label: 'Chased / mean-reversion', blurb: 'Extended far past a clean entry — buyers late, pullback risk high.' },
  blowoff: { label: 'Blow-off / exhaustion', blurb: 'A volume-climax spike that tends to mark the end of the move, not the start.' },
  illiquid: { label: 'Slippage / stop-run', blurb: 'Thin liquidity — the fill and the stop are both unreliable.' },
  sectorRollover: { label: 'Sector rolling over', blurb: 'The name’s sector is weakening — the tide is going out.' },
  breadthDivergence: { label: 'Breadth divergence', blurb: 'Price rising while market breadth deteriorates — a fragile advance.' },
  repeatedFailure: { label: 'Repeated failed breakouts', blurb: 'The level has rejected price before — supply overhead.' },
  choppy: { label: 'Chop, no follow-through', blurb: 'High volatility with little net drift — whipsaw territory.' },
  singleFactor: { label: 'Single-factor fragility', blurb: 'Several screeners agree but read the SAME factor — one confirmation, not many.' },
  weakClass: { label: 'Weak class record', blurb: 'This signal class has a below-market realized track record.' },
};

// The feature registry: weight (prior severity) + the failure mode it implies. Weights are
// honest v1 PRIORS (like Ghost's static pillars), not fitted — the validation decides whether
// they earn the right to bind. Sum > 1 so several co-firing features push toward the cap.
const FEATURES = [
  { key: 'earningsBinary', weight: 0.25, mode: 'earningsGap' },
  { key: 'extended', weight: 0.20, mode: 'chased' },
  { key: 'volClimax', weight: 0.15, mode: 'blowoff' },
  { key: 'failedBreakouts', weight: 0.13, mode: 'repeatedFailure' },
  { key: 'illiquid', weight: 0.12, mode: 'illiquid' },
  { key: 'breadthWeak', weight: 0.11, mode: 'breadthDivergence' },
  { key: 'sectorWeak', weight: 0.10, mode: 'sectorRollover' },
  { key: 'volWithoutPersistence', weight: 0.10, mode: 'choppy' },
  { key: 'poorTrack', weight: 0.10, mode: 'weakClass' },
  { key: 'singleFactor', weight: 0.08, mode: 'singleFactor' },
];

const CONFIG = {
  MAX_PROB: 0.95,   // never claim certainty of failure
  MIN_SIZE: 0.25,   // a rejected name is trimmed, not zeroed (it might still be a fine trade)
  ADJ_K: 0.5,       // how hard failure discounts the base score in the SHADOW adjusted-score view
  REJECT_AT: 0.5,   // failureProb ≥ this ⇒ "rejected" bucket (validation split)
  APPROVE_AT: 0.25, // failureProb ≤ this ⇒ "approved" bucket; between = near-threshold
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// The ONE scorer, over a feature vector {key: severity 0..1}. Shared by both extractors.
function scoreFeatures(fv, cfg = CONFIG) {
  let raw = 0;
  const contribs = [];
  for (const f of FEATURES) {
    const v = clamp01(fv[f.key]);
    if (v <= 0) continue;
    const contribution = f.weight * v;
    raw += contribution;
    contribs.push({ key: f.key, mode: f.mode, modeLabel: FAILURE_MODES[f.mode].label, severity: +v.toFixed(2), contribution: +contribution.toFixed(3) });
  }
  const failureProb = +Math.min(cfg.MAX_PROB, raw).toFixed(3);
  contribs.sort((a, b) => b.contribution - a.contribution);
  const drivers = contribs.slice(0, 3);
  const expectedMode = drivers.length ? drivers[0].mode : null;
  const sizeMult = +Math.max(cfg.MIN_SIZE, 1 - failureProb).toFixed(3);
  return { failureProb, drivers, expectedMode, expectedModeLabel: expectedMode ? FAILURE_MODES[expectedMode].label : null, sizeMult };
}

// ── Live extractor: failure features from an enriched signal (rankSignals output) ──────────
function featuresFromSignal(sig = {}, ctx = {}) {
  const re = sig.remainingEdge;
  const regime = ctx.regime || {};
  // Extension: chased past entry (in R) OR a large fraction of the advertised move already spent.
  const extFromR = re && re.rated && Number.isFinite(re.extensionR) ? clamp01((re.extensionR - 0.5) / 2) : (sig.state === 'extended' ? 1 : 0);
  const consumed = re && re.rated && Number.isFinite(re.consumedPct) ? clamp01((re.consumedPct - 50) / 50) : 0;
  const exq = sig.execution || {};
  return {
    earningsBinary: sig.event && sig.event.kind === 'binary' ? 1 : 0,
    extended: Math.max(extFromR, consumed),
    illiquid: Number.isFinite(exq.quality) ? clamp01(1 - exq.quality) : ((exq.penalties && exq.penalties.length) ? 0.5 : 0),
    sectorWeak: Number.isFinite(sig.sectorStrength) && sig.sectorStrength < 0 ? clamp01(-sig.sectorStrength) : 0,
    breadthWeak: regime.bearish === true ? 1 : (Number.isFinite(regime.breadthPct) && regime.breadthPct < 40 ? clamp01((40 - regime.breadthPct) / 40) : 0),
    singleFactor: sig.evidence && sig.evidence.singleFamily ? 1 : 0,
    poorTrack: Number.isFinite(sig.expectancyTilt) && sig.expectancyTilt < 1 ? clamp01((1 - sig.expectancyTilt) / 0.3) : 0,
    // Candle-only features — unavailable from the live signal alone, left 0 here.
    volClimax: 0, failedBreakouts: 0, volWithoutPersistence: 0,
  };
}

// The full live assessment: base (winner) score in, failure read + a SHADOW adjusted score out.
function assessSignal(sig = {}, ctx = {}, cfg = CONFIG) {
  const fv = featuresFromSignal(sig, ctx);
  const s = scoreFeatures(fv, cfg);
  const base = Number.isFinite(sig.score) ? sig.score : null;
  return {
    version: FAILURE_MODEL_VERSION, shadow: true,
    ...s, features: fv,
    baseScore: base,
    // Shadow-only: what the rank WOULD be if the failure read were applied. Not used to rank.
    adjustedScore: base != null ? +(base * (1 - s.failureProb * cfg.ADJ_K)).toFixed(1) : null,
    bucket: s.failureProb >= cfg.REJECT_AT ? 'rejected' : s.failureProb <= cfg.APPROVE_AT ? 'approved' : 'near-threshold',
  };
}

// ── Candle extractor: reconstruct the candle-derivable failure features POINT-IN-TIME at bar
// `idx`, so the validation can score historical picks with no look-ahead. earnings/singleFactor/
// poorTrack are not candle-derivable and stay 0 — the validation therefore tests the technical
// failure subset honestly (and labels it as such). ctx may carry {benchTrend, sectorTrend}.
function sma(candles, n, idx) {
  if (idx + 1 < n) return null;
  let s = 0; for (let k = idx - n + 1; k <= idx; k++) s += candles[k].close;
  return s / n;
}
function atr(candles, n, idx) {
  if (idx < n) return null;
  let s = 0;
  for (let k = idx - n + 1; k <= idx; k++) {
    const c = candles[k], p = candles[k - 1];
    const hi = c.high ?? c.close, lo = c.low ?? c.close;
    s += Math.max(hi - lo, Math.abs(hi - p.close), Math.abs(lo - p.close));
  }
  return s / n;
}
function featuresFromCandles(candles, idx, ctx = {}) {
  const fv = { earningsBinary: 0, extended: 0, volClimax: 0, failedBreakouts: 0, illiquid: 0, breadthWeak: 0, sectorWeak: 0, volWithoutPersistence: 0, poorTrack: 0, singleFactor: 0 };
  if (!Array.isArray(candles) || idx < 21 || idx >= candles.length) return fv;
  const c = candles[idx];
  const sma20 = sma(candles, 20, idx), a = atr(candles, 14, idx);
  // Extended: far above SMA20 in BOTH ATR terms AND percent terms — the MIN of the two, so a
  // low-vol drift that sits only a few % above its SMA isn't flagged "fully extended" just
  // because ATR is tiny (which would saturate on any smooth uptrend). A real parabola is far in
  // both. 3 ATR ≈ full on the volatility axis; 15% above SMA20 ≈ full on the percent axis.
  if (sma20 > 0 && a > 0 && c.close > sma20) {
    const atrSignal = (c.close - sma20) / (3 * a);
    const pctSignal = (c.close / sma20 - 1) / 0.15;
    fv.extended = clamp01(Math.min(atrSignal, pctSignal));
  }
  // Volume climax: today's volume vs the 20-bar average, gated on a large single-bar move.
  const vols = []; for (let k = idx - 19; k <= idx; k++) if (Number.isFinite(candles[k].volume)) vols.push(candles[k].volume);
  if (vols.length >= 10 && Number.isFinite(c.volume)) {
    const avgV = vols.reduce((s, v) => s + v, 0) / vols.length;
    const volRatio = avgV > 0 ? c.volume / avgV : 0;
    const barMove = a > 0 ? Math.abs((c.close - candles[idx - 1].close)) / a : 0;
    if (volRatio > 2 && barMove > 1.5) fv.volClimax = clamp01((volRatio - 2) / 3);
  }
  // Repeated failed breakouts: bars in the last 40 that poked above the trailing 20-bar high
  // but closed back below it (supply overhead rejecting price).
  let fails = 0;
  for (let k = Math.max(21, idx - 40); k <= idx; k++) {
    let priorHigh = -Infinity; for (let j = k - 20; j < k; j++) priorHigh = Math.max(priorHigh, candles[j].high ?? candles[j].close);
    const hi = candles[k].high ?? candles[k].close;
    if (hi > priorHigh && candles[k].close < priorHigh) fails++;
  }
  fv.failedBreakouts = clamp01(fails / 4);
  // Vol without persistence: high ATR but low net drift over 20 bars (chop/whipsaw).
  if (a > 0 && idx >= 20) {
    const net = Math.abs(c.close - candles[idx - 20].close);
    const persistence = net / (20 * a);
    const atrPct = a / c.close;
    if (atrPct > 0.02) fv.volWithoutPersistence = clamp01(1 - persistence * 2.5);
  }
  // Optional context trends (point-in-time), when the caller supplies them.
  if (Number.isFinite(ctx.sectorTrend) && ctx.sectorTrend < 0) fv.sectorWeak = clamp01(-ctx.sectorTrend);
  if (Number.isFinite(ctx.benchTrend) && ctx.benchTrend < 0) fv.breadthWeak = clamp01(-ctx.benchTrend);
  return fv;
}

module.exports = {
  FAILURE_MODEL_VERSION, FAILURE_MODES, FEATURES, CONFIG,
  scoreFeatures, featuresFromSignal, assessSignal, featuresFromCandles, sma, atr, clamp01,
};
