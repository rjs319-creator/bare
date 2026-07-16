// OMEGA-SWING — 5–10 DAY MOMENTUM CONTINUATION ENGINE (pure core)
//
// Purpose: surface liquid US names that have ALREADY started moving but still have a high
// probability of CONTINUING higher over the next 5–10 trading days. Not long-term investing,
// not intraday scalping, not a raw breakout screen, and explicitly NOT a buyer of stocks
// that have already gone vertical. It looks for sustainable early-to-middle-stage momentum
// with good entry location and controlled downside.
//
// This file is PURE and unit-testable: daily candles (+ optional SPY/sector benchmark
// candles, catalyst tag, regime) in → features, momentum-stage, setups, exhaustion penalties,
// a 0–100 score, an expected-utility rank, tier, entry-timing plan, and risk/invalidation
// out. No network, no clock, no mutation. Missing data yields `null`, never a fabricated
// number — matching the app's honesty premise.
//
// HONESTY WALL (inherited from the whole app's multi-session research): on this EOD / free
// data there is no durable regime-robust selection edge; the ONE validated lever is regime
// avoidance (stand down in risk-off). So OMEGA-SWING's interpretable score is a disciplined
// RANKING + entry-quality layer, its probabilities are a transparent baseline, and the live
// point-in-time ledger + purged walk-forward (omega-swing-routes) are what decide whether it
// actually predicts anything. Nothing here claims an edge the frozen validation hasn't shown.

'use strict';

const L = require('./evolve-labels');     // sliceForward / benchmarkReturn (point-in-time correct)
const { tradeLevels, atrOf } = require('./levels');

const OMEGA_VERSION = 'omega-swing-v1';

// The two continuation horizons this engine optimizes. Terminal (not triple-barrier) residual
// return is the PRIMARY label — sector- and market-relative, per the spec.
const OMEGA_HORIZONS = { h5: 5, h10: 10 };
const TARGET_3PCT = 0.03, TARGET_5PCT = 0.05;   // "gain ≥3% / ≥5% within 10 trading days"

// ── small numeric helpers ─────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const last = (a) => (a.length ? a[a.length - 1] : null);
const finite = (x) => Number.isFinite(x);
const pctRet = (a, b) => (finite(a) && finite(b) && b > 0 ? a / b - 1 : null);

// Ordinary-least-squares slope of y on x=0..n-1, normalized by the mean level (→ %/bar), plus
// the fit's R² (how cleanly the trend explains the path). Returns {slope, r2} or nulls.
function trendFit(vals) {
  const n = vals.length;
  if (n < 3) return { slope: null, r2: null };
  const xs = vals.map((_, i) => i);
  const mx = mean(xs), my = mean(vals);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = vals[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0) return { slope: null, r2: null };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : clamp01((sxy * sxy) / (sxx * syy));
  return { slope: my !== 0 ? slope / Math.abs(my) : null, r2: +r2.toFixed(3) };
}

