// ORBIT-ML feature layer (orbit-ml-features-v1).
//
// REUSES lib/orbit-features (the proven, leakage-guarded ORBIT snapshot: returns,
// residual momentum, demand pressure, latent drift, relative strength) and ADDS
// point-in-time-reconstructable SPECIALIST-EVIDENCE features that ORBIT deliberately
// excluded — turning the existing screeners' logic into continuous, market-neutral-
// friendly inputs for the cross-sectional ranker.
//
// Only candle-derivable specialist evidence is included, because that is what is
// cleanly PIT-reconstructable without a survivorship-biased scorer replay:
//   breakout status, distance-from-high/MA in ATR units, VCP/range compression,
//   volume dry-up, pocket-pivot, signal freshness, fraction-of-expected-move-consumed.
// Evidence that needs external PIT feeds (ghost insider, options flow, PEAD surprise,
// fundamentals) is NOT reconstructed here — it is flagged as unavailable rather than
// faked (see docs/orbit-ml-features.md). Every added feature is causal: it reads only
// bars ≤ asOfIdx, proven by test/orbit-ml-features.test.js.

const { orbitFeatures } = require('./orbit-features');
const { calcATR } = require('./signal');
const M = require('./orbit-math');

const ML_FEATURES_VERSION = 'orbit-ml-features-v1';

// Names of the specialist-evidence features this layer adds.
const ML_FEATURE_NAMES = Object.freeze([
  'distFrom52wHighAtr', 'distFromSma50Atr', 'distFromSma200Atr', 'breakout20', 'breakout50',
  'volDryUp', 'pocketPivot', 'rangeCompression', 'signalFreshness', 'fracMoveConsumed', 'relStrength63',
]);

function smaAt(closes, k, i) {
  if (i + 1 < k) return null;
  let s = 0; for (let j = i - k + 1; j <= i; j++) s += closes[j];
  return s / k;
}

// Compute specialist-evidence features as-of the last bar of `bars` (already sliced).
function specialistFeatures(bars, marketCloses) {
  const n = bars.length, i = n - 1;
  const closes = bars.map(c => c.close), vols = bars.map(c => c.volume || 0);
  const atr = calcATR(bars, 14)[i];
  const px = closes[i];
  const atrp = (atr && px > 0) ? atr : (px * 0.02);   // fallback ATR ~2%
  const f = {};

  // Distance from rolling high / SMAs in ATR units (volatility-normalised).
  const hi252 = Math.max(...closes.slice(Math.max(0, n - 252)));
  const sma50 = smaAt(closes, 50, i), sma200 = smaAt(closes, 200, i);
  f.distFrom52wHighAtr = +((px - hi252) / atrp).toFixed(3);
  f.distFromSma50Atr = sma50 != null ? +((px - sma50) / atrp).toFixed(3) : null;
  f.distFromSma200Atr = sma200 != null ? +((px - sma200) / atrp).toFixed(3) : null;

  // Breakout status: close above the prior 20/50-session high (excluding today).
  const priorHi = (k) => n > k ? Math.max(...closes.slice(n - 1 - k, n - 1)) : null;
  const h20 = priorHi(20), h50 = priorHi(50);
  f.breakout20 = h20 != null ? (px > h20 ? 1 : 0) : null;
  f.breakout50 = h50 != null ? (px > h50 ? 1 : 0) : null;

  // Volume dry-up: recent 5-session avg volume vs 50-session avg (VCP hallmark, <1 = drying).
  const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const v5 = avg(vols.slice(-5)), v50 = avg(vols.slice(-50));
  f.volDryUp = (v5 != null && v50 > 0) ? +(v5 / v50).toFixed(3) : null;

  // Pocket pivot: today up on volume greater than the largest down-day volume of the last 10.
  let maxDownVol = 0;
  for (let k = Math.max(1, n - 10); k < n; k++) if (closes[k] < closes[k - 1]) maxDownVol = Math.max(maxDownVol, vols[k]);
  f.pocketPivot = (closes[i] > closes[i - 1] && vols[i] > maxDownVol && maxDownVol > 0) ? 1 : 0;

  // Range compression: mean 5-session true-range vs mean 20-session (VCP tightening; <1 = tighter).
  const trOf = (k) => { const c = bars[k], pc = bars[k - 1]; return Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close)); };
  const trs = []; for (let k = Math.max(1, n - 20); k < n; k++) trs.push(trOf(k));
  const r5 = avg(trs.slice(-5)), r20 = avg(trs);
  f.rangeCompression = (r5 != null && r20 > 0) ? +(r5 / r20).toFixed(3) : null;

  // Signal freshness: sessions since the last 252-session closing high (0 = new high today).
  let fresh = null; for (let k = i; k >= Math.max(0, n - 252); k--) { if (closes[k] >= hi252 * 0.999) { fresh = i - k; break; } }
  f.signalFreshness = fresh;

  // Fraction of the expected move already consumed: 21-session move vs an ATR·√21 scale.
  const px21 = closes[Math.max(0, i - 21)];
  const move21 = px21 > 0 ? (px - px21) / px21 : 0;
  const expMove = (atrp / px) * Math.sqrt(21);
  f.fracMoveConsumed = expMove > 0 ? +M.clamp(move21 / expMove, -3, 3).toFixed(3) : null;

  // Relative strength vs market over 63 sessions (RS-line style).
  if (marketCloses && marketCloses[i] != null && marketCloses[Math.max(0, i - 63)] != null) {
    const mkt0 = marketCloses[Math.max(0, i - 63)], mkt1 = marketCloses[i];
    const stk = px21 && closes[Math.max(0, i - 63)] > 0 ? px / closes[Math.max(0, i - 63)] : null;
    f.relStrength63 = (stk != null && mkt0 > 0) ? +(stk - mkt1 / mkt0).toFixed(4) : null;
  } else f.relStrength63 = null;

  return f;
}

// Build the ORBIT-ML feature snapshot: the reused ORBIT snapshot + specialist evidence.
function orbitMlFeatures(candles, factorCloses = {}, opts = {}) {
  const asOfIdx = opts.asOfIdx == null ? candles.length - 1 : opts.asOfIdx;
  if (asOfIdx < 0 || asOfIdx >= candles.length) return null;
  const base = orbitFeatures(candles, factorCloses, opts);
  if (!base) return null;
  const bars = candles.slice(0, asOfIdx + 1);
  const mkt = Array.isArray(factorCloses.marketCloses) ? factorCloses.marketCloses.slice(0, asOfIdx + 1) : null;
  const spec = specialistFeatures(bars, mkt);
  return {
    ...base,
    version: ML_FEATURES_VERSION,
    baseVersion: base.version,
    features: { ...base.features, ...spec },
    mlFeatureNames: ML_FEATURE_NAMES,
    // Specialist evidence needing external PIT feeds is not reconstructed here.
    unavailableEvidence: ['ghostInsider', 'optionsFlow', 'peadSurprise', 'fundamentals'],
  };
}

module.exports = { ML_FEATURES_VERSION, ML_FEATURE_NAMES, orbitMlFeatures, specialistFeatures };