// ── FEATURE EXTRACTION (§2) ────────────────────────────────────────────────────────────
// candles: daily OHLCV oldest→newest. bench: { spy: candles[], sector: candles[] } (optional).
// Returns a flat, inspectable feature object, or null when there isn't enough history.
function computeFeatures(candles, bench = {}) {
  const c = (candles || []).filter(x => x && finite(x.close) && finite(x.volume));
  const n = c.length;
  if (n < 55) return null;                       // need ~50d MA + lookback → honest floor
  const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low), vols = c.map(x => x.volume);
  const px = last(closes);

  const ret = [];
  for (let i = 1; i < n; i++) ret.push(closes[i] / closes[i - 1] - 1);

  // Price momentum over standard lookbacks.
  const rN = (k) => pctRet(px, closes[n - 1 - k]);
  const r1 = rN(1), r3 = rN(3), r5 = rN(5), r10 = rN(10), r20 = rN(20);
  const prevR5 = pctRet(closes[n - 6], closes[n - 11]);     // the 5d return of the prior week
  const accel = (finite(r5) && finite(prevR5)) ? r5 - prevR5 : null;   // return acceleration
  const slope5 = trendFit(closes.slice(-5)).slope, slope10 = trendFit(closes.slice(-10)).slope;
  const slope20 = trendFit(closes.slice(-20)).slope;

  // Moving averages + alignment + extension.
  const sma = (k) => mean(closes.slice(-k));
  const sma5 = sma(5), sma10 = sma(10), sma20 = sma(20), sma50 = sma(50);
  const pAbove = (m) => (m > 0 ? px / m - 1 : null);
  const maAligned = (sma5 > sma10 && sma10 > sma20 && sma20 > sma50);       // clean fan
  const maAlignScore = clamp01(((sma5 > sma10) + (sma10 > sma20) + (sma20 > sma50)) / 3);
  const high20 = Math.max(...highs.slice(-20)), high52 = Math.max(...highs.slice(-Math.min(252, n)));
  const distFrom20High = high20 > 0 ? px / high20 - 1 : null;               // ≤0, 0 = at highs
  const distFrom52High = high52 > 0 ? px / high52 - 1 : null;

  // Close quality: fraction of up closes, avg close-location value, close strength.
  const up10 = mean(ret.slice(-10).map(r => (r > 0 ? 1 : 0)));
  const clv = mean(c.slice(-10).map(x => { const rng = x.high - x.low; return rng > 0 ? ((x.close - x.low) - (x.high - x.close)) / rng : 0; }));
  const closeStrength = mean(c.slice(-5).map(x => { const rng = x.high - x.low; return rng > 0 ? (x.close - x.low) / rng : 0.5; }));

  // Relative strength vs SPY and sector ETF (excess return over benchmark, multiple windows).
  const rel = (benchC, k) => {
    if (!benchC || benchC.length < k + 1) return null;
    const bpx = last(benchC.map(x => x.close));
    const bprev = benchC[benchC.length - 1 - k] && benchC[benchC.length - 1 - k].close;
    const br = pctRet(bpx, bprev), sr = rN(k);
    return (finite(br) && finite(sr)) ? +(sr - br).toFixed(4) : null;
  };
  const rsSpy3 = rel(bench.spy, 3), rsSpy5 = rel(bench.spy, 5), rsSpy10 = rel(bench.spy, 10), rsSpy20 = rel(bench.spy, 20);
  const rsSec5 = rel(bench.sector, 5), rsSec10 = rel(bench.sector, 10);
  const rsSpyAccel = (finite(rsSpy5) && finite(rsSpy10)) ? +(rsSpy5 - rsSpy10 / 2).toFixed(4) : null;   // near vs far RS

  // Volume confirmation (§2 volume) — reward MULTI-DAY participation, penalize 1-day spikes.
  const relVol1 = vols[n - 1] / (mean(vols.slice(-21, -1)) || 1);
  const relVol3 = mean(vols.slice(-3)) / (mean(vols.slice(-23, -3)) || 1);
  const relVol5 = mean(vols.slice(-5)) / (mean(vols.slice(-25, -5)) || 1);
  const upVol = mean(c.slice(-10).filter((_, i, a) => i > 0 && a[i].close >= a[i - 1].close).map(x => x.volume));
  let upV = 0, downV = 0;
  for (let i = n - 10; i < n; i++) { if (i < 1) continue; (closes[i] >= closes[i - 1] ? (upV += vols[i]) : (downV += vols[i])); }
  const upDownVol = downV > 0 ? +(upV / downV).toFixed(2) : (upV > 0 ? 3 : 1);
  // Accumulation/distribution proxy: sum(CLV × volume) trend over 10d, normalized.
  const adSlope = trendFit(c.slice(-10).map((x, i, a) => {
    const rng = x.high - x.low; const clvi = rng > 0 ? ((x.close - x.low) - (x.high - x.close)) / rng : 0;
    return (a.slice(0, i + 1)).reduce((s, y) => { const r2 = y.high - y.low; const cl = r2 > 0 ? ((y.close - y.low) - (y.high - y.close)) / r2 : 0; return s + cl * y.volume; }, 0);
  })).slope;
  const volPersistence = mean(vols.slice(-5).map(v => (v > (mean(vols.slice(-25, -5)) || 1) ? 1 : 0)));  // days above baseline
  const dv = c.map(x => x.close * x.volume);
  const dvAccel = (mean(dv.slice(-3)) / (mean(dv.slice(-13, -3)) || 1)) - 1;
  const dollarVol = +(mean(vols.slice(-20)) * px).toFixed(0);   // ~20d ADV in $

  // Trend quality (§2 trend quality) — favor a smooth 12% over a chaotic 20%.
  const seg20 = closes.slice(-21);
  const netMove = Math.abs((last(seg20) - seg20[0]));
  const pathLen = seg20.slice(1).reduce((s, x, i) => s + Math.abs(x - seg20[i]), 0) || 1;
  const efficiency = clamp01(netMove / pathLen);                 // directional efficiency ratio
  const fit20 = trendFit(seg20).r2;                              // regression fit of the up-trend
  const upperHalf = mean(c.slice(-10).map(x => { const rng = x.high - x.low; return rng > 0 && (x.close - x.low) / rng > 0.5 ? 1 : 0; }));
  const recentHigh = Math.max(...highs.slice(-10)), recentLow = Math.min(...lows.slice(-5));
  const pullbackDepth = recentHigh > 0 ? clamp01((recentHigh - recentLow) / recentHigh) : null;
  // HH/HL structure over last 8 sessions.
  let hh = 0, hl = 0; for (let i = n - 8; i < n; i++) { if (i < 1) continue; if (highs[i] > highs[i - 1]) hh++; if (lows[i] > lows[i - 1]) hl++; }
  const structure = +((hh + hl) / 14).toFixed(2);
  const atr = atrOf(c), atrPct = px > 0 ? atr / px : null;
  const volAdjMom = (finite(r20) && finite(atrPct) && atrPct > 0) ? +(r20 / (atrPct * Math.sqrt(20))).toFixed(2) : null;
  const downside = ret.slice(-20).filter(r => r < 0);
  const downsideSemiVol = downside.length ? +(Math.sqrt(mean(downside.map(r => r * r))) * 100).toFixed(2) : 0;
  // Gap dependence: share of the 20d move explained by overnight gaps (high = fragile).
  let gapSum = 0; for (let i = n - 20; i < n; i++) { if (i < 1) continue; gapSum += Math.abs(c[i].open - closes[i - 1]); }
  const gapDependence = pathLen > 0 ? clamp01(gapSum / pathLen) : null;

  // Extension / exhaustion inputs.
  const extAbove20 = sma20 > 0 ? px / sma20 - 1 : null;
  const extAbove50 = sma50 > 0 ? px / sma50 - 1 : null;
  const atrExtension = (finite(extAbove20) && finite(atrPct) && atrPct > 0) ? +(extAbove20 / atrPct).toFixed(2) : null; // in ATRs above SMA20
  const consecUp = (() => { let k = 0; for (let i = ret.length - 1; i >= 0 && ret[i] > 0; i--) k++; return k; })();
  const changePct = pctRet(px, closes[n - 2]);
  const upperWicks = mean(c.slice(-5).map(x => { const rng = x.high - x.low; return rng > 0 ? (x.high - Math.max(x.open, x.close)) / rng : 0; }));

  return {
    price: +px.toFixed(2), changePct: changePct == null ? null : +(changePct * 100).toFixed(2),
    // momentum
    r1, r3, r5, r10, r20, accel, slope5, slope10, slope20,
    pAbove5: pAbove(sma5), pAbove10: pAbove(sma10), pAbove20: pAbove(sma20), pAbove50: pAbove(sma50),
    maAligned, maAlignScore, distFrom20High, distFrom52High, upClose10: +up10.toFixed(2),
    clv: +clv.toFixed(2), closeStrength: +closeStrength.toFixed(2),
    // relative strength
    rsSpy3, rsSpy5, rsSpy10, rsSpy20, rsSec5, rsSec10, rsSpyAccel,
    // volume
    relVol1: +relVol1.toFixed(2), relVol3: +relVol3.toFixed(2), relVol5: +relVol5.toFixed(2),
    upDownVol, adSlope, volPersistence: +volPersistence.toFixed(2), dvAccel: +(dvAccel * 100).toFixed(1), dollarVol,
    // trend quality
    efficiency: +efficiency.toFixed(2), fit20, upperHalf: +upperHalf.toFixed(2), pullbackDepth: pullbackDepth == null ? null : +pullbackDepth.toFixed(3),
    structure, volAdjMom, downsideSemiVol, gapDependence: gapDependence == null ? null : +gapDependence.toFixed(2),
    // exhaustion
    extAbove20: extAbove20 == null ? null : +(extAbove20 * 100).toFixed(1), extAbove50: extAbove50 == null ? null : +(extAbove50 * 100).toFixed(1),
    atrPct: atrPct == null ? null : +(atrPct * 100).toFixed(2), atrExtension, consecUp,
    upperWicks: +upperWicks.toFixed(2),
  };
}

// ── MOMENTUM-STAGE CLASSIFICATION (§3) ──────────────────────────────────────────────────
// EARLY / CONFIRMED / CONTINUATION / EXTENDED / EXHAUSTED / FAILED. OMEGA-SWING primarily
// wants EARLY, CONFIRMED, and favorable CONTINUATION — where continuation probability and
// entry quality are both good.
const STAGES = ['EARLY', 'CONFIRMED', 'CONTINUATION', 'EXTENDED', 'EXHAUSTED', 'FAILED'];
const STAGE_META = {
  EARLY:        { icon: '🌱', blurb: 'Momentum just emerged — small move, room to run.' },
  CONFIRMED:    { icon: '✅', blurb: 'Momentum strengthening with real participation.' },
  CONTINUATION: { icon: '➡️', blurb: 'Established trend with a constructive entry.' },
  EXTENDED:     { icon: '⚠️', blurb: 'Trend valid but entry is poor — already run.' },
  EXHAUSTED:    { icon: '🥵', blurb: 'Continuation probability deteriorating — exhaustion.' },
  FAILED:       { icon: '❌', blurb: 'Momentum has broken down.' },
};
function classifyStage(f) {
  if (!f) return 'FAILED';
  const above20 = f.pAbove20 != null && f.pAbove20 > 0;
  const decel = f.accel != null && f.accel < 0;
  const brokeTrend = (f.slope10 != null && f.slope10 < 0) || (f.pAbove20 != null && f.pAbove20 < -0.03);
  // FAILED first — momentum gone.
  if (brokeTrend && (f.r10 == null || f.r10 < 0) && f.structure < 0.35) return 'FAILED';
  // EXHAUSTED — run far and losing steam / distribution signs.
  const exhausted = (f.extAbove20 != null && f.extAbove20 > 22 && (decel || f.upperWicks > 0.45))
    || (f.consecUp >= 7 && decel) || (f.atrExtension != null && f.atrExtension > 6 && decel);
  if (exhausted) return 'EXHAUSTED';
  // EXTENDED — trend intact but stretched (poor entry).
  const extended = (f.extAbove20 != null && f.extAbove20 > 15) || (f.atrExtension != null && f.atrExtension > 4) || (f.distFrom20High != null && f.distFrom20High > -0.005 && f.r10 != null && f.r10 > 0.18);
  if (extended && above20) return 'EXTENDED';
  // EARLY — momentum recently emerged, not extended, modest run.
  const early = above20 && (f.r10 == null || f.r10 < 0.12) && (f.extAbove20 == null || f.extAbove20 < 8);
  const confirmedPart = f.relVol5 > 1.1 && f.upDownVol > 1.1 && f.maAlignScore >= 0.66;
  if (early && !confirmedPart) return 'EARLY';
  // CONFIRMED — strengthening WITH participation.
  if (above20 && confirmedPart && (f.extAbove20 == null || f.extAbove20 < 12)) return 'CONFIRMED';
  // CONTINUATION — established trend, constructive (near a shallow pullback / consolidation).
  if (above20 && f.maAlignScore >= 0.66) return 'CONTINUATION';
  return above20 ? 'EARLY' : 'FAILED';
}
// Stages OMEGA-SWING is allowed to SELECT from (the rest are Watch/Avoid).
const SELECTABLE_STAGES = new Set(['EARLY', 'CONFIRMED', 'CONTINUATION']);

// ── CONSTRUCTIVE SETUP DETECTION (§5) ───────────────────────────────────────────────────
// Each detector returns a 0..1 strength (how cleanly the structure is present). The engine
// keeps the best-matching setup; the walk-forward measures which setups actually pay.
const SETUP_META = {
  tightConsolidation: 'Tight consolidation near highs, volume drying up.',
  highTightContinuation: 'Strong move → short controlled pause → renewed volume.',
  firstPullback: 'First pullback to short-term support on lighter volume.',
  breakoutContinuation: 'Reclaim/hold above resistance with participation.',
  postEarningsDrift: 'Holding an earnings/catalyst gap with persistent volume.',
  secondWave: 'Orderly consolidation after a first leg, RS intact, interest returning.',
};
function detectSetups(f, candles, ctx = {}) {
  if (!f) return { setups: [], best: null, bestScore: 0 };
  const s = {};
  // Tight consolidation near highs: close to 20d high, shallow range, volume contracting.
  s.tightConsolidation = clamp01(
    (f.distFrom20High != null ? clamp01(1 + f.distFrom20High / 0.06) : 0) * 0.4
    + (f.pullbackDepth != null ? clamp01(1 - f.pullbackDepth / 0.08) : 0) * 0.3
    + (f.relVol3 < 1 ? 0.3 : 0.1));
  // High-tight continuation: strong 20d run, brief pause (soft recent), volume returning.
  s.highTightContinuation = clamp01(
    (f.r20 != null ? clamp01(f.r20 / 0.25) : 0) * 0.4
    + (f.pullbackDepth != null ? clamp01(1 - f.pullbackDepth / 0.12) : 0) * 0.3
    + (f.relVol1 > 1.2 ? 0.3 : 0.1));
  // First pullback: uptrend, price pulled toward SMA10/20, lighter volume, improving close.
  const nearSupport = f.pAbove10 != null && f.pAbove10 > -0.04 && f.pAbove10 < 0.03;
  s.firstPullback = clamp01(
    (f.maAlignScore >= 0.66 ? 0.35 : 0) + (nearSupport ? 0.3 : 0)
    + (f.relVol1 < 1 ? 0.2 : 0) + (f.closeStrength > 0.55 ? 0.15 : 0));
  // Breakout continuation: at/above 20d high with real (not extreme) relative volume.
  s.breakoutContinuation = clamp01(
    (f.distFrom20High != null && f.distFrom20High > -0.01 ? 0.4 : 0)
    + (f.relVol3 > 1.3 && f.relVol3 < 4 ? 0.35 : 0.1) + (f.clv > 0.2 ? 0.25 : 0));
  // Post-earnings / catalyst drift: a recent gap held, volume persists (needs catalyst ctx).
  const hasCatalyst = !!ctx.catalyst;
  s.postEarningsDrift = clamp01(
    (hasCatalyst ? 0.4 : 0.1) + (f.gapDependence != null ? clamp01(f.gapDependence) * 0.3 : 0)
    + (f.volPersistence > 0.4 ? 0.3 : 0));
  // Second wave: consolidation after a first leg, RS intact, volume returning.
  s.secondWave = clamp01(
    (f.rsSpy20 != null && f.rsSpy20 > 0 ? 0.35 : 0) + (f.pullbackDepth != null ? clamp01(1 - f.pullbackDepth / 0.15) : 0) * 0.3
    + (f.relVol3 > 1.1 ? 0.35 : 0.1));
  const entries = Object.entries(s).map(([k, v]) => ({ setup: k, strength: +v.toFixed(2) })).sort((a, b) => b.strength - a.strength);
  const best = entries[0] && entries[0].strength >= 0.5 ? entries[0].setup : null;
  return { setups: entries, best, bestScore: entries[0] ? entries[0].strength : 0 };
}

// ── EXHAUSTION & FALSE-MOMENTUM FILTERS (§6) ────────────────────────────────────────────
// Multiplicative penalty envelope — a fatal flaw collapses the score. A strong past return
// alone must NOT qualify a name.
function exhaustionPenalty(f, ctx = {}) {
  if (!f) return { mult: 0, flags: ['no data'] };
  let mult = 1; const flags = [];
  const add = (m, why) => { mult *= m; flags.push(why); };
  if (f.changePct != null && f.changePct > 20) add(0.55, 'extreme single-day spike');
  if (f.extAbove20 != null && f.extAbove20 > 25) add(0.6, 'parabolic / far above support');
  else if (f.extAbove20 != null && f.extAbove20 > 15) add(0.85, 'extended above 20d avg');
  if (f.atrExtension != null && f.atrExtension > 6) add(0.7, `${f.atrExtension} ATRs above SMA20`);
  if (f.upperWicks > 0.5) add(0.8, 'repeated upper wicks (selling into strength)');
  if (f.clv != null && f.clv < -0.1 && f.r5 != null && f.r5 > 0.1) add(0.8, 'weak closes despite the run');
  if (f.accel != null && f.accel < -0.03) add(0.8, 'decelerating');
  if (f.relVol3 != null && f.relVol3 < 0.7 && f.r10 != null && f.r10 > 0.15) add(0.82, 'volume decaying after a run');
  if (f.gapDependence != null && f.gapDependence > 0.6) add(0.85, 'move is mostly overnight gaps');
  if (f.downsideSemiVol > 6) add(0.85, 'high downside volatility');
  if (f.consecUp >= 8) add(0.85, `${f.consecUp} straight up days (mean-reversion risk)`);
  // Liquidity / structure penalties.
  if (f.dollarVol != null && f.dollarVol < 3e6) add(0.6, 'thin liquidity');
  else if (f.dollarVol != null && f.dollarVol < 1e7) add(0.85, 'sub-$10M ADV');
  if (f.price != null && f.price < 3) add(0.8, 'low price (<$3)');
  if (ctx.dilutionRisk) add(0.75, 'recent offering / dilution risk');
  if (ctx.binaryEventInWindow) add(0.7, 'binary event inside the hold window');
  // Regime — the one validated lever.
  if (ctx.regime && (ctx.regime.bearish === true || ctx.regime.riskOn === false)) add(0.7, 'risk-off tape');
  return { mult: +mult.toFixed(3), flags };
}

// ── 0–100 SCORE (§10) ───────────────────────────────────────────────────────────────────
// Interpretable BASELINE weights. The trained model (validated via walk-forward) may override
// these once it earns promotion; until then this disciplined formula is the shipped ranker.
const SCORE_WEIGHTS = {
  relStrength: 0.20, momentumPersistence: 0.15, volumeQuality: 0.15, trendSmoothness: 0.12,
  catalystPersistence: 0.12, setupQuality: 0.10, regime: 0.08, modelResidual: 0.08,
};
function scoreComponents(f, ctx = {}) {
  const setup = ctx.setup || detectSetups(f, null, ctx);
  const cat = ctx.catalystQuality != null ? ctx.catalystQuality : (ctx.catalyst ? 0.5 : 0.25);
  const relStrength = clamp01(0.5 + ((f.rsSpy5 || 0) + (f.rsSpy10 || 0) + (f.rsSec10 || 0)) / 0.15);
  const momentumPersistence = clamp01(0.4 * (f.upClose10 || 0) + 0.3 * (f.maAlignScore || 0) + 0.3 * clamp01((f.accel || 0) / 0.04 + 0.5));
  const volumeQuality = clamp01(0.4 * clamp01(((f.upDownVol || 1) - 0.8) / 1.5) + 0.3 * (f.volPersistence || 0) + 0.3 * clamp01(((f.relVol5 || 1) - 0.9) / 1.5));
  const trendSmoothness = clamp01(0.5 * (f.efficiency || 0) + 0.3 * (f.fit20 || 0) + 0.2 * (f.upperHalf || 0));
  const catalystPersistence = clamp01(cat);
  const setupQuality = clamp01(setup.bestScore || 0);
  const regimeFit = ctx.regime ? (ctx.regime.bearish ? 0.15 : ctx.regime.riskOn ? 1 : 0.6) : 0.6;
  const modelResidual = ctx.modelProb != null ? clamp01(ctx.modelProb) : clamp01(0.5 + ((f.rsSpy10 || 0) + (f.volAdjMom || 0) / 20) / 0.2);
  return { relStrength, momentumPersistence, volumeQuality, trendSmoothness, catalystPersistence, setupQuality, regime: regimeFit, modelResidual };
}
function omegaScore(f, ctx = {}) {
  if (!f) return { score: 0, components: null, penalties: ['no data'], penaltyMult: 0 };
  const comp = scoreComponents(f, ctx);
  const base = 100 * Object.entries(SCORE_WEIGHTS).reduce((s, [k, w]) => s + w * comp[k], 0);
  const pen = exhaustionPenalty(f, ctx);
  const score = +clamp(base * pen.mult, 0, 100).toFixed(1);
  return { score, components: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, +v.toFixed(2)])), penalties: pen.flags, penaltyMult: pen.mult };
}

// ── PROBABILITY / EXPECTED-RESIDUAL BASELINE (§8 fallback) ──────────────────────────────
// Transparent, monotone map from features → the predicted quantities. NOT a trained model —
// a defensible prior the point-in-time ledger + walk-forward will confirm or refute. A fitted
// model (ctx.model) overrides these once it survives frozen validation.
function predictBaseline(f, ctx = {}) {
  if (!f) return null;
  const rsWin = clamp01(0.5 + ((f.rsSpy5 || 0) + (f.rsSpy10 || 0)) / 0.12);
  const trend = clamp01(0.5 * (f.efficiency || 0) + 0.5 * (f.maAlignScore || 0));
  const partic = clamp01(0.5 + ((f.upDownVol || 1) - 1) / 2 + (f.volPersistence || 0) / 4 - 0.25);
  const late = f.extAbove20 != null ? clamp01(f.extAbove20 / 25) : 0.3;         // exhaustion drag
  const core = clamp01(0.45 * rsWin + 0.3 * trend + 0.25 * partic - 0.25 * late);
  const pPos = clamp(0.35 + 0.4 * core, 0.15, 0.85);          // P(positive residual, 10d)
  const p3 = clamp(0.28 + 0.44 * core, 0.1, 0.82);            // P(≥3% within 10d)
  const p5 = clamp(0.16 + 0.4 * core, 0.05, 0.72);           // P(≥5% within 10d)
  const atrp = (f.atrPct || 3) / 100;
  const expMove10 = atrp * Math.sqrt(10);
  const expResid10 = +((pPos - 0.5) * 2 * expMove10 * 0.9).toFixed(4);   // residual expectancy (fraction)
  const expResid5 = +(expResid10 * 0.62).toFixed(4);
  const expMAE = +(-(atrp * Math.sqrt(6) * (0.7 + 0.6 * late))).toFixed(4);
  const expMFE = +(atrp * Math.sqrt(10) * (0.8 + 0.4 * core)).toFixed(4);
  const tailLossProb = clamp(0.12 + 0.5 * late + 0.3 * (f.downsideSemiVol / 12 || 0), 0.05, 0.6);
  const failFastProb = clamp(0.2 + 0.4 * (1 - core), 0.1, 0.7);
  return {
    pPositive: +pPos.toFixed(3), p3pct: +p3.toFixed(3), p5pct: +p5.toFixed(3),
    expResidual5: expResid5, expResidual10: expResid10, expMAE, expMFE,
    tailLossProb: +tailLossProb.toFixed(3), failFastProb: +failFastProb.toFixed(3),
    core: +core.toFixed(3), source: 'baseline',
  };
}

// ── ECONOMIC RANKING — EXPECTED UTILITY (§11) ───────────────────────────────────────────
// Rank by expected utility, not win probability. Favor 6% upside / 2% adverse over 8% / 8%.
function expectedUtility(pred, f, ctx = {}) {
  if (!pred) return 0;
  const upside = (pred.expResidual10 || 0) + (pred.pPositive - 0.5) * (pred.expMFE || 0);   // prob-weighted upside
  const adverse = Math.abs(pred.expMAE || 0) * (0.6 + pred.tailLossProb);                   // MAE + tail penalty
  const cost = (f && f.dollarVol != null && f.dollarVol < 1e7 ? 0.006 : 0.0025);            // transaction-cost proxy
  const exhaustion = f && f.extAbove20 != null ? Math.max(0, (f.extAbove20 - 12) / 100) * 0.5 : 0;
  const uncertainty = (1 - (pred.core ?? 0.5)) * 0.01;
  return +(upside - adverse - cost - exhaustion - uncertainty).toFixed(4);
}

// ── ENTRY-TIMING ENGINE (§9) ────────────────────────────────────────────────────────────
const ENTRY_CLASSES = ['BUY_NOW', 'BUY_ON_BREAKOUT', 'BUY_ON_FIRST_PULLBACK', 'WAIT_FOR_CLOSE_CONFIRMATION', 'WATCH', 'SKIP'];
function entryTiming(f, stage, setup, levels) {
  if (!f) return { classification: 'SKIP', reason: 'no data' };
  if (stage === 'FAILED' || stage === 'EXHAUSTED') return { classification: 'SKIP', reason: `${stage.toLowerCase()} momentum` };
  const ext20 = f.extAbove20 ?? 0, atrExt = f.atrExtension ?? 0;
  // Too extended for a market entry → wait for a pullback rather than chase.
  if (ext20 > 15 || atrExt > 4) {
    return { classification: 'BUY_ON_FIRST_PULLBACK', reason: `extended (${ext20}% above 20d) — wait for a pullback toward support` };
  }
  const nearHigh = f.distFrom20High != null && f.distFrom20High > -0.015;
  const pulledIn = f.pAbove10 != null && f.pAbove10 > -0.04 && f.pAbove10 < 0.02;
  if (setup && setup.best === 'breakoutContinuation' && !nearHigh) {
    return { classification: 'BUY_ON_BREAKOUT', reason: 'wants a close back above the pivot to confirm' };
  }
  if (setup && (setup.best === 'firstPullback' || setup.best === 'tightConsolidation') && pulledIn && f.closeStrength > 0.5) {
    return { classification: 'BUY_NOW', reason: 'constructive pullback holding support with a firm close' };
  }
  if (nearHigh && f.relVol3 > 1.2 && f.clv > 0.1) {
    return { classification: 'BUY_NOW', reason: 'holding near highs with participation, not yet extended' };
  }
  if (f.accel != null && f.accel < 0) {
    return { classification: 'WAIT_FOR_CLOSE_CONFIRMATION', reason: 'momentum cooling — want a firm up-close first' };
  }
  return { classification: 'WATCH', reason: 'setup developing — no clean trigger yet' };
}

// ── RISK / INVALIDATION + SIZING (§13) ──────────────────────────────────────────────────
// entry-to-invalidation from swing structure (levels.js), plus ATR-based fallback. Ranking
// stays separate from portfolio construction — this only produces per-name levels + a
// risk-normalized size suggestion.
function riskPlan(candles, entry, f, { maxRiskPct = 0.01 } = {}) {
  if (!candles || !finite(entry) || entry <= 0) return null;
  const lv = tradeLevels(candles, entry, { bullish: true, targetMode: 'measured' });
  const atr = atrOf(candles);
  const atrStop = +(entry - 2 * atr).toFixed(2);
  const stop = lv && lv.stop < entry ? Math.max(lv.stop, atrStop * 0.9) : atrStop;   // structure, floored by ATR
  const riskPerShare = entry - stop;
  if (!(riskPerShare > 0)) return null;
  const riskPct = +((riskPerShare / entry) * 100).toFixed(2);
  const target1 = lv && lv.resistance > entry ? lv.resistance : +(entry + 3 * atr).toFixed(2);
  const target2 = +(entry + (target1 - entry) * 1.8).toFixed(2);
  const rr = +((target1 - entry) / riskPerShare).toFixed(2);
  // Risk-normalized sizing: fraction of portfolio so a stop-out loses ~maxRiskPct of equity.
  const sizePctOfEquity = +clamp((maxRiskPct / (riskPerShare / entry)) * 100, 0, 100).toFixed(1);
  return {
    invalidation: +stop.toFixed(2), riskPct, target1: +target1.toFixed(2), target2, rr,
    entryZoneLow: +(entry * 0.99).toFixed(2), entryZoneHigh: +(entry * 1.015).toFixed(2),
    sizePctOfEquity, stopBasis: lv ? lv.stopBasis : 'atr',
  };
}

// ── CANDIDATE TIERS (§12) ───────────────────────────────────────────────────────────────
// OMEGA Prime / OMEGA Qualified / OMEGA Watch / Avoid. Do NOT force a fixed number of Prime —
// zero Prime is acceptable. Prime requires positive expected utility AND good entry AND no
// severe warning.
const TIERS = ['OMEGA_PRIME', 'OMEGA_QUALIFIED', 'OMEGA_WATCH', 'AVOID'];
const TIER_META = {
  OMEGA_PRIME:     { label: 'OMEGA Prime', icon: '💠' },
  OMEGA_QUALIFIED: { label: 'OMEGA Qualified', icon: '🟢' },
  OMEGA_WATCH:     { label: 'OMEGA Watch', icon: '👁' },
  AVOID:           { label: 'Avoid', icon: '🚫' },
};
function classifyTier({ score, utility, pred, f, stage, entry, setup, regime }) {
  const severe = f && ((f.dollarVol != null && f.dollarVol < 3e6) || (f.price != null && f.price < 3) || (f.extAbove20 != null && f.extAbove20 > 25));
  if (!f || stage === 'FAILED' || stage === 'EXHAUSTED' || utility <= 0 || severe) return 'AVOID';
  const entryGood = entry && ['BUY_NOW', 'BUY_ON_BREAKOUT', 'BUY_ON_FIRST_PULLBACK'].includes(entry.classification);
  const strongRS = (f.rsSpy10 || 0) > 0 && (f.rsSpy5 || 0) > 0;
  const persistentVol = (f.volPersistence || 0) >= 0.4 && (f.upDownVol || 1) >= 1.1;
  const regimeOk = !regime || regime.bearish !== true;
  const lowerBoundPos = pred && (pred.pPositive - 0.5) - 0.5 * (1 - (pred.core ?? 0.5)) > 0;   // crude positive lower bound
  if (score >= 72 && utility >= 0.01 && strongRS && persistentVol && regimeOk && SELECTABLE_STAGES.has(stage)
      && entry.classification === 'BUY_NOW' && lowerBoundPos && (setup ? setup.bestScore >= 0.55 : true)) return 'OMEGA_PRIME';
  if (score >= 58 && utility > 0 && strongRS && entryGood && regimeOk) return 'OMEGA_QUALIFIED';
  if (score >= 45 && SELECTABLE_STAGES.has(stage)) return 'OMEGA_WATCH';
  if (stage === 'EXTENDED' && score >= 50 && strongRS) return 'OMEGA_WATCH';   // strong but wait for entry
  return 'AVOID';
}

// ── RESIDUAL LABELING (§ primary target) ────────────────────────────────────────────────
// Sector- and market-relative forward return over 5 and 10 trading days is the PRIMARY label.
// residual = stock fwd return − weighted-market − sector-ETF adjustment. Point-in-time correct:
// uses ONLY candles strictly after predDate (evolve-labels.sliceForward). Returns pending when
// the window hasn't elapsed; never fabricates a benchmark (missing → null, not zero).
function residualForward({ candles, predDate, entry, window, spyCandles = null, sectorCandles = null, marketWeight = 0.6, sectorWeight = 0.4 }) {
  const fwd = L.sliceForward(candles, predDate, window + 3);
  if (!fwd.length || !finite(entry) || entry <= 0) return { resolved: false, pending: true, reason: 'no-forward-bars' };
  const n = Math.min(window, fwd.length);
  if (fwd.length < window) return { resolved: false, pending: true, barsObserved: fwd.length, windowNeeded: window, reason: 'window-not-elapsed' };
  const exit = fwd[n - 1].close;
  const raw = +((exit - entry) / entry).toFixed(4);
  // Path stats over the realized window.
  let mfe = 0, mae = 0, hit3 = null, hit5 = null;
  for (let i = 0; i < n; i++) {
    const hi = finite(fwd[i].high) ? fwd[i].high : fwd[i].close, lo = finite(fwd[i].low) ? fwd[i].low : fwd[i].close;
    mfe = Math.max(mfe, (hi - entry) / entry); mae = Math.min(mae, (lo - entry) / entry);
    if (hit3 == null && (hi - entry) / entry >= TARGET_3PCT) hit3 = i + 1;
    if (hit5 == null && (hi - entry) / entry >= TARGET_5PCT) hit5 = i + 1;
  }
  const spyRet = L.benchmarkReturn(L.sliceForward(spyCandles, predDate, window + 3), window);
  const secRet = L.benchmarkReturn(L.sliceForward(sectorCandles, predDate, window + 3), window);
  // Weighted-market + sector adjustment. If sector is unknown, fold its weight into market.
  let residual = null;
  if (spyRet != null) {
    const secComp = secRet != null ? secRet : spyRet;
    const wSec = secRet != null ? sectorWeight : 0;
    const wMkt = secRet != null ? marketWeight : 1;
    residual = +(raw - (wMkt * spyRet + wSec * secComp)).toFixed(4);
  }
  return {
    resolved: true, pending: false, window, rawReturn: raw,
    residualReturn: residual, spyReturn: spyRet, sectorReturn: secRet,
    mfe: +mfe.toFixed(4), mae: +mae.toFixed(4),
    hit3pct: hit3 != null, timeTo3pct: hit3, hit5pct: hit5 != null, timeTo5pct: hit5,
  };
}

// ── TOP-LEVEL: score one candidate end-to-end ───────────────────────────────────────────
// Ties every piece together into one inspectable card object. ctx carries catalyst,
// catalystQuality, regime, dilutionRisk, binaryEventInWindow, model (optional), maxRiskPct.
function evaluateCandidate({ ticker, candles, bench = {}, ctx = {} }) {
  const f = computeFeatures(candles, bench);
  if (!f) return null;
  const stage = classifyStage(f);
  const setup = detectSetups(f, candles, ctx);
  const model = ctx.model && typeof ctx.model.predict === 'function' ? ctx.model.predict(f) : null;
  const pred = model || predictBaseline(f, ctx);
  const sc = omegaScore(f, { ...ctx, setup, modelProb: pred ? pred.pPositive : null });
  const entry = entryTiming(f, stage, setup, null);
  const risk = riskPlan(candles, f.price, f, { maxRiskPct: ctx.maxRiskPct || 0.01 });
  const utility = expectedUtility(pred, f, ctx);
  const tier = classifyTier({ score: sc.score, utility, pred, f, stage, entry, setup, regime: ctx.regime });
  return {
    ticker, price: f.price, changePct: f.changePct,
    score: sc.score, components: sc.components, penalties: sc.penalties,
    stage, stageMeta: STAGE_META[stage], setup: setup.best, setupScore: setup.bestScore, setups: setup.setups,
    tier, tierMeta: TIER_META[tier], utility,
    pred, entry, risk, features: f,
  };
}

module.exports = {
  OMEGA_VERSION, OMEGA_HORIZONS, TARGET_3PCT, TARGET_5PCT,
  computeFeatures, trendFit, mean, clamp01, clamp,
  STAGES, STAGE_META, SELECTABLE_STAGES, classifyStage,
  SETUP_META, detectSetups, exhaustionPenalty,
  SCORE_WEIGHTS, scoreComponents, omegaScore, predictBaseline, expectedUtility,
  ENTRY_CLASSES, entryTiming, riskPlan, TIERS, TIER_META, classifyTier,
  residualForward, evaluateCandidate,
};

